import { lstatSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { z, type ZodIssue } from "zod";

import { stableStringify } from "./canonical.js";
import { WorkspaceLocalPathSchema } from "./workspace-composition.js";

export const WORKSPACE_PRIVACY_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_PRIVACY_CONTRACT =
  "cartograph.workspace-privacy" as const;
export const WORKSPACE_PRIVACY_MAX_REPOSITORIES = 64 as const;
export const WORKSPACE_PRIVACY_MAX_NODES = 200_000 as const;
export const WORKSPACE_PRIVACY_MAX_EDGES = 400_000 as const;
export const WORKSPACE_PRIVACY_MAX_BYTES = 1024 * 1024 * 1024;
export const WORKSPACE_PRIVACY_MAX_COMPRESSED_BYTES = 256 * 1024 * 1024;
export const WORKSPACE_PRIVACY_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
export const WORKSPACE_PRIVACY_MAX_DEPTH = 256 as const;
export const WORKSPACE_PRIVACY_MAX_WALL_CLOCK_MS = 300_000 as const;
export const WORKSPACE_PRIVACY_MAX_MEMORY_BYTES = 1024 * 1024 * 1024;
export const WORKSPACE_PRIVACY_MAX_CACHE_BYTES = 256 * 1024 * 1024;
export const WORKSPACE_PRIVACY_MAX_CACHE_ENTRIES = 4_096 as const;
export const WORKSPACE_PRIVACY_MAX_REPORT_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_PRIVACY_MAX_REPORT_ITEMS = 100_000 as const;
export const WORKSPACE_PRIVACY_MAX_PATHS = 8_192 as const;
export const WORKSPACE_PRIVACY_MAX_PATH_LENGTH = 1_024 as const;
export const WORKSPACE_PRIVACY_MAX_METADATA_FIELDS = 128 as const;
export const WORKSPACE_PRIVACY_MAX_METADATA_VALUE_LENGTH = 4_096 as const;
export const WORKSPACE_PRIVACY_MAX_RUNTIME_METADATA_RECORDS = 1_024 as const;
export const WORKSPACE_PRIVACY_MAX_RUNTIME_METADATA_BYTES = 64 * 1024;
export const WORKSPACE_PRIVACY_MAX_TEMPORARY_ENTRIES = 4_096 as const;
export const WORKSPACE_PRIVACY_MAX_EXPANSION_RATIO = 10_000 as const;

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u,
    "must be a portable lower-case identifier",
  )
  .transform((value) => value.normalize("NFC"));

const MetadataKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u, "must be a portable metadata key")
  .transform((value) => value.normalize("NFC"));

const MetadataValueSchema = z
  .string()
  .trim()
  .max(WORKSPACE_PRIVACY_MAX_METADATA_VALUE_LENGTH)
  .transform((value) => value.normalize("NFC"))
  .refine(
    (value) => !/[\0\r\n]/u.test(value),
    "must not contain control characters",
  );

const DigestSchema = z
  .string()
  .trim()
  .regex(/^sha256:[0-9a-f]{64}$/iu, "must be a SHA-256 digest");

const TrustSchema = z.enum(["trusted", "untrusted"]);
const RepositoryStatusSchema = z.enum(["available", "omitted", "failed"]);
const PathExposureModeSchema = z.enum(["none", "relative", "digest"]);

