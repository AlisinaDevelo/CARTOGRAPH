import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";

import type { Evidence, ResourceLimits } from "../core/index.js";
import { createResourceBudget } from "../resources.js";

const WORKSPACE_DETECTOR = "cartograph.typescript-workspace@1/manifest";
const PACKAGE_MANIFEST = "package.json";
const WORKSPACE_MANIFESTS = [
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml",
] as const;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".cartograph",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "vendor",
]);

export type WorkspaceManager = "npm" | "pnpm" | "yarn";

export type WorkspaceManifestErrorCode =
  "ambiguous" | "malformed" | "missing" | "overlap" | "duplicate-name";

export class WorkspaceManifestError extends Error {
  readonly code: WorkspaceManifestErrorCode;
  readonly manifestPath: string | undefined;

  constructor(
    code: WorkspaceManifestErrorCode,
    message: string,
    manifestPath?: string,
  ) {
    super(message);
    this.name = "WorkspaceManifestError";
    this.code = code;
    this.manifestPath = manifestPath;
  }
}

export type WorkspacePackage = {
  readonly name: string;
  readonly rootDir: string;
  readonly relativeRoot: string;
  readonly manifestPath: string;
  readonly manifestRelativePath: string;
  readonly nodeId: string;
  readonly dependencies: readonly string[];
  readonly evidence: Evidence;
};

export type WorkspaceDiscovery = {
  readonly manager: WorkspaceManager;
  readonly manifestPath: string;
  readonly patterns: readonly string[];
  readonly packages: readonly WorkspacePackage[];
};

type JsonRecord = Record<string, unknown>;
type PatternMatch = { readonly path: string; readonly pattern: string };

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const normalizePath = (value: string): string =>
  value.normalize("NFC").replaceAll(sep, "/");

const relativePath = (rootDir: string, candidate: string): string => {
  const value = normalizePath(relative(rootDir, candidate));
  return value.length === 0 ? "." : value;
};

const hashBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isRegularFile = (path: string): boolean => {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
};

const isDirectory = (path: string): boolean => {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
};

const parseManifestJson = (path: string, maxBytes: number): JsonRecord => {
  if (!isRegularFile(path)) {
    throw new WorkspaceManifestError(
      "missing",
      `workspace package manifest is missing or not a regular file: ${path}`,
      path,
    );
  }
  const metadata = lstatSync(path);
  if (metadata.size > maxBytes)
    throw new WorkspaceManifestError(
      "malformed",
      `workspace package manifest exceeds the ${maxBytes} byte file ceiling: ${path}`,
      path,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new WorkspaceManifestError(
      "malformed",
      `could not parse workspace package manifest ${path}: ${detail}`,
      path,
    );
  }
  if (!isRecord(parsed)) {
    throw new WorkspaceManifestError(
      "malformed",
      `workspace package manifest must be a JSON object: ${path}`,
      path,
    );
  }
  return parsed;
};

const portablePattern = (value: unknown, manifestPath: string): string => {
  if (typeof value !== "string") {
    throw new WorkspaceManifestError(
      "malformed",
      `workspace pattern must be a string in ${manifestPath}`,
      manifestPath,
    );
  }
  const normalized = value.trim().replaceAll("\\", "/");
  const candidate = normalized.startsWith("!")
    ? normalized.slice(1).trim()
    : normalized;
  if (
    candidate.length === 0 ||
    candidate.includes("\0") ||
    candidate.startsWith("/") ||
    candidate.startsWith("~") ||
    candidate.startsWith("//") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(candidate) ||
    candidate.split("/").some((part) => part === "..")
  ) {
    throw new WorkspaceManifestError(
      "malformed",
      `workspace pattern must be repository-relative and portable: ${JSON.stringify(value)} in ${manifestPath}`,
      manifestPath,
    );
  }
  return normalized;
};

const workspacePatterns = (value: unknown, manifestPath: string): string[] => {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.packages)
      ? value.packages
      : undefined;
  if (!raw || raw.length === 0) {
    throw new WorkspaceManifestError(
      "malformed",
      `workspace declaration in ${manifestPath} must contain a non-empty packages array`,
      manifestPath,
    );
  }
  return raw.map((pattern) => portablePattern(pattern, manifestPath));
};

