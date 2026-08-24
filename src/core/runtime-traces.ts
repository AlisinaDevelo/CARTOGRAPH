import { z } from "zod";

import { stableStringify } from "./canonical.js";

export const RUNTIME_TRACE_SCHEMA_VERSION = 1 as const;
export const RUNTIME_TRACE_CONTRACT = "cartograph.runtime-traces" as const;
export const RUNTIME_TRACE_MEDIA_TYPE =
  "application/vnd.cartograph.runtime-traces+json" as const;
export const RUNTIME_TRACE_FORMAT = "otlp-json" as const;

const HexId = (length: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`, "u"));

const DecimalNanosecondsSchema = z.string().regex(/^\d+$/u);

export const RuntimeSpanKindSchema = z.enum([
  "unspecified",
  "internal",
  "server",
  "client",
  "producer",
  "consumer",
]);

export const RuntimeSpanStatusSchema = z.enum(["unset", "ok", "error"]);

export const RuntimeSpanSchema = z
  .object({
    traceId: HexId(32),
    spanId: HexId(16),
    parentSpanId: HexId(16).optional(),
    name: z.string().trim().min(1).max(512),
    kind: RuntimeSpanKindSchema,
    startTimeUnixNano: DecimalNanosecondsSchema,
    endTimeUnixNano: DecimalNanosecondsSchema,
    serviceName: z.string().trim().min(1).max(256).optional(),
    scopeName: z.string().trim().min(1).max(256).optional(),
    scopeVersion: z.string().trim().min(1).max(128).optional(),
    status: RuntimeSpanStatusSchema,
  })
  .strict()
  .superRefine((span, context) => {
    if (BigInt(span.endTimeUnixNano) < BigInt(span.startTimeUnixNano)) {
      context.addIssue({
        code: "custom",
        path: ["endTimeUnixNano"],
        message: "must be greater than or equal to startTimeUnixNano",
      });
    }
  });

export const RuntimeTraceSummarySchema = z
  .object({
    resourceSpans: z.number().int().nonnegative(),
    scopeSpans: z.number().int().nonnegative(),
    inputSpans: z.number().int().nonnegative(),
    normalizedSpans: z.number().int().nonnegative(),
    discardedAttributes: z.number().int().nonnegative(),
  })
  .strict();

export const RuntimeTraceSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_TRACE_SCHEMA_VERSION),
    contract: z.literal(RUNTIME_TRACE_CONTRACT),
    mediaType: z.literal(RUNTIME_TRACE_MEDIA_TYPE),
    format: z.literal(RUNTIME_TRACE_FORMAT),
    spans: z.array(RuntimeSpanSchema).max(1_000_000),
    summary: RuntimeTraceSummarySchema,
  })
  .strict();

export type RuntimeSpanKind = z.infer<typeof RuntimeSpanKindSchema>;
export type RuntimeSpanStatus = z.infer<typeof RuntimeSpanStatusSchema>;
export type RuntimeSpan = z.infer<typeof RuntimeSpanSchema>;
export type RuntimeTraceSummary = z.infer<typeof RuntimeTraceSummarySchema>;
export type RuntimeTrace = z.infer<typeof RuntimeTraceSchema>;

export const RuntimeTraceLimitsSchema = z
  .object({
    maxBytes: z
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
  })
  .strict()
  .default({
    maxBytes: 64 * 1024 * 1024,
    maxResourceSpans: 10_000,
    maxScopeSpans: 100_000,
    maxSpans: 100_000,
    maxAttributesPerRecord: 256,
  });

export type RuntimeTraceLimits = z.infer<typeof RuntimeTraceLimitsSchema>;

export type RuntimeTraceValidationCode =
  "invalid-json" | "invalid-input" | "limit-exceeded" | "duplicate-span";

export class RuntimeTraceValidationError extends Error {
  readonly code: RuntimeTraceValidationCode;

  constructor(code: RuntimeTraceValidationCode, message: string) {
    super(message);
    this.name = "RuntimeTraceValidationError";
    this.code = code;
  }
}

const issueText = (issues: z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "trace";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

const RawUnsignedIntegerSchema = z.union([
  z.string().trim().regex(/^\d+$/u),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
]);

const RawAttributeValueSchema = z
  .object({
    stringValue: z.string().optional(),
    boolValue: z.boolean().optional(),
    intValue: RawUnsignedIntegerSchema.optional(),
    doubleValue: z.number().finite().optional(),
    bytesValue: z.string().optional(),
    arrayValue: z.unknown().optional(),
    kvlistValue: z.unknown().optional(),
  })
  .passthrough();

const RawAttributeSchema = z
  .object({
    key: z.string().trim().min(1).max(256),
    value: RawAttributeValueSchema,
  })
  .passthrough();

const RawResourceSchema = z
  .object({
    attributes: z.array(RawAttributeSchema).max(10_000).default([]),
  })
  .passthrough();

const RawScopeSchema = z
  .object({
    name: z.string().max(256).optional(),
    version: z.string().max(128).optional(),
    attributes: z.array(RawAttributeSchema).max(10_000).default([]),
  })
  .passthrough();

const RawStatusSchema = z
  .object({
    code: z
      .union([z.number().int().min(0).max(2), z.string().trim().min(1).max(32)])
      .optional(),
    message: z.string().max(2_048).optional(),
  })
  .passthrough();

const RawSpanSchema = z
  .object({
    traceId: z.string(),
    spanId: z.string(),
    parentSpanId: z.string().optional(),
    name: z.string(),
    kind: z.union([
      z.number().int().min(0).max(5),
      z.string().trim().min(1).max(32),
    ]),
    startTimeUnixNano: RawUnsignedIntegerSchema,
    endTimeUnixNano: RawUnsignedIntegerSchema,
    attributes: z.array(RawAttributeSchema).max(10_000).default([]),
    status: RawStatusSchema.optional(),
  })
  .passthrough();

const RawScopeSpansSchema = z
  .object({
    scope: RawScopeSchema.optional(),
    spans: z.array(RawSpanSchema).max(1_000_000).default([]),
  })
  .passthrough();

const RawResourceSpansSchema = z
  .object({
    resource: RawResourceSchema.optional(),
    scopeSpans: z.array(RawScopeSpansSchema).max(100_000).default([]),
  })
  .passthrough();

const RawOtlpExportSchema = z
  .object({
    resourceSpans: z.array(RawResourceSpansSchema).max(10_000),
  })
  .passthrough();

type RawOtlpExport = z.infer<typeof RawOtlpExportSchema>;
type RawResourceSpans = z.infer<typeof RawResourceSpansSchema>;
type RawScopeSpans = z.infer<typeof RawScopeSpansSchema>;
type RawSpan = z.infer<typeof RawSpanSchema>;
type RawAttribute = z.infer<typeof RawAttributeSchema>;

const parseLimits = (value: unknown): RuntimeTraceLimits => {
  const parsed = RuntimeTraceLimitsSchema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new RuntimeTraceValidationError(
      "invalid-input",
      issueText(parsed.error.issues),
    );
  }
  return parsed.data;
};

const parseRawExport = (value: unknown): RawOtlpExport => {
  const parsed = RawOtlpExportSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeTraceValidationError(
      "invalid-input",
      issueText(parsed.error.issues),
    );
  }
  return parsed.data;
};

const normalizeDecimal = (value: string | number, path: string): string => {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RuntimeTraceValidationError(
        "invalid-input",
        `${path}: must be a non-negative safe integer`,
      );
    }
    return String(value);
  }
  const normalized = value.replace(/^0+(?=\d)/u, "");
  if (!/^\d+$/u.test(normalized)) {
    throw new RuntimeTraceValidationError(
      "invalid-input",
      `${path}: must be a non-negative integer`,
    );
  }
  return normalized;
};

const normalizeHex = (value: string, length: number, path: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "u").test(normalized)) {
    throw new RuntimeTraceValidationError(
      "invalid-input",
      `${path}: must be exactly ${length} hexadecimal characters`,
    );
  }
  return normalized;
};

const normalizeKind = (
  value: string | number,
  path: string,
): RuntimeSpanKind => {
  const byNumber: RuntimeSpanKind[] = [
    "unspecified",
    "internal",
    "server",
    "client",
    "producer",
    "consumer",
  ];
  if (typeof value === "number") return byNumber[value] ?? "unspecified";
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^span_kind_/u, "");
  if (
    normalized === "unspecified" ||
    normalized === "internal" ||
    normalized === "server" ||
    normalized === "client" ||
    normalized === "producer" ||
    normalized === "consumer"
  ) {
    return normalized;
  }
  throw new RuntimeTraceValidationError(
    "invalid-input",
    `${path}: unsupported span kind`,
  );
};

const normalizeStatus = (
  value: RawSpan["status"],
  path: string,
): RuntimeSpanStatus => {
  if (!value?.code) return "unset";
  if (typeof value.code === "number") {
    return value.code === 2 ? "error" : value.code === 1 ? "ok" : "unset";
  }
  const normalized = value.code
    .trim()
    .toLowerCase()
    .replace(/^status_code_/u, "");
  if (normalized === "unset" || normalized === "ok" || normalized === "error") {
    return normalized;
  }
  throw new RuntimeTraceValidationError(
    "invalid-input",
    `${path}.code: unsupported status code`,
  );
};

const attributeString = (
  attributes: readonly RawAttribute[],
  key: string,
): string | undefined => {
  const values = attributes
    .filter((attribute) => attribute.key === key)
    .flatMap((attribute) =>
      typeof attribute.value.stringValue === "string"
        ? [attribute.value.stringValue.trim()]
        : [],
    )
    .filter((value) => value.length > 0);
  return values.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )[0];
};

const boundedText = (
  value: string | undefined,
  maxLength: number,
  path: string,
): string | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length > maxLength) {
    throw new RuntimeTraceValidationError(
      "invalid-input",
      `${path}: exceeds ${maxLength} characters`,
    );
  }
  return normalized;
};

const normalizeSpan = (
  span: RawSpan,
  resource: RawResourceSpans,
  scope: RawScopeSpans,
  index: number,
): RuntimeSpan => {
  const path = `resourceSpans[].scopeSpans[].spans[${index}]`;
  const startTimeUnixNano = normalizeDecimal(
    span.startTimeUnixNano,
    `${path}.startTimeUnixNano`,
  );
  const endTimeUnixNano = normalizeDecimal(
    span.endTimeUnixNano,
    `${path}.endTimeUnixNano`,
  );
  if (BigInt(endTimeUnixNano) < BigInt(startTimeUnixNano)) {
    throw new RuntimeTraceValidationError(
      "invalid-input",
      `${path}.endTimeUnixNano: must be greater than or equal to startTimeUnixNano`,
    );
  }
  const parent = span.parentSpanId?.trim();
  const parentSpanId =
    parent && parent !== "0000000000000000"
      ? normalizeHex(parent, 16, `${path}.parentSpanId`)
      : undefined;
  const name = span.name.trim();
  if (name.length === 0 || name.length > 512) {
    throw new RuntimeTraceValidationError(
      "invalid-input",
      `${path}.name: must contain 1-512 non-whitespace characters`,
    );
  }
  const serviceName = boundedText(
    attributeString(resource.resource?.attributes ?? [], "service.name"),
    256,
    `${path}.serviceName`,
  );
  const scopeName = boundedText(scope.scope?.name, 256, `${path}.scopeName`);
  const scopeVersion = boundedText(
    scope.scope?.version,
    128,
    `${path}.scopeVersion`,
  );
  const traceId = normalizeHex(span.traceId, 32, `${path}.traceId`);
  const spanId = normalizeHex(span.spanId, 16, `${path}.spanId`);
  if (/^0+$/u.test(traceId) || /^0+$/u.test(spanId)) {
    throw new RuntimeTraceValidationError(
      "invalid-input",
      `${path}: traceId and spanId must not be all zeroes`,
    );
  }
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    kind: normalizeKind(span.kind, `${path}.kind`),
    startTimeUnixNano,
    endTimeUnixNano,
    ...(serviceName ? { serviceName } : {}),
    ...(scopeName ? { scopeName } : {}),
    ...(scopeVersion ? { scopeVersion } : {}),
    status: normalizeStatus(span.status, `${path}.status`),
  };
};

const canonicalizeTrace = (trace: RuntimeTrace): RuntimeTrace => ({
  ...trace,
  spans: [...trace.spans].sort((left, right) => {
    const leftKey = `${left.traceId}:${left.startTimeUnixNano}:${left.spanId}`;
    const rightKey = `${right.traceId}:${right.startTimeUnixNano}:${right.spanId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  }),
});

