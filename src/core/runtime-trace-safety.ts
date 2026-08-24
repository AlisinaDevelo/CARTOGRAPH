import { z } from "zod";

import { stableStringify } from "./canonical.js";

import {
  RuntimeTraceSchema,
  serializeRuntimeTrace,
  type RuntimeSpan,
  type RuntimeTrace,
} from "./runtime-traces.js";

export const RUNTIME_TRACE_SAFETY_SCHEMA_VERSION = 1 as const;
export const RUNTIME_TRACE_SAFETY_CONTRACT =
  "cartograph.runtime-trace-safety" as const;
export const RUNTIME_TRACE_SAFETY_MEDIA_TYPE =
  "application/vnd.cartograph.runtime-trace-safety+json" as const;

export const RuntimeTraceRedactionFieldSchema = z.enum([
  "span.name",
  "span.serviceName",
  "span.scopeName",
  "span.scopeVersion",
]);

const DEFAULT_REDACTION_FIELDS = [
  "span.name",
  "span.serviceName",
  "span.scopeName",
  "span.scopeVersion",
] as const;

export const RuntimeTraceRedactionOptionsSchema = z
  .object({
    fields: z
      .array(RuntimeTraceRedactionFieldSchema)
      .min(1)
      .max(DEFAULT_REDACTION_FIELDS.length)
      .default([...DEFAULT_REDACTION_FIELDS]),
    replacement: z.string().trim().min(1).max(64).default("[REDACTED]"),
  })
  .strict()
  .refine(
    (options) => new Set(options.fields).size === options.fields.length,
    "fields must not contain duplicates",
  )
  .default({
    fields: [...DEFAULT_REDACTION_FIELDS],
    replacement: "[REDACTED]",
  });

export const RuntimeTraceRetentionModeSchema = z.enum([
  "memory-only",
  "discard-after-read",
]);

export const RuntimeTraceRetentionPolicySchema = z
  .object({
    mode: RuntimeTraceRetentionModeSchema.default("memory-only"),
    maxTraces: z.number().int().positive().max(10_000).default(64),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024)
      .default(4 * 1024 * 1024),
    ttlMs: z
      .number()
      .int()
      .positive()
      .max(30 * 24 * 60 * 60 * 1_000)
      .default(15 * 60 * 1_000),
  })
  .strict()
  .default({
    mode: "memory-only",
    maxTraces: 64,
    maxBytes: 4 * 1024 * 1024,
    ttlMs: 15 * 60 * 1_000,
  });

export const RuntimeTraceSafetyPolicySchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_TRACE_SAFETY_SCHEMA_VERSION),
    contract: z.literal(RUNTIME_TRACE_SAFETY_CONTRACT),
    mediaType: z.literal(RUNTIME_TRACE_SAFETY_MEDIA_TYPE),
    redaction: RuntimeTraceRedactionOptionsSchema,
    retention: RuntimeTraceRetentionPolicySchema,
  })
  .strict();

export const DEFAULT_RUNTIME_TRACE_SAFETY_POLICY =
  RuntimeTraceSafetyPolicySchema.parse({
    schemaVersion: RUNTIME_TRACE_SAFETY_SCHEMA_VERSION,
    contract: RUNTIME_TRACE_SAFETY_CONTRACT,
    mediaType: RUNTIME_TRACE_SAFETY_MEDIA_TYPE,
    redaction: {},
    retention: {},
  });

export type RuntimeTraceRedactionField = z.infer<
  typeof RuntimeTraceRedactionFieldSchema
>;
export type RuntimeTraceRedactionOptions = z.infer<
  typeof RuntimeTraceRedactionOptionsSchema
>;
export type RuntimeTraceRetentionMode = z.infer<
  typeof RuntimeTraceRetentionModeSchema
>;
export type RuntimeTraceRetentionPolicy = z.infer<
  typeof RuntimeTraceRetentionPolicySchema
>;
export type RuntimeTraceSafetyPolicy = z.infer<
  typeof RuntimeTraceSafetyPolicySchema
>;

export type RuntimeTraceSafetyErrorCode =
  | "invalid-policy"
  | "invalid-trace"
  | "invalid-retention-id"
  | "limit-exceeded";

export class RuntimeTraceSafetyError extends Error {
  readonly code: RuntimeTraceSafetyErrorCode;

  constructor(code: RuntimeTraceSafetyErrorCode, message: string) {
    super(message);
    this.name = "RuntimeTraceSafetyError";
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

const parseRedactionOptions = (
  value: unknown,
): RuntimeTraceRedactionOptions => {
  const parsed = RuntimeTraceRedactionOptionsSchema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new RuntimeTraceSafetyError(
      "invalid-policy",
      issueText(parsed.error.issues),
    );
  }
  return parsed.data;
};

const parsePolicy = (value: unknown): RuntimeTraceSafetyPolicy => {
  const parsed = RuntimeTraceSafetyPolicySchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeTraceSafetyError(
      "invalid-policy",
      issueText(parsed.error.issues),
    );
  }
  return parsed.data;
};