export const WorkspacePrivacyLimitsSchema = z
  .object({
    maxRepositories: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_REPOSITORIES)
      .default(WORKSPACE_PRIVACY_MAX_REPOSITORIES),
    maxNodes: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_NODES)
      .default(WORKSPACE_PRIVACY_MAX_NODES),
    maxEdges: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_EDGES)
      .default(WORKSPACE_PRIVACY_MAX_EDGES),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_BYTES)
      .default(WORKSPACE_PRIVACY_MAX_BYTES),
    maxCompressedBytes: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_COMPRESSED_BYTES)
      .default(WORKSPACE_PRIVACY_MAX_COMPRESSED_BYTES),
    maxExpandedBytes: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_EXPANDED_BYTES)
      .default(WORKSPACE_PRIVACY_MAX_EXPANDED_BYTES),
    maxDepth: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_DEPTH)
      .default(WORKSPACE_PRIVACY_MAX_DEPTH),
    maxWallClockMs: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_WALL_CLOCK_MS)
      .default(30_000),
    maxMemoryBytes: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_MEMORY_BYTES)
      .default(WORKSPACE_PRIVACY_MAX_MEMORY_BYTES),
    maxCacheBytes: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_CACHE_BYTES)
      .default(WORKSPACE_PRIVACY_MAX_CACHE_BYTES),
    maxCacheEntries: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_CACHE_ENTRIES)
      .default(WORKSPACE_PRIVACY_MAX_CACHE_ENTRIES),
    maxReportBytes: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_REPORT_BYTES)
      .default(4 * 1024 * 1024),
    maxReportItems: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_REPORT_ITEMS)
      .default(WORKSPACE_PRIVACY_MAX_REPORT_ITEMS),
    maxPathCount: z
      .number()
      .int()
      .nonnegative()
      .max(WORKSPACE_PRIVACY_MAX_PATHS)
      .default(0),
    maxPathLength: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_PATH_LENGTH)
      .default(WORKSPACE_PRIVACY_MAX_PATH_LENGTH),
    maxRuntimeMetadataRecords: z
      .number()
      .int()
      .nonnegative()
      .max(WORKSPACE_PRIVACY_MAX_RUNTIME_METADATA_RECORDS)
      .default(0),
    maxRuntimeMetadataBytes: z
      .number()
      .int()
      .nonnegative()
      .max(WORKSPACE_PRIVACY_MAX_RUNTIME_METADATA_BYTES)
      .default(0),
    maxTemporaryEntries: z
      .number()
      .int()
      .nonnegative()
      .max(WORKSPACE_PRIVACY_MAX_TEMPORARY_ENTRIES)
      .default(0),
    maxExpansionRatio: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_EXPANSION_RATIO)
      .default(1_000),
  })
  .strict();

export const WorkspacePrivacyPathExposureSchema = z
  .object({
    mode: PathExposureModeSchema.default("none"),
    maxPaths: z
      .number()
      .int()
      .nonnegative()
      .max(WORKSPACE_PRIVACY_MAX_PATHS)
      .default(0),
    maxPathLength: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_PRIVACY_MAX_PATH_LENGTH)
      .default(WORKSPACE_PRIVACY_MAX_PATH_LENGTH),
  })
  .strict()
  .default({
    mode: "none",
    maxPaths: 0,
    maxPathLength: WORKSPACE_PRIVACY_MAX_PATH_LENGTH,
  });

const RuntimeMetadataKeySchema = z.enum([
  "durationMs",
  "memoryBytes",
  "platform",
  "toolVersion",
  "cacheHitRatio",
]);

export const WorkspacePrivacyRuntimeMetadataRecordSchema = z
  .object({
    key: RuntimeMetadataKeySchema,
    value: z
      .string()
      .trim()
      .max(256)
      .transform((value) => value.normalize("NFC"))
      .refine(
        (value) => !/[\0\r\n]/u.test(value),
        "must not contain control characters",
      ),
  })
  .strict();

export const WorkspacePrivacyRuntimeMetadataSchema = z
  .object({
    enabled: z.boolean().default(false),
    records: z
      .array(WorkspacePrivacyRuntimeMetadataRecordSchema)
      .max(WORKSPACE_PRIVACY_MAX_RUNTIME_METADATA_RECORDS)
      .default([]),
  })
  .strict()
  .default({ enabled: false, records: [] });

export const WorkspacePrivacySnapshotSummarySchema = z
  .object({
    nodes: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    compressedBytes: z.number().int().nonnegative().default(0),
    expandedBytes: z.number().int().nonnegative().default(0),
    maxDepth: z.number().int().nonnegative().default(0),
  })
  .strict();

