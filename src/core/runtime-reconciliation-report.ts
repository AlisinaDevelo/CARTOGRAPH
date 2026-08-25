import { z } from "zod";

import { stableStringify } from "./canonical.js";
import { RevisionSchema } from "./schemas.js";
import {
  RuntimeReconciliationSchema,
  type RuntimeReconciliation,
} from "./runtime-reconciliation.js";
import {
  RuntimeTraceBudgetCoverageSchema,
  RuntimeTraceBudgetPolicySchema,
  type RuntimeTraceBudgetCoverage,
  type RuntimeTraceBudgetPolicy,
} from "./runtime-trace-budgets.js";

export const RUNTIME_RECONCILIATION_REPORT_SCHEMA_VERSION = 1 as const;
export const RUNTIME_RECONCILIATION_REPORT_CONTRACT =
  "cartograph.runtime-reconciliation-report" as const;
export const RUNTIME_RECONCILIATION_REPORT_MEDIA_TYPE =
  "application/vnd.cartograph.runtime-reconciliation-report+json" as const;

const DigestSchema = z
  .string()
  .trim()
  .regex(/^sha256:[0-9a-f]{64}$/u, "must be a SHA-256 digest");

const LocalArtifactSchema = z.literal("explicit-local-file");

export const RuntimeReconciliationStaticProvenanceSchema = z
  .object({
    source: LocalArtifactSchema,
    artifact: z.literal("GraphSnapshot"),
    schemaVersion: z.literal(1),
    digest: DigestSchema,
    revision: RevisionSchema,
    nodes: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    diagnostics: z.number().int().nonnegative(),
  })
  .strict();

export const RuntimeReconciliationRuntimeProvenanceSchema = z
  .object({
    source: LocalArtifactSchema,
    artifact: z.literal("cartograph.runtime-traces"),
    schemaVersion: z.literal(1),
    format: z.literal("otlp-json"),
    digest: DigestSchema,
    coverage: RuntimeTraceBudgetCoverageSchema,
    redacted: z.literal(true),
  })
  .strict();

export const RuntimeReconciliationBindingProvenanceSchema = z
  .object({
    source: LocalArtifactSchema,
    artifact: z.literal("RuntimeSpanBinding[]"),
    count: z.number().int().nonnegative(),
    digest: DigestSchema,
  })
  .strict();

export const RuntimeReconciliationDiagnosticSchema = z
  .object({
    source: z.enum(["runtime-budget", "reconciliation", "input"]),
    code: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/u),
    message: z.string().trim().min(1).max(2_048),
  })
  .strict();

export const RuntimeReconciliationUncertaintySummarySchema = z
  .object({
    none: z.number().int().nonnegative(),
    unobserved: z.number().int().nonnegative(),
    unmapped: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
  })
  .strict();

export const RuntimeReconciliationReportLimitsSchema = z
  .object({
    tracePolicy: RuntimeTraceBudgetPolicySchema,
    maxReportItems: z.number().int().positive().max(200_000),
    observed: z
      .object({
        staticInputBytes: z.number().int().nonnegative(),
        runtimeInputBytes: z.number().int().nonnegative(),
        bindingsInputBytes: z.number().int().nonnegative(),
        totalInputBytes: z.number().int().nonnegative(),
        processingMs: z.number().int().nonnegative(),
        outputRecords: z.number().int().nonnegative(),
        outputBytes: z.number().int().nonnegative(),
      })
      .strict(),
    bounded: z.literal(true),
  })
  .strict();

export const RuntimeReconciliationRetentionSchema = z
  .object({
    mode: z.literal("discard-after-read"),
    persisted: z.literal(false),
    retainedTracesAfterRead: z.literal(0),
    maxTraces: z.number().int().positive().max(100_000),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
  })
  .strict();

export const RuntimeReconciliationReportSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_RECONCILIATION_REPORT_SCHEMA_VERSION),
    contract: z.literal(RUNTIME_RECONCILIATION_REPORT_CONTRACT),
    mediaType: z.literal(RUNTIME_RECONCILIATION_REPORT_MEDIA_TYPE),
    localOnly: z.literal(true),
    static: RuntimeReconciliationStaticProvenanceSchema,
    runtime: RuntimeReconciliationRuntimeProvenanceSchema,
    bindings: RuntimeReconciliationBindingProvenanceSchema,
    reconciliation: RuntimeReconciliationSchema,
    uncertainty: RuntimeReconciliationUncertaintySummarySchema,
    diagnostics: z.array(RuntimeReconciliationDiagnosticSchema).max(16),
    limits: RuntimeReconciliationReportLimitsSchema,
    retention: RuntimeReconciliationRetentionSchema,
  })
  .strict();

export type RuntimeReconciliationStaticProvenance = z.infer<
  typeof RuntimeReconciliationStaticProvenanceSchema
>;
export type RuntimeReconciliationRuntimeProvenance = z.infer<
  typeof RuntimeReconciliationRuntimeProvenanceSchema
>;
export type RuntimeReconciliationBindingProvenance = z.infer<
  typeof RuntimeReconciliationBindingProvenanceSchema
>;
export type RuntimeReconciliationDiagnostic = z.infer<
  typeof RuntimeReconciliationDiagnosticSchema
>;
export type RuntimeReconciliationUncertaintySummary = z.infer<
  typeof RuntimeReconciliationUncertaintySummarySchema
>;
export type RuntimeReconciliationReportLimits = z.infer<
  typeof RuntimeReconciliationReportLimitsSchema
>;
export type RuntimeReconciliationRetention = z.infer<
  typeof RuntimeReconciliationRetentionSchema
>;
export type RuntimeReconciliationReport = z.infer<
  typeof RuntimeReconciliationReportSchema
>;

export type RuntimeReconciliationReportInput = {
  readonly static: RuntimeReconciliationStaticProvenance;
  readonly runtime: RuntimeReconciliationRuntimeProvenance;
  readonly bindings: RuntimeReconciliationBindingProvenance;
  readonly reconciliation: RuntimeReconciliation;
  readonly uncertainty: RuntimeReconciliationUncertaintySummary;
  readonly diagnostics: readonly RuntimeReconciliationDiagnostic[];
  readonly limits: RuntimeReconciliationReportLimits;
  readonly retention: RuntimeReconciliationRetention;
};

export const createRuntimeReconciliationReport = (
  input: RuntimeReconciliationReportInput,
): RuntimeReconciliationReport => {
  const parsed = RuntimeReconciliationReportSchema.safeParse({
    schemaVersion: RUNTIME_RECONCILIATION_REPORT_SCHEMA_VERSION,
    contract: RUNTIME_RECONCILIATION_REPORT_CONTRACT,
    mediaType: RUNTIME_RECONCILIATION_REPORT_MEDIA_TYPE,
    localOnly: true,
    ...input,
  });
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  }
  return parsed.data;
};

export const serializeRuntimeReconciliationReport = (
  value: unknown,
): string => {
  const parsed = RuntimeReconciliationReportSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  }
  return stableStringify(parsed.data);
};

export type RuntimeReconciliationReportTracePolicy = RuntimeTraceBudgetPolicy;
export type RuntimeReconciliationReportTraceCoverage =
  RuntimeTraceBudgetCoverage;
