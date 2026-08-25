import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";

import { ZodError, z } from "zod";

import {
  assertSupportedSchemaVersion,
  canonicalizeGraphSnapshot,
  GraphValidationError,
  stableStringify,
} from "./canonical.js";
import {
  SourceLocationSchema,
  GraphNodeSchema,
  type Diagnostic,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
} from "./schemas.js";
import {
  computeImpactSubgraph,
  type ImpactDirection,
  type ImpactSubgraph,
} from "./impact.js";
import {
  projectArchitectureQueryMetadata,
  ArchitectureQueryMetadataResultSchema,
  type ArchitectureQueryMetadataResult,
} from "./query-metadata.js";
import { createResourceBudget, ResourceLimitError } from "../resources.js";

export const ARCHITECTURE_QUERY_SCHEMA_VERSION = 1 as const;
export const ARCHITECTURE_QUERY_CONTRACT =
  "cartograph.architecture-query" as const;

export const ARCHITECTURE_QUERY_SUPPORTED_OPERATIONS = [
  "select-nodes",
  "select-edges",
  "neighbors",
  "reachability",
  "dependency-path",
  "boundary-crossing",
  "cycles",
] as const;

export const ARCHITECTURE_QUERY_UNSUPPORTED_OPERATIONS = [
  "source-body-search",
  "remote-query",
  "mutation",
] as const;

const QUERY_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u;
const MAX_SELECTOR_PREDICATES = 32;
const MAX_QUERY_IDENTIFIER_LENGTH = 160;
const MAX_SELECTOR_VALUE_LENGTH = 512;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;

export const ArchitectureQueryOperationSchema = z.enum([
  ...ARCHITECTURE_QUERY_SUPPORTED_OPERATIONS,
  ...ARCHITECTURE_QUERY_UNSUPPORTED_OPERATIONS,
]);

export const ArchitectureQueryStatusSchema = z.enum([
  "ok",
  "unsupported",
  "resource-limit",
]);

const QueryIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_QUERY_IDENTIFIER_LENGTH)
  .regex(QUERY_IDENTIFIER_PATTERN, "must be a portable lower-case identifier");

const QueryCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_QUERY_IDENTIFIER_LENGTH)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );

const SelectorValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SELECTOR_VALUE_LENGTH)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );

const QueryPortablePathSchema = SelectorValueSchema.refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z][A-Za-z\d+.-]*:/.test(value) &&
    !value.split("/").some((part) => part === ".."),
  "must be a repository-relative path",
);

const QueryPortableReferenceSchema = SelectorValueSchema.refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.startsWith("~") &&
    !/^[A-Za-z]:/.test(value) &&
    !/^file:/iu.test(value),
  "must not contain an absolute local reference",
);

const QueryContentHashSchema = z
  .string()
  .trim()
  .regex(/^(?:sha256:)?[0-9a-f]{64}$/iu, "must be a SHA-256 content hash");

const NODE_KINDS = [
  "endpoint",
  "module",
  "package",
  "service",
  "function",
  "database_table",
  "queue",
  "external_service",
  "file",
  "unknown",
] as const;
const NodeKindSchema = z.enum(NODE_KINDS);

const EDGE_KINDS = [
  "calls",
  "imports",
  "reads",
  "writes",
  "publishes",
  "subscribes",
  "requests",
  "contains",
  "routes_to",
  "depends_on",
  "implements",
  "unknown",
] as const;
const EdgeKindSchema = z.enum(EDGE_KINDS);

const ConfidenceSchema = z.enum([
  "certain",
  "inferred",
  "observed",
  "user_confirmed",
]);

const requirePredicateField = <T extends Record<string, unknown>>(
  predicate: T,
  context: z.RefinementCtx,
): void => {
  if (Object.values(predicate).every((value) => value === undefined)) {
    context.addIssue({
      code: "custom",
      message: "predicate must contain at least one field",
    });
  }
};

export const ArchitectureQueryNodePredicateSchema = z
  .object({
    id: SelectorValueSchema.optional(),
    stableKey: SelectorValueSchema.optional(),
    kind: NodeKindSchema.optional(),
    name: SelectorValueSchema.optional(),
    language: SelectorValueSchema.optional(),
    pathPrefix: QueryPortablePathSchema.optional(),
  })
  .strict()
  .superRefine(requirePredicateField);

export const ArchitectureQueryEdgePredicateSchema = z
  .object({
    from: SelectorValueSchema.optional(),
    to: SelectorValueSchema.optional(),
    kind: EdgeKindSchema.optional(),
    confidence: ConfidenceSchema.optional(),
    hasEvidence: z.boolean().optional(),
  })
  .strict()
  .superRefine(requirePredicateField);

export const ArchitectureQuerySelectorSchema = z
  .object({
    nodes: z
      .array(ArchitectureQueryNodePredicateSchema)
      .max(MAX_SELECTOR_PREDICATES)
      .default([]),
    edges: z
      .array(ArchitectureQueryEdgePredicateSchema)
      .max(MAX_SELECTOR_PREDICATES)
      .default([]),
  })
  .strict();

export const ArchitectureQueryLimitsSchema = z
  .object({
    maxDepth: z.number().int().nonnegative().max(64).default(8),
    maxNodes: z.number().int().positive().max(100_000).default(10_000),
    maxEdges: z.number().int().positive().max(200_000).default(20_000),
    maxTimeMs: z.number().int().positive().max(120_000).default(5_000),
    maxResultBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_RESULT_BYTES)
      .default(4 * 1024 * 1024),
  })
  .strict()
  .default({
    maxDepth: 8,
    maxNodes: 10_000,
    maxEdges: 20_000,
    maxTimeMs: 5_000,
    maxResultBytes: 4 * 1024 * 1024,
  });

export const ArchitectureQueryProjectionSchema = z
  .object({
    evidence: z.enum(["full", "summary", "none"]).default("full"),
    includeNodes: z.boolean().default(true),
    includeEdges: z.boolean().default(true),
    includeDiagnostics: z.boolean().default(true),
    metadata: z.enum(["full", "summary", "none"]).default("none"),
  })
  .strict()
  .default({
    evidence: "full",
    includeNodes: true,
    includeEdges: true,
    includeDiagnostics: true,
    metadata: "none",
  });

