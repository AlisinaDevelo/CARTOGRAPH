import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open, readFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, relative, resolve, sep } from "node:path";

import {
  analyzeTypeScriptRepository,
  type TypeScriptAnalyzerOptions,
} from "./analyzers/index.js";
import { ResourceLimitError, assertReportItemLimit } from "./resources.js";
import {
  diffGraphSnapshots,
  composePolicyConfig,
  evaluatePolicyOnDiff,
  evaluatePolicyOnSnapshot,
  migrateGraphSnapshot,
  parseGraphDiff,
  parseGraphSnapshot,
  parsePolicyConfig,
  readAdrReferenceDocument,
  AdrReferenceValidationError,
  defaultCartographConfig,
  readCartographConfig,
  createRemediationReview,
  createRuntimeReconciliationReport,
  DEFAULT_RUNTIME_TRACE_SAFETY_POLICY,
  DEFAULT_RUNTIME_TRACE_BUDGET_POLICY,
  importRuntimeTraceWithBudget,
  reconcileRuntimeTrace,
  RuntimeReconciliationInputSchema,
  RuntimeTraceBudgetPolicySchema,
  RuntimeSpanBindingSchema,
  RuntimeTraceRetentionStore,
  RuntimeTraceSafetyPolicySchema,
  serializeRuntimeReconciliationReport,
  serializeRuntimeTrace,
  serializeGraphSnapshot,
  serializeRemediationReview,
  validateMigrationOutput,
  stableStringify,
  type CartographConfig,
  type AdrReferenceDocument,
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
import { buildAdrReport, type AdrReport } from "./report/adr.js";
import { renderDiff, type ReportFormat } from "./report/render.js";

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_POLICY_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_REMEDIATION_REVIEW_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_BINDINGS_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_TRACE_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_TOTAL_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_RUNTIME_REPORT_ITEMS = 200_000;
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
  adr?: string;
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

const readAdrReferenceAtRoot = (
  root: string,
  referencePath: string,
): AdrReferenceDocument | undefined => {
  try {
    return readAdrReferenceDocument(root, referencePath);
  } catch (error) {
    if (
      error instanceof AdrReferenceValidationError &&
      error.message.startsWith("ADR reference file does not exist:")
    ) {
      return undefined;
    }
    throw error;
  }
};

const revisionMaterializationOptions = (
  config: CartographConfig,
  signal: AbortSignal | undefined,
) => ({
  resources: {
    maxArchiveBytes: config.resources.maxArchiveBytes,
    maxExtractedBytes: config.resources.maxSourceBytes,
    maxMemoryBytes: config.resources.maxMemoryBytes,
    maxWallClockMs: config.resources.maxWallClockMs,
  },
  ...(signal === undefined ? {} : { signal }),
});

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
  const graphDiff = diffGraphSnapshots(before, after, {
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
  });
  let adrReport: AdrReport | undefined;
  const adrPath = options.adr;
  if (adrPath !== undefined) {
    adrReport = await withMaterializedRevision(
      repositoryRoot,
      comparison.fromCommitSha,
      async (beforeRevision) =>
        await withMaterializedRevision(
          repositoryRoot,
          comparison.headCommitSha,
          (afterRevision) => {
            const previous = readAdrReferenceAtRoot(
              beforeRevision.root,
              adrPath,
            );
            const current = readAdrReferenceAtRoot(afterRevision.root, adrPath);
            return buildAdrReport(graphDiff, {
              ...(current === undefined ? {} : { current }),
              ...(previous === undefined ? {} : { previous }),
              currentSnapshot: after,
              previousSnapshot: before,
              root: afterRevision.root,
            });
          },
          revisionMaterializationOptions(config, options.signal),
        ),
      revisionMaterializationOptions(config, options.signal),
    );
  }
  return renderDiff(
    graphDiff,
    options.format,
    config.resources.maxReportItems,
    adrReport,
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

export type PolicyEvaluationFileOptions = {
  input: string;
  inputKind: PolicyInputKind;
  mode?: PolicyCiMode;
  asOf?: string;
  adr?: string;
  expiringWithinDays?: number;
  policy: string;
  root: string;
};

export async function evaluatePolicyFile(
  options: PolicyEvaluationFileOptions,
): Promise<PolicyEvaluation> {
  const root = realpathSync(resolve(options.root));
  const parsedPolicy = composePolicyConfig(root, options.policy).policy;
  const policy =
    options.mode === undefined
      ? parsedPolicy
      : parsePolicyConfig({ ...parsedPolicy, mode: options.mode });
  const adrContext =
    options.adr === undefined
      ? undefined
      : (() => {
          try {
            return {
              document: readAdrReferenceDocument(root, options.adr),
              root,
            };
          } catch (error) {
            return {
              root,
              loadError:
                error instanceof Error
                  ? error.message
                  : "could not load the local ADR reference document",
            };
          }
        })();
  const evaluationOptions = {
    ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
    ...(options.expiringWithinDays === undefined
      ? {}
      : { expiringWithinDays: options.expiringWithinDays }),
    ...(adrContext === undefined ? {} : { adr: adrContext }),
  };
  if (options.inputKind === "snapshot") {
    return evaluatePolicyOnSnapshot(
      policy,
      await loadSnapshot(options.input),
      evaluationOptions,
    );
  }
  return evaluatePolicyOnDiff(
    policy,
    await loadDiff(options.input),
    evaluationOptions,
  );
}

export type RuntimeReconciliationFileOptions = {
  snapshot: string;
  trace: string;
  bindings: string;
  maxInputBytes?: number;
  maxSpans?: number;
  maxTraces?: number;
  maxAnalysisMs?: number;
  maxReportBytes?: number;
  maxReportItems?: number;
};

type BoundedJsonInput = {
  readonly value: unknown;
  readonly bytes: number;
};

const readBoundedJsonInput = async (
  inputPath: string,
  maximumBytes: number,
  label: string,
): Promise<BoundedJsonInput> => {
  const resolvedInput = resolve(inputPath);
  const metadata = await stat(resolvedInput);
  if (!metadata.isFile())
    throw new Error(`${label} is not a regular file: ${inputPath}`);
  if (metadata.size > maximumBytes) {
    throw new ResourceLimitError(
      `${label} exceeds the ${maximumBytes} byte input limit`,
    );
  }
  const source = await readFile(resolvedInput, "utf8");
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > maximumBytes) {
    throw new ResourceLimitError(
      `${label} exceeds the ${maximumBytes} byte input limit`,
    );
  }
  try {
    return { value: JSON.parse(source) as unknown, bytes };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`could not parse ${label}: ${detail}`, { cause: error });
  }
};