const stripYamlComment = (line: string): string => {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "#" && quote === undefined) return line.slice(0, index);
    if ((character === "'" || character === '"') && quote === undefined)
      quote = character;
    else if (character === quote) quote = undefined;
  }
  return line;
};

const yamlScalar = (value: string, manifestPath: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0)
    throw new WorkspaceManifestError(
      "malformed",
      `pnpm workspace pattern is empty in ${manifestPath}`,
      manifestPath,
    );
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    return trimmed.slice(1, -1);
  return trimmed;
};

const parsePnpmWorkspace = (path: string, maxBytes: number): string[] => {
  if (!isRegularFile(path))
    throw new WorkspaceManifestError(
      "missing",
      `pnpm workspace manifest is missing or not a regular file: ${path}`,
      path,
    );
  const metadata = lstatSync(path);
  if (metadata.size > maxBytes)
    throw new WorkspaceManifestError(
      "malformed",
      `pnpm workspace manifest exceeds the ${maxBytes} byte file ceiling: ${path}`,
      path,
    );
  const lines = readFileSync(path, "utf8").split(/\r?\n/u);
  const patterns: string[] = [];
  let inPackages = false;
  let packagesIndent = -1;
  for (const rawLine of lines) {
    const line = stripYamlComment(rawLine).replace(/\s+$/u, "");
    if (line.trim().length === 0) continue;
    const indentation = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (!inPackages) {
      if (trimmed === "packages:") {
        inPackages = true;
        packagesIndent = indentation;
        continue;
      }
      if (/^packages\s*:/u.test(trimmed)) {
        const inline = trimmed.slice(trimmed.indexOf(":") + 1).trim();
        if (!inline.startsWith("[") || !inline.endsWith("]"))
          throw new WorkspaceManifestError(
            "malformed",
            `pnpm packages must be a YAML list in ${path}`,
            path,
          );
        const values = inline
          .slice(1, -1)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => yamlScalar(value, path));
        patterns.push(...values);
        inPackages = false;
        continue;
      }
      continue;
    }
    if (indentation <= packagesIndent) {
      inPackages = false;
      if (trimmed === "packages:") {
        inPackages = true;
        packagesIndent = indentation;
      }
      continue;
    }
    if (!trimmed.startsWith("-"))
      throw new WorkspaceManifestError(
        "malformed",
        `pnpm packages entries must be list items in ${path}: ${trimmed}`,
        path,
      );
    patterns.push(yamlScalar(trimmed.slice(1), path));
  }
  if (patterns.length === 0)
    throw new WorkspaceManifestError(
      "malformed",
      `pnpm workspace manifest must declare a non-empty packages list: ${path}`,
      path,
    );
  return patterns.map((pattern) => portablePattern(pattern, path));
};

const globRegExp = (pattern: string): RegExp => {
  const normalized = pattern.replace(/^!/, "").replace(/\/+$/u, "");
  if (normalized === "." || normalized.length === 0) return /^\.$/u;
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === undefined) continue;
    if (character === "*" && normalized[index + 1] === "*") {
      source += "(?:[^/]+(?:/|$))*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${source}/?$`, "u");
};

const walkDirectories = (
  rootDir: string,
  checkBudget: () => void,
): string[] => {
  const directories = [rootDir];
  const visited = new Set<string>();
  for (let index = 0; index < directories.length; index += 1) {
    checkBudget();
    const directory = directories[index];
    if (directory === undefined) continue;
    const physical = realpathSync(directory);
    if (visited.has(physical)) continue;
    visited.add(physical);
    try {
      const entries = readdirSync(directory, { withFileTypes: true }).sort(
        (left, right) => compareStrings(left.name, right.name),
      );
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const candidate = join(directory, entry.name);
        if (isDirectory(candidate)) directories.push(candidate);
      }
    } catch {
      continue;
    }
  }
  return directories.sort((left, right) =>
    compareStrings(relativePath(rootDir, left), relativePath(rootDir, right)),
  );
};