export const ArchitectureQueryOrderingSchema = z
  .object({
    nodes: z.literal("stableKey,id").default("stableKey,id"),
    edges: z.literal("from,to,kind").default("from,to,kind"),
    diagnostics: z.literal("id").default("id"),
    evidence: z.literal("id").default("id"),
  })
  .strict()
  .default({
    nodes: "stableKey,id",
    edges: "from,to,kind",
    diagnostics: "id",
    evidence: "id",
  });

const QueryTraversalDirectionSchema = z.enum([
  "forward",
  "reverse",
  "both",
  "downstream",
  "upstream",
]);

const QueryEdgeKindsSchema = z
  .array(EdgeKindSchema)
  .min(1)
  .max(EDGE_KINDS.length)
  .refine(
    (edgeKinds) => new Set(edgeKinds).size === edgeKinds.length,
    "edgeKinds must not contain duplicates",
  )
  .default([...EDGE_KINDS]);

export const ArchitectureQueryTraversalSchema = z
  .object({
    direction: QueryTraversalDirectionSchema.default("forward"),
    edgeKinds: QueryEdgeKindsSchema,
    includeUnresolved: z.boolean().default(true),
  })
  .strict()
  .default({
    direction: "forward",
    edgeKinds: [...EDGE_KINDS],
    includeUnresolved: true,
  });

const QueryNodeReferenceObjectSchema = z
  .object({
    id: SelectorValueSchema.optional(),
    stableKey: SelectorValueSchema.optional(),
  })
  .strict()
  .superRefine((reference, context) => {
    if (reference.id === undefined && reference.stableKey === undefined) {
      context.addIssue({
        code: "custom",
        message: "node reference must contain id or stableKey",
      });
    }
  });

export const ArchitectureQueryNodeReferenceSchema = z.union([
  SelectorValueSchema,
  QueryNodeReferenceObjectSchema,
]);

const QueryPathDirectionSchema = z.enum(["forward", "reverse"]);
const QueryPathEdgeKindsSchema = z
  .array(EdgeKindSchema)
  .min(1)
  .max(EDGE_KINDS.length)
  .refine(
    (edgeKinds) => new Set(edgeKinds).size === edgeKinds.length,
    "edgeKinds must not contain duplicates",
  )
  .default(["depends_on"]);

export const ArchitectureQueryPathSchema = z
  .object({
    from: ArchitectureQueryNodeReferenceSchema,
    to: ArchitectureQueryNodeReferenceSchema,
    direction: QueryPathDirectionSchema.default("forward"),
    edgeKinds: QueryPathEdgeKindsSchema,
    includeUnresolved: z.boolean().default(true),
  })
  .strict();

export const ArchitectureQuerySchema = z
  .object({
    schemaVersion: z.literal(ARCHITECTURE_QUERY_SCHEMA_VERSION),
    contract: z.literal(ARCHITECTURE_QUERY_CONTRACT),
    queryId: QueryIdentifierSchema,
    operation: ArchitectureQueryOperationSchema,
    snapshotSchemaVersion: z.literal(1).default(1),
    selectors: ArchitectureQuerySelectorSchema.default({
      nodes: [],
      edges: [],
    }),
    limits: ArchitectureQueryLimitsSchema,
    projection: ArchitectureQueryProjectionSchema,
    ordering: ArchitectureQueryOrderingSchema,
    traversal: ArchitectureQueryTraversalSchema,
    path: ArchitectureQueryPathSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.operation === "select-nodes" &&
      query.selectors.nodes.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectors", "nodes"],
        message: "select-nodes requires at least one node predicate",
      });
    }
    if (
      query.operation === "select-edges" &&
      query.selectors.edges.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectors", "edges"],
        message: "select-edges requires at least one edge predicate",
      });
    }
    if (
      ["neighbors", "reachability", "boundary-crossing", "cycles"].includes(
        query.operation,
      ) &&
      query.selectors.nodes.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectors", "nodes"],
        message: `${query.operation} requires at least one node predicate`,
      });
    }
    if (query.operation === "dependency-path" && query.path === undefined) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "dependency-path requires a from/to path specification",
      });
    }
    if (query.operation !== "dependency-path" && query.path !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "path is only valid for dependency-path queries",
      });
    }
  });

const QueryEvidenceKindSchema = z.enum(["source", "runtime", "git", "user"]);

export const ArchitectureQueryEvidenceSchema = z
  .object({
    id: SelectorValueSchema,
    kind: QueryEvidenceKindSchema,
    path: QueryPortablePathSchema.optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    endColumn: z.number().int().positive().optional(),
    location: SourceLocationSchema.optional(),
    revision: SelectorValueSchema.optional(),
    reference: QueryPortableReferenceSchema.optional(),
    observedAt: SelectorValueSchema.optional(),
    observedCount: z.number().int().nonnegative().optional(),
    detector: SelectorValueSchema.optional(),
    contentHash: QueryContentHashSchema.optional(),
  })
  .strict();

export const ArchitectureQueryEdgeSchema = z
  .object({
    from: SelectorValueSchema,
    to: SelectorValueSchema,
    kind: EdgeKindSchema,
    confidence: ConfidenceSchema,
    evidence: z.array(ArchitectureQueryEvidenceSchema).default([]),
    unresolvedReason: SelectorValueSchema.optional(),
  })
  .strict();

const QueryDiagnosticEdgeSchema = z
  .object({
    from: SelectorValueSchema,
    to: SelectorValueSchema,
    kind: EdgeKindSchema,
  })
  .strict();

