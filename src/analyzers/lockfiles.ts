import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type { ResourceLimits } from "../core/index.js";
import { ResourceLimitError } from "../resources.js";
import type { WorkspaceDiscovery } from "./workspace.js";

export const LOCKFILE_DETECTOR = "cartograph.lockfile@1";

export type LockfileManager = "npm" | "pnpm" | "yarn" | "bun";

export type LockfileSource = {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly contentHash: string;
};

export type LockfileDependency = {
  readonly ownerRoot: string;
  readonly ownerName?: string;
  readonly manager: LockfileManager;
  readonly lockfilePath: string;
  readonly name: string;
  readonly requested?: string;
  readonly resolvedVersion?: string;
  readonly integrity?: string;
  readonly source: LockfileSource;
};

export type LockfileDiagnosticCode =
  | "AMBIGUOUS_LOCKFILE"
  | "LOCKFILE_MISSING_INTEGRITY"
  | "LOCKFILE_VERSION_MISMATCH";

export type LockfileDiagnostic = {
  readonly code: LockfileDiagnosticCode;
  readonly source: LockfileSource;
  readonly detail: string;
};

export type LockfileDiscovery = {
  readonly dependencies: readonly LockfileDependency[];
  readonly diagnostics: readonly LockfileDiagnostic[];
  readonly fileHashes: ReadonlyMap<string, string>;
};

type JsonRecord = Record<string, unknown>;
type LockfileCandidate = {
  readonly ownerDir: string;
  readonly path: string;
  readonly manager: LockfileManager;
};
type PackageManifest = {
  readonly name?: string;
  readonly packageManager?: string;
  readonly dependencies: ReadonlyMap<string, string>;
};
type PackageRecord = {
  readonly name: string;
  readonly version?: string;
  readonly integrity?: string;
  readonly source: LockfileSource;
};

const LOCKFILE_NAMES: ReadonlyMap<string, LockfileManager> = new Map([
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
]);

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const normalizePath = (value: string): string =>
  value.normalize("NFC").replaceAll(sep, "/");