const parseTrace = (value: unknown): RuntimeTrace => {
  const parsed = RuntimeTraceSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeTraceSafetyError(
      "invalid-trace",
      issueText(parsed.error.issues),
    );
  }
  return parsed.data;
};

const redactSpan = (
  span: RuntimeSpan,
  fields: ReadonlySet<RuntimeTraceRedactionField>,
  replacement: string,
): RuntimeSpan => ({
  ...span,
  name: fields.has("span.name") ? replacement : span.name,
  ...(span.serviceName
    ? {
        serviceName: fields.has("span.serviceName")
          ? replacement
          : span.serviceName,
      }
    : {}),
  ...(span.scopeName
    ? {
        scopeName: fields.has("span.scopeName") ? replacement : span.scopeName,
      }
    : {}),
  ...(span.scopeVersion
    ? {
        scopeVersion: fields.has("span.scopeVersion")
          ? replacement
          : span.scopeVersion,
      }
    : {}),
});

export const redactRuntimeTrace = (
  value: unknown,
  options?: unknown,
): RuntimeTrace => {
  const trace = parseTrace(value);
  const parsedOptions = parseRedactionOptions(options);
  const fields = new Set(parsedOptions.fields);
  const redacted = RuntimeTraceSchema.parse({
    ...trace,
    spans: trace.spans.map((span) =>
      redactSpan(span, fields, parsedOptions.replacement),
    ),
  });
  return JSON.parse(serializeRuntimeTrace(redacted)) as RuntimeTrace;
};

type RetainedTrace = {
  readonly trace: RuntimeTrace;
  readonly bytes: number;
  readonly insertedAt: number;
  readonly expiresAt: number;
};

const RetentionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.includes("\r") &&
      !value.includes("\n") &&
      !value.includes("/") &&
      !value.includes("\\"),
    "must be a non-path retention identifier",
  );

export class RuntimeTraceRetentionStore {
  readonly policy: RuntimeTraceRetentionPolicy;
  readonly redaction: RuntimeTraceRedactionOptions;
  private readonly clock: () => number;
  private readonly traces = new Map<string, RetainedTrace>();
  private retainedBytes = 0;

  constructor(
    policy: RuntimeTraceSafetyPolicy = DEFAULT_RUNTIME_TRACE_SAFETY_POLICY,
    clock: () => number = Date.now,
  ) {
    const parsed = parsePolicy(policy);
    this.policy = parsed.retention;
    this.redaction = parsed.redaction;
    this.clock = clock;
  }

  get size(): number {
    return this.traces.size;
  }

  get bytes(): number {
    return this.retainedBytes;
  }

  put(id: string, value: unknown, now = this.clock()): RuntimeTrace {
    const parsedId = RetentionIdSchema.safeParse(id);
    if (!parsedId.success) {
      throw new RuntimeTraceSafetyError(
        "invalid-retention-id",
        issueText(parsedId.error.issues),
      );
    }
    const trace = redactRuntimeTrace(value, this.redaction);
    const serialized = serializeRuntimeTrace(trace);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > this.policy.maxBytes) {
      throw new RuntimeTraceSafetyError(
        "limit-exceeded",
        `redacted trace exceeds maxBytes=${this.policy.maxBytes}`,
      );
    }
    this.evictExpired(now);
    this.remove(parsedId.data);
    while (
      this.traces.size >= this.policy.maxTraces ||
      this.retainedBytes + bytes > this.policy.maxBytes
    ) {
      const oldest = this.oldestId();
      if (!oldest) break;
      this.remove(oldest);
    }
    this.traces.set(parsedId.data, {
      trace,
      bytes,
      insertedAt: now,
      expiresAt: now + this.policy.ttlMs,
    });
    this.retainedBytes += bytes;
    return trace;
  }

  get(id: string, now = this.clock()): RuntimeTrace | undefined {
    const parsedId = RetentionIdSchema.safeParse(id);
    if (!parsedId.success) {
      throw new RuntimeTraceSafetyError(
        "invalid-retention-id",
        issueText(parsedId.error.issues),
      );
    }
    this.evictExpired(now);
    const retained = this.traces.get(parsedId.data);
    if (!retained) return undefined;
    if (this.policy.mode === "discard-after-read") {
      this.remove(parsedId.data);
    }
    return retained.trace;
  }

  clear(): void {
    this.traces.clear();
    this.retainedBytes = 0;
  }

  private evictExpired(now: number): void {
    for (const [id, retained] of this.traces) {
      if (retained.expiresAt <= now) this.remove(id);
    }
  }

  private oldestId(): string | undefined {
    return [...this.traces.entries()]
      .sort(
        (left, right) =>
          left[1].insertedAt - right[1].insertedAt ||
          (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
      )
      .at(0)?.[0];
  }

  private remove(id: string): void {
    const retained = this.traces.get(id);
    if (!retained) return;
    this.traces.delete(id);
    this.retainedBytes -= retained.bytes;
  }
}

export const serializeRuntimeTraceSafetyPolicy = (value: unknown): string => {
  const parsed = RuntimeTraceSafetyPolicySchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeTraceSafetyError(
      "invalid-policy",
      issueText(parsed.error.issues),
    );
  }
  return stableStringify(parsed.data);
};