export const ArchitectureQueryDiagnosticSchema = z
  .object({
    id: SelectorValueSchema,
    code: QueryCodeSchema,
    severity: z.enum(["info", "warning", "error"]),
    message: SelectorValueSchema,
    remediation: SelectorValueSchema.optional(),
    source: z.enum(["query", "snapshot"]).default("query"),
    operation: ArchitectureQueryOperationSchema.optional(),
    limit: z
      .enum(["maxDepth", "maxNodes", "maxEdges", "maxTimeMs", "maxResultBytes"])
      .optional(),
    nodeId: SelectorValueSchema.optional(),
    edge: QueryDiagnosticEdgeSchema.optional(),
    evidenceIds: z.array(SelectorValueSchema).max(64).default([]),
  })
  .strict();

export const ArchitectureQueryPathResultSchema = z
  .object({
    nodes: z.array(SelectorValueSchema).min(1).max(100_000),
    edges: z.array(ArchitectureQueryEdgeSchema).max(200_000),
    length: z.number().int().nonnegative(),
  })
  .strict();

export const ArchitectureQueryCycleSchema = z
  .object({
    nodes: z.array(SelectorValueSchema).min(2).max(100_000),
    edges: z.array(ArchitectureQueryEdgeSchema).min(1).max(200_000),
  })
  .strict();

export const ArchitectureQueryBoundarySchema = z
  .object({
    insideNodeId: SelectorValueSchema,
    outsideNodeId: SelectorValueSchema,
    direction: z.enum(["outbound", "inbound"]),
    edge: ArchitectureQueryEdgeSchema,
  })
  .strict();

export const ArchitectureQueryNodeDepthSchema = z
  .object({
    nodeId: SelectorValueSchema,
    depth: z.number().int().nonnegative(),
    root: z.boolean(),
  })
  .strict();

export const ArchitectureQueryResultSchema = z
  .object({
    schemaVersion: z.literal(ARCHITECTURE_QUERY_SCHEMA_VERSION),
    contract: z.literal(ARCHITECTURE_QUERY_CONTRACT),
    queryId: QueryIdentifierSchema,
    operation: ArchitectureQueryOperationSchema,
    status: ArchitectureQueryStatusSchema,
    ordering: ArchitectureQueryOrderingSchema,
    projection: ArchitectureQueryProjectionSchema,
    limits: ArchitectureQueryLimitsSchema,
    nodes: z.array(GraphNodeSchema).default([]),
    edges: z.array(ArchitectureQueryEdgeSchema).default([]),
    diagnostics: z.array(ArchitectureQueryDiagnosticSchema).default([]),
    paths: z.array(ArchitectureQueryPathResultSchema).default([]),
    cycles: z.array(ArchitectureQueryCycleSchema).default([]),
    boundaries: z.array(ArchitectureQueryBoundarySchema).default([]),
    nodeDepths: z.array(ArchitectureQueryNodeDepthSchema).default([]),
    truncated: z.boolean().default(false),
    truncatedEdges: z.array(ArchitectureQueryEdgeSchema).default([]),
    metadata: ArchitectureQueryMetadataResultSchema.optional(),
    unsupportedOperation: ArchitectureQueryOperationSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.status === "unsupported" &&
      result.unsupportedOperation === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["unsupportedOperation"],
        message: "unsupported results must identify the operation",
      });
    }
    if (
      result.status !== "unsupported" &&
      result.unsupportedOperation !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["unsupportedOperation"],
        message: "only unsupported results may identify unsupportedOperation",
      });
    }
  });

export type ArchitectureQueryOperation = z.infer<
  typeof ArchitectureQueryOperationSchema
>;
export type ArchitectureQueryStatus = z.infer<
  typeof ArchitectureQueryStatusSchema
>;
export type ArchitectureQueryNodePredicate = z.infer<
  typeof ArchitectureQueryNodePredicateSchema
>;
export type ArchitectureQueryEdgePredicate = z.infer<
  typeof ArchitectureQueryEdgePredicateSchema
>;
export type ArchitectureQueryNodeReference = z.infer<
  typeof ArchitectureQueryNodeReferenceSchema
>;
export type ArchitectureQueryPath = z.infer<typeof ArchitectureQueryPathSchema>;
export type ArchitectureQuery = z.infer<typeof ArchitectureQuerySchema>;
export type ArchitectureQueryEvidence = z.infer<
  typeof ArchitectureQueryEvidenceSchema
>;
export type ArchitectureQueryEdge = z.infer<typeof ArchitectureQueryEdgeSchema>;
export type ArchitectureQueryDiagnostic = z.infer<
  typeof ArchitectureQueryDiagnosticSchema
>;
export type ArchitectureQueryPathResult = z.infer<
  typeof ArchitectureQueryPathResultSchema
>;
export type ArchitectureQueryCycle = z.infer<
  typeof ArchitectureQueryCycleSchema
>;
export type ArchitectureQueryBoundary = z.infer<
  typeof ArchitectureQueryBoundarySchema
>;
export type ArchitectureQueryNodeDepth = z.infer<
  typeof ArchitectureQueryNodeDepthSchema
>;
export type ArchitectureQueryMetadata = ArchitectureQueryMetadataResult;
export type ArchitectureQueryResult = z.infer<
  typeof ArchitectureQueryResultSchema
>;

const parseQueryContract = <T>(
  parse: (input: unknown) => T,
  input: unknown,
  contract: string,
): T => {
  try {
    return parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new GraphValidationError(
        contract,
        error.issues.map((issue) => ({
          path: issue.path.map((part) =>
            typeof part === "symbol" ? part.toString() : part,
          ),
          message: issue.message,
        })),
      );
    }
    throw error;
  }
};

export const parseArchitectureQuery = (input: unknown): ArchitectureQuery => {
  assertSupportedSchemaVersion(
    input,
    ARCHITECTURE_QUERY_CONTRACT,
    ARCHITECTURE_QUERY_SCHEMA_VERSION,
  );
  return parseQueryContract(
    (value) => ArchitectureQuerySchema.parse(value),
    input,
    "ArchitectureQuery",
  );
};