const relativePath = (rootDir: string, candidate: string): string => {
  const value = normalizePath(relative(rootDir, candidate));
  return value.length > 0 ? value : ".";
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

const lineAndColumnAt = (
  text: string,
  index: number,
): { line: number; column: number } => {
  const prefix = text.slice(0, Math.max(0, index));
  const line = prefix.split(/\r?\n/u).length;
  const lastBreak = Math.max(
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf("\r"),
  );
  return { line, column: prefix.length - lastBreak };
};

const sourceAt = (
  path: string,
  text: string,
  contentHash: string,
  index: number,
): LockfileSource => {
  const location = lineAndColumnAt(text, index);
  return {
    path,
    line: location.line,
    column: location.column,
    contentHash,
  };
};

const sourceForNeedle = (
  path: string,
  text: string,
  contentHash: string,
  needle: string,
  start = 0,
): LockfileSource => {
  const index = text.indexOf(needle, Math.max(0, start));
  return sourceAt(path, text, contentHash, index >= 0 ? index : 0);
};

const scalar = (value: string): string => {
  const trimmed = value.trim().replace(/^['"]|['"]$/gu, "");
  return trimmed;
};

const packageNameFromKey = (value: string): string => {
  const normalized = value.replace(/^['"]|['"]$/gu, "").replace(/^\/{1,}/u, "");
  const nodeModules = normalized.lastIndexOf("node_modules/");
  if (nodeModules >= 0) return normalized.slice(nodeModules + 13);
  if (normalized.startsWith("@")) {
    const secondAt = normalized.indexOf("@", 1);
    const slash = normalized.indexOf("/");
    if (secondAt > slash && secondAt > 0) return normalized.slice(0, secondAt);
  }
  const at = normalized.lastIndexOf("@");
  return at > 0 ? normalized.slice(0, at) : normalized;
};

const versionFromKey = (value: string): string | undefined => {
  const normalized = value.replace(/^['"]|['"]$/gu, "");
  if (normalized.startsWith("@")) {
    const slash = normalized.indexOf("/");
    const at = normalized.indexOf("@", slash + 1);
    return at > 0 ? normalized.slice(at + 1) : undefined;
  }
  const at = normalized.lastIndexOf("@");
  return at > 0 ? normalized.slice(at + 1) : undefined;
};

const exactVersion = (value: string | undefined): boolean =>
  value !== undefined && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value);

const localReference = (value: string | undefined): boolean =>
  value !== undefined &&
  /^(?:workspace:|link:|file:|git\+|https?:)/u.test(value);

const manifestAt = (ownerDir: string, maxBytes: number): PackageManifest => {
  const path = join(ownerDir, "package.json");
  if (!isRegularFile(path)) return { dependencies: new Map() };
  const metadata = lstatSync(path);
  if (metadata.size > maxBytes) return { dependencies: new Map() };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return { dependencies: new Map() };
    const dependencies = new Map<string, string>();
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const values = parsed[field];
      if (!isRecord(values)) continue;
      for (const [name, version] of Object.entries(values))
        if (typeof version === "string") dependencies.set(name, version);
    }
    return {
      ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
      ...(typeof parsed.packageManager === "string"
        ? { packageManager: parsed.packageManager }
        : {}),
      dependencies,
    };
  } catch {
    return { dependencies: new Map() };
  }
};

const candidatesFor = (
  rootDir: string,
  workspace: WorkspaceDiscovery | undefined,
): LockfileCandidate[] => {
  const ownerDirs = new Set<string>([
    rootDir,
    ...(workspace?.packages.map((candidate) => candidate.rootDir) ?? []),
  ]);
  const candidates: LockfileCandidate[] = [];
  for (const ownerDir of [...ownerDirs].sort(compareStrings)) {
    for (const [name, manager] of LOCKFILE_NAMES) {
      const path = join(ownerDir, name);
      if (isRegularFile(path)) candidates.push({ ownerDir, path, manager });
    }
  }
  return candidates.sort((left, right) =>
    compareStrings(
      `${left.ownerDir}:${left.path}`,
      `${right.ownerDir}:${right.path}`,
    ),
  );
};

const addDiagnostic = (
  diagnostics: LockfileDiagnostic[],
  code: LockfileDiagnosticCode,
  source: LockfileSource,
  detail: string,
): void => {
  diagnostics.push({ code, source, detail });
};

const versionMismatch = (
  requested: string | undefined,
  resolved: string | undefined,
): boolean =>
  exactVersion(requested) && resolved !== undefined && requested !== resolved;

const integrityDiagnostic = (
  diagnostics: LockfileDiagnostic[],
  dependency: LockfileDependency,
): void => {
  if (
    dependency.integrity ||
    localReference(dependency.requested) ||
    localReference(dependency.resolvedVersion)
  )
    return;
  addDiagnostic(
    diagnostics,
    "LOCKFILE_MISSING_INTEGRITY",
    dependency.source,
    `${dependency.manager} lockfile record for ${dependency.name} has no integrity or checksum field.`,
  );
};

const npmDependencies = (
  rootDir: string,
  candidate: LockfileCandidate,
  text: string,
  contentHash: string,
  parsed: JsonRecord,
  diagnostics: LockfileDiagnostic[],
  manifest: PackageManifest,
): LockfileDependency[] => {
  const lockfileVersion = parsed.lockfileVersion;
  const numericVersion =
    typeof lockfileVersion === "number"
      ? lockfileVersion
      : typeof lockfileVersion === "string"
        ? Number(lockfileVersion)
        : undefined;
  if (!numericVersion || ![1, 2, 3].includes(numericVersion))
    addDiagnostic(
      diagnostics,
      "LOCKFILE_VERSION_MISMATCH",
      sourceForNeedle(
        relativePath(rootDir, candidate.path),
        text,
        contentHash,
        "lockfileVersion",
      ),
      `npm lockfile version ${String(lockfileVersion)} is outside the supported v1-v3 range.`,
    );
  const packageRecords = new Map<string, PackageRecord>();
  const packages = isRecord(parsed.packages) ? parsed.packages : undefined;
  if (packages) {
    for (const [key, value] of Object.entries(packages)) {
      if (key.length === 0 || !isRecord(value)) continue;
      const name = packageNameFromKey(key);
      const source = sourceForNeedle(
        relativePath(rootDir, candidate.path),
        text,
        contentHash,
        JSON.stringify(key),
      );
      packageRecords.set(name, {
        name,
        ...(typeof value.version === "string"
          ? { version: value.version }
          : {}),
        ...(typeof value.integrity === "string"
          ? { integrity: value.integrity }
          : {}),
        source,
      });
    }
  }
  const legacy = isRecord(parsed.dependencies)
    ? parsed.dependencies
    : undefined;
  if (legacy) {
    for (const [name, value] of Object.entries(legacy)) {
      if (!isRecord(value) || packageRecords.has(name)) continue;
      const source = sourceForNeedle(
        relativePath(rootDir, candidate.path),
        text,
        contentHash,
        JSON.stringify(name),
      );
      packageRecords.set(name, {
        name,
        ...(typeof value.version === "string"
          ? { version: value.version }
          : {}),
        ...(typeof value.integrity === "string"
          ? { integrity: value.integrity }
          : {}),
        source,
      });
    }
  }
  const dependencies: LockfileDependency[] = [];
  for (const [name, requested] of manifest.dependencies) {
    const record = packageRecords.get(name);
    const source =
      record?.source ??
      sourceForNeedle(
        relativePath(rootDir, candidate.path),
        text,
        contentHash,
        JSON.stringify(name),
      );
    const dependency: LockfileDependency = {
      ownerRoot: relativePath(rootDir, candidate.ownerDir),
      ...(manifest.name ? { ownerName: manifest.name } : {}),
      manager: "npm",
      lockfilePath: relativePath(rootDir, candidate.path),
      name,
      requested,
      ...(record?.version ? { resolvedVersion: record.version } : {}),
      ...(record?.integrity ? { integrity: record.integrity } : {}),
      source,
    };
    dependencies.push(dependency);
    if (!record || versionMismatch(requested, record.version))
      addDiagnostic(
        diagnostics,
        "LOCKFILE_VERSION_MISMATCH",
        source,
        `npm lockfile does not resolve ${name} to the exact declared version ${requested}.`,
      );
    integrityDiagnostic(diagnostics, dependency);
  }
  return dependencies;
};

const parsePnpm = (
  rootDir: string,
  candidate: LockfileCandidate,
  text: string,
  contentHash: string,
  diagnostics: LockfileDiagnostic[],
  manifest: PackageManifest,
): LockfileDependency[] => {
  const lines = text.split(/\r?\n/u);
  const importerDeps = new Map<
    string,
    Map<
      string,
      { requested?: string; resolved?: string; source: LockfileSource }
    >
  >();
  const packageRecords = new Map<string, PackageRecord>();
  let section: "importers" | "packages" | undefined;
  let importer: string | undefined;
  let dependencyField: string | undefined;
  let dependencyName: string | undefined;
  let packageKey: string | undefined;
  let packageSource: LockfileSource | undefined;
  let packageIntegrity: string | undefined;
  let packageVersion: string | undefined;
  let offset = 0;
  const flushPackage = (): void => {
    if (!packageKey || !packageSource) return;
    const name = packageNameFromKey(packageKey);
    const version = packageVersion ?? versionFromKey(packageKey);
    packageRecords.set(name, {
      name,
      ...(version ? { version } : {}),
      ...(packageIntegrity ? { integrity: packageIntegrity } : {}),
      source: packageSource,
    });
    packageKey = undefined;
    packageSource = undefined;
    packageIntegrity = undefined;
    packageVersion = undefined;
  };
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const indentation = rawLine.length - rawLine.trimStart().length;
    const source = sourceAt(
      relativePath(rootDir, candidate.path),
      text,
      contentHash,
      offset,
    );
    offset += rawLine.length + 1;
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (indentation === 0 && trimmed.startsWith("lockfileVersion:")) {
      const value = Number(scalar(trimmed.slice("lockfileVersion:".length)));
      if (
        !Number.isFinite(value) ||
        ![5, 6, 7, 8, 9].includes(Math.trunc(value))
      )
        addDiagnostic(
          diagnostics,
          "LOCKFILE_VERSION_MISMATCH",
          source,
          `pnpm lockfile version ${trimmed.slice("lockfileVersion:".length).trim()} is outside the supported v5-v9 range.`,
        );
      continue;
    }
    if (indentation === 0 && trimmed === "importers:") {
      flushPackage();
      section = "importers";
      importer = undefined;
      continue;
    }
    if (indentation === 0 && trimmed === "packages:") {
      flushPackage();
      section = "packages";
      importer = undefined;
      continue;
    }
    if (section === "importers") {
      if (indentation === 2 && trimmed.endsWith(":")) {
        importer = scalar(trimmed.slice(0, -1));
        dependencyField = undefined;
        dependencyName = undefined;
        continue;
      }
      if (indentation === 4 && trimmed.endsWith(":")) {
        dependencyField = scalar(trimmed.slice(0, -1));
        dependencyName = undefined;
        continue;
      }
      if (
        importer &&
        dependencyField &&
        [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
        ].includes(dependencyField)
      ) {
        if (indentation === 6 && trimmed.endsWith(":")) {
          dependencyName = scalar(trimmed.slice(0, -1));
          const byName =
            importerDeps.get(importer) ??
            new Map<
              string,
              { requested?: string; resolved?: string; source: LockfileSource }
            >();
          byName.set(dependencyName, { source });
          importerDeps.set(importer, byName);
          continue;
        }
        if (dependencyName && indentation >= 8) {
          const byName = importerDeps.get(importer);
          const current = byName?.get(dependencyName);
          if (!current) continue;
          if (trimmed.startsWith("specifier:"))
            current.requested = scalar(trimmed.slice("specifier:".length));
          if (trimmed.startsWith("version:"))
            current.resolved = scalar(trimmed.slice("version:".length));
        }
      }
      continue;
    }
    if (section === "packages") {
      if (indentation === 2 && trimmed.endsWith(":")) {
        flushPackage();
        packageKey = scalar(trimmed.slice(0, -1));
        packageSource = source;
        continue;
      }
      if (!packageKey || indentation < 4) continue;
      if (trimmed.startsWith("integrity:"))
        packageIntegrity = scalar(trimmed.slice("integrity:".length));
      else {
        const inlineIntegrity = trimmed.match(
          /(?:^|[\s{])integrity:\s*([^,}\s]+)/u,
        );
        if (inlineIntegrity?.[1]) packageIntegrity = scalar(inlineIntegrity[1]);
      }
      if (trimmed.startsWith("version:"))
        packageVersion = scalar(trimmed.slice("version:".length));
    }
  }
  flushPackage();
  const dependencies: LockfileDependency[] = [];
  for (const [owner, values] of importerDeps) {
    for (const [name, value] of values) {
      const record = packageRecords.get(name);
      const resolved = value.resolved?.replace(/^\/?/u, "").split("(")[0];
      const source = record?.source ?? value.source;
      const dependency: LockfileDependency = {
        ownerRoot: owner,
        ...(manifest.name && owner === "." ? { ownerName: manifest.name } : {}),
        manager: "pnpm",
        lockfilePath: relativePath(rootDir, candidate.path),
        name,
        ...(value.requested ? { requested: value.requested } : {}),
        ...(resolved ? { resolvedVersion: resolved } : {}),
        ...(record?.integrity ? { integrity: record.integrity } : {}),
        source,
      };
      dependencies.push(dependency);
      if (
        (value.requested &&
          resolved &&
          versionMismatch(value.requested, resolved)) ||
        !record
      )
        addDiagnostic(
          diagnostics,
          "LOCKFILE_VERSION_MISMATCH",
          source,
          `pnpm lockfile does not provide the declared ${name} record.`,
        );
      integrityDiagnostic(diagnostics, dependency);
    }
  }
  return dependencies;
};

const parseYarn = (
  rootDir: string,
  candidate: LockfileCandidate,
  text: string,
  contentHash: string,
  diagnostics: LockfileDiagnostic[],
  manifest: PackageManifest,
): LockfileDependency[] => {
  const lines = text.split(/\r?\n/u);
  const records: PackageRecord[] = [];
  let keys: string[] = [];
  let source: LockfileSource | undefined;
  let version: string | undefined;
  let integrity: string | undefined;
  let offset = 0;
  const flush = (): void => {
    for (const key of keys) {
      const name = packageNameFromKey(key);
      if (name === "__metadata") continue;
      records.push({
        name,
        ...(version ? { version } : {}),
        ...(integrity ? { integrity } : {}),
        source: source as LockfileSource,
      });
    }
    keys = [];
    source = undefined;
    version = undefined;
    integrity = undefined;
  };
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const indentation = rawLine.length - rawLine.trimStart().length;
    const currentSource = sourceAt(
      relativePath(rootDir, candidate.path),
      text,
      contentHash,
      offset,
    );
    offset += rawLine.length + 1;
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("# yarn lockfile v")) {
      const lockfileVersion = Number(trimmed.slice("# yarn lockfile v".length));
      if (!Number.isFinite(lockfileVersion) || lockfileVersion !== 1)
        addDiagnostic(
          diagnostics,
          "LOCKFILE_VERSION_MISMATCH",
          currentSource,
          `yarn lockfile version ${trimmed.slice("# yarn lockfile v".length).trim()} is outside the supported classic v1 range.`,
        );
      continue;
    }
    if (trimmed.startsWith("#")) continue;
    if (indentation === 0 && trimmed.endsWith(":")) {
      flush();
      keys = trimmed
        .slice(0, -1)
        .split(/\s*,\s*/u)
        .map((key) => scalar(key));
      source = currentSource;
      continue;
    }
    if (indentation === 0 && trimmed.startsWith("__metadata:")) {
      flush();
      source = currentSource;
      continue;
    }
    if (indentation === 2 || indentation === 4) {
      if (trimmed.startsWith("version "))
        version = scalar(trimmed.slice("version ".length));
      if (trimmed.startsWith("integrity "))
        integrity = scalar(trimmed.slice("integrity ".length));
      if (trimmed.startsWith("checksum "))
        integrity = scalar(trimmed.slice("checksum ".length));
    }
  }
  flush();
  const wanted = manifest.dependencies;
  const dependencies: LockfileDependency[] = [];
  for (const record of records) {
    if (wanted.size > 0 && !wanted.has(record.name)) continue;
    const requested = wanted.get(record.name);
    const dependency: LockfileDependency = {
      ownerRoot: relativePath(rootDir, candidate.ownerDir),
      ...(manifest.name ? { ownerName: manifest.name } : {}),
      manager: "yarn",
      lockfilePath: relativePath(rootDir, candidate.path),
      name: record.name,
      ...(requested ? { requested } : {}),
      ...(record.version ? { resolvedVersion: record.version } : {}),
      ...(record.integrity ? { integrity: record.integrity } : {}),
      source: record.source,
    };
    dependencies.push(dependency);
    if (versionMismatch(requested, record.version))
      addDiagnostic(
        diagnostics,
        "LOCKFILE_VERSION_MISMATCH",
        record.source,
        `yarn lockfile resolves ${record.name} to ${record.version} instead of exact declaration ${requested}.`,
      );
    integrityDiagnostic(diagnostics, dependency);
  }
  return dependencies;
};

const jsonPackageRecords = (
  rootDir: string,
  candidate: LockfileCandidate,
  text: string,
  contentHash: string,
  value: unknown,
): PackageRecord[] => {
  if (!isRecord(value)) return [];
  const records: PackageRecord[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry) && !Array.isArray(entry)) continue;
    const name = packageNameFromKey(key);
    let version: string | undefined;
    let integrity: string | undefined;
    if (Array.isArray(entry)) {
      if (typeof entry[0] === "string") version = versionFromKey(entry[0]);
      const metadata = entry.find(isRecord);
      if (metadata) {
        if (typeof metadata.version === "string") version = metadata.version;
        if (typeof metadata.integrity === "string")
          integrity = metadata.integrity;
        if (typeof metadata.checksum === "string")
          integrity = metadata.checksum;
      }
    } else {
      if (typeof entry.version === "string") version = entry.version;
      if (typeof entry.integrity === "string") integrity = entry.integrity;
      if (typeof entry.checksum === "string") integrity = entry.checksum;
    }
    records.push({
      name,
      ...(version ? { version } : {}),
      ...(integrity ? { integrity } : {}),
      source: sourceForNeedle(
        relativePath(rootDir, candidate.path),
        text,
        contentHash,
        JSON.stringify(key),
      ),
    });
  }
  return records;
};

