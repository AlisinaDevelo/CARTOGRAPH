import { Buffer } from "node:buffer";
import { constants, realpathSync } from "node:fs";
import { lstat, open, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import {
  analyzeTypeScriptRepository,
  type TypeScriptAnalyzerOptions,
} from "./analyzers/index.js";
import { assertReportItemLimit } from "./resources.js";
import {
  diffGraphSnapshots,
  evaluatePolicyOnDiff,
  evaluatePolicyOnSnapshot,
  migrateGraphSnapshot,
  parseGraphDiff,
  parseGraphSnapshot,
  parsePolicyConfig,
  defaultCartographConfig,
  readCartographConfig,
  readPolicyConfig,
  createRemediationReview,
  serializeGraphSnapshot,
  serializeRemediationReview,
  validateMigrationOutput,
  type CartographConfig,
  type PolicyCiMode,
  type PolicyEvaluation,
  type GraphSnapshot,
  type SnapshotMigrationResult,
} from "./core/index.js";
import {
  readPathHistory,
  resolveRevisionComparison,
  withMaterializedRevision,
  type RevisionComparisonMode,
} from "./git/revision.js";
import { renderDiff, type ReportFormat } from "./report/render.js";

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_POLICY_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_REMEDIATION_REVIEW_BYTES = 2 * 1024 * 1024;
// macOS exposes these root-owned aliases for /private/{tmp,var}; they are not
// user-controlled path components and must remain usable for normal temp paths.
const MACOS_ROOT_SYMLINKS = new Set(["/tmp", "/var"]);

export type ScanOptions = {
  root: string;
  tsconfigPath?: string;
  config?: CartographConfig;
  configPath?: string;
  signal?: AbortSignal;
};

export type RevisionDiffOptions = {
  base: string;
  comparison?: RevisionComparisonMode;
  format: ReportFormat;
  head: string;
  root: string;
  tsconfigPath?: string;
  config?: CartographConfig;
  configPath?: string;
  signal?: AbortSignal;
};

type ConfigOptions = {
  config?: CartographConfig;
  configPath?: string;
  tsconfigPath?: string;
};

const containedPath = (
  root: string,
  candidate: string,
  label: string,
): string => {
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(resolve(realRoot, candidate));
  const relativePath = relative(realRoot, realCandidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  ) {
    throw new Error(`${label} must stay inside the analyzed repository`);
  }
  return realCandidate;
};

const configurationFor = (
  root: string,
  options: ConfigOptions,
): CartographConfig => {
  if (options.config) return options.config;
  if (options.configPath)
    return readCartographConfig(root, options.configPath).config;
  return defaultCartographConfig();
};

const analyzerOptions = (
  root: string,
  config: CartographConfig,
  tsconfigPath: string | undefined,
  revision: NonNullable<TypeScriptAnalyzerOptions["revision"]>,
  signal?: AbortSignal,
) => ({
  rootDir: root,
  include: config.include,
  exclude: config.exclude,
  extractors: config.extractors,
  resources: config.resources,
  revision,
  ...(signal === undefined ? {} : { signal }),
  ...(tsconfigPath === undefined
    ? {}
    : { tsconfigPath: containedPath(root, tsconfigPath, "tsconfig") }),
});

export function scanRepository(options: ScanOptions): GraphSnapshot {
  const root = realpathSync(resolve(options.root));
  const config = configurationFor(root, options);
  const snapshot = parseGraphSnapshot(
    analyzeTypeScriptRepository(
      analyzerOptions(
        root,
        config,
        options.tsconfigPath ?? config.tsconfigPath,
        { branch: "working-tree", commitSha: "working-tree" },
        options.signal,
      ),
    ),
  );
  assertReportItemLimit(
    snapshot.nodes.length + snapshot.edges.length + snapshot.diagnostics.length,
    config.resources.maxReportItems,
  );
  return snapshot;
}

const scanMaterializedRevision = async (
  repositoryRoot: string,
  ref: string,
  tsconfigPath?: string,
  config?: CartographConfig,
  signal?: AbortSignal,
): Promise<GraphSnapshot> =>
  await withMaterializedRevision(
    repositoryRoot,
    ref,
    (revision) =>
      parseGraphSnapshot(
        analyzeTypeScriptRepository(
          analyzerOptions(
            revision.root,
            config ?? defaultCartographConfig(),
            tsconfigPath,
            { commitSha: revision.commit },
            signal,
          ),
        ),
      ),
    {
      ...(config?.resources === undefined
        ? {}
        : {
            resources: {
              maxArchiveBytes: config.resources.maxArchiveBytes,
              maxExtractedBytes: config.resources.maxSourceBytes,
              maxMemoryBytes: config.resources.maxMemoryBytes,
              maxWallClockMs: config.resources.maxWallClockMs,
            },
          }),
      ...(signal === undefined ? {} : { signal }),
    },
  );

export async function diffRepositoryRevisions(
  options: RevisionDiffOptions,
): Promise<string> {
  const repositoryRoot = resolve(options.root);
  const config = configurationFor(repositoryRoot, options);
  const comparison = await resolveRevisionComparison(
    repositoryRoot,
    options.base,
    options.head,
    options.comparison ?? "direct",
    options.signal === undefined ? {} : { signal: options.signal },
  );
  const before = await scanMaterializedRevision(
    repositoryRoot,
    comparison.fromCommitSha,
    options.tsconfigPath ?? config.tsconfigPath,
    config,
    options.signal,
  );
  const after = await scanMaterializedRevision(
    repositoryRoot,
    comparison.headCommitSha,
    options.tsconfigPath ?? config.tsconfigPath,
    config,
    options.signal,
  );
  const pathHistory = await readPathHistory(
    repositoryRoot,
    comparison.fromCommitSha,
    comparison.headCommitSha,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  return renderDiff(
    diffGraphSnapshots(before, after, {
      comparison: {
        mode: comparison.mode,
        baseRef: comparison.baseRef,
        headRef: comparison.headRef,
        baseCommitSha: comparison.baseCommitSha,
        headCommitSha: comparison.headCommitSha,
        ...(comparison.mergeBaseSha === undefined
          ? {}
          : { mergeBaseSha: comparison.mergeBaseSha }),
      },
      identity: { pathHistory },
    }),
    options.format,
    config.resources.maxReportItems,
  );
}

export async function loadSnapshot(path: string): Promise<GraphSnapshot> {
  const inputPath = resolve(path);
  const metadata = await stat(inputPath);
  if (!metadata.isFile())
    throw new Error(`snapshot is not a regular file: ${path}`);
  if (metadata.size > MAX_SNAPSHOT_BYTES) {
    throw new Error(`snapshot exceeds the 64 MiB input limit: ${path}`);
  }

  const source = await readFile(inputPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error(`snapshot exceeds the 64 MiB input limit: ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`could not parse snapshot ${path}: ${detail}`, {
      cause: error,
    });
  }
  return parseGraphSnapshot(value);
}

export async function loadDiff(path: string) {
  const inputPath = resolve(path);
  const metadata = await stat(inputPath);
  if (!metadata.isFile())
    throw new Error(`diff is not a regular file: ${path}`);
  if (metadata.size > MAX_POLICY_INPUT_BYTES)
    throw new Error(`diff exceeds the 64 MiB input limit: ${path}`);

  let value: unknown;
  try {
    const source = await readFile(inputPath, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_POLICY_INPUT_BYTES)
      throw new Error("diff exceeds the 64 MiB input limit");
    value = JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`could not parse diff ${path}: ${detail}`, {
      cause: error,
    });
  }
  return parseGraphDiff(value);
}

export type PolicyInputKind = "snapshot" | "diff";

export type PolicyEvaluationOptions = {
  input: string;
  inputKind: PolicyInputKind;
  mode?: PolicyCiMode;
  policy: string;
  root: string;
};

export async function evaluatePolicyFile(
  options: PolicyEvaluationOptions,
): Promise<PolicyEvaluation> {
  const root = realpathSync(resolve(options.root));
  const parsedPolicy = readPolicyConfig(root, options.policy);
  const policy =
    options.mode === undefined
      ? parsedPolicy
      : parsePolicyConfig({ ...parsedPolicy, mode: options.mode });
  if (options.inputKind === "snapshot") {
    return evaluatePolicyOnSnapshot(policy, await loadSnapshot(options.input));
  }
  return evaluatePolicyOnDiff(policy, await loadDiff(options.input));
}

export async function diffSnapshotFiles(
  beforePath: string,
  afterPath: string,
  format: ReportFormat,
  maxReportItems?: number,
): Promise<string> {
  const [before, after] = await Promise.all([
    loadSnapshot(beforePath),
    loadSnapshot(afterPath),
  ]);
  return renderDiff(diffGraphSnapshots(before, after), format, maxReportItems);
}

export async function migrateSnapshotFile(
  inputPath: string,
): Promise<SnapshotMigrationResult> {
  const resolvedInput = resolve(inputPath);
  const metadata = await stat(resolvedInput);
  if (!metadata.isFile())
    throw new Error(`snapshot is not a regular file: ${inputPath}`);
  if (metadata.size > MAX_SNAPSHOT_BYTES)
    throw new Error(`snapshot exceeds the 64 MiB input limit: ${inputPath}`);

  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolvedInput, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`could not parse snapshot ${inputPath}: ${detail}`, {
      cause: error,
    });
  }
  const result = migrateGraphSnapshot(value);
  validateMigrationOutput(result);
  return result;
}

export async function reviewRemediationFile(
  inputPath: string,
  asOf?: string,
): Promise<string> {
  const resolvedInput = resolve(inputPath);
  const metadata = await stat(resolvedInput);
  if (!metadata.isFile())
    throw new Error(`remediation review is not a regular file: ${inputPath}`);
  if (metadata.size > MAX_REMEDIATION_REVIEW_BYTES)
    throw new Error(
      `remediation review exceeds the 2 MiB input limit: ${inputPath}`,
    );
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolvedInput, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(
      `could not parse remediation review ${inputPath}: ${detail}`,
      {
        cause: error,
      },
    );
  }
  const review = createRemediationReview(
    value,
    asOf === undefined ? {} : { now: asOf },
  );
  return `${serializeRemediationReview(review)}\n`;
}

export async function writeOutputFile(
  outputPath: string,
  content: string,
  force: boolean,
): Promise<void> {
  const path = resolve(outputPath);
  let parentPath = dirname(path);
  while (true) {
    try {
      const metadata = await lstat(parentPath);
      if (
        metadata.isSymbolicLink() &&
        !(process.platform === "darwin" && MACOS_ROOT_SYMLINKS.has(parentPath))
      )
        throw new Error("output path must not contain a symbolic link");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }

    const ancestorPath = dirname(parentPath);
    if (ancestorPath === parentPath) break;
    parentPath = ancestorPath;
  }

  if (force) {
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink())
        throw new Error("output path must not be a symbolic link");
      if (!metadata.isFile())
        throw new Error("output path must be a regular file");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
  }

  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    (force ? constants.O_TRUNC : constants.O_EXCL) |
    constants.O_NOFOLLOW;
  const handle = await open(path, flags, 0o600);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new Error("output path must be a regular file");
    await handle.writeFile(content, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

export function serializeScan(snapshot: GraphSnapshot): string {
  return `${serializeGraphSnapshot(snapshot)}\n`;
}