const selectPackageDirectories = (
  rootDir: string,
  patterns: readonly string[],
  checkBudget: () => void,
): string[] => {
  const directories = walkDirectories(rootDir, checkBudget);
  const selected = new Map<string, PatternMatch>();
  const positivePatterns = new Map<string, string>();
  for (const pattern of patterns) {
    const negative = pattern.startsWith("!");
    const matcher = globRegExp(pattern);
    const matches = directories.filter((directory) =>
      matcher.test(relativePath(rootDir, directory)),
    );
    for (const directory of matches) {
      const manifest = join(directory, PACKAGE_MANIFEST);
      if (!isRegularFile(manifest)) continue;
      if (negative) selected.delete(directory);
      else {
        const existing = positivePatterns.get(directory);
        if (existing) {
          throw new WorkspaceManifestError(
            "overlap",
            `workspace patterns ${JSON.stringify(existing)} and ${JSON.stringify(pattern)} both select ${relativePath(rootDir, directory)}; use one non-overlapping declaration`,
          );
        }
        positivePatterns.set(directory, pattern);
        selected.set(directory, { path: directory, pattern });
      }
    }
    if (
      !negative &&
      matches.every(
        (directory) => !isRegularFile(join(directory, PACKAGE_MANIFEST)),
      )
    ) {
      throw new WorkspaceManifestError(
        "missing",
        `workspace pattern ${JSON.stringify(pattern)} did not select a package.json under ${rootDir}`,
      );
    }
  }
  const roots = [...selected.keys()].sort((left, right) =>
    compareStrings(relativePath(rootDir, left), relativePath(rootDir, right)),
  );
  for (let index = 0; index < roots.length; index += 1) {
    for (let other = index + 1; other < roots.length; other += 1) {
      const leftRoot = roots[index];
      const rightRoot = roots[other];
      if (leftRoot === undefined || rightRoot === undefined) continue;
      const left = relativePath(rootDir, leftRoot);
      const right = relativePath(rootDir, rightRoot);
      if (right.startsWith(`${left}/`))
        throw new WorkspaceManifestError(
          "overlap",
          `workspace package roots overlap: ${left} contains ${right}; narrow the workspace patterns`,
        );
    }
  }
  if (roots.length === 0)
    throw new WorkspaceManifestError(
      "missing",
      `workspace declaration did not select any package.json under ${rootDir}`,
    );
  return roots;
};

const dependencyNames = (manifest: JsonRecord, path: string): string[] => {
  const names = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (!isRecord(value))
      throw new WorkspaceManifestError(
        "malformed",
        `${field} must be an object in workspace package manifest ${path}`,
        path,
      );
    for (const [name, version] of Object.entries(value)) {
      if (name.trim().length === 0 || typeof version !== "string")
        throw new WorkspaceManifestError(
          "malformed",
          `${field} must map package names to version strings in ${path}`,
          path,
        );
      names.add(name.normalize("NFC"));
    }
  }
  return [...names].sort(compareStrings);
};

const managerFor = (
  rootDir: string,
  manifest: JsonRecord,
): WorkspaceManager => {
  const packageManager = manifest.packageManager;
  if (typeof packageManager === "string" && packageManager.startsWith("pnpm@"))
    return "pnpm";
  if (typeof packageManager === "string" && packageManager.startsWith("yarn@"))
    return "yarn";
  if (isRegularFile(join(rootDir, "yarn.lock"))) return "yarn";
  return "npm";
};

const manifestEvidence = (
  rootDir: string,
  manifestPath: string,
  contentHash: string,
): Evidence => {
  const path = relativePath(rootDir, manifestPath);
  return {
    id: `workspace:${path}:1:1`,
    kind: "source",
    path,
    line: 1,
    column: 1,
    detector: WORKSPACE_DETECTOR,
    contentHash,
  };
};

