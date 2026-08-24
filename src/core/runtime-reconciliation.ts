import { z } from "zod";

import { canonicalizeGraphSnapshot, stableStringify } from "./canonical.js";
import {
  GraphSnapshotSchema,
  RevisionSchema,
  type GraphEdge,
  type Revision,
} from "./schemas.js";
import {
  RUNTIME_TRACE_SCHEMA_VERSION,
  RuntimeTraceSchema,
  type RuntimeSpan,
} from "./runtime-traces.js";

export const RUNTIME_RECONCILIATION_SCHEMA_VERSION = 1 as const;
export const RUNTIME_RECONCILIATION_CONTRACT =
  "cartograph.runtime-reconciliation" as const;
export const RUNTIME_RECONCILIATION_MEDIA_TYPE =
  "application/vnd.cartograph.runtime-reconciliation+json" as const;

export const RuntimeReconciliationClassificationSchema = z.enum([
  "observed-and-modeled",
  "modeled-not-observed",
  "observed-but-unmodeled",
  "ambiguous",
]);

export const RuntimeReconciliationUncertaintySchema = z.enum([
  "none",
  "unobserved",
  "unmapped",
  "ambiguous",
]);

const ReferenceSchema = z.string().trim().min(1).max(2_048);

export const RuntimeSpanBindingSchema = z
  .object({
    traceId: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{32}$/u),
    spanId: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{16}$/u),
    nodeId: z.string().trim().min(1).max(2_048),
    confidence: z.enum(["certain", "inferred"]),
  })
  .strict();

export const RuntimeReconciliationInputSchema = z
  .object({
    schemaVersion: z
      .literal(RUNTIME_RECONCILIATION_SCHEMA_VERSION)
      .default(RUNTIME_RECONCILIATION_SCHEMA_VERSION),
    staticSnapshot: GraphSnapshotSchema,
    runtimeTrace: RuntimeTraceSchema,
    bindings: z.array(RuntimeSpanBindingSchema).max(1_000_000).default([]),
  })
  .strict();

export const RuntimeReconciliationRecordSchema = z
  .object({
    id: ReferenceSchema,
    classification: RuntimeReconciliationClassificationSchema,
    staticEdgeIds: z.array(ReferenceSchema).max(100_000),
    staticEvidenceRefs: z.array(ReferenceSchema).max(100_000),
    traceRefs: z.array(ReferenceSchema).max(100_000),
    evidenceRefs: z.array(ReferenceSchema).min(1).max(200_000),
    observedCount: z.number().int().nonnegative(),
    uncertainty: RuntimeReconciliationUncertaintySchema,
    reason: z.string().trim().min(1).max(2_048),
  })
  .strict();

export const RuntimeReconciliationSummarySchema = z
  .object({
    staticEdges: z.number().int().nonnegative(),
    runtimeSpanEdges: z.number().int().nonnegative(),
    mappedSpans: z.number().int().nonnegative(),
    observedAndModeled: z.number().int().nonnegative(),
    modeledNotObserved: z.number().int().nonnegative(),
    observedButUnmodeled: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
  })
  .strict();

export const RuntimeReconciliationSchema = z
  .object({
    schemaVersion: z.literal(RUNTIME_RECONCILIATION_SCHEMA_VERSION),
    contract: z.literal(RUNTIME_RECONCILIATION_CONTRACT),
    mediaType: z.literal(RUNTIME_RECONCILIATION_MEDIA_TYPE),
    runtimeTraceSchemaVersion: z.literal(RUNTIME_TRACE_SCHEMA_VERSION),
    staticRevision: RevisionSchema,
    records: z.array(RuntimeReconciliationRecordSchema).max(200_000),
    summary: RuntimeReconciliationSummarySchema,
  })
  .strict();

export type RuntimeReconciliationClassification = z.infer<
  typeof RuntimeReconciliationClassificationSchema
>;
export type RuntimeReconciliationUncertainty = z.infer<
  typeof RuntimeReconciliationUncertaintySchema
>;
export type RuntimeSpanBinding = z.infer<typeof RuntimeSpanBindingSchema>;
export type RuntimeReconciliationInput = z.infer<
  typeof RuntimeReconciliationInputSchema
>;
export type RuntimeReconciliationRecord = z.infer<
  typeof RuntimeReconciliationRecordSchema
>;
export type RuntimeReconciliationSummary = z.infer<
  typeof RuntimeReconciliationSummarySchema
>;
export type RuntimeReconciliation = z.infer<typeof RuntimeReconciliationSchema>;

export type RuntimeReconciliationErrorCode =
  | "invalid-input"
  | "duplicate-binding"
  | "unknown-binding-span"
  | "unknown-binding-node";

export class RuntimeReconciliationError extends Error {
  readonly code: RuntimeReconciliationErrorCode;

  constructor(code: RuntimeReconciliationErrorCode, message: string) {
    super(message);
    this.name = "RuntimeReconciliationError";
    this.code = code;
  }
}

