import { z } from "zod";

import { stableStringify } from "./canonical.js";
import {
  DEFAULT_RUNTIME_TRACE_SAFETY_POLICY,
  redactRuntimeTrace,
  RuntimeTraceRedactionOptionsSchema,
  type RuntimeTraceRedactionOptions,
} from "./runtime-trace-safety.js";
import {
  parseRuntimeTraceJson,
  RuntimeTraceSchema,
  RuntimeTraceValidationError,
  serializeRuntimeTrace,
  type RuntimeTrace,
} from "./runtime-traces.js";

export const RUNTIME_TRACE_BUDGETS_SCHEMA_VERSION = 1 as const;
export const RUNTIME_TRACE_BUDGETS_CONTRACT =
  "cartograph.runtime-trace-budgets" as const;
export const RUNTIME_TRACE_BUDGETS_MEDIA_TYPE =
  "application/vnd.cartograph.runtime-trace-budgets+json" as const;

export const RuntimeTraceBudgetOverflowSchema = z.enum([
  "fail-closed",
  "truncate-incomplete",
]);

export const RuntimeTraceBudgetPolicySchema = z
  .object({
    maxInputBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024)
      .default(64 * 1024 * 1024),
    maxResourceSpans: z.number().int().positive().max(10_000).default(10_000),
    maxScopeSpans: z.number().int().positive().max(100_000).default(100_000),
    maxSpans: z.number().int().positive().max(1_000_000).default(100_000),
    maxAttributesPerRecord: z
      .number()
      .int()
      .nonnegative()
      .max(10_000)
      .default(256),
    maxTraces: z.number().int().positive().max(100_000).default(10_000),
    maxAnalysisMs: z.number().int().positive().max(300_000).default(30_000),
    maxReportBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024)
      .default(4 * 1024 * 1024),
    overflow: RuntimeTraceBudgetOverflowSchema.default("fail-closed"),
    redaction: RuntimeTraceRedactionOptionsSchema.default(
      DEFAULT_RUNTIME_TRACE_SAFETY_POLICY.redaction,
    ),
  })
  .strict()
  .default({
    maxInputBytes: 64 * 1024 * 1024,
    maxResourceSpans: 10_000,
    maxScopeSpans: 100_000,
    maxSpans: 100_000,
    maxAttributesPerRecord: 256,
    maxTraces: 10_000,
    maxAnalysisMs: 30_000,
    maxReportBytes: 4 * 1024 * 1024,
    overflow: "fail-closed",
    redaction: DEFAULT_RUNTIME_TRACE_SAFETY_POLICY.redaction,
  });

export const RuntimeTraceBudgetCoverageSchema = z
  .object({
    complete: z.boolean(),
    truncated: z.boolean(),
    inputTraces: z.number().int().nonnegative(),
    retainedTraces: z.number().int().nonnegative(),
    droppedTraces: z.number().int().nonnegative(),
    inputSpans: z.number().int().nonnegative(),
    retainedSpans: z.number().int().nonnegative(),
    droppedSpans: z.number().int().nonnegative(),
  })
  .strict();

export const RuntimeTraceBudgetDiagnosticCodeSchema = z.enum([
  "trace-count-truncated",
]);

export const RuntimeTraceBudgetDiagnosticSchema = z
  .object({
    code: RuntimeTraceBudgetDiagnosticCodeSchema,
    message: z.string().trim().min(1).max(2_048),
  })
  .strict();

export const RuntimeTraceBudgetResultSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_TRACE_BUDGETS_SCHEMA_VERSION),
    contract: z.literal(RUNTIME_TRACE_BUDGETS_CONTRACT),
    mediaType: z.literal(RUNTIME_TRACE_BUDGETS_MEDIA_TYPE),
    policy: RuntimeTraceBudgetPolicySchema,
    trace: RuntimeTraceSchema,
    coverage: RuntimeTraceBudgetCoverageSchema,
    diagnostics: z.array(RuntimeTraceBudgetDiagnosticSchema).max(16),
    reportBytes: z.number().int().nonnegative(),
    redacted: z.literal(true),
    tempFiles: z.literal(false),
  })
  .strict();