export const WorkspacePrivacyRepositorySchema = z
  .object({
    id: IdentifierSchema,
    trust: TrustSchema.default("untrusted"),
    status: RepositoryStatusSchema.default("available"),
    snapshot: WorkspacePrivacySnapshotSummarySchema.optional(),
    metadata: z
      .record(MetadataKeySchema, MetadataValueSchema)
      .refine(
        (value) =>
          Object.keys(value).length <= WORKSPACE_PRIVACY_MAX_METADATA_FIELDS,
        `metadata cannot contain more than ${WORKSPACE_PRIVACY_MAX_METADATA_FIELDS} fields`,
      )
      .default({}),
    paths: z
      .array(WorkspaceLocalPathSchema)
      .max(WORKSPACE_PRIVACY_MAX_PATHS)
      .default([]),
    pathDigests: z
      .array(DigestSchema)
      .max(WORKSPACE_PRIVACY_MAX_PATHS)
      .default([]),
    failureCode: z
      .enum(["unavailable", "invalid-manifest", "resource-limit", "cancelled"])
      .optional(),
  })
  .strict()
  .superRefine((repository, context) => {
    if (repository.status === "available" && !repository.snapshot) {
      context.addIssue({
        code: "custom",
        path: ["snapshot"],
        message: "available repositories require a snapshot summary",
      });
    }
    if (repository.status !== "available" && repository.snapshot) {
      context.addIssue({
        code: "custom",
        path: ["snapshot"],
        message: "omitted or failed repositories cannot contribute a snapshot",
      });
    }
    if (repository.status === "failed" && !repository.failureCode) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "failed repositories require a stable failure code",
      });
    }
    if (repository.status !== "failed" && repository.failureCode) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "only failed repositories may carry a failure code",
      });
    }
  });

export const WorkspacePrivacyCacheSummarySchema = z
  .object({
    entries: z.number().int().nonnegative().default(0),
    bytes: z.number().int().nonnegative().default(0),
    temporaryEntries: z.number().int().nonnegative().default(0),
  })
  .strict()
  .default({ entries: 0, bytes: 0, temporaryEntries: 0 });

export const WorkspacePrivacyReportSummarySchema = z
  .object({
    bytes: z.number().int().nonnegative().default(0),
    items: z.number().int().nonnegative().default(0),
  })
  .strict()
  .default({ bytes: 0, items: 0 });

export const WorkspacePrivacyObservedBudgetSchema = z
  .object({
    wallClockMs: z.number().int().nonnegative().default(0),
    memoryBytes: z.number().int().nonnegative().default(0),
  })
  .strict()
  .default({ wallClockMs: 0, memoryBytes: 0 });

export const WorkspacePrivacyRequestSchema = z
  .object({
    $schema: z.string().trim().max(512).optional(),
    schemaVersion: z.literal(WORKSPACE_PRIVACY_SCHEMA_VERSION),
    contract: z.literal(WORKSPACE_PRIVACY_CONTRACT),
    workspaceId: IdentifierSchema,
    repositories: z
      .array(WorkspacePrivacyRepositorySchema)
      .min(1)
      .max(WORKSPACE_PRIVACY_MAX_REPOSITORIES),
    limits: WorkspacePrivacyLimitsSchema,
    pathExposure: WorkspacePrivacyPathExposureSchema,
    runtimeMetadata: WorkspacePrivacyRuntimeMetadataSchema,
    cache: WorkspacePrivacyCacheSummarySchema,
    report: WorkspacePrivacyReportSummarySchema,
    observed: WorkspacePrivacyObservedBudgetSchema,
    allowMixedTrust: z.boolean().default(false),
    allowPartial: z.boolean().default(false),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.repositories.length > request.limits.maxRepositories) {
      context.addIssue({
        code: "custom",
        path: ["repositories"],
        message: "repository count exceeds the declared privacy ceiling",
      });
    }
    const identities = new Set<string>();
    for (const [index, repository] of request.repositories.entries()) {
      if (identities.has(repository.id)) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "id"],
          message: "duplicate repository identity",
        });
      }
      identities.add(repository.id);
    }
  });