export const serializeArchitectureQuery = (input: unknown): string =>
  stableStringify(parseArchitectureQuery(input));

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const compareNodes = (left: GraphNode, right: GraphNode): number => {
  const stableKeyOrder = compareStrings(left.stableKey, right.stableKey);
  return stableKeyOrder === 0
    ? compareStrings(left.id, right.id)
    : stableKeyOrder;
};

const compareEdges = (
  left: Pick<GraphEdge, "from" | "to" | "kind">,
  right: Pick<GraphEdge, "from" | "to" | "kind">,
): number => {
  const fromOrder = compareStrings(left.from, right.from);
  if (fromOrder !== 0) return fromOrder;
  const toOrder = compareStrings(left.to, right.to);
  if (toOrder !== 0) return toOrder;
  return compareStrings(left.kind, right.kind);
};

const compareDiagnostics = (
  left: ArchitectureQueryDiagnostic,
  right: ArchitectureQueryDiagnostic,
): number => compareStrings(left.id, right.id);

const matchesNode = (
  node: GraphNode,
  predicate: ArchitectureQueryNodePredicate,
): boolean =>
  (predicate.id === undefined || predicate.id === node.id) &&
  (predicate.stableKey === undefined ||
    predicate.stableKey === node.stableKey) &&
  (predicate.kind === undefined || predicate.kind === node.kind) &&
  (predicate.name === undefined || predicate.name === node.name) &&
  (predicate.language === undefined || predicate.language === node.language) &&
  (predicate.pathPrefix === undefined ||
    node.location?.path.startsWith(predicate.pathPrefix) === true);

const matchesEdge = (
  edge: GraphEdge,
  predicate: ArchitectureQueryEdgePredicate,
): boolean =>
  (predicate.from === undefined || predicate.from === edge.from) &&
  (predicate.to === undefined || predicate.to === edge.to) &&
  (predicate.kind === undefined || predicate.kind === edge.kind) &&
  (predicate.confidence === undefined ||
    predicate.confidence === edge.confidence) &&
  (predicate.hasEvidence === undefined ||
    predicate.hasEvidence === edge.evidence.length > 0);

const projectEvidence = (
  evidence: Evidence,
  projection: ArchitectureQuery["projection"]["evidence"],
): ArchitectureQueryEvidence => {
  if (projection === "full") return { ...evidence };
  if (projection === "none") return { id: evidence.id, kind: evidence.kind };
  return {
    id: evidence.id,
    kind: evidence.kind,
    ...(evidence.path === undefined ? {} : { path: evidence.path }),
    ...(evidence.line === undefined ? {} : { line: evidence.line }),
    ...(evidence.detector === undefined ? {} : { detector: evidence.detector }),
    ...(evidence.contentHash === undefined
      ? {}
      : { contentHash: evidence.contentHash }),
  };
};

const projectEdge = (
  edge: GraphEdge,
  projection: ArchitectureQuery["projection"]["evidence"],
): ArchitectureQueryEdge => ({
  from: edge.from,
  to: edge.to,
  kind: edge.kind,
  confidence: edge.confidence,
  evidence: edge.evidence
    .map((evidence) => projectEvidence(evidence, projection))
    .sort((left, right) => compareStrings(left.id, right.id)),
  ...(edge.unresolvedReason === undefined
    ? {}
    : { unresolvedReason: edge.unresolvedReason }),
});

const projectDiagnostic = (
  diagnostic: Diagnostic,
): ArchitectureQueryDiagnostic => ({
  id: `snapshot:${diagnostic.id}`,
  code: diagnostic.code,
  severity: diagnostic.severity,
  message: diagnostic.message,
  ...(diagnostic.remediation === undefined
    ? {}
    : { remediation: diagnostic.remediation }),
  source: "snapshot",
  ...(diagnostic.nodeId === undefined ? {} : { nodeId: diagnostic.nodeId }),
  ...(diagnostic.edge === undefined ? {} : { edge: diagnostic.edge }),
  evidenceIds: diagnostic.evidence.map((evidence) => evidence.id),
});

const queryDiagnostic = (
  query: ArchitectureQuery,
  code: string,
  message: string,
  severity: ArchitectureQueryDiagnostic["severity"],
  options: Partial<
    Pick<
      ArchitectureQueryDiagnostic,
      "limit" | "operation" | "remediation" | "nodeId" | "edge" | "evidenceIds"
    >
  > = {},
): ArchitectureQueryDiagnostic => ({
  id: `query:${query.queryId}:${code.toLowerCase()}`,
  code,
  severity,
  message,
  source: "query",
  operation: query.operation,
  evidenceIds: [],
  ...options,
});

type QueryResultDetails = Partial<
  Pick<
    ArchitectureQueryResult,
    | "paths"
    | "cycles"
    | "boundaries"
    | "nodeDepths"
    | "truncated"
    | "truncatedEdges"
    | "metadata"
  >
>;

const buildResult = (
  query: ArchitectureQuery,
  status: ArchitectureQueryStatus,
  nodes: readonly GraphNode[],
  edges: readonly ArchitectureQueryEdge[],
  diagnostics: readonly ArchitectureQueryDiagnostic[],
  unsupportedOperation?: ArchitectureQueryOperation,
  details: QueryResultDetails = {},
): ArchitectureQueryResult => {
  const result = {
    schemaVersion: ARCHITECTURE_QUERY_SCHEMA_VERSION,
    contract: ARCHITECTURE_QUERY_CONTRACT,
    queryId: query.queryId,
    operation: query.operation,
    status,
    ordering: query.ordering,
    projection: query.projection,
    limits: query.limits,
    nodes: [...nodes].sort(compareNodes),
    edges: [...edges].sort((left, right) => compareEdges(left, right)),
    diagnostics: [...diagnostics].sort(compareDiagnostics),
    paths: details.paths ?? [],
    cycles: details.cycles ?? [],
    boundaries: details.boundaries ?? [],
    nodeDepths: [...(details.nodeDepths ?? [])].sort((left, right) => {
      const depthOrder = left.depth - right.depth;
      return depthOrder !== 0
        ? depthOrder
        : compareStrings(left.nodeId, right.nodeId);
    }),
    truncated: details.truncated ?? false,
    truncatedEdges: [...(details.truncatedEdges ?? [])].sort((left, right) =>
      compareEdges(left, right),
    ),
    ...(details.metadata === undefined ? {} : { metadata: details.metadata }),
    ...(unsupportedOperation === undefined ? {} : { unsupportedOperation }),
  };
  return parseQueryContract(
    (input) => ArchitectureQueryResultSchema.parse(input),
    result,
    "ArchitectureQueryResult",
  );
};