const issueText = (issues: z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path =
        issue.path.length > 0 ? issue.path.join(".") : "reconciliation";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

const traceRef = (span: RuntimeSpan): string =>
  `trace:${span.traceId}:${span.spanId}`;

const traceRefFor = (traceId: string, spanId: string): string =>
  `trace:${traceId}:${spanId}`;

const staticEdgeId = (edge: GraphEdge): string =>
  `edge:${edge.from}|${edge.kind}|${edge.to}`;

const staticEvidenceRefs = (edge: GraphEdge): string[] => {
  const refs = edge.evidence.map(
    (evidence) => `static-evidence:${evidence.id}`,
  );
  return refs.length > 0 ? refs : [`static-edge:${staticEdgeId(edge)}`];
};

const sortStrings = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

const canonicalizeReconciliation = (
  reconciliation: RuntimeReconciliation,
): RuntimeReconciliation => ({
  ...reconciliation,
  records: [...reconciliation.records].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  ),
});

const parseInput = (value: unknown): RuntimeReconciliationInput => {
  const parsed = RuntimeReconciliationInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeReconciliationError(
      "invalid-input",
      issueText(parsed.error.issues),
    );
  }
  return {
    ...parsed.data,
    staticSnapshot: canonicalizeGraphSnapshot(parsed.data.staticSnapshot),
    runtimeTrace: RuntimeTraceSchema.parse(parsed.data.runtimeTrace),
  };
};

type ObservedAggregate = {
  readonly endpointKey: string;
  readonly from: string;
  readonly to: string;
  readonly staticEdges: readonly GraphEdge[];
  readonly traceRefs: Set<string>;
  count: number;
};

const endpointKey = (from: string, to: string): string => `${from}\0${to}`;

const endpointReference = (from: string, to: string): string =>
  `${encodeURIComponent(from)}=>${encodeURIComponent(to)}`;