const discoverDeclarations = (
  rootDir: string,
  maxBytes: number,
):
  | { manager: WorkspaceManager; manifestPath: string; patterns: string[] }
  | undefined => {
  const packagePath = join(rootDir, PACKAGE_MANIFEST);
  const packageManifest = isRegularFile(packagePath)
    ? parseManifestJson(packagePath, maxBytes)
    : undefined;
  const pnpmPaths = WORKSPACE_MANIFESTS.filter((name) =>
    isRegularFile(join(rootDir, name)),
  ).map((name) => join(rootDir, name));
  if (pnpmPaths.length > 1)
    throw new WorkspaceManifestError(
      "ambiguous",
      `both pnpm workspace manifests are present under ${rootDir}; keep only one`,
    );
  const hasPackageWorkspaces =
    packageManifest && "workspaces" in packageManifest;
  if (hasPackageWorkspaces && pnpmPaths.length > 0) {
    const pnpmPath = pnpmPaths[0];
    if (pnpmPath === undefined)
      throw new WorkspaceManifestError(
        "ambiguous",
        `pnpm workspace manifest list is unexpectedly empty under ${rootDir}`,
      );
    throw new WorkspaceManifestError(
      "ambiguous",
      `package.json workspaces and ${relativePath(rootDir, pnpmPath)} are both present; choose one workspace manager`,
      packagePath,
    );
  }
  if (hasPackageWorkspaces) {
    return {
      manager: managerFor(rootDir, packageManifest),
      manifestPath: packagePath,
      patterns: workspacePatterns(packageManifest.workspaces, packagePath),
    };
  }
  if (pnpmPaths.length > 0) {
    const manifestPath = pnpmPaths[0];
    if (manifestPath === undefined)
      throw new WorkspaceManifestError(
        "missing",
        `pnpm workspace manifest list is unexpectedly empty under ${rootDir}`,
      );
    return {
      manager: "pnpm",
      manifestPath,
      patterns: parsePnpmWorkspace(manifestPath, maxBytes),
    };
  }
  return undefined;
};

export const discoverWorkspacePackages = (
  rootDir: string,
  resources: ResourceLimits,
  signal?: AbortSignal,
): WorkspaceDiscovery | undefined => {
  const checkBudget = createResourceBudget({
    maxMemoryBytes: resources.maxMemoryBytes,
    maxWallClockMs: resources.maxWallClockMs,
    ...(signal === undefined ? {} : { signal }),
  });
  const declarations = discoverDeclarations(rootDir, resources.maxFileBytes);
  if (!declarations) return undefined;
  const roots = selectPackageDirectories(
    rootDir,
    declarations.patterns,
    checkBudget,
  );
  const packages: WorkspacePackage[] = [];
  const names = new Map<string, string>();
  for (const packageRoot of roots) {
    checkBudget();
    const manifestPath = join(packageRoot, PACKAGE_MANIFEST);
    const manifest = parseManifestJson(manifestPath, resources.maxFileBytes);
    const name = manifest.name;
    if (typeof name !== "string" || name.trim().length === 0)
      throw new WorkspaceManifestError(
        "malformed",
        `workspace package manifest must declare a non-empty name: ${manifestPath}`,
        manifestPath,
      );
    const normalizedName = name.trim().normalize("NFC");
    const relativeRoot = relativePath(rootDir, packageRoot);
    const existing = names.get(normalizedName);
    if (existing)
      throw new WorkspaceManifestError(
        "duplicate-name",
        `workspace package name ${JSON.stringify(normalizedName)} is declared by both ${existing} and ${relativeRoot}`,
      );
    names.set(normalizedName, relativeRoot);
    const content = readFileSync(manifestPath);
    const manifestRelativePath = `${relativeRoot}/${PACKAGE_MANIFEST}`.replace(
      /^\.\//u,
      "",
    );
    packages.push({
      name: normalizedName,
      rootDir: realpathSync(packageRoot),
      relativeRoot,
      manifestPath: realpathSync(manifestPath),
      manifestRelativePath,
      nodeId: `package:${relativeRoot === "." ? "root" : relativeRoot}`,
      dependencies: dependencyNames(manifest, manifestPath),
      evidence: manifestEvidence(rootDir, manifestPath, hashBytes(content)),
    });
  }
  return {
    manager: declarations.manager,
    manifestPath: relativePath(rootDir, declarations.manifestPath),
    patterns: [...declarations.patterns],
    packages: packages.sort((left, right) =>
      compareStrings(left.nodeId, right.nodeId),
    ),
  };
};

export const workspacePackageForPath = (
  discovery: WorkspaceDiscovery,
  filePath: string,
): WorkspacePackage | undefined => {
  const candidates = discovery.packages
    .filter((candidate) => {
      const candidateRoot = resolve(candidate.rootDir);
      const absolute = resolve(filePath);
      const path = relative(candidateRoot, absolute);
      return (
        path === "" ||
        (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep))
      );
    })
    .sort((left, right) => right.rootDir.length - left.rootDir.length);
  return candidates[0];
};