const selectedSnapshotDiagnostics = (
  snapshot: GraphSnapshot,
  nodeIds: ReadonlySet<string>,
  edges: readonly GraphEdge[],
): ArchitectureQueryDiagnostic[] => {
  const edgeKeys = new Set(
    edges.map((edge) => `${edge.from}\0${edge.to}\0${edge.kind}`),
  );
  return snapshot.diagnostics
    .filter(
      (diagnostic) =>
        (diagnostic.nodeId !== undefined && nodeIds.has(diagnostic.nodeId)) ||
        (diagnostic.edge !== undefined &&
          edgeKeys.has(
            `${diagnostic.edge.from}\0${diagnostic.edge.to}\0${diagnostic.edge.kind}`,
          )),
    )
    .map(projectDiagnostic);
};

const limitResult = (
  query: ArchitectureQuery,
  limit: ArchitectureQueryDiagnostic["limit"],
  message: string,
): ArchitectureQueryResult =>
  buildResult(
    query,
    "resource-limit",
    [],
    [],
    [
      queryDiagnostic(query, "QUERY_RESOURCE_LIMIT", message, "error", {
        limit,
      }),
    ],
  );

const normalizeTraversalDirection = (
  direction: ArchitectureQuery["traversal"]["direction"],
): "forward" | "reverse" | "both" => {
  if (direction === "downstream") return "forward";
  if (direction === "upstream") return "reverse";
  return direction;
};

const nodeReferenceParts = (
  reference: ArchitectureQueryNodeReference,
): { id: string | undefined; stableKey: string | undefined } =>
  typeof reference === "string"
    ? { id: reference, stableKey: reference }
    : { id: reference.id, stableKey: reference.stableKey };

const resolveNodeReference = (
  snapshot: GraphSnapshot,
  reference: ArchitectureQueryNodeReference,
): GraphNode | undefined => {
  const parts = nodeReferenceParts(reference);
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const byStableKey = new Map(
    snapshot.nodes.map((node) => [node.stableKey, node]),
  );
  return (
    (parts.id === undefined ? undefined : byId.get(parts.id)) ??
    (parts.stableKey === undefined
      ? undefined
      : byStableKey.get(parts.stableKey))
  );
};

const selectQueryNodes = (
  snapshot: GraphSnapshot,
  predicates: readonly ArchitectureQueryNodePredicate[],
): GraphNode[] =>
  snapshot.nodes
    .filter((node) =>
      predicates.some((predicate) => matchesNode(node, predicate)),
    )
    .sort(compareNodes);

const filteredTraversalSnapshot = (
  snapshot: GraphSnapshot,
  edgeKinds: readonly GraphEdge["kind"][],
): GraphSnapshot => {
  if (edgeKinds.length === EDGE_KINDS.length) return snapshot;
  const allowed = new Set(edgeKinds);
  return {
    ...snapshot,
    edges: snapshot.edges.filter((edge) => allowed.has(edge.kind)),
  };
};

const edgeResultKey = (edge: Pick<GraphEdge, "from" | "to" | "kind">): string =>
  `${edge.from}\0${edge.to}\0${edge.kind}`;

type TraversalAggregate = {
  nodes: GraphNode[];
  nodeDepths: ArchitectureQueryNodeDepth[];
  edges: GraphEdge[];
  cycles: ArchitectureQueryCycle[];
  truncatedEdges: GraphEdge[];
  truncated: boolean;
};

const stripImpactNode = (node: ImpactSubgraph["nodes"][number]): GraphNode => ({
  id: node.id,
  stableKey: node.stableKey,
  kind: node.kind,
  name: node.name,
  ...(node.language === undefined ? {} : { language: node.language }),
  ...(node.location === undefined ? {} : { location: node.location }),
});

const aggregateImpacts = (
  impacts: readonly ImpactSubgraph[],
  evidenceProjection: ArchitectureQuery["projection"]["evidence"],
): TraversalAggregate => {
  const nodes = new Map<
    string,
    { node: GraphNode; depth: number; root: boolean }
  >();
  const edges = new Map<string, GraphEdge>();
  const truncatedEdges = new Map<string, GraphEdge>();
  const cycles = new Map<string, ArchitectureQueryCycle>();

  for (const impact of impacts) {
    for (const node of impact.nodes) {
      const graphNode = stripImpactNode(node);
      const existing = nodes.get(node.id);
      if (existing === undefined || node.depth < existing.depth) {
        nodes.set(node.id, {
          node: graphNode,
          depth: node.depth,
          root: existing?.root === true || node.root,
        });
      } else if (node.root) {
        existing.root = true;
      }
    }
    for (const edge of impact.edges) edges.set(edgeResultKey(edge), edge);
    for (const edge of impact.depthLimitedEdges)
      truncatedEdges.set(edgeResultKey(edge), edge);
    for (const cycle of impact.cycles) {
      const projected: ArchitectureQueryCycle = {
        nodes: [...cycle.nodes],
        edges: cycle.edges.map((edge) => projectEdge(edge, evidenceProjection)),
      };
      const identity = stableStringify([
        projected.nodes,
        projected.edges.map(edgeResultKey),
      ]);
      cycles.set(identity, projected);
    }
  }

  const nodeDepths = [...nodes.values()].map(({ node, depth, root }) => ({
    nodeId: node.id,
    depth,
    root,
  }));
  return {
    nodes: [...nodes.values()].map(({ node }) => node).sort(compareNodes),
    nodeDepths,
    edges: [...edges.values()].sort(compareEdges),
    cycles: [...cycles.values()].sort((left, right) =>
      compareStrings(
        stableStringify([left.nodes, left.edges.map(edgeResultKey)]),
        stableStringify([right.nodes, right.edges.map(edgeResultKey)]),
      ),
    ),
    truncatedEdges: [...truncatedEdges.values()].sort(compareEdges),
    truncated: truncatedEdges.size > 0,
  };
};