const sha256 = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const runtimeReconciliationDiagnostics = (
  staticSnapshot: GraphSnapshot,
  budgetDiagnostics: readonly { code: string; message: string }[],
  reconciliation: ReturnType<typeof reconcileRuntimeTrace>,
) =>
  [
    ...budgetDiagnostics.map((diagnostic) => ({
      source: "runtime-budget" as const,
      code: diagnostic.code,
      message: diagnostic.message,
    })),
    ...staticSnapshot.diagnostics.map((diagnostic) => ({
      source: "input" as const,
      code: /^[A-Za-z0-9._:-]+$/u.test(diagnostic.code)
        ? diagnostic.code
        : "input:diagnostic",
      message: diagnostic.message,
    })),
    ...reconciliation.records
      .filter((record) => record.uncertainty !== "none")
      .map((record) => ({
        source: "reconciliation" as const,
        code: `uncertainty:${record.uncertainty}`,
        message: `${record.id}: ${record.reason}`,
      })),
  ].slice(0, 16);

const runtimeReconciliationUncertainty = (
  reconciliation: ReturnType<typeof reconcileRuntimeTrace>,
) => {
  const summary = { none: 0, unobserved: 0, unmapped: 0, ambiguous: 0 };
  for (const record of reconciliation.records) summary[record.uncertainty] += 1;
  return summary;
};