export const WorkspacePrivacyDiagnosticCodeSchema = z.enum([
  "repository-limit",
  "node-limit",
  "edge-limit",
  "byte-limit",
  "compressed-byte-limit",
  "expanded-byte-limit",
  "decompression-limit",
  "depth-limit",
  "time-limit",
  "memory-limit",
  "cache-limit",
  "report-limit",
  "path-exposure",
  "secret-metadata",
  "runtime-metadata",
  "mixed-trust",
  "partial-failure",
  "temporary-data",
  "invalid-path",
  "invalid-manifest",
]);

export const WorkspacePrivacyDiagnosticSchema = z
  .object({
    code: WorkspacePrivacyDiagnosticCodeSchema,
    scope: IdentifierSchema.optional(),
    message: z.string().trim().min(1).max(512),
  })
  .strict();

export const WorkspacePrivacyTotalsSchema = z
  .object({
    repositories: z.number().int().nonnegative(),
    nodes: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    compressedBytes: z.number().int().nonnegative(),
    expandedBytes: z.number().int().nonnegative(),
    maxDepth: z.number().int().nonnegative(),
    cacheEntries: z.number().int().nonnegative(),
    cacheBytes: z.number().int().nonnegative(),
    temporaryEntries: z.number().int().nonnegative(),
    reportBytes: z.number().int().nonnegative(),
    reportItems: z.number().int().nonnegative(),
    pathCount: z.number().int().nonnegative(),
    runtimeMetadataRecords: z.number().int().nonnegative(),
    runtimeMetadataBytes: z.number().int().nonnegative(),
  })
  .strict();

export const WorkspacePrivacyAssessmentSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_PRIVACY_SCHEMA_VERSION),
    contract: z.literal(WORKSPACE_PRIVACY_CONTRACT),
    workspaceId: IdentifierSchema,
    status: z.enum(["accepted", "partial"]),
    trustMode: z.enum(["homogeneous", "isolated-mixed"]),
    limits: WorkspacePrivacyLimitsSchema,
    pathExposure: WorkspacePrivacyPathExposureSchema,
    runtimeMetadata: z
      .object({
        enabled: z.boolean(),
        redacted: z.literal(true),
        records: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
      })
      .strict(),
    repositories: z
      .array(
        z
          .object({
            id: IdentifierSchema,
            trust: TrustSchema,
            status: RepositoryStatusSchema,
          })
          .strict(),
      )
      .min(1)
      .max(WORKSPACE_PRIVACY_MAX_REPOSITORIES),
    totals: WorkspacePrivacyTotalsSchema,
    diagnostics: z.array(WorkspacePrivacyDiagnosticSchema).max(64),
  })
  .strict();

export type WorkspacePrivacyLimits = z.infer<
  typeof WorkspacePrivacyLimitsSchema
>;
export type WorkspacePrivacyPathExposure = z.infer<
  typeof WorkspacePrivacyPathExposureSchema
>;
export type WorkspacePrivacyRuntimeMetadataRecord = z.infer<
  typeof WorkspacePrivacyRuntimeMetadataRecordSchema
>;
export type WorkspacePrivacyRuntimeMetadata = z.infer<
  typeof WorkspacePrivacyRuntimeMetadataSchema
>;
export type WorkspacePrivacySnapshotSummary = z.infer<
  typeof WorkspacePrivacySnapshotSummarySchema
>;
export type WorkspacePrivacyRepository = z.infer<
  typeof WorkspacePrivacyRepositorySchema
>;
export type WorkspacePrivacyCacheSummary = z.infer<
  typeof WorkspacePrivacyCacheSummarySchema
>;
export type WorkspacePrivacyReportSummary = z.infer<
  typeof WorkspacePrivacyReportSummarySchema
>;
export type WorkspacePrivacyObservedBudget = z.infer<
  typeof WorkspacePrivacyObservedBudgetSchema
>;
export type WorkspacePrivacyRequest = z.infer<
  typeof WorkspacePrivacyRequestSchema
>;
export type WorkspacePrivacyDiagnosticCode = z.infer<
  typeof WorkspacePrivacyDiagnosticCodeSchema