const truncationDiagnostics = (
  query: ArchitectureQuery,
  edges: readonly GraphEdge[],
): ArchitectureQueryDiagnostic[] =>
  edges.map((edge) =>
    queryDiagnostic(
      query,
      "QUERY_TRUNCATED",
      `traversal stopped at maxDepth ${query.limits.maxDepth}; edge ${edge.from} -> ${edge.to} remains outside the returned node set`,
      "warning",
      {
        limit: "maxDepth",
        edge: { from: edge.from, to: edge.to, kind: edge.kind },
        evidenceIds: edge.evidence.map((evidence) => evidence.id),
      },
    ),
  );

const resourceLimitFromError = (
  error: unknown,
): { limit: ArchitectureQueryDiagnostic["limit"]; message: string } => {
  const message = error instanceof Error ? error.message : String(error);
  if (/node ceiling/iu.test(message)) return { limit: "maxNodes", message };
  if (/edge ceiling/iu.test(message)) return { limit: "maxEdges", message };
  if (/wall-clock|time ceiling|timed out/iu.test(message))
    return { limit: "maxTimeMs", message };
  return { limit: "maxTimeMs", message };
};

const resultWithByteLimit = (
  query: ArchitectureQuery,
  result: ArchitectureQueryResult,
): ArchitectureQueryResult =>
  Buffer.byteLength(stableStringify(result), "utf8") >
  query.limits.maxResultBytes
    ? limitResult(
        query,
        "maxResultBytes",
        `query result exceeds the ${query.limits.maxResultBytes} byte output ceiling`,
      )
    : result;

const pathResult = (
  query: ArchitectureQuery,
  snapshot: GraphSnapshot,
  budget: () => void,
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths: ArchitectureQueryPathResult[];
  diagnostics: ArchitectureQueryDiagnostic[];
  truncated: boolean;
} => {
  const path = query.path;
  if (path === undefined)
    throw new Error("validated dependency path is missing");
  const from = resolveNodeReference(snapshot, path.from);
  const to = resolveNodeReference(snapshot, path.to);
  if (from === undefined || to === undefined) {
    const missing = from === undefined ? path.from : path.to;
    return {
      nodes: [],
      edges: [],
      paths: [],
      diagnostics: [
        queryDiagnostic(
          query,
          "QUERY_NODE_NOT_FOUND",
          `dependency path node does not match the snapshot: ${typeof missing === "string" ? missing : JSON.stringify(missing)}`,
          "error",
        ),
      ],
      truncated: false,
    };
  }
  if (from.id === to.id) {
    return {
      nodes: [from],
      edges: [],
      paths: [{ nodes: [from.id], edges: [], length: 0 }],
      diagnostics: [],
      truncated: false,
    };
  }

  const allowed = new Set(path.edgeKinds);
  const direction = path.direction;
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of snapshot.edges) {
    if (!allowed.has(edge.kind)) continue;
    const key = direction === "forward" ? edge.from : edge.to;
    const outgoing = adjacency.get(key) ?? [];
    outgoing.push(edge);
    adjacency.set(key, outgoing);
  }
  for (const outgoing of adjacency.values()) outgoing.sort(compareEdges);

  const queue = [from.id];
  const depthByNode = new Map([[from.id, 0]]);
  const predecessor = new Map<string, { nodeId: string; edge: GraphEdge }>();
  let traversedEdges = 0;
  let truncated = false;
  while (queue.length > 0) {
    budget();
    const current = queue.shift();
    if (current === undefined) break;
    const depth = depthByNode.get(current) ?? 0;
    if (depth >= query.limits.maxDepth) {
      if ((adjacency.get(current) ?? []).length > 0) truncated = true;
      continue;
    }
    for (const edge of adjacency.get(current) ?? []) {
      budget();
      traversedEdges += 1;
      if (traversedEdges > query.limits.maxEdges) {
        throw new ResourceLimitError(
          `dependency path exceeds the ${query.limits.maxEdges.toLocaleString("en-US")} edge ceiling`,
        );
      }
      if (edge.evidence.length === 0 && !path.includeUnresolved) continue;
      const next = direction === "forward" ? edge.to : edge.from;
      if (depthByNode.has(next)) continue;
      depthByNode.set(next, depth + 1);
      predecessor.set(next, { nodeId: current, edge });
      if (depthByNode.size > query.limits.maxNodes) {
        throw new ResourceLimitError(
          `dependency path exceeds the ${query.limits.maxNodes.toLocaleString("en-US")} node ceiling`,
        );
      }
      if (next === to.id) {
        queue.length = 0;
        break;
      }
      queue.push(next);
    }
  }

  const targetDepth = depthByNode.get(to.id);
  if (targetDepth === undefined) {
    const diagnostics = [
      queryDiagnostic(
        query,
        "QUERY_PATH_NOT_FOUND",
        `no dependency path was found from ${from.id} to ${to.id}`,
        "info",
      ),
    ];
    if (truncated)
      diagnostics.push(
        queryDiagnostic(
          query,
          "QUERY_TRUNCATED",
          `dependency path search reached maxDepth ${query.limits.maxDepth} before finding a target`,
          "warning",
          { limit: "maxDepth" },
        ),
      );
    return {
      nodes: [],
      edges: [],
      paths: [],
      diagnostics,
      truncated,
    };
  }

  const pathNodes = [to.id];
  const pathEdges: GraphEdge[] = [];
  let current = to.id;
  while (current !== from.id) {
    const previous = predecessor.get(current);
    if (previous === undefined) break;
    pathNodes.push(previous.nodeId);
    pathEdges.push(previous.edge);
    current = previous.nodeId;
  }
  pathNodes.reverse();
  pathEdges.reverse();
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  return {
    nodes: pathNodes
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is GraphNode => node !== undefined),
    edges: pathEdges,
    paths: [
      {
        nodes: pathNodes,
        edges: pathEdges.map((edge) =>
          projectEdge(edge, query.projection.evidence),
        ),
        length: targetDepth,
      },
    ],
    diagnostics: [],
    truncated: false,
  };
};