export async function reconcileRuntimeFiles(
  options: RuntimeReconciliationFileOptions,
): Promise<string> {
  const tracePolicy = RuntimeTraceBudgetPolicySchema.parse({
    ...DEFAULT_RUNTIME_TRACE_BUDGET_POLICY,
    ...(options.maxInputBytes === undefined
      ? {}
      : { maxInputBytes: options.maxInputBytes }),
    ...(options.maxSpans === undefined ? {} : { maxSpans: options.maxSpans }),
    ...(options.maxTraces === undefined
      ? {}
      : { maxTraces: options.maxTraces }),
    ...(options.maxAnalysisMs === undefined
      ? {}
      : { maxAnalysisMs: options.maxAnalysisMs }),
    ...(options.maxReportBytes === undefined
      ? {}
      : { maxReportBytes: options.maxReportBytes }),
    overflow: "fail-closed",
  });
  if (tracePolicy.maxInputBytes > MAX_RUNTIME_TRACE_INPUT_BYTES) {
    throw new ResourceLimitError(
      `runtime trace maxInputBytes must not exceed ${MAX_RUNTIME_TRACE_INPUT_BYTES} bytes`,
    );
  }
  const maxReportItems = options.maxReportItems ?? MAX_RUNTIME_REPORT_ITEMS;
  if (
    !Number.isInteger(maxReportItems) ||
    maxReportItems < 1 ||
    maxReportItems > MAX_RUNTIME_REPORT_ITEMS
  ) {
    throw new ResourceLimitError(
      `runtime reconciliation maxReportItems must be between 1 and ${MAX_RUNTIME_REPORT_ITEMS}`,
    );
  }

  const startedAt = performance.now();
  const staticInput = await readBoundedJsonInput(
    options.snapshot,
    MAX_SNAPSHOT_BYTES,
    "static snapshot",
  );
  const staticSnapshot = parseGraphSnapshot(staticInput.value);
  const bindingsInput = await readBoundedJsonInput(
    options.bindings,
    MAX_RUNTIME_BINDINGS_BYTES,
    "runtime bindings",
  );
  const parsedBindings = RuntimeSpanBindingSchema.array()
    .max(1_000_000)
    .safeParse(bindingsInput.value);
  if (!parsedBindings.success) {
    throw new Error(
      parsedBindings.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  }
  const traceInput = await readBoundedJsonInput(
    options.trace,
    tracePolicy.maxInputBytes,
    "runtime trace",
  );
  const runtimeText = JSON.stringify(traceInput.value);
  const budget = importRuntimeTraceWithBudget(runtimeText, tracePolicy, () =>
    performance.now(),
  );
  const retentionPolicy = RuntimeTraceSafetyPolicySchema.parse({
    ...DEFAULT_RUNTIME_TRACE_SAFETY_POLICY,
    redaction: tracePolicy.redaction,
    retention: {
      ...DEFAULT_RUNTIME_TRACE_SAFETY_POLICY.retention,
      mode: "discard-after-read",
      maxTraces: Math.min(tracePolicy.maxTraces, 10_000),
      maxBytes: tracePolicy.maxInputBytes,
    },
  });
  const retention = new RuntimeTraceRetentionStore(retentionPolicy, () =>
    performance.now(),
  );
  retention.put("runtime-input", budget.trace);
  const runtimeTrace = retention.get("runtime-input");
  if (!runtimeTrace) {
    throw new Error(
      "runtime trace was unavailable after bounded local retention",
    );
  }
  if (retention.size !== 0) {
    throw new Error("runtime trace retention did not discard the local trace");
  }

  const totalInputBytes =
    staticInput.bytes + traceInput.bytes + bindingsInput.bytes;
  if (totalInputBytes > MAX_RUNTIME_TOTAL_INPUT_BYTES) {
    throw new ResourceLimitError(
      `runtime reconciliation inputs exceed the ${MAX_RUNTIME_TOTAL_INPUT_BYTES} byte total limit`,
    );
  }
  assertReportItemLimit(
    staticSnapshot.nodes.length +
      staticSnapshot.edges.length +
      staticSnapshot.diagnostics.length +
      parsedBindings.data.length,
    maxReportItems,
  );
  const input = RuntimeReconciliationInputSchema.parse({
    staticSnapshot,
    runtimeTrace,
    bindings: parsedBindings.data,
  });
  const reconciliation = reconcileRuntimeTrace(input);
  assertReportItemLimit(reconciliation.records.length, maxReportItems);
  const processingMs = Math.max(0, Math.ceil(performance.now() - startedAt));
  if (processingMs > tracePolicy.maxAnalysisMs) {
    throw new ResourceLimitError(
      `runtime reconciliation exceeded the ${tracePolicy.maxAnalysisMs} ms processing limit`,
    );
  }

  const serializedRuntimeTrace = serializeRuntimeTrace(runtimeTrace);
  const baseObserved = {
    staticInputBytes: staticInput.bytes,
    runtimeInputBytes: traceInput.bytes,
    bindingsInputBytes: bindingsInput.bytes,
    totalInputBytes,
    processingMs,
    outputRecords: reconciliation.records.length,
    outputBytes: 0,
  };
  const createReport = (outputBytes: number) =>
    createRuntimeReconciliationReport({
      static: {
        source: "explicit-local-file",
        artifact: "GraphSnapshot",
        schemaVersion: staticSnapshot.schemaVersion,
        digest: sha256(stableStringify(staticSnapshot)),
        revision: staticSnapshot.revision,
        nodes: staticSnapshot.nodes.length,
        edges: staticSnapshot.edges.length,
        diagnostics: staticSnapshot.diagnostics.length,
      },
      runtime: {
        source: "explicit-local-file",
        artifact: "cartograph.runtime-traces",
        schemaVersion: runtimeTrace.schemaVersion,
        format: runtimeTrace.format,
        digest: sha256(serializedRuntimeTrace),
        coverage: budget.coverage,
        redacted: true,
      },
      bindings: {
        source: "explicit-local-file",
        artifact: "RuntimeSpanBinding[]",
        count: parsedBindings.data.length,
        digest: sha256(stableStringify(parsedBindings.data)),
      },
      reconciliation,
      uncertainty: runtimeReconciliationUncertainty(reconciliation),
      diagnostics: runtimeReconciliationDiagnostics(
        staticSnapshot,
        budget.diagnostics,
        reconciliation,
      ),
      limits: {
        tracePolicy,
        maxReportItems,
        observed: { ...baseObserved, outputBytes },
        bounded: true,
      },
      retention: {
        mode: "discard-after-read",
        persisted: false,
        retainedTracesAfterRead: 0,
        maxTraces: retentionPolicy.retention.maxTraces,
        maxBytes: retentionPolicy.retention.maxBytes,
      },
    });
  let report = createReport(0);
  let serialized = `${serializeRuntimeReconciliationReport(report)}\n`;
  let sizeConverged = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outputBytes = Buffer.byteLength(serialized, "utf8");
    if (outputBytes > tracePolicy.maxReportBytes) {
      throw new ResourceLimitError(
        `runtime reconciliation report exceeds the ${tracePolicy.maxReportBytes} byte output limit`,
      );
    }
    report = createReport(outputBytes);
    serialized = `${serializeRuntimeReconciliationReport(report)}\n`;
    if (Buffer.byteLength(serialized, "utf8") === outputBytes) {
      sizeConverged = true;
      break;
    }
  }
  if (!sizeConverged) {
    throw new Error(
      "runtime reconciliation report size did not stabilize deterministically",
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > tracePolicy.maxReportBytes) {
    throw new ResourceLimitError(
      `runtime reconciliation report exceeds the ${tracePolicy.maxReportBytes} byte output limit`,
    );
  }
  return serialized;
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