>;
export type WorkspacePrivacyDiagnostic = z.infer<
  typeof WorkspacePrivacyDiagnosticSchema
>;
export type WorkspacePrivacyTotals = z.infer<
  typeof WorkspacePrivacyTotalsSchema
>;
export type WorkspacePrivacyAssessment = z.infer<
  typeof WorkspacePrivacyAssessmentSchema
>;

export const DEFAULT_WORKSPACE_PRIVACY_LIMITS =
  WorkspacePrivacyLimitsSchema.parse({});

export type WorkspacePrivacyErrorCode =
  | "invalid-input"
  | "privacy-violation"
  | "resource-limit"
  | "partial-failure"
  | "cancelled";

export class WorkspacePrivacyValidationError extends Error {
  readonly code: WorkspacePrivacyErrorCode;
  readonly diagnostic: WorkspacePrivacyDiagnosticCode | undefined;
  readonly issues: readonly ZodIssue[];

  constructor(
    code: WorkspacePrivacyErrorCode,
    message: string,
    diagnostic?: WorkspacePrivacyDiagnosticCode,
    issues: readonly ZodIssue[] = [],
  ) {
    super(message);
    this.name = "WorkspacePrivacyValidationError";
    this.code = code;
    this.diagnostic = diagnostic;
    this.issues = issues;
  }
}