export const reconcileRuntimeTrace = (
  value: unknown,
): RuntimeReconciliation => {
  const input = parseInput(value);
  const staticNodes = new Set(
    input.staticSnapshot.nodes.map((node) => node.id),
  );
  const staticEdgesByEndpoint = new Map<string, GraphEdge[]>();
  for (const edge of input.staticSnapshot.edges) {
    const key = endpointKey(edge.from, edge.to);
    const candidates = staticEdgesByEndpoint.get(key) ?? [];
    candidates.push(edge);
    staticEdgesByEndpoint.set(key, candidates);
  }
  for (const candidates of staticEdgesByEndpoint.values()) {
    candidates.sort((left, right) =>
      staticEdgeId(left) < staticEdgeId(right)
        ? -1
        : staticEdgeId(left) > staticEdgeId(right)
          ? 1
          : 0,
    );
  }

  const spanByKey = new Map<string, RuntimeSpan>();
  for (const span of input.runtimeTrace.spans) {
    spanByKey.set(`${span.traceId}:${span.spanId}`, span);
  }
  const bindingBySpan = new Map<string, RuntimeSpanBinding>();
  for (const binding of input.bindings) {
    const key = `${binding.traceId}:${binding.spanId}`;
    if (bindingBySpan.has(key)) {
      throw new RuntimeReconciliationError(
        "duplicate-binding",
        `duplicate runtime span binding ${key}`,
      );
    }
    if (!spanByKey.has(key)) {
      throw new RuntimeReconciliationError(
        "unknown-binding-span",
        `runtime span binding references an unknown span ${key}`,
      );
    }
    if (!staticNodes.has(binding.nodeId)) {
      throw new RuntimeReconciliationError(
        "unknown-binding-node",
        `runtime span binding references an unknown static node ${binding.nodeId}`,
      );
    }
    bindingBySpan.set(key, binding);
  }

  const observed = new Map<string, ObservedAggregate>();
  const records: RuntimeReconciliationRecord[] = [];
  let runtimeSpanEdges = 0;
  for (const span of input.runtimeTrace.spans) {
    if (!span.parentSpanId) continue;
    runtimeSpanEdges += 1;
    const childKey = `${span.traceId}:${span.spanId}`;
    const parentKey = `${span.traceId}:${span.parentSpanId}`;
    const childBinding = bindingBySpan.get(childKey);
    const parentBinding = bindingBySpan.get(parentKey);
    const childRef = traceRef(span);
    const parentRef = traceRefFor(span.traceId, span.parentSpanId);
    if (!childBinding || !parentBinding) {
      records.push({
        id: `observed-but-unmodeled:${childRef}`,
        classification: "observed-but-unmodeled",
        staticEdgeIds: [],
        staticEvidenceRefs: [],
        traceRefs: sortStrings([childRef, parentRef]),
        evidenceRefs: sortStrings([childRef, parentRef]),
        observedCount: 1,
        uncertainty: "unmapped",
        reason: !spanByKey.has(parentKey)
          ? "runtime parent span is absent from the imported trace"
          : "runtime span or parent has no explicit static-node binding",
      });
      continue;
    }
    const key = endpointKey(parentBinding.nodeId, childBinding.nodeId);
    const existing = observed.get(key);
    if (existing) {
      existing.count += 1;
      existing.traceRefs.add(childRef);
      existing.traceRefs.add(parentRef);
      continue;
    }
    observed.set(key, {
      endpointKey: key,
      from: parentBinding.nodeId,
      to: childBinding.nodeId,
      staticEdges: staticEdgesByEndpoint.get(key) ?? [],
      traceRefs: new Set([childRef, parentRef]),
      count: 1,
    });
  }

  const observedStaticEdgeIds = new Set<string>();
  for (const aggregate of observed.values()) {
    const staticEdges = aggregate.staticEdges;
    const traceRefs = sortStrings(aggregate.traceRefs);
    if (staticEdges.length === 1) {
      const edge = staticEdges[0];
      if (!edge) {
        throw new RuntimeReconciliationError(
          "invalid-input",
          `static endpoint ${aggregate.endpointKey} has no edge record`,
        );
      }
      const edgeId = staticEdgeId(edge);
      observedStaticEdgeIds.add(edgeId);
      const staticRefs = staticEvidenceRefs(edge);
      records.push({
        id: `observed-and-modeled:${edgeId}`,
        classification: "observed-and-modeled",
        staticEdgeIds: [edgeId],
        staticEvidenceRefs: staticRefs,
        traceRefs,
        evidenceRefs: sortStrings([...staticRefs, ...traceRefs]),
        observedCount: aggregate.count,
        uncertainty: "none",
        reason: "runtime parent and child spans map to one static edge",
      });
      continue;
    }
    if (staticEdges.length > 1) {
      const edgeIds = staticEdges.map(staticEdgeId);
      const staticRefs = sortStrings(staticEdges.flatMap(staticEvidenceRefs));
      for (const edgeId of edgeIds) observedStaticEdgeIds.add(edgeId);
      records.push({
        id: `ambiguous:${endpointReference(aggregate.from, aggregate.to)}`,
        classification: "ambiguous",
        staticEdgeIds: sortStrings(edgeIds),
        staticEvidenceRefs: staticRefs,
        traceRefs,
        evidenceRefs: sortStrings([...staticRefs, ...traceRefs]),
        observedCount: aggregate.count,
        uncertainty: "ambiguous",
        reason:
          "runtime parent and child spans map to multiple static edges with the same endpoints",
      });
      continue;
    }
    records.push({
      id: `observed-but-unmodeled:${endpointReference(
        aggregate.from,
        aggregate.to,
      )}`,
      classification: "observed-but-unmodeled",
      staticEdgeIds: [],
      staticEvidenceRefs: [],
      traceRefs,
      evidenceRefs: traceRefs,
      observedCount: aggregate.count,
      uncertainty: "unmapped",
      reason:
        "runtime parent and child spans map to nodes without a static edge",
    });
  }

  for (const edge of input.staticSnapshot.edges) {
    const edgeId = staticEdgeId(edge);
    if (observedStaticEdgeIds.has(edgeId)) continue;
    const staticRefs = staticEvidenceRefs(edge);
    records.push({
      id: `modeled-not-observed:${edgeId}`,
      classification: "modeled-not-observed",
      staticEdgeIds: [edgeId],
      staticEvidenceRefs: staticRefs,
      traceRefs: [],
      evidenceRefs: staticRefs,
      observedCount: 0,
      uncertainty: "unobserved",
      reason:
        "static edge has no matching mapped runtime parent/child observation",
    });
  }

  const parsed = RuntimeReconciliationSchema.safeParse({
    schemaVersion: RUNTIME_RECONCILIATION_SCHEMA_VERSION,
    contract: RUNTIME_RECONCILIATION_CONTRACT,
    mediaType: RUNTIME_RECONCILIATION_MEDIA_TYPE,
    runtimeTraceSchemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
    staticRevision: input.staticSnapshot.revision,
    records,
    summary: {
      staticEdges: input.staticSnapshot.edges.length,
      runtimeSpanEdges,
      mappedSpans: bindingBySpan.size,
      observedAndModeled: records.filter(
        (record) => record.classification === "observed-and-modeled",
      ).length,
      modeledNotObserved: records.filter(
        (record) => record.classification === "modeled-not-observed",
      ).length,
      observedButUnmodeled: records.filter(
        (record) => record.classification === "observed-but-unmodeled",
      ).length,
      ambiguous: records.filter(
        (record) => record.classification === "ambiguous",
      ).length,
    },
  });
  if (!parsed.success) {
    throw new RuntimeReconciliationError(
      "invalid-input",
      issueText(parsed.error.issues),
    );
  }
  return canonicalizeReconciliation(parsed.data);
};

export const serializeRuntimeReconciliation = (value: unknown): string => {
  const parsed = RuntimeReconciliationSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeReconciliationError(
      "invalid-input",
      issueText(parsed.error.issues),
    );
  }
  return stableStringify(canonicalizeReconciliation(parsed.data));
};

export type RuntimeReconciliationRevision = Revision;