const parseBun = (
  rootDir: string,
  candidate: LockfileCandidate,
  text: string,
  contentHash: string,
  diagnostics: LockfileDiagnostic[],
  manifest: PackageManifest,
): LockfileDependency[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    addDiagnostic(
      diagnostics,
      "LOCKFILE_VERSION_MISMATCH",
      sourceAt(relativePath(rootDir, candidate.path), text, contentHash, 0),
      "Bun binary lockfiles or malformed Bun lockfiles are outside the offline parser boundary.",
    );
    return [];
  }
  const record = isRecord(parsed) ? parsed : {};
  const version = record.lockfileVersion;
  const numericVersion =
    typeof version === "number"
      ? version
      : typeof version === "string"
        ? Number(version)
        : undefined;
  if (!numericVersion || ![0, 1].includes(numericVersion))
    addDiagnostic(
      diagnostics,
      "LOCKFILE_VERSION_MISMATCH",
      sourceForNeedle(
        relativePath(rootDir, candidate.path),
        text,
        contentHash,
        "lockfileVersion",
      ),
      "Bun lockfile does not declare a supported lockfileVersion.",
    );
  const packageRecords = [
    ...jsonPackageRecords(
      rootDir,
      candidate,
      text,
      contentHash,
      record.packages,
    ),
  ];
  const dependencyMaps: Array<{ owner: string; values: JsonRecord }> = [];
  if (isRecord(record.workspaces)) {
    for (const [owner, workspace] of Object.entries(record.workspaces)) {
      if (!isRecord(workspace)) continue;
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
      ])
        if (isRecord(workspace[field]))
          dependencyMaps.push({
            owner: owner.length > 0 ? owner : ".",
            values: workspace[field],
          });
    }
  } else {
    for (const field of ["dependencies", "devDependencies"])
      if (isRecord(record[field]))
        dependencyMaps.push({
          owner: ".",
          values: record[field],
        });
  }
  const dependencies: LockfileDependency[] = [];
  for (const { owner, values } of dependencyMaps) {
    for (const [name, requestedValue] of Object.entries(values)) {
      const requested =
        typeof requestedValue === "string" ? requestedValue : undefined;
      const packageRecord = packageRecords.find((item) => item.name === name);
      const source =
        packageRecord?.source ??
        sourceForNeedle(
          relativePath(rootDir, candidate.path),
          text,
          contentHash,
          JSON.stringify(name),
        );
      const dependency: LockfileDependency = {
        ownerRoot: owner,
        ...(owner === "." && manifest.name ? { ownerName: manifest.name } : {}),
        manager: "bun",
        lockfilePath: relativePath(rootDir, candidate.path),
        name,
        ...(requested ? { requested } : {}),
        ...(packageRecord?.version
          ? { resolvedVersion: packageRecord.version }
          : {}),
        ...(packageRecord?.integrity
          ? { integrity: packageRecord.integrity }
          : {}),
        source,
      };
      dependencies.push(dependency);
      if (versionMismatch(requested, packageRecord?.version))
        addDiagnostic(
          diagnostics,
          "LOCKFILE_VERSION_MISMATCH",
          source,
          `bun lockfile resolves ${name} to an unexpected exact version.`,
        );
      integrityDiagnostic(diagnostics, dependency);
    }
  }
  return dependencies;
};