const issueText = (issues: readonly ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

const secretPattern =
  /(?:-----BEGIN [^-]+ PRIVATE KEY-----|(?:ghp|gho|ghu|ghs|github_pat|glpat|xox[baprs]-|sk-[A-Za-z0-9])[A-Za-z0-9_-]{8,}|(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|private[_-]?key|secret|token)\s*[:=]|https?:\/\/[^\s/@]+:[^\s/@]+@)/iu;
const secretKeyPattern =
  /(?:api[_-]?key|access[_-]?token|authorization|password|private[_-]?key|secret|token)/iu;

const pathPattern =
  /(?:^|[\\/])(?:\.\.?|Users|home|private|var|tmp)(?:[\\/]|$)/iu;

const metadataContainsSecret = (metadata: Record<string, string>): boolean =>
  Object.entries(metadata).some(
    ([key, value]) => secretKeyPattern.test(key) || secretPattern.test(value),
  );

const runtimeMetadataBytes = (
  runtimeMetadata: WorkspacePrivacyRuntimeMetadata,
): number =>
  Buffer.byteLength(
    stableStringify(
      runtimeMetadata.records.map(({ key, value }) => ({ key, value })),
    ),
    "utf8",
  );

const fail = (
  code: WorkspacePrivacyErrorCode,
  diagnostic: WorkspacePrivacyDiagnosticCode,
  message: string,
): never => {
  throw new WorkspacePrivacyValidationError(code, message, diagnostic);
};

const canonicalizeRequest = (
  request: WorkspacePrivacyRequest,
): WorkspacePrivacyRequest => ({
  ...request,
  repositories: [...request.repositories]
    .map((repository) => ({
      ...repository,
      metadata: Object.fromEntries(
        Object.entries(repository.metadata).sort(([left], [right]) =>
          compareStrings(left, right),
        ),
      ),
      paths: [...repository.paths].sort(compareStrings),
      pathDigests: [...repository.pathDigests].sort(compareStrings),
    }))
    .sort((left, right) => compareStrings(left.id, right.id)),
  runtimeMetadata: {
    ...request.runtimeMetadata,
    records: [...request.runtimeMetadata.records].sort((left, right) =>
      compareStrings(left.key, right.key),
    ),
  },
});

const totalsFor = (
  request: WorkspacePrivacyRequest,
): WorkspacePrivacyTotals => {
  const snapshotTotals = request.repositories.reduce(
    (totals, repository) => {
      if (!repository.snapshot) return totals;
      return {
        ...totals,
        nodes: totals.nodes + repository.snapshot.nodes,
        edges: totals.edges + repository.snapshot.edges,
        bytes: totals.bytes + repository.snapshot.bytes,
        compressedBytes:
          totals.compressedBytes + repository.snapshot.compressedBytes,
        expandedBytes: totals.expandedBytes + repository.snapshot.expandedBytes,
        maxDepth: Math.max(totals.maxDepth, repository.snapshot.maxDepth),
      };
    },
    {
      repositories: request.repositories.length,
      nodes: 0,
      edges: 0,
      bytes: 0,
      compressedBytes: 0,
      expandedBytes: 0,
      maxDepth: 0,
      cacheEntries: request.cache.entries,
      cacheBytes: request.cache.bytes,
      temporaryEntries: request.cache.temporaryEntries,
      reportBytes: request.report.bytes,
      reportItems: request.report.items,
      pathCount: request.repositories.reduce(
        (total, repository) =>
          total + repository.paths.length + repository.pathDigests.length,
        0,
      ),
      runtimeMetadataRecords: request.runtimeMetadata.records.length,
      runtimeMetadataBytes: runtimeMetadataBytes(request.runtimeMetadata),
    } satisfies WorkspacePrivacyTotals,
  );
  return snapshotTotals;
};

const validatePrivacy = (
  request: WorkspacePrivacyRequest,
): WorkspacePrivacyTotals => {
  const limits = request.limits;
  const totals = totalsFor(request);
  if (totals.repositories > limits.maxRepositories)
    fail(
      "resource-limit",
      "repository-limit",
      "workspace repository limit exceeded",
    );
  if (totals.nodes > limits.maxNodes)
    fail("resource-limit", "node-limit", "workspace node limit exceeded");
  if (totals.edges > limits.maxEdges)
    fail("resource-limit", "edge-limit", "workspace edge limit exceeded");
  if (totals.bytes > limits.maxBytes)
    fail("resource-limit", "byte-limit", "workspace byte limit exceeded");
  if (totals.compressedBytes > limits.maxCompressedBytes)
    fail(
      "resource-limit",
      "compressed-byte-limit",
      "compressed workspace byte limit exceeded",
    );
  if (totals.expandedBytes > limits.maxExpandedBytes)
    fail(
      "resource-limit",
      "expanded-byte-limit",
      "expanded workspace byte limit exceeded",
    );
  if (
    totals.compressedBytes > 0 &&
    totals.expandedBytes > totals.compressedBytes * limits.maxExpansionRatio
  ) {
    fail(
      "resource-limit",
      "decompression-limit",
      "workspace expansion ratio exceeded",
    );
  }
  if (totals.maxDepth > limits.maxDepth)
    fail(
      "resource-limit",
      "depth-limit",
      "workspace graph depth limit exceeded",
    );
  if (request.observed.wallClockMs > limits.maxWallClockMs)
    fail("resource-limit", "time-limit", "workspace wall-clock limit exceeded");
  if (request.observed.memoryBytes > limits.maxMemoryBytes)
    fail("resource-limit", "memory-limit", "workspace memory limit exceeded");
  if (
    totals.cacheBytes > limits.maxCacheBytes ||
    totals.cacheEntries > limits.maxCacheEntries
  )
    fail("resource-limit", "cache-limit", "workspace cache limit exceeded");
  if (
    totals.reportBytes > limits.maxReportBytes ||
    totals.reportItems > limits.maxReportItems
  )
    fail("resource-limit", "report-limit", "workspace report limit exceeded");
  if (totals.temporaryEntries > limits.maxTemporaryEntries)
    fail(
      "resource-limit",
      "temporary-data",
      "workspace temporary-data limit exceeded",
    );

  const pathCount = totals.pathCount;
  if (pathCount > limits.maxPathCount)
    fail(
      "privacy-violation",
      "path-exposure",
      "workspace path exposure limit exceeded",
    );
  const rawPathCount = request.repositories.reduce(
    (total, repository) => total + repository.paths.length,
    0,
  );
  if (request.pathExposure.mode === "none" && rawPathCount > 0)
    fail(
      "privacy-violation",
      "path-exposure",
      "raw workspace paths are disabled",
    );
  if (request.pathExposure.mode === "digest" && rawPathCount > 0)
    fail(
      "privacy-violation",
      "path-exposure",
      "digest-only path mode cannot carry raw paths",
    );
  if (
    request.pathExposure.mode === "relative" &&
    request.pathExposure.maxPaths < pathCount
  )
    fail(
      "privacy-violation",
      "path-exposure",
      "workspace path exposure exceeds its declared limit",
    );
  for (const repository of request.repositories) {
    if (metadataContainsSecret(repository.metadata))
      fail(
        "privacy-violation",
        "secret-metadata",
        "secret-shaped workspace metadata is not retained",
      );
    if (
      repository.paths.some(
        (path) =>
          path.length >
            Math.min(
              limits.maxPathLength,
              request.pathExposure.maxPathLength,
            ) || pathPattern.test(path),
      )
    ) {
      fail(
        "privacy-violation",
        "path-exposure",
        "workspace path metadata is not portable or safe",
      );
    }
  }
  if (
    !request.runtimeMetadata.enabled &&
    request.runtimeMetadata.records.length > 0
  )
    fail(
      "privacy-violation",
      "runtime-metadata",
      "runtime metadata is disabled by default",
    );
  if (
    totals.runtimeMetadataRecords > limits.maxRuntimeMetadataRecords ||
    totals.runtimeMetadataBytes > limits.maxRuntimeMetadataBytes
  )
    fail(
      "privacy-violation",
      "runtime-metadata",
      "runtime metadata exceeds its explicit retention limit",
    );
  if (
    request.runtimeMetadata.records.some(
      ({ key, value }) =>
        secretPattern.test(key) ||
        secretPattern.test(value) ||
        pathPattern.test(value),
    )
  ) {
    fail(
      "privacy-violation",
      "runtime-metadata",
      "runtime metadata contains a sensitive value",
    );
  }
  const trustValues = new Set(request.repositories.map((repo) => repo.trust));
  if (trustValues.size > 1 && !request.allowMixedTrust)
    fail(
      "privacy-violation",
      "mixed-trust",
      "mixed-trust workspace input requires explicit isolation",
    );
  const failed = request.repositories.filter(
    (repo) => repo.status === "failed",
  );
  if (failed.length > 0 && !request.allowPartial)
    fail(
      "partial-failure",
      "partial-failure",
      "workspace failure cannot be reported as a complete result",
    );
  return totals;
};

export const parseWorkspacePrivacyRequest = (
  value: unknown,
): WorkspacePrivacyRequest => {
  const parsed = WorkspacePrivacyRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkspacePrivacyValidationError(
      "invalid-input",
      `workspace privacy request validation failed: ${issueText(parsed.error.issues)}`,
      "invalid-manifest",
      parsed.error.issues,
    );
  }
  const request = canonicalizeRequest(parsed.data);
  validatePrivacy(request);
  return request;
};

