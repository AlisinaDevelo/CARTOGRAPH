import { z } from "zod";

import { GraphContractError, stableStringify } from "./canonical.js";
import { CAPABILITY_REGISTRY_VERSION } from "./capabilities.js";
import {
  ArchitectureQueryLimitsSchema,
  ArchitectureQueryResultSchema,
  ArchitectureQuerySchema,
  parseArchitectureQuery,
  type ArchitectureQuery,
  type ArchitectureQueryEdge,
  type ArchitectureQueryResult,
} from "./query.js";

export const ARCHITECTURE_QUERY_EXPLANATION_SCHEMA_VERSION = 1 as const;
export const ARCHITECTURE_QUERY_EXPLANATION_CONTRACT =
  "cartograph.architecture-query-explanation" as const;
export const ARCHITECTURE_QUERY_EXPLANATION_TOOL_VERSION = "0.1.0" as const;

const ExplanationIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );

const ExplanationPlanSchema = z.string().trim().min(1).max(1_000_000);

const ExplanationEdgeReferenceSchema = z
  .object({
    from: ExplanationIdentifierSchema,
    to: ExplanationIdentifierSchema,
    kind: ExplanationIdentifierSchema,
  })
  .strict();

export const ArchitectureQueryExplanationUncertaintyCodeSchema = z.enum([
  "cycle",
  "truncated",
  "missing-evidence",
  "diagnostic",
  "metadata",
  "empty-result",
  "unsupported",
  "resource-limit",
]);

export const ArchitectureQueryExplanationUncertaintySchema = z
  .object({
    id: ExplanationIdentifierSchema,
    code: ArchitectureQueryExplanationUncertaintyCodeSchema,
    message: ExplanationIdentifierSchema,
    nodeIds: z.array(ExplanationIdentifierSchema).max(100_000).default([]),
    edge: ExplanationEdgeReferenceSchema.optional(),
    evidenceIds: z.array(ExplanationIdentifierSchema).max(100_000),
  })
  .strict();

export const ArchitectureQueryExplanationSummarySchema = z
  .object({
    resultNodes: z.number().int().nonnegative(),
    resultEdges: z.number().int().nonnegative(),
    pathCount: z.number().int().nonnegative(),
    cycleCount: z.number().int().nonnegative(),
    boundaryCount: z.number().int().nonnegative(),
    diagnosticCount: z.number().int().nonnegative(),
    evidenceCount: z.number().int().nonnegative(),
    missingEvidenceEdges: z.number().int().nonnegative(),
    edgeKinds: z.array(ExplanationIdentifierSchema).max(12),
    metadataPolicies: z.number().int().nonnegative(),
    metadataDecisions: z.number().int().nonnegative(),
    metadataOwnershipHints: z.number().int().nonnegative(),
    metadataDiagnostics: z.number().int().nonnegative(),
    truncated: z.boolean(),
    empty: z.boolean(),
  })
  .strict();

export const ArchitectureQueryExplanationToolSchema = z
  .object({
    name: z.literal("cartograph-cli"),
    version: ExplanationIdentifierSchema,
    querySchemaVersion: z.literal(1),
    resultSchemaVersion: z.literal(1),
    capabilityRegistryVersion: z.literal(CAPABILITY_REGISTRY_VERSION),
    explanationSchemaVersion: z.literal(
      ARCHITECTURE_QUERY_EXPLANATION_SCHEMA_VERSION,
    ),
    formats: z
      .array(z.enum(["json", "markdown", "html"]))
      .length(3)
      .refine(
        (formats) => new Set(formats).size === formats.length,
        "formats must not contain duplicates",
      ),
  })
  .strict();