const boundaryResult = (
  query: ArchitectureQuery,
  snapshot: GraphSnapshot,
  budget: () => void,
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  boundaries: ArchitectureQueryBoundary[];
} => {
  const inside = new Set(
    selectQueryNodes(snapshot, query.selectors.nodes).map((node) => node.id),
  );
  const allowed = new Set(query.traversal.edgeKinds);
  const direction = normalizeTraversalDirection(query.traversal.direction);
  const boundaries = new Map<string, ArchitectureQueryBoundary>();
  for (const edge of snapshot.edges) {
    budget();
    if (!allowed.has(edge.kind)) continue;
    if (edge.evidence.length === 0 && !query.traversal.includeUnresolved)
      continue;
    const fromInside = inside.has(edge.from);
    const toInside = inside.has(edge.to);
    if (fromInside === toInside) continue;
    const crossingDirection = fromInside ? "outbound" : "inbound";
    if (
      (direction === "forward" && crossingDirection !== "outbound") ||
      (direction === "reverse" && crossingDirection !== "inbound")
    )
      continue;
    const boundary: ArchitectureQueryBoundary = {
      insideNodeId: fromInside ? edge.from : edge.to,
      outsideNodeId: fromInside ? edge.to : edge.from,
      direction: crossingDirection,
      edge: projectEdge(edge, query.projection.evidence),
    };
    boundaries.set(
      `${boundary.insideNodeId}\0${boundary.outsideNodeId}\0${edge.kind}`,
      boundary,
    );
  }
  const sortedBoundaries = [...boundaries.values()].sort((left, right) =>
    compareStrings(
      stableStringify([left.insideNodeId, left.outsideNodeId, left.edge.kind]),
      stableStringify([
        right.insideNodeId,
        right.outsideNodeId,
        right.edge.kind,
      ]),
    ),
  );
  const edgeValues = sortedBoundaries.map((boundary) => boundary.edge);
  const nodeIds = new Set(edgeValues.flatMap((edge) => [edge.from, edge.to]));
  return {
    nodes: snapshot.nodes
      .filter((node) => nodeIds.has(node.id))
      .sort(compareNodes),
    edges: snapshot.edges
      .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
      .filter(
        (edge) =>
          boundaries.has(`${edge.from}\0${edge.to}\0${edge.kind}`) ||
          boundaries.has(`${edge.to}\0${edge.from}\0${edge.kind}`),
      )
      .sort(compareEdges),
    boundaries: sortedBoundaries,
  };
};

const executeTraversal = (
  query: ArchitectureQuery,
  snapshot: GraphSnapshot,
  budget: () => void,
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: ArchitectureQueryDiagnostic[];
  details: QueryResultDetails;
} => {
  if (query.operation === "dependency-path") {
    const result = pathResult(query, snapshot, budget);
    return {
      nodes: result.nodes,
      edges: result.edges,
      diagnostics: result.diagnostics,
      details: {
        paths: result.paths,
        truncated: result.truncated,
      },
    };
  }
  if (query.operation === "boundary-crossing") {
    const result = boundaryResult(query, snapshot, budget);
    if (result.nodes.length > query.limits.maxNodes)
      throw new ResourceLimitError(
        `boundary crossing exceeds the ${query.limits.maxNodes.toLocaleString("en-US")} node ceiling`,
      );
    if (result.edges.length > query.limits.maxEdges)
      throw new ResourceLimitError(
        `boundary crossing exceeds the ${query.limits.maxEdges.toLocaleString("en-US")} edge ceiling`,
      );
    return {
      nodes: result.nodes,
      edges: result.edges,
      diagnostics: [],
      details: { boundaries: result.boundaries },
    };
  }

  const rootNodes = selectQueryNodes(snapshot, query.selectors.nodes);
  const direction = normalizeTraversalDirection(query.traversal.direction);
  const directions: ImpactDirection[] =
    direction === "both" ? ["forward", "reverse"] : [direction];
  const traversalSnapshot = filteredTraversalSnapshot(
    snapshot,
    query.traversal.edgeKinds,
  );
  const impacts: ImpactSubgraph[] = [];
  for (const traversalDirection of directions) {
    budget();
    if (rootNodes.length === 0) break;
    impacts.push(
      computeImpactSubgraph(traversalSnapshot, {
        roots: rootNodes.map((node) => node.id),
        direction: traversalDirection,
        maxDepth:
          query.operation === "neighbors"
            ? Math.min(1, query.limits.maxDepth)
            : query.limits.maxDepth,
        maxNodes: query.limits.maxNodes,
        maxEdges: query.limits.maxEdges,
        includeUnresolved: query.traversal.includeUnresolved,
      }),
    );
    budget();
  }
  const aggregate = aggregateImpacts(impacts, query.projection.evidence);
  if (aggregate.nodes.length > query.limits.maxNodes)
    throw new ResourceLimitError(
      `query traversal exceeds the ${query.limits.maxNodes.toLocaleString("en-US")} node ceiling`,
    );
  if (aggregate.edges.length > query.limits.maxEdges)
    throw new ResourceLimitError(
      `query traversal exceeds the ${query.limits.maxEdges.toLocaleString("en-US")} edge ceiling`,
    );
  const truncatedEdgeKeys = new Set(
    aggregate.truncatedEdges.map((edge) => edgeResultKey(edge)),
  );
  const resultEdges =
    query.operation === "neighbors"
      ? aggregate.edges.filter(
          (edge) => !truncatedEdgeKeys.has(edgeResultKey(edge)),
        )
      : aggregate.edges;
  return {
    nodes: aggregate.nodes,
    edges: resultEdges,
    diagnostics: truncationDiagnostics(query, aggregate.truncatedEdges),
    details: {
      cycles: aggregate.cycles,
      nodeDepths: aggregate.nodeDepths,
      truncated: aggregate.truncated,
      truncatedEdges: aggregate.truncatedEdges.map((edge) =>
        projectEdge(edge, query.projection.evidence),
      ),
    },
  };
};

