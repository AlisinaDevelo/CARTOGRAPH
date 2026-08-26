import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

import type { ResourceLimits } from "../core/index.js";
import { ResourceLimitError } from "../resources.js";

/** Detector identity for generated-code provenance and exclusion records. */
export const GENERATED_CODE_DETECTOR = "cartograph.generated@1";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const GENERATED_DIRECTORY_NAMES = new Set([
  "build",
  "coverage",
  "dist",
  "generated",
  "out",
]);
const NEVER_SCAN_DIRECTORIES = new Set([
  ".git",
  ".cartograph",
  "node_modules",
  "vendor",
]);
const MARKER_BYTES = 64 * 1024;

export type GeneratedProvenanceKind =
  "configured-exclude" | "directory" | "filename" | "marker";

export type GeneratedSource = {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly contentHash: string;
};

export type GeneratedArtifact = {
  readonly path: string;
  readonly included: boolean;
  readonly kind: GeneratedProvenanceKind;
  readonly reason: string;
  readonly source: GeneratedSource;
  readonly sourcePaths: readonly string[];
};

export type GeneratedRelationship = {
  readonly generatedPath: string;
  readonly sourcePath: string;
  readonly source: GeneratedSource;
};

export type GeneratedPartialDiagnosticCode =
  "EXCLUDED_GENERATED_FILE" | "GENERATED_SOURCE_UNRESOLVED";

export type GeneratedPartialDiagnostic = {
  readonly code: GeneratedPartialDiagnosticCode;
  readonly source: GeneratedSource;
  readonly detail: string;
};

export type GeneratedDiscovery = {
  readonly included: readonly GeneratedArtifact[];
  readonly excluded: readonly GeneratedArtifact[];
  readonly relationships: readonly GeneratedRelationship[];
  readonly diagnostics: readonly GeneratedPartialDiagnostic[];
  readonly fileHashes: ReadonlyMap<string, string>;
};

type Marker = {
  readonly index: number;
  readonly generated: boolean;
  readonly sourceTokens: readonly { token: string; index: number }[];
};

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

const isInsideRoot = (rootDir: string, candidate: string): boolean => {
  const root = resolve(rootDir);
  const target = resolve(candidate);
  return target === root || target.startsWith(`${root}${sep}`);
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
  rootDir: string,
  path: string,
  contentHash: string,
  text: string,
  index: number,
): GeneratedSource => {
  const location = lineAndColumnAt(text, index);
  return {
    path: relativePath(rootDir, path),
    line: location.line,
    column: location.column,
    contentHash,
  };
};

const globRegExp = (pattern: string): RegExp => {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character?.replace(/[|\\{}()[\]^$+.*]/gu, "\\$&") ?? "";
    }
  }
  return new RegExp(`${expression}$`, "u");
};

const matchesPathPattern = (pattern: string, path: string): boolean => {
  const normalized = pattern.replaceAll("\\", "/");
  if (normalized === ".") return true;
  if (globRegExp(normalized).test(path)) return true;
  return !/[?*]/u.test(normalized) && path.startsWith(`${normalized}/`);
};

const isRegularFile = (path: string): boolean => {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
};