export const ArchitectureQueryExplanationSchema = z
  .object({
    schemaVersion: z.literal(ARCHITECTURE_QUERY_EXPLANATION_SCHEMA_VERSION),
    contract: z.literal(ARCHITECTURE_QUERY_EXPLANATION_CONTRACT),
    query: ArchitectureQuerySchema,
    normalizedPlan: ExplanationPlanSchema,
    result: ArchitectureQueryResultSchema,
    limits: ArchitectureQueryLimitsSchema,
    summary: ArchitectureQueryExplanationSummarySchema,
    uncertainty: z
      .array(ArchitectureQueryExplanationUncertaintySchema)
      .max(100_000),
    tool: ArchitectureQueryExplanationToolSchema,
    deterministic: z.literal(true),
    readOnly: z.literal(true),
    network: z.literal(false),
    sourceBodiesIncluded: z.literal(false),
  })
  .strict();

export type ArchitectureQueryExplanationUncertaintyCode = z.infer<
  typeof ArchitectureQueryExplanationUncertaintyCodeSchema
>;
export type ArchitectureQueryExplanationUncertainty = z.infer<
  typeof ArchitectureQueryExplanationUncertaintySchema
>;
export type ArchitectureQueryExplanationSummary = z.infer<
  typeof ArchitectureQueryExplanationSummarySchema
>;
export type ArchitectureQueryExplanationTool = z.infer<
  typeof ArchitectureQueryExplanationToolSchema
>;
export type ArchitectureQueryExplanation = z.infer<
  typeof ArchitectureQueryExplanationSchema
>;

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const edgeKey = (
  edge: Pick<ArchitectureQueryEdge, "from" | "to" | "kind">,
): string => stableStringify([edge.from, edge.to, edge.kind]);

const edgeReference = (
  edge: Pick<ArchitectureQueryEdge, "from" | "to" | "kind">,
): z.infer<typeof ExplanationEdgeReferenceSchema> => ({
  from: edge.from,
  to: edge.to,
  kind: edge.kind,
});

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const explanationEdges = (
  result: ArchitectureQueryResult,
): ArchitectureQueryEdge[] => {
  const edges = new Map<string, ArchitectureQueryEdge>();
  const add = (edge: ArchitectureQueryEdge): void => {
    const key = edgeKey(edge);
    if (!edges.has(key)) edges.set(key, edge);
  };
  for (const edge of result.edges) add(edge);
  for (const edge of result.truncatedEdges) add(edge);
  for (const path of result.paths) for (const edge of path.edges) add(edge);
  for (const cycle of result.cycles) for (const edge of cycle.edges) add(edge);
  for (const boundary of result.boundaries) add(boundary.edge);
  return [...edges.values()].sort((left, right) =>
    compareStrings(edgeKey(left), edgeKey(right)),
  );
};

const metadataEvidenceIds = (metadata: unknown): string[] => {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === "evidenceIds" || childKey === "evidenceRefs") {
        if (Array.isArray(child))
          for (const item of child)
            if (typeof item === "string") values.push(item);
      } else visit(child);
    }
  };
  visit(metadata);
  return sortedUnique(values);
};

const makeUncertainty = (
  code: ArchitectureQueryExplanationUncertaintyCode,
  id: string,
  message: string,
  options: Partial<
    Pick<
      ArchitectureQueryExplanationUncertainty,
      "nodeIds" | "edge" | "evidenceIds"
    >
  > = {},
): ArchitectureQueryExplanationUncertainty => ({
  id,
  code,
  message,
  nodeIds: sortedUnique(options.nodeIds ?? []),
  ...(options.edge === undefined ? {} : { edge: options.edge }),
  evidenceIds: sortedUnique(options.evidenceIds ?? []),
});