const parseCandidate = (
  rootDir: string,
  candidate: LockfileCandidate,
  resources: ResourceLimits,
  diagnostics: LockfileDiagnostic[],
  manifest: PackageManifest,
): { dependencies: LockfileDependency[]; contentHash: string } => {
  const metadata = lstatSync(candidate.path);
  if (metadata.size > resources.maxFileBytes)
    throw new ResourceLimitError(
      `lockfile ${relativePath(rootDir, candidate.path)} exceeds the ${resources.maxFileBytes} byte file ceiling`,
    );
  const bytes = readFileSync(candidate.path);
  const text = bytes.toString("utf8");
  const contentHash = hashBytes(bytes);
  if (candidate.path.endsWith(".lockb")) {
    addDiagnostic(
      diagnostics,
      "LOCKFILE_VERSION_MISMATCH",
      sourceAt(relativePath(rootDir, candidate.path), text, contentHash, 0),
      "Bun binary lockfiles require Bun to decode and remain outside the offline parser boundary.",
    );
    return { dependencies: [], contentHash };
  }
  if (candidate.manager === "npm") {
    try {
      const parsed = JSON.parse(text) as unknown;
      return {
        dependencies: isRecord(parsed)
          ? npmDependencies(
              rootDir,
              candidate,
              text,
              contentHash,
              parsed,
              diagnostics,
              manifest,
            )
          : [],
        contentHash,
      };
    } catch {
      addDiagnostic(
        diagnostics,
        "LOCKFILE_VERSION_MISMATCH",
        sourceAt(relativePath(rootDir, candidate.path), text, contentHash, 0),
        "npm lockfile is not valid JSON and cannot be normalized offline.",
      );
      return { dependencies: [], contentHash };
    }
  }
  if (candidate.manager === "pnpm")
    return {
      dependencies: parsePnpm(
        rootDir,
        candidate,
        text,
        contentHash,
        diagnostics,
        manifest,
      ),
      contentHash,
    };
  if (candidate.manager === "yarn")
    return {
      dependencies: parseYarn(
        rootDir,
        candidate,
        text,
        contentHash,
        diagnostics,
        manifest,
      ),
      contentHash,
    };
  return {
    dependencies: parseBun(
      rootDir,
      candidate,
      text,
      contentHash,
      diagnostics,
      manifest,
    ),
    contentHash,
  };
};