const readPrefix = (path: string, maxBytes: number): string => {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(descriptor, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};

const markerFor = (text: string): Marker => {
  const lines = text.split(/\r?\n/u);
  let offset = 0;
  let generated = false;
  let firstIndex = -1;
  const sourceTokens: { token: string; index: number }[] = [];

  for (const line of lines) {
    const comment = line.match(/^\s*(?:\/\/|#|\/\*+|\*)\s*(.*?)(?:\*\/\s*)?$/u);
    const body = comment?.[1] ?? line.trim();
    const bodyOffset = comment
      ? Math.max(0, line.indexOf(body))
      : Math.max(0, line.search(/\S/u));
    const markerIndex = offset + (bodyOffset < 0 ? 0 : bodyOffset);

    if (
      /(?:^|\s)(?:@generated|@codegen|generated\s+(?:file|by)|do\s+not\s+edit)(?:\b|$)/iu.test(
        body,
      ) ||
      /^cartograph\s*:\s*generated\b/iu.test(body)
    ) {
      generated = true;
      if (firstIndex < 0) firstIndex = markerIndex;
    }

    const sourceMatch = body.match(
      /(?:cartograph\s*:\s*)?(?:@?generated[- ]from)\s*[:=]\s*(.+)$/iu,
    );
    if (sourceMatch?.[1]) {
      if (firstIndex < 0) firstIndex = markerIndex;
      generated = true;
      for (const rawToken of sourceMatch[1].split(/[,\s]+/u)) {
        const token = rawToken.trim().replace(/^[`"']|[`"',;*]+$/gu, "");
        if (token.length > 0) sourceTokens.push({ token, index: markerIndex });
      }
    }
    offset += line.length + 1;
  }

  return {
    index: firstIndex < 0 ? 0 : firstIndex,
    generated,
    sourceTokens,
  };
};

const pathLooksGenerated = (path: string): boolean => {
  const base = path.split("/").at(-1) ?? path;
  return /(?:\.generated|\.gen)(?:\.[^.]+)+$/iu.test(base);
};

const patternLooksGenerated = (pattern: string): boolean =>
  /(?:^|[/._-])(?:build|coverage|dist|generated|out)(?:$|[/._-])/iu.test(
    pattern,
  );

const directoryReason = (path: string): string | undefined => {
  const parts = path.split("/");
  const generated = parts.find((part) => GENERATED_DIRECTORY_NAMES.has(part));
  return generated === undefined
    ? undefined
    : `detected generated directory "${generated}"`;
};

const sourceTokensFor = (
  rootDir: string,
  filePath: string,
  sourceTokens: readonly { token: string; index: number }[],
  sourcePaths: ReadonlySet<string>,
): { sourcePath: string; index: number }[] => {
  const resolved: { sourcePath: string; index: number }[] = [];
  const seen = new Set<string>();
  for (const sourceToken of sourceTokens) {
    const token = sourceToken.token.replaceAll("\\", "/");
    const candidates = token.startsWith(".")
      ? [resolve(filePath, "..", token)]
      : [resolve(rootDir, token), resolve(filePath, "..", token)];
    let candidate: string | undefined;
    for (const attempt of candidates) {
      if (!isInsideRoot(rootDir, attempt) || !isRegularFile(attempt)) continue;
      let physical: string;
      try {
        physical = realpathSync(attempt);
      } catch {
        continue;
      }
      if (!isInsideRoot(rootDir, physical)) continue;
      const normalized = resolve(attempt);
      if (sourcePaths.has(normalized)) {
        candidate = normalized;
        break;
      }
    }
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      resolved.push({ sourcePath: candidate, index: sourceToken.index });
    }
  }
  return resolved.sort((left, right) =>
    compareStrings(left.sourcePath, right.sourcePath),
  );
};

/**
 * Discovers generated TypeScript artifacts without executing generators.
 *
 * Source files that remain in the analyzer's selected set are classified in
 * the returned `included` list. Source files hidden by a detected generated
 * directory or an explicit generated-looking exclusion are returned in
 * `excluded` and receive one diagnostic each when integrated into a graph.
 */
export const discoverGeneratedCode = (
  rootDir: string,
  sourcePaths: ReadonlySet<string>,
  include: readonly string[],
  exclude: readonly string[],
  resources: ResourceLimits,
  checkBudget: () => void,
): GeneratedDiscovery => {
  const included: GeneratedArtifact[] = [];
  const excluded: GeneratedArtifact[] = [];
  const relationships: GeneratedRelationship[] = [];
  const diagnostics: GeneratedPartialDiagnostic[] = [];
  const fileHashes = new Map<string, string>();
  const visited = new Set<string>();
  let generatedFiles = 0;
  let generatedBytes = 0;

  const visit = (directory: string): void => {
    checkBudget();
    const physicalDirectory = resolve(directory);
    if (visited.has(physicalDirectory)) return;
    visited.add(physicalDirectory);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort(
        (left, right) => compareStrings(left.name, right.name),
      );
    } catch {
      return;
    }

    for (const entry of entries) {
      checkBudget();
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && NEVER_SCAN_DIRECTORIES.has(entry.name))
        continue;
      const entryPath = join(directory, entry.name);
      const relative = relativePath(rootDir, entryPath);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name)))
        continue;

      const absolutePath = resolve(entryPath);
      const selected =
        sourcePaths.has(absolutePath) &&
        include.some((pattern) => matchesPathPattern(pattern, relative));
      const configuredPattern = exclude.find((pattern) =>
        matchesPathPattern(pattern, relative),
      );
      const directoryDetected = directoryReason(relative);
      const filenameDetected = pathLooksGenerated(relative);
      let metadata;
      try {
        metadata = lstatSync(absolutePath);
      } catch {
        continue;
      }
      const text = readPrefix(absolutePath, MARKER_BYTES);
      const marker = markerFor(text);
      const configuredDetected =
        configuredPattern !== undefined &&
        (patternLooksGenerated(configuredPattern) ||
          directoryDetected !== undefined ||
          filenameDetected ||
          marker.generated);
      const generated =
        directoryDetected !== undefined ||
        filenameDetected ||
        marker.generated ||
        configuredDetected;
      if (!generated) continue;

      generatedFiles += 1;
      if (generatedFiles > resources.maxFiles)
        throw new ResourceLimitError(
          `generated-code discovery exceeds the ${resources.maxFiles} file ceiling`,
        );
      if (metadata.size > resources.maxFileBytes)
        throw new ResourceLimitError(
          `generated source file exceeds the ${resources.maxFileBytes} byte file ceiling: ${relative}`,
        );
      generatedBytes += metadata.size;
      if (generatedBytes > resources.maxSourceBytes)
        throw new ResourceLimitError(
          `generated-code discovery exceeds the ${resources.maxSourceBytes} byte source ceiling`,
        );
      const bytes = readFileSync(absolutePath);
      const contentHash = hashBytes(bytes);
      fileHashes.set(relative, contentHash);

      const source = sourceAt(
        rootDir,
        absolutePath,
        contentHash,
        text,
        marker.index,
      );
      const sources = sourceTokensFor(
        rootDir,
        absolutePath,
        marker.sourceTokens,
        sourcePaths,
      );
      const sourcePathsForArtifact = sources.map((candidate) =>
        relativePath(rootDir, candidate.sourcePath),
      );
      const kind: GeneratedProvenanceKind = marker.generated
        ? "marker"
        : configuredDetected
          ? "configured-exclude"
          : directoryDetected !== undefined
            ? "directory"
            : "filename";
      const detectedReason = marker.generated
        ? marker.sourceTokens.length > 0
          ? `explicit generated marker${sourcePathsForArtifact.length > 0 ? ` referencing ${sourcePathsForArtifact.join(", ")}` : ""}`
          : "explicit generated marker"
        : (directoryDetected ?? "generated filename marker");
      const reason =
        configuredDetected && configuredPattern
          ? `${detectedReason}; configured exclusion pattern "${configuredPattern}"`
          : detectedReason;
      const artifact: GeneratedArtifact = {
        path: relative,
        included: selected,
        kind,
        reason,
        source,
        sourcePaths: sourcePathsForArtifact,
      };
      (selected ? included : excluded).push(artifact);

      for (const candidate of sources) {
        relationships.push({
          generatedPath: relative,
          sourcePath: relativePath(rootDir, candidate.sourcePath),
          source: sourceAt(
            rootDir,
            absolutePath,
            contentHash,
            text,
            candidate.index,
          ),
        });
      }

      if (!selected) {
        diagnostics.push({
          code: "EXCLUDED_GENERATED_FILE",
          source,
          detail: `Excluded generated path "${relative}" because ${reason}.`,
        });
      }
      if (marker.sourceTokens.length > 0 && sources.length === 0) {
        diagnostics.push({
          code: "GENERATED_SOURCE_UNRESOLVED",
          source,
          detail: `Generated path "${relative}" declares source provenance, but no declared source path is selected inside the analyzed repository.`,
        });
      }
    }
  };

  visit(resolve(rootDir));

  const sortArtifacts = (left: GeneratedArtifact, right: GeneratedArtifact) =>
    compareStrings(left.path, right.path);
  included.sort(sortArtifacts);
  excluded.sort(sortArtifacts);
  relationships.sort((left, right) =>
    compareStrings(
      `${left.generatedPath}\u0000${left.sourcePath}`,
      `${right.generatedPath}\u0000${right.sourcePath}`,
    ),
  );
  diagnostics.sort((left, right) =>
    compareStrings(
      `${left.code}\u0000${left.source.path}`,
      `${right.code}\u0000${right.source.path}`,
    ),
  );
  return { included, excluded, relationships, diagnostics, fileHashes };
};