const buildUncertainty = (
  query: ArchitectureQuery,
  result: ArchitectureQueryResult,
): ArchitectureQueryExplanationUncertainty[] => {
  const uncertainties = new Map<
    string,
    ArchitectureQueryExplanationUncertainty
  >();
  const add = (item: ArchitectureQueryExplanationUncertainty): void => {
    if (!uncertainties.has(item.id)) uncertainties.set(item.id, item);
  };

  if (result.status === "unsupported")
    add(
      makeUncertainty(
        "unsupported",
        `status:${result.queryId}:unsupported`,
        `query operation ${result.unsupportedOperation ?? result.operation} is unsupported; no result was inferred`,
      ),
    );
  if (result.status === "resource-limit")
    add(
      makeUncertainty(
        "resource-limit",
        `status:${result.queryId}:resource-limit`,
        "query execution stopped at an explicit resource limit; no partial result was accepted",
      ),
    );

  const edges = explanationEdges(result);
  for (const edge of edges) {
    if (edge.evidence.length === 0) {
      add(
        makeUncertainty(
          "missing-evidence",
          `edge:${edgeKey(edge)}:missing-evidence`,
          `edge ${edge.from} ${edge.kind} ${edge.to} has no evidence; ${edge.unresolvedReason ?? "its relationship remains unresolved"}`,
          { edge: edgeReference(edge) },
        ),
      );
    }
  }

  for (const cycle of result.cycles) {
    const identity = stableStringify(cycle.nodes);
    add(
      makeUncertainty(
        "cycle",
        `cycle:${identity}`,
        `cycle closes through ${cycle.nodes.join(" -> ")}; repeated traversal is suppressed`,
        {
          nodeIds: cycle.nodes,
          evidenceIds: cycle.edges.flatMap((edge) =>
            edge.evidence.map((evidence) => evidence.id),
          ),
        },
      ),
    );
  }

  if (result.truncated) {
    for (const edge of result.truncatedEdges) {
      add(
        makeUncertainty(
          "truncated",
          `edge:${edgeKey(edge)}:truncated`,
          `traversal stopped at maxDepth ${query.limits.maxDepth}; edge ${edge.from} ${edge.kind} ${edge.to} remains outside the returned node set`,
          {
            edge: edgeReference(edge),
            evidenceIds: edge.evidence.map((evidence) => evidence.id),
          },
        ),
      );
    }
  }

  for (const diagnostic of result.diagnostics) {
    add(
      makeUncertainty(
        "diagnostic",
        `diagnostic:${diagnostic.id}`,
        `${diagnostic.code}: ${diagnostic.message}`,
        {
          ...(diagnostic.nodeId === undefined
            ? {}
            : { nodeIds: [diagnostic.nodeId] }),
          ...(diagnostic.edge === undefined
            ? {}
            : { edge: edgeReference(diagnostic.edge) }),
          evidenceIds: diagnostic.evidenceIds,
        },
      ),
    );
  }

  for (const diagnostic of result.metadata?.diagnostics ?? []) {
    add(
      makeUncertainty(
        "metadata",
        `metadata:${diagnostic.id}`,
        `${diagnostic.code}: ${diagnostic.message}`,
        {
          ...(diagnostic.target?.kind === "node"
            ? { nodeIds: [diagnostic.target.graphId] }
            : {}),
          evidenceIds: diagnostic.evidenceRefs,
        },
      ),
    );
  }

  for (const unsupported of result.metadata?.unsupported ?? []) {
    if (
      result.metadata?.diagnostics.some(
        (diagnostic) => diagnostic.id === `unsupported:${unsupported.id}`,
      )
    )
      continue;
    add(
      makeUncertainty(
        "metadata",
        `metadata:${unsupported.id}:unsupported`,
        `${unsupported.code}: ${unsupported.message}`,
        {
          ...(unsupported.target?.kind === "node"
            ? { nodeIds: [unsupported.target.graphId] }
            : {}),
          evidenceIds: unsupported.evidenceRefs,
        },
      ),
    );
  }

  const empty =
    result.nodes.length === 0 &&
    result.edges.length === 0 &&
    result.paths.length === 0 &&
    result.cycles.length === 0 &&
    result.boundaries.length === 0;
  if (result.status === "ok" && empty)
    add(
      makeUncertainty(
        "empty-result",
        `result:${result.queryId}:empty`,
        "the query completed successfully but selected no nodes, edges, paths, cycles, or boundaries",
      ),
    );

  return [...uncertainties.values()].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
};