export const parseRuntimeTrace = (
  value: unknown,
  options?: Partial<RuntimeTraceLimits>,
): RuntimeTrace => {
  const limits = parseLimits(options);
  const input = parseRawExport(value);
  if (input.resourceSpans.length > limits.maxResourceSpans) {
    throw new RuntimeTraceValidationError(
      "limit-exceeded",
      `resourceSpans exceeds maxResourceSpans=${limits.maxResourceSpans}`,
    );
  }

  const spans: RuntimeSpan[] = [];
  const seen = new Set<string>();
  let scopeSpans = 0;
  let inputSpans = 0;
  let discardedAttributes = 0;
  input.resourceSpans.forEach((resource, resourceIndex) => {
    const resourceAttributes = resource.resource?.attributes ?? [];
    if (resourceAttributes.length > limits.maxAttributesPerRecord) {
      throw new RuntimeTraceValidationError(
        "limit-exceeded",
        `resourceSpans[${resourceIndex}].resource.attributes exceeds maxAttributesPerRecord=${limits.maxAttributesPerRecord}`,
      );
    }
    discardedAttributes += resourceAttributes.length;
    scopeSpans += resource.scopeSpans.length;
    if (scopeSpans > limits.maxScopeSpans) {
      throw new RuntimeTraceValidationError(
        "limit-exceeded",
        `scopeSpans exceeds maxScopeSpans=${limits.maxScopeSpans}`,
      );
    }
    resource.scopeSpans.forEach((scope, scopeIndex) => {
      const scopeAttributes = scope.scope?.attributes ?? [];
      if (scopeAttributes.length > limits.maxAttributesPerRecord) {
        throw new RuntimeTraceValidationError(
          "limit-exceeded",
          `resourceSpans[${resourceIndex}].scopeSpans[${scopeIndex}].scope.attributes exceeds maxAttributesPerRecord=${limits.maxAttributesPerRecord}`,
        );
      }
      discardedAttributes += scopeAttributes.length;
      scope.spans.forEach((span, spanIndex) => {
        if (span.attributes.length > limits.maxAttributesPerRecord) {
          throw new RuntimeTraceValidationError(
            "limit-exceeded",
            `resourceSpans[${resourceIndex}].scopeSpans[${scopeIndex}].spans[${spanIndex}].attributes exceeds maxAttributesPerRecord=${limits.maxAttributesPerRecord}`,
          );
        }
        discardedAttributes += span.attributes.length;
        inputSpans += 1;
        if (inputSpans > limits.maxSpans) {
          throw new RuntimeTraceValidationError(
            "limit-exceeded",
            `spans exceeds maxSpans=${limits.maxSpans}`,
          );
        }
        const normalized = normalizeSpan(span, resource, scope, spanIndex);
        const identity = `${normalized.traceId}:${normalized.spanId}`;
        if (seen.has(identity)) {
          throw new RuntimeTraceValidationError(
            "duplicate-span",
            `duplicate span identity ${identity}`,
          );
        }
        seen.add(identity);
        spans.push(normalized);
      });
    });
  });

  const parsed = RuntimeTraceSchema.safeParse({
    schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
    contract: RUNTIME_TRACE_CONTRACT,
    mediaType: RUNTIME_TRACE_MEDIA_TYPE,
    format: RUNTIME_TRACE_FORMAT,
    spans,
    summary: {
      resourceSpans: input.resourceSpans.length,
      scopeSpans,
      inputSpans,
      normalizedSpans: spans.length,
      discardedAttributes,
    },
  });
  if (!parsed.success) {
    throw new RuntimeTraceValidationError(
      "invalid-input",
      issueText(parsed.error.issues),
    );
  }
  return canonicalizeTrace(parsed.data);
};

export const parseRuntimeTraceJson = (
  text: string,
  options?: Partial<RuntimeTraceLimits>,
): RuntimeTrace => {
  const limits = parseLimits(options);
  if (typeof text !== "string") {
    throw new RuntimeTraceValidationError(
      "invalid-json",
      "trace input must be a JSON string",
    );
  }
  if (Buffer.byteLength(text, "utf8") > limits.maxBytes) {
    throw new RuntimeTraceValidationError(
      "limit-exceeded",
      `JSON input exceeds maxBytes=${limits.maxBytes}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new RuntimeTraceValidationError(
      "invalid-json",
      `trace input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseRuntimeTrace(value, limits);
};

export const serializeRuntimeTrace = (value: unknown): string => {
  const parsed = RuntimeTraceSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeTraceValidationError(
      "invalid-input",
      issueText(parsed.error.issues),
    );
  }
  return stableStringify(canonicalizeTrace(parsed.data));
};