export type RuntimeTraceBudgetOverflow = z.infer<
  typeof RuntimeTraceBudgetOverflowSchema
>;
export type RuntimeTraceBudgetPolicy = z.infer<
  typeof RuntimeTraceBudgetPolicySchema
>;
export type RuntimeTraceBudgetCoverage = z.infer<
  typeof RuntimeTraceBudgetCoverageSchema
>;
export type RuntimeTraceBudgetDiagnosticCode = z.infer<
  typeof RuntimeTraceBudgetDiagnosticCodeSchema
>;
export type RuntimeTraceBudgetDiagnostic = z.infer<
  typeof RuntimeTraceBudgetDiagnosticSchema
>;
export type RuntimeTraceBudgetResult = z.infer<
  typeof RuntimeTraceBudgetResultSchema
>;

export const DEFAULT_RUNTIME_TRACE_BUDGET_POLICY =
  RuntimeTraceBudgetPolicySchema.parse({});

export type RuntimeTraceBudgetErrorCode =
  | "invalid-policy"
  | "invalid-json"
  | "invalid-input"
  | "duplicate-span"
  | "input-bytes-limit-exceeded"
  | "resource-span-limit-exceeded"
  | "scope-span-limit-exceeded"
  | "span-limit-exceeded"
  | "attribute-limit-exceeded"
  | "trace-count-limit-exceeded"
  | "analysis-time-limit-exceeded"
  | "report-size-limit-exceeded";

export class RuntimeTraceBudgetError extends Error {
  readonly code: RuntimeTraceBudgetErrorCode;

  constructor(code: RuntimeTraceBudgetErrorCode, message: string) {
    super(message);
    this.name = "RuntimeTraceBudgetError";
    this.code = code;
  }
}

const issueText = (issues: z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "policy";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

const parsePolicy = (value: unknown): RuntimeTraceBudgetPolicy => {
  const parsed = RuntimeTraceBudgetPolicySchema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new RuntimeTraceBudgetError(
      "invalid-policy",
      issueText(parsed.error.issues),
    );
  }
  return parsed.data;
};

const mapValidationError = (
  error: RuntimeTraceValidationError,
): RuntimeTraceBudgetErrorCode => {
  if (error.code === "invalid-json") return "invalid-json";
  if (error.code === "duplicate-span") return "duplicate-span";
  if (/JSON input exceeds/u.test(error.message)) {
    return "input-bytes-limit-exceeded";
  }
  if (/resourceSpans exceeds/u.test(error.message)) {
    return "resource-span-limit-exceeded";
  }
  if (/scopeSpans exceeds/u.test(error.message)) {
    return "scope-span-limit-exceeded";
  }
  if (/attributes exceeds/u.test(error.message)) {
    return "attribute-limit-exceeded";
  }
  if (/spans exceeds/u.test(error.message)) return "span-limit-exceeded";
  return "invalid-input";
};

const failFromValidation = (error: unknown): never => {
  if (error instanceof RuntimeTraceBudgetError) throw error;
  if (error instanceof RuntimeTraceValidationError) {
    throw new RuntimeTraceBudgetError(
      error.code === "invalid-input"
        ? "invalid-input"
        : mapValidationError(error),
      error.message,
    );
  }
  throw new RuntimeTraceBudgetError(
    "invalid-input",
    error instanceof Error ? error.message : String(error),
  );
};