export const validateWorkspacePrivacyRequest = parseWorkspacePrivacyRequest;

export const assessWorkspacePrivacy = (
  value: unknown,
): WorkspacePrivacyAssessment => {
  const request = parseWorkspacePrivacyRequest(value);
  const totals = totalsFor(request);
  const failed = request.repositories.filter(
    (repo) => repo.status === "failed",
  );
  const trustMode =
    new Set(request.repositories.map((repo) => repo.trust)).size > 1
      ? "isolated-mixed"
      : "homogeneous";
  const diagnostics: WorkspacePrivacyDiagnostic[] = failed.map(
    (repository) => ({
      code: "partial-failure",
      scope: repository.id,
      message: "repository was excluded after a bounded, explicit failure",
    }),
  );
  return WorkspacePrivacyAssessmentSchema.parse({
    schemaVersion: WORKSPACE_PRIVACY_SCHEMA_VERSION,
    contract: WORKSPACE_PRIVACY_CONTRACT,
    workspaceId: request.workspaceId,
    status: failed.length > 0 ? "partial" : "accepted",
    trustMode,
    limits: request.limits,
    pathExposure: request.pathExposure,
    runtimeMetadata: {
      enabled: request.runtimeMetadata.enabled,
      redacted: true,
      records: totals.runtimeMetadataRecords,
      bytes: totals.runtimeMetadataBytes,
    },
    repositories: request.repositories.map(({ id, trust, status }) => ({
      id,
      trust,
      status,
    })),
    totals,
    diagnostics,
  });
};