const buildSummary = (
  query: ArchitectureQuery,
  result: ArchitectureQueryResult,
): ArchitectureQueryExplanationSummary => {
  const edges = explanationEdges(result);
  const metadata = result.metadata;
  const metadataEdgeKinds = query.traversal.edgeKinds;
  const pathEdgeKinds = result.paths.flatMap((path) =>
    path.edges.map((edge) => edge.kind),
  );
  return {
    resultNodes: result.nodes.length,
    resultEdges: result.edges.length,
    pathCount: result.paths.length,
    cycleCount: result.cycles.length,
    boundaryCount: result.boundaries.length,
    diagnosticCount:
      result.diagnostics.length + (metadata?.diagnostics.length ?? 0),
    evidenceCount: sortedUnique([
      ...edges.flatMap((edge) => edge.evidence.map((evidence) => evidence.id)),
      ...result.diagnostics.flatMap((diagnostic) => diagnostic.evidenceIds),
      ...metadataEvidenceIds(metadata),
    ]).length,
    missingEvidenceEdges: edges.filter((edge) => edge.evidence.length === 0)
      .length,
    edgeKinds: sortedUnique([
      ...metadataEdgeKinds,
      ...pathEdgeKinds,
      ...edges.map((edge) => edge.kind),
    ]),
    metadataPolicies: metadata?.policies.length ?? 0,
    metadataDecisions: metadata?.decisions.references.length ?? 0,
    metadataOwnershipHints: metadata?.ownership.hints.length ?? 0,
    metadataDiagnostics: metadata?.diagnostics.length ?? 0,
    truncated: result.truncated,
    empty:
      result.nodes.length === 0 &&
      result.edges.length === 0 &&
      result.paths.length === 0 &&
      result.cycles.length === 0 &&
      result.boundaries.length === 0,
  };
};

/**
 * Build a portable, self-contained explanation for one normalized query and
 * its already computed result. This function never executes a query, reads a
 * repository, follows a reference, or mutates either input.
 */
export const buildArchitectureQueryExplanation = (
  queryInput: unknown,
  resultInput: unknown,
): ArchitectureQueryExplanation => {
  const query = parseArchitectureQuery(queryInput);
  const result = ArchitectureQueryResultSchema.parse(resultInput);
  if (query.queryId !== result.queryId)
    throw new GraphContractError(
      "conflict",
      `query explanation queryId ${query.queryId} does not match result queryId ${result.queryId}`,
    );
  if (query.operation !== result.operation)
    throw new GraphContractError(
      "conflict",
      `query explanation operation ${query.operation} does not match result operation ${result.operation}`,
    );

  const explanation = {
    schemaVersion: ARCHITECTURE_QUERY_EXPLANATION_SCHEMA_VERSION,
    contract: ARCHITECTURE_QUERY_EXPLANATION_CONTRACT,
    query,
    normalizedPlan: stableStringify(query),
    result,
    limits: result.limits,
    summary: buildSummary(query, result),
    uncertainty: buildUncertainty(query, result),
    tool: {
      name: "cartograph-cli" as const,
      version: ARCHITECTURE_QUERY_EXPLANATION_TOOL_VERSION,
      querySchemaVersion: 1 as const,
      resultSchemaVersion: 1 as const,
      capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
      explanationSchemaVersion: ARCHITECTURE_QUERY_EXPLANATION_SCHEMA_VERSION,
      formats: ["json", "markdown", "html"] as const,
    },
    deterministic: true as const,
    readOnly: true as const,
    network: false as const,
    sourceBodiesIncluded: false as const,
  };
  return ArchitectureQueryExplanationSchema.parse(explanation);
};

export const explainArchitectureQuery = buildArchitectureQueryExplanation;

export const serializeArchitectureQueryExplanation = (
  explanation: ArchitectureQueryExplanation,
): string =>
  stableStringify(ArchitectureQueryExplanationSchema.parse(explanation));