const traceIds = (trace: RuntimeTrace): string[] =>
  [...new Set(trace.spans.map((span) => span.traceId))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

const truncateTrace = (
  trace: RuntimeTrace,
  maxTraces: number,
): { trace: RuntimeTrace; droppedTraces: number; droppedSpans: number } => {
  const allTraceIds = traceIds(trace);
  const retainedIds = new Set(allTraceIds.slice(0, maxTraces));
  const spans = trace.spans.filter((span) => retainedIds.has(span.traceId));
  return {
    trace: RuntimeTraceSchema.parse({
      ...trace,
      spans,
      summary: {
        ...trace.summary,
        normalizedSpans: spans.length,
      },
    }),
    droppedTraces: allTraceIds.length - retainedIds.size,
    droppedSpans: trace.spans.length - spans.length,
  };
};

export const importRuntimeTraceWithBudget = (
  text: string,
  policyValue: unknown = DEFAULT_RUNTIME_TRACE_BUDGET_POLICY,
  clock: () => number = Date.now,
): RuntimeTraceBudgetResult => {
  const policy = parsePolicy(policyValue);
  const startedAt = clock();
  let imported: RuntimeTrace;
  try {
    imported = parseRuntimeTraceJson(text, {
      maxBytes: policy.maxInputBytes,
      maxResourceSpans: policy.maxResourceSpans,
      maxScopeSpans: policy.maxScopeSpans,
      maxSpans: policy.maxSpans,
      maxAttributesPerRecord: policy.maxAttributesPerRecord,
    });
  } catch (error) {
    failFromValidation(error);
  }

  const redacted = redactRuntimeTrace(imported!, policy.redaction);
  const importedTraceIds = traceIds(imported!);
  let trace = redacted;
  let droppedTraces = 0;
  let droppedSpans = 0;
  const diagnostics: RuntimeTraceBudgetDiagnostic[] = [];
  if (importedTraceIds.length > policy.maxTraces) {
    if (policy.overflow === "fail-closed") {
      throw new RuntimeTraceBudgetError(
        "trace-count-limit-exceeded",
        `trace count exceeds maxTraces=${policy.maxTraces}`,
      );
    }
    const truncated = truncateTrace(redacted, policy.maxTraces);
    trace = truncated.trace;
    droppedTraces = truncated.droppedTraces;
    droppedSpans = truncated.droppedSpans;
    diagnostics.push({
      code: "trace-count-truncated",
      message: `retained ${policy.maxTraces} of ${importedTraceIds.length} traces; coverage is incomplete`,
    });
  }

  const serializedTrace = serializeRuntimeTrace(trace);
  const reportBytes = Buffer.byteLength(serializedTrace, "utf8");
  if (reportBytes > policy.maxReportBytes) {
    throw new RuntimeTraceBudgetError(
      "report-size-limit-exceeded",
      `serialized trace exceeds maxReportBytes=${policy.maxReportBytes}`,
    );
  }
  const elapsedMs = clock() - startedAt;
  if (elapsedMs > policy.maxAnalysisMs) {
    throw new RuntimeTraceBudgetError(
      "analysis-time-limit-exceeded",
      `trace import exceeded maxAnalysisMs=${policy.maxAnalysisMs}`,
    );
  }

  const result = RuntimeTraceBudgetResultSchema.safeParse({
    schemaVersion: RUNTIME_TRACE_BUDGETS_SCHEMA_VERSION,
    contract: RUNTIME_TRACE_BUDGETS_CONTRACT,
    mediaType: RUNTIME_TRACE_BUDGETS_MEDIA_TYPE,
    policy,
    trace,
    coverage: {
      complete: droppedTraces === 0,
      truncated: droppedTraces > 0,
      inputTraces: importedTraceIds.length,
      retainedTraces: importedTraceIds.length - droppedTraces,
      droppedTraces,
      inputSpans: imported!.summary.inputSpans,
      retainedSpans: trace.spans.length,
      droppedSpans,
    },
    diagnostics,
    reportBytes,
    redacted: true,
    tempFiles: false,
  });
  if (!result.success) {
    throw new RuntimeTraceBudgetError(
      "invalid-input",
      issueText(result.error.issues),
    );
  }
  return result.data;
};

export const serializeRuntimeTraceBudgetResult = (value: unknown): string => {
  const parsed = RuntimeTraceBudgetResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeTraceBudgetError(
      "invalid-input",
      issueText(parsed.error.issues),
    );
  }
  return stableStringify(parsed.data);
};

export type RuntimeTraceBudgetRedaction = RuntimeTraceRedactionOptions;