export const enforceWorkspacePrivacy = assessWorkspacePrivacy;

export const parseWorkspacePrivacyAssessment = (
  value: unknown,
): WorkspacePrivacyAssessment => {
  const parsed = WorkspacePrivacyAssessmentSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkspacePrivacyValidationError(
      "invalid-input",
      `workspace privacy assessment validation failed: ${issueText(parsed.error.issues)}`,
      "invalid-manifest",
      parsed.error.issues,
    );
  }
  return parsed.data;
};

export const serializeWorkspacePrivacyRequest = (value: unknown): string =>
  stableStringify(parseWorkspacePrivacyRequest(value));

export const serializeWorkspacePrivacyAssessment = (value: unknown): string =>
  stableStringify(parseWorkspacePrivacyAssessment(value));

export const assertWorkspacePrivacyPath = (
  repositoryRoot: string,
  candidate: string,
): string => {
  const parsed = WorkspaceLocalPathSchema.safeParse(candidate);
  if (!parsed.success)
    fail(
      "privacy-violation",
      "invalid-path",
      "workspace path is not a safe relative path",
    );
  const localPath = parsed.success ? parsed.data : "";
  let root = "";
  try {
    root = realpathSync(repositoryRoot);
  } catch {
    fail("privacy-violation", "invalid-path", "workspace root is unavailable");
  }
  const resolved = resolve(root, localPath);
  const relativePath = relative(root, resolved);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  ) {
    fail(
      "privacy-violation",
      "invalid-path",
      "workspace path escapes its repository root",
    );
  }
  let current = root;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        fail(
          "privacy-violation",
          "invalid-path",
          "workspace path crosses a symbolic link",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
  return resolved;
};

export const validateWorkspacePrivacyPath = assertWorkspacePrivacyPath;

export type WorkspacePrivacyBudgetOptions = {
  signal?: AbortSignal;
  clock?: () => number;
  memoryBytes?: () => number;
  subject?: string;
};

export type WorkspacePrivacyBudget = {
  readonly startedAt: number;
  readonly check: () => void;
};

export const createWorkspacePrivacyBudget = (
  limits: WorkspacePrivacyLimits = DEFAULT_WORKSPACE_PRIVACY_LIMITS,
  options: WorkspacePrivacyBudgetOptions = {},
): WorkspacePrivacyBudget => {
  const clock = options.clock ?? Date.now;
  const memoryBytes = options.memoryBytes ?? (() => process.memoryUsage().rss);
  const startedAt = clock();
  const subject = options.subject ?? "workspace privacy boundary";
  const check = (): void => {
    if (options.signal?.aborted)
      throw new WorkspacePrivacyValidationError(
        "cancelled",
        `${subject} was cancelled`,
        "time-limit",
      );
    if (clock() - startedAt > limits.maxWallClockMs)
      throw new WorkspacePrivacyValidationError(
        "resource-limit",
        `${subject} exceeded its wall-clock ceiling`,
        "time-limit",
      );
    if (memoryBytes() > limits.maxMemoryBytes)
      throw new WorkspacePrivacyValidationError(
        "resource-limit",
        `${subject} exceeded its memory ceiling`,
        "memory-limit",
      );
  };
  return { startedAt, check };
};

export const withWorkspacePrivacyTemporaryDirectory = async <T>(
  callback: (directory: string) => T | Promise<T>,
  prefix = "cartograph-workspace-privacy-",
): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export const withWorkspacePrivacyTempDirectory =
  withWorkspacePrivacyTemporaryDirectory;

export const createWorkspacePrivacyTemporaryDirectory = async (
  prefix = "cartograph-workspace-privacy-",
): Promise<string> => mkdtemp(join(tmpdir(), prefix));

export const cleanupWorkspacePrivacyTemporaryDirectory = async (
  directory: string,
): Promise<void> => {
  await rm(directory, { recursive: true, force: true });
};
