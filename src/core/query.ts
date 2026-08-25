import { Buffer } from "node:buffer";

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

export const ARCHITECTURE_QUERY_SCHEMA_VERSION = 1 as const;
export const ARCHITECTURE_QUERY_CONTRACT =
  "cartograph.architecture-query" as const;

export const ARCHITECTURE_QUERY_SUPPORTED_OPERATIONS = [
  "select-nodes",
  "select-edges",
] as const;

export const ARCHITECTURE_QUERY_UNSUPPORTED_OPERATIONS = [
  "reachability",
  "dependency-path",
  "boundary-crossing",
  "cycles",
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

const NodeKindSchema = z.enum([
  "endpoint",
  "module",
  "service",
  "function",
  "database_table",
  "queue",
  "external_service",
  "file",
  "unknown",
]);

const EdgeKindSchema = z.enum([
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
]);

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
  .strict()
  .superRefine((selector, context) => {
    if (selector.nodes.length === 0 && selector.edges.length === 0) {
      context.addIssue({
        code: "custom",
        message: "selector must contain a node or edge predicate",
      });
    }
  });

export const ArchitectureQueryLimitsSchema = z
  .object({
    maxDepth: z.number().int().nonnegative().max(64).default(8),
    maxNodes: z.number().int().positive().max(100_000).default(10_000),
    maxEdges: z.number().int().positive().max(200_000).default(20_000),
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
    maxResultBytes: 4 * 1024 * 1024,
  });

export const ArchitectureQueryProjectionSchema = z
  .object({
    evidence: z.enum(["full", "summary", "none"]).default("full"),
    includeNodes: z.boolean().default(true),
    includeEdges: z.boolean().default(true),
    includeDiagnostics: z.boolean().default(true),
  })
  .strict()
  .default({
    evidence: "full",
    includeNodes: true,
    includeEdges: true,
    includeDiagnostics: true,
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

export const ArchitectureQuerySchema = z
  .object({
    schemaVersion: z.literal(ARCHITECTURE_QUERY_SCHEMA_VERSION),
    contract: z.literal(ARCHITECTURE_QUERY_CONTRACT),
    queryId: QueryIdentifierSchema,
    operation: ArchitectureQueryOperationSchema,
    snapshotSchemaVersion: z.literal(1).default(1),
    selectors: ArchitectureQuerySelectorSchema,
    limits: ArchitectureQueryLimitsSchema,
    projection: ArchitectureQueryProjectionSchema,
    ordering: ArchitectureQueryOrderingSchema,
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
      .enum(["maxDepth", "maxNodes", "maxEdges", "maxResultBytes"])
      .optional(),
    nodeId: SelectorValueSchema.optional(),
    edge: QueryDiagnosticEdgeSchema.optional(),
    evidenceIds: z.array(SelectorValueSchema).max(64).default([]),
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
export type ArchitectureQuery = z.infer<typeof ArchitectureQuerySchema>;
export type ArchitectureQueryEvidence = z.infer<
  typeof ArchitectureQueryEvidenceSchema
>;
export type ArchitectureQueryEdge = z.infer<typeof ArchitectureQueryEdgeSchema>;
export type ArchitectureQueryDiagnostic = z.infer<
  typeof ArchitectureQueryDiagnosticSchema
>;
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
    Pick<ArchitectureQueryDiagnostic, "limit" | "operation" | "remediation">
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

const buildResult = (
  query: ArchitectureQuery,
  status: ArchitectureQueryStatus,
  nodes: readonly GraphNode[],
  edges: readonly ArchitectureQueryEdge[],
  diagnostics: readonly ArchitectureQueryDiagnostic[],
  unsupportedOperation?: ArchitectureQueryOperation,
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

/**
 * Execute the contract's currently supported selector operations. Traversal,
 * path, boundary, cycle, source-body, remote, and mutation operations remain
 * explicit unsupported results until their dedicated roadmap work lands.
 */
export const executeArchitectureQuery = (
  snapshotInput: unknown,
  queryInput: unknown,
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
  );
  if (
    Buffer.byteLength(stableStringify(result), "utf8") >
    query.limits.maxResultBytes
  )
    return limitResult(
      query,
      "maxResultBytes",
      `query result exceeds the ${query.limits.maxResultBytes} byte output ceiling`,
    );
  return result;
};

export const serializeArchitectureQueryResult = (input: unknown): string =>
  stableStringify(
    parseQueryContract(
      (value) => ArchitectureQueryResultSchema.parse(value),
      input,
      "ArchitectureQueryResult",
    ),
  );