/** Execute a local, read-only architecture query with bounded traversal. */
export const executeArchitectureQuery = (
  snapshotInput: unknown,
  queryInput: unknown,
  metadataInput?: unknown,
): ArchitectureQueryResult => {
  const query = parseArchitectureQuery(queryInput);
  const snapshot = canonicalizeGraphSnapshot(snapshotInput);

  if (
    !ARCHITECTURE_QUERY_SUPPORTED_OPERATIONS.some(
      (op) => op === query.operation,
    )
  ) {
    return buildResult(
      query,
      "unsupported",
      [],
      [],
      [
        queryDiagnostic(
          query,
          "QUERY_OPERATION_UNSUPPORTED",
          `query operation ${query.operation} is reserved for a later contract implementation`,
          "warning",
          {
            remediation:
              "Use select-nodes or select-edges, or wait for the roadmap operation to be implemented.",
          },
        ),
      ],
      query.operation,
    );
  }

  const startedAt = performance.now();
  const budget = createResourceBudget({
    maxWallClockMs: query.limits.maxTimeMs,
    subject: `architecture query ${query.queryId}`,
  });
  const enforceBudget = (): void => {
    budget();
    if (performance.now() - startedAt > query.limits.maxTimeMs) {
      throw new ResourceLimitError(
        `architecture query exceeded the ${query.limits.maxTimeMs} ms time ceiling`,
      );
    }
  };

  const traversalOperation = [
    "neighbors",
    "reachability",
    "dependency-path",
    "boundary-crossing",
    "cycles",
  ].includes(query.operation);
  if (traversalOperation) {
    try {
      const execution = executeTraversal(query, snapshot, enforceBudget);
      const nodeIds = new Set(execution.nodes.map((node) => node.id));
      const resultDiagnostics = [
        ...(query.projection.includeDiagnostics
          ? selectedSnapshotDiagnostics(snapshot, nodeIds, execution.edges)
          : []),
        ...execution.diagnostics,
      ];
      const detailProjection: QueryResultDetails = { ...execution.details };
      if (execution.details.paths !== undefined) {
        detailProjection.paths = execution.details.paths.map((path) => ({
          ...path,
          edges: query.projection.includeEdges ? path.edges : [],
        }));
      }
      if (execution.details.cycles !== undefined) {
        detailProjection.cycles = execution.details.cycles;
      }
      if (execution.details.truncatedEdges !== undefined) {
        detailProjection.truncatedEdges = query.projection.includeEdges
          ? execution.details.truncatedEdges
          : [];
      }
      if (query.projection.metadata !== "none") {
        detailProjection.metadata = projectArchitectureQueryMetadata(
          metadataInput,
          { nodes: execution.nodes, edges: execution.edges },
        );
      }
      const result = buildResult(
        query,
        "ok",
        query.projection.includeNodes ? execution.nodes : [],
        query.projection.includeEdges
          ? execution.edges.map((edge) =>
              projectEdge(edge, query.projection.evidence),
            )
          : [],
        resultDiagnostics,
        undefined,
        detailProjection,
      );
      enforceBudget();
      return resultWithByteLimit(query, result);
    } catch (error) {
      if (error instanceof ResourceLimitError) {
        const resource = resourceLimitFromError(error);
        return limitResult(query, resource.limit, resource.message);
      }
      throw error;
    }
  }

  const selectedNodes =
    query.operation === "select-nodes"
      ? snapshot.nodes.filter((node) =>
          query.selectors.nodes.some((predicate) =>
            matchesNode(node, predicate),
          ),
        )
      : [];
  const selectedEdges =
    query.operation === "select-edges"
      ? snapshot.edges.filter((edge) =>
          query.selectors.edges.some((predicate) =>
            matchesEdge(edge, predicate),
          ),
        )
      : [];
  const resultNodes =
    query.operation === "select-edges"
      ? (() => {
          const ids = new Set(
            selectedEdges.flatMap((edge) => [edge.from, edge.to]),
          );
          return snapshot.nodes.filter((node) => ids.has(node.id));
        })()
      : selectedNodes;

  if (resultNodes.length > query.limits.maxNodes)
    return limitResult(
      query,
      "maxNodes",
      `query result contains ${resultNodes.length} nodes, exceeding the ${query.limits.maxNodes} node ceiling`,
    );
  if (selectedEdges.length > query.limits.maxEdges)
    return limitResult(
      query,
      "maxEdges",
      `query result contains ${selectedEdges.length} edges, exceeding the ${query.limits.maxEdges} edge ceiling`,
    );

  const nodeIds = new Set(resultNodes.map((node) => node.id));
  const diagnostics = query.projection.includeDiagnostics
    ? selectedSnapshotDiagnostics(snapshot, nodeIds, selectedEdges)
    : [];
  const metadata =
    query.projection.metadata === "none"
      ? undefined
      : projectArchitectureQueryMetadata(metadataInput, {
          nodes: resultNodes,
          edges: selectedEdges,
        });
  const result = buildResult(
    query,
    "ok",
    query.projection.includeNodes ? resultNodes : [],
    query.projection.includeEdges
      ? selectedEdges.map((edge) =>
          projectEdge(edge, query.projection.evidence),
        )
      : [],
    diagnostics,
    undefined,
    metadata === undefined ? {} : { metadata },
  );
  return resultWithByteLimit(query, result);
};

export const serializeArchitectureQueryResult = (input: unknown): string =>
  stableStringify(
    parseQueryContract(
      (value) => ArchitectureQueryResultSchema.parse(value),
      input,
      "ArchitectureQueryResult",
    ),
  );