export const discoverLockfiles = (
  rootDir: string,
  workspace: WorkspaceDiscovery | undefined,
  resources: ResourceLimits,
  checkBudget: () => void,
): LockfileDiscovery => {
  const resolvedRoot = resolve(rootDir);
  const candidates = candidatesFor(resolvedRoot, workspace);
  const diagnostics: LockfileDiagnostic[] = [];
  const dependencies: LockfileDependency[] = [];
  const fileHashes = new Map<string, string>();
  const byOwner = new Map<string, LockfileCandidate[]>();
  for (const candidate of candidates) {
    const values = byOwner.get(candidate.ownerDir) ?? [];
    values.push(candidate);
    byOwner.set(candidate.ownerDir, values);
  }
  for (const [ownerDir, ownerCandidates] of byOwner) {
    checkBudget();
    if (ownerCandidates.length > 1) {
      const first = ownerCandidates[0];
      if (first) {
        const bytes = readFileSync(first.path);
        const path = relativePath(resolvedRoot, first.path);
        addDiagnostic(
          diagnostics,
          "AMBIGUOUS_LOCKFILE",
          sourceAt(path, bytes.toString("utf8"), hashBytes(bytes), 0),
          `Multiple package-manager lockfiles are present for ${relativePath(resolvedRoot, ownerDir)}.`,
        );
      }
    }
    const manifest = manifestAt(ownerDir, resources.maxFileBytes);
    for (const candidate of ownerCandidates) {
      checkBudget();
      const expectedManager = manifest.packageManager?.split("@")[0];
      if (
        expectedManager &&
        ["npm", "pnpm", "yarn", "bun"].includes(expectedManager) &&
        expectedManager !== candidate.manager
      ) {
        const bytes = readFileSync(candidate.path);
        const text = bytes.toString("utf8");
        addDiagnostic(
          diagnostics,
          "LOCKFILE_VERSION_MISMATCH",
          sourceAt(
            relativePath(resolvedRoot, candidate.path),
            text,
            hashBytes(bytes),
            0,
          ),
          `package.json declares ${expectedManager} but ${candidate.manager} lockfile is present.`,
        );
      }
      const parsed = parseCandidate(
        resolvedRoot,
        candidate,
        resources,
        diagnostics,
        manifest,
      );
      const path = relativePath(resolvedRoot, candidate.path);
      fileHashes.set(path, parsed.contentHash);
      dependencies.push(...parsed.dependencies);
    }
  }
  return {
    dependencies: dependencies.sort((left, right) =>
      compareStrings(
        `${left.ownerRoot}:${left.name}:${left.lockfilePath}:${left.source.line}:${left.source.column}:${left.resolvedVersion ?? ""}`,
        `${right.ownerRoot}:${right.name}:${right.lockfilePath}:${right.source.line}:${right.source.column}:${right.resolvedVersion ?? ""}`,
      ),
    ),
    diagnostics: diagnostics.sort((left, right) =>
      compareStrings(
        `${left.source.path}:${left.source.line}:${left.source.column}:${left.code}:${left.detail}`,
        `${right.source.path}:${right.source.line}:${right.source.column}:${right.code}:${right.detail}`,
      ),
    ),
    fileHashes,
  };
};
