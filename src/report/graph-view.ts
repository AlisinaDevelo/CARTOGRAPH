import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { z, ZodError } from "zod";

import {
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
  EvidenceSchema,
  RevisionSchema,
} from "../core/schemas.js";
import {
  canonicalizeGraphSnapshot,
  stableStringify,
} from "../core/canonical.js";
import {
  executeGraphQuery,
  GraphQueryDiagnosticSchema,
  GraphQuerySchema,
  parseGraphQuery,
  type GraphQuery,
} from "../core/query-language.js";
import { ResourceLimitError } from "../resources.js";

/** Version of the local, presentation-only filtered graph-view contract. */
export const GRAPH_VIEW_SCHEMA_VERSION = 1 as const;
export const GRAPH_VIEW_CONTRACT = "cartograph.graph-view" as const;
export const GRAPH_VIEW_MEDIA_TYPE =
  "application/vnd.cartograph.graph-view+json" as const;
export const GRAPH_VIEW_MAX_NODES = 10_000 as const;
export const GRAPH_VIEW_MAX_EDGES = 20_000 as const;
export const GRAPH_VIEW_MAX_SAMPLE_IDS = 64 as const;
export const GRAPH_VIEW_MAX_BYTES = 16 * 1024 * 1024;

const GRAPH_VIEW_NODE_KINDS = [
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
const GRAPH_VIEW_EDGE_KINDS = [
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
const GRAPH_VIEW_CONFIDENCES = [
  "certain",
  "inferred",
  "observed",
  "user_confirmed",
] as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) => !value.includes("\0") && !/[\r\n]/u.test(value),
    "must not contain control characters",
  );
const PathSchema = IdentifierSchema.refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z][A-Za-z\d+.-]*:/u.test(value) &&
    !value.split("/").some((part) => part === ".."),
  "must be a repository-relative path",
);
const NodeKindSchema = z.enum(GRAPH_VIEW_NODE_KINDS);
const EdgeKindSchema = z.enum(GRAPH_VIEW_EDGE_KINDS);
const ConfidenceSchema = z.enum(GRAPH_VIEW_CONFIDENCES);
const EvidencePathsSchema = z.array(PathSchema);
const GraphViewLocationSchema = z
  .object({
    path: PathSchema,
    line: z.number().int().positive(),
    column: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    endColumn: z.number().int().positive().optional(),
  })
  .strict();

export const GraphViewPointSchema = z
  .object({
    x: z.number().int().nonnegative().max(10_000_000),
    y: z.number().int().nonnegative().max(10_000_000),
  })
  .strict();

export const GraphViewNodeSchema = z
  .object({
    id: IdentifierSchema,
    stableKey: IdentifierSchema,
    kind: NodeKindSchema,
    name: z.string().trim().min(1).max(2_048),
    language: IdentifierSchema.optional(),
    location: GraphViewLocationSchema.optional(),
    groupId: IdentifierSchema,
    position: GraphViewPointSchema,
  })
  .strict();

export const GraphViewEdgeSchema = z
  .object({
    identity: IdentifierSchema,
    from: IdentifierSchema,
    to: IdentifierSchema,
    kind: EdgeKindSchema,
    confidence: ConfidenceSchema,
    evidence: z.array(EvidenceSchema),
    evidencePaths: EvidencePathsSchema,
    unresolved: z.boolean(),
    unresolvedReason: z.string().trim().min(1).max(2_048).optional(),
  })
  .strict()
  .superRefine((edge, context) => {
    if (edge.identity !== `${edge.from}|${edge.kind}|${edge.to}`) {
      context.addIssue({
        code: "custom",
        path: ["identity"],
        message: "identity must be the canonical from|kind|to tuple",
      });
    }
    if (
      edge.unresolved !==
      (edge.evidence.length === 0 || edge.unresolvedReason !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["unresolved"],
        message: "unresolved must reflect missing evidence or unresolvedReason",
      });
    }
  });

export const GraphViewGroupSchema = z
  .object({
    id: IdentifierSchema,
    kind: NodeKindSchema,
    nodeIds: z.array(IdentifierSchema).max(GRAPH_VIEW_MAX_NODES),
  })
  .strict();

export const GraphViewLayoutSchema = z
  .object({
    algorithm: z.literal("kind-columns-v1"),
    width: z.number().int().positive().max(10_000_000),
    height: z.number().int().positive().max(10_000_000),
    groupOrder: z.array(IdentifierSchema).max(GRAPH_VIEW_NODE_KINDS.length),
    semantics: z.literal(
      "presentation-only; position and grouping do not encode dependency strength, confidence, reachability, or completeness",
    ),
  })
  .strict();

export const GraphViewConfidenceLegendSchema = z
  .object({
    value: ConfidenceSchema,
    count: z.number().int().nonnegative(),
    description: z.string().trim().min(1).max(512),
  })
  .strict();

export const GraphViewOmittedCategorySchema = z
  .object({
    count: z.number().int().nonnegative(),
    sampleIds: z.array(IdentifierSchema).max(GRAPH_VIEW_MAX_SAMPLE_IDS),
  })
  .strict();

export const GraphViewOmittedContextSchema = z
  .object({
    nodes: GraphViewOmittedCategorySchema,
    edges: GraphViewOmittedCategorySchema,
    diagnostics: GraphViewOmittedCategorySchema,
  })
  .strict();

export const GraphViewLegendSchema = z
  .object({
    confidence: z
      .array(GraphViewConfidenceLegendSchema)
      .length(GRAPH_VIEW_CONFIDENCES.length),
    unresolvedEdges: z
      .object({
        count: z.number().int().nonnegative(),
        identities: z.array(IdentifierSchema).max(GRAPH_VIEW_MAX_EDGES),
      })
      .strict(),
    omittedContext: GraphViewOmittedContextSchema,
  })
  .strict();

export const GraphViewSelectionSchema = z
  .object({
    nodeIds: z.array(IdentifierSchema).max(GRAPH_VIEW_MAX_NODES),
    edgeIdentities: z.array(IdentifierSchema).max(GRAPH_VIEW_MAX_EDGES),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    complete: z.boolean(),
  })
  .strict();

export const GraphViewReportSchema = z
  .object({
    schemaVersion: z.literal(GRAPH_VIEW_SCHEMA_VERSION),
    contract: z.literal(GRAPH_VIEW_CONTRACT),
    mediaType: z.literal(GRAPH_VIEW_MEDIA_TYPE),
    viewId: IdentifierSchema,
    snapshotRevision: RevisionSchema,
    query: GraphQuerySchema,
    queryDiagnostics: z.array(GraphQueryDiagnosticSchema),
    queryTruncated: z.boolean(),
    selection: GraphViewSelectionSchema,
    selectionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    groups: z.array(GraphViewGroupSchema).max(GRAPH_VIEW_NODE_KINDS.length),
    nodes: z.array(GraphViewNodeSchema).max(GRAPH_VIEW_MAX_NODES),
    edges: z.array(GraphViewEdgeSchema).max(GRAPH_VIEW_MAX_EDGES),
    layout: GraphViewLayoutSchema,
    semantics: z
      .object({
        layout: z.literal("presentation-only"),
        edgeIdentity: z.literal("from|kind|to"),
        omittedContext: z.literal(
          "counts and samples are not selected records",
        ),
        warning: z.string().trim().min(1).max(1_024),
      })
      .strict(),
    legend: GraphViewLegendSchema,
    omittedContext: GraphViewOmittedContextSchema,
    deterministic: z.literal(true),
    readOnly: z.literal(true),
    reportDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .strict();

export type GraphViewPoint = z.infer<typeof GraphViewPointSchema>;
export type GraphViewNode = z.infer<typeof GraphViewNodeSchema>;
export type GraphViewEdge = z.infer<typeof GraphViewEdgeSchema>;
export type GraphViewGroup = z.infer<typeof GraphViewGroupSchema>;
export type GraphViewLayout = z.infer<typeof GraphViewLayoutSchema>;
export type GraphViewConfidenceLegend = z.infer<
  typeof GraphViewConfidenceLegendSchema
>;
export type GraphViewOmittedCategory = z.infer<
  typeof GraphViewOmittedCategorySchema
>;
export type GraphViewOmittedContext = z.infer<
  typeof GraphViewOmittedContextSchema
>;
export type GraphViewLegend = z.infer<typeof GraphViewLegendSchema>;
export type GraphViewSelection = z.infer<typeof GraphViewSelectionSchema>;
export type GraphViewReport = z.infer<typeof GraphViewReportSchema>;

export type GraphViewOptions = {
  readonly snapshot: unknown;
  readonly query: unknown;
  readonly viewId?: string;
  readonly maxSampleIds?: number;
};

export type GraphViewErrorCode =
  "invalid-input" | "invalid-query" | "unsupported-target" | "resource-limit";

export class GraphViewError extends Error {
  readonly code: GraphViewErrorCode;

  constructor(code: GraphViewErrorCode, message: string) {
    super(message);
    this.name = "GraphViewError";
    this.code = code;
  }
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const edgeIdentity = (edge: Pick<GraphEdge, "from" | "kind" | "to">): string =>
  `${edge.from}|${edge.kind}|${edge.to}`;

const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;

const selectionDigestFor = (selection: {
  readonly nodeIds: readonly string[];
  readonly edgeIdentities: readonly string[];
}): string =>
  digest({
    nodeIds: [...selection.nodeIds].sort(compareStrings),
    edgeIdentities: [...selection.edgeIdentities].sort(compareStrings),
  });

const sample = (values: readonly string[], maxSampleIds: number): string[] =>
  [...values].sort(compareStrings).slice(0, maxSampleIds);

const confidenceDescription = (value: GraphViewEdge["confidence"]): string => {
  switch (value) {
    case "certain":
      return "Direct evidence supports this relationship.";
    case "user_confirmed":
      return "A local user explicitly confirmed this relationship.";
    case "observed":
      return "A local observation supports this relationship.";
    case "inferred":
      return "The relationship is derived by a bounded inference.";
  }
};

const evidencePaths = (edge: GraphEdge): string[] =>
  [
    ...new Set(
      edge.evidence.flatMap((evidence) =>
        [evidence.path, evidence.location?.path].filter(
          (path): path is string => path !== undefined,
        ),
      ),
    ),
  ].sort(compareStrings);

const parseOptions = (
  options: GraphViewOptions,
): {
  readonly snapshot: GraphSnapshot;
  readonly query: GraphQuery;
  readonly viewId: string;
  readonly maxSampleIds: number;
} => {
  if (!options || typeof options !== "object")
    throw new GraphViewError(
      "invalid-input",
      "graph view options are required",
    );
  let snapshot: GraphSnapshot;
  try {
    snapshot = canonicalizeGraphSnapshot(options.snapshot);
  } catch (error) {
    throw new GraphViewError(
      "invalid-input",
      `graph view snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let query: GraphQuery;
  try {
    query = parseGraphQuery(options.query);
  } catch (error) {
    throw new GraphViewError(
      "invalid-query",
      `graph view query is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (query.target === "changes")
    throw new GraphViewError(
      "unsupported-target",
      "graph views require a node or edge query; change queries have no snapshot layout",
    );
  const viewId = options.viewId ?? `view-${query.queryId}`;
  const parsedViewId = IdentifierSchema.safeParse(viewId);
  if (!parsedViewId.success)
    throw new GraphViewError("invalid-input", "graph view viewId is invalid");
  const maxSampleIds = options.maxSampleIds ?? GRAPH_VIEW_MAX_SAMPLE_IDS;
  if (
    !Number.isInteger(maxSampleIds) ||
    maxSampleIds < 1 ||
    maxSampleIds > GRAPH_VIEW_MAX_SAMPLE_IDS
  )
    throw new GraphViewError(
      "invalid-input",
      `maxSampleIds must be an integer between 1 and ${GRAPH_VIEW_MAX_SAMPLE_IDS}`,
    );
  return { snapshot, query, viewId: parsedViewId.data, maxSampleIds };
};

const buildOmittedContext = (
  snapshot: GraphSnapshot,
  selectedNodes: readonly GraphNode[],
  selectedEdges: readonly GraphEdge[],
  maxSampleIds: number,
): GraphViewOmittedContext => {
  const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
  const selectedEdgeIds = new Set(selectedEdges.map(edgeIdentity));
  const omittedNodeIds = snapshot.nodes
    .filter((node) => !selectedNodeIds.has(node.id))
    .map((node) => node.id);
  const omittedEdgeIds = snapshot.edges
    .filter((edge) => !selectedEdgeIds.has(edgeIdentity(edge)))
    .map(edgeIdentity);
  const diagnosticIds = snapshot.diagnostics.map((diagnostic) => diagnostic.id);
  return {
    nodes: {
      count: omittedNodeIds.length,
      sampleIds: sample(omittedNodeIds, maxSampleIds),
    },
    edges: {
      count: omittedEdgeIds.length,
      sampleIds: sample(omittedEdgeIds, maxSampleIds),
    },
    diagnostics: {
      count: diagnosticIds.length,
      sampleIds: sample(diagnosticIds, maxSampleIds),
    },
  };
};

const layoutNodes = (
  nodes: readonly GraphNode[],
): {
  readonly groups: GraphViewGroup[];
  readonly nodes: GraphViewNode[];
  readonly layout: GraphViewLayout;
} => {
  const byKind = new Map<GraphNode["kind"], GraphNode[]>();
  for (const node of nodes) {
    const existing = byKind.get(node.kind) ?? [];
    existing.push(node);
    byKind.set(node.kind, existing);
  }
  const kinds = [...byKind.keys()].sort(compareStrings);
  const groups: GraphViewGroup[] = [];
  const projected: GraphViewNode[] = [];
  let maximumRows = 0;
  for (const [column, kind] of kinds.entries()) {
    const members = [...(byKind.get(kind) ?? [])].sort((left, right) => {
      const stable = compareStrings(left.stableKey, right.stableKey);
      return stable === 0 ? compareStrings(left.id, right.id) : stable;
    });
    maximumRows = Math.max(maximumRows, members.length);
    const groupId = `kind:${kind}`;
    groups.push({
      id: groupId,
      kind,
      nodeIds: members.map((node) => node.id),
    });
    members.forEach((node, row) => {
      projected.push({
        ...node,
        groupId,
        position: { x: 40 + column * 320, y: 70 + row * 100 },
      });
    });
  }
  return {
    groups,
    nodes: projected,
    layout: {
      algorithm: "kind-columns-v1",
      width: Math.max(240, kinds.length * 320 + 40),
      height: Math.max(160, maximumRows * 100 + 100),
      groupOrder: groups.map((group) => group.id),
      semantics:
        "presentation-only; position and grouping do not encode dependency strength, confidence, reachability, or completeness",
    },
  };
};

const buildLegend = (
  selectedEdges: readonly GraphViewEdge[],
  omittedContext: GraphViewOmittedContext,
): GraphViewLegend => ({
  confidence: GRAPH_VIEW_CONFIDENCES.map((value) => ({
    value,
    count: selectedEdges.filter((edge) => edge.confidence === value).length,
    description: confidenceDescription(value),
  })),
  unresolvedEdges: {
    count: selectedEdges.filter((edge) => edge.unresolved).length,
    identities: selectedEdges
      .filter((edge) => edge.unresolved)
      .map((edge) => edge.identity)
      .sort(compareStrings),
  },
  omittedContext,
});

const parseReport = (input: unknown): GraphViewReport => {
  try {
    return GraphViewReportSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError)
      throw new GraphViewError(
        "invalid-input",
        `graph view report is invalid: ${error.message}`,
      );
    throw error;
  }
};

/** Build a bounded, deterministic view over a local canonical snapshot. */
export const createGraphViewReport = (
  options: GraphViewOptions,
): GraphViewReport => {
  const { snapshot, query, viewId, maxSampleIds } = parseOptions(options);
  const result = executeGraphQuery(snapshot, query);
  if (result.status !== "ok") {
    const diagnostic = result.diagnostics[0];
    const message = diagnostic?.message ?? `query status is ${result.status}`;
    if (result.status === "resource-limit")
      throw new ResourceLimitError(
        `graph view query resource limit: ${message}`,
      );
    throw new GraphViewError(
      "invalid-query",
      `graph view query failed: ${message}`,
    );
  }
  if (result.nodes.length > GRAPH_VIEW_MAX_NODES)
    throw new ResourceLimitError(
      `graph view contains ${result.nodes.length} nodes, exceeding the ${GRAPH_VIEW_MAX_NODES} node ceiling`,
    );
  if (result.edges.length > GRAPH_VIEW_MAX_EDGES)
    throw new ResourceLimitError(
      `graph view contains ${result.edges.length} edges, exceeding the ${GRAPH_VIEW_MAX_EDGES} edge ceiling`,
    );
  const selectedNodeIds = new Set(result.nodes.map((node) => node.id));
  const selectedEdges = result.edges.map((edge) => {
    if (!selectedNodeIds.has(edge.from) || !selectedNodeIds.has(edge.to))
      throw new GraphViewError(
        "invalid-query",
        `graph view edge ${edgeIdentity(edge)} references a node outside the selected view`,
      );
    const unresolved =
      edge.evidence.length === 0 || edge.unresolvedReason !== undefined;
    return {
      identity: edgeIdentity(edge),
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      confidence: edge.confidence,
      evidence: edge.evidence,
      evidencePaths: evidencePaths(edge),
      unresolved,
      ...(edge.unresolvedReason === undefined
        ? {}
        : { unresolvedReason: edge.unresolvedReason }),
    } satisfies GraphViewEdge;
  });
  const projection = layoutNodes(result.nodes);
  const omittedContext = buildOmittedContext(
    snapshot,
    result.nodes,
    result.edges,
    maxSampleIds,
  );
  const selection = {
    nodeIds: projection.nodes.map((node) => node.id),
    edgeIdentities: selectedEdges.map((edge) => edge.identity),
    complete: !result.truncated,
  };
  const selectionDigest = selectionDigestFor(selection);
  const base = {
    schemaVersion: GRAPH_VIEW_SCHEMA_VERSION,
    contract: GRAPH_VIEW_CONTRACT,
    mediaType: GRAPH_VIEW_MEDIA_TYPE,
    viewId,
    snapshotRevision: snapshot.revision,
    query,
    queryDiagnostics: result.diagnostics,
    queryTruncated: result.truncated,
    selection: { ...selection, digest: selectionDigest },
    selectionDigest,
    groups: projection.groups,
    nodes: projection.nodes,
    edges: selectedEdges,
    layout: projection.layout,
    semantics: {
      layout: "presentation-only" as const,
      edgeIdentity: "from|kind|to" as const,
      omittedContext: "counts and samples are not selected records" as const,
      warning:
        "Layout position and grouping are presentation aids only; inspect typed edges, confidence, evidence, unresolved status, and omissions before inferring architecture.",
    },
    legend: buildLegend(selectedEdges, omittedContext),
    omittedContext,
    deterministic: true as const,
    readOnly: true as const,
  };
  const report = parseReport({ ...base, reportDigest: digest(base) });
  if (Buffer.byteLength(stableStringify(report), "utf8") > GRAPH_VIEW_MAX_BYTES)
    throw new ResourceLimitError(
      `graph view report exceeds the ${(GRAPH_VIEW_MAX_BYTES / (1024 * 1024)).toLocaleString("en-US")} MiB output ceiling`,
    );
  return report;
};

export const parseGraphViewReport = (input: unknown): GraphViewReport => {
  const report = parseReport(input);
  const { reportDigest, ...base } = report;
  if (digest(base) !== reportDigest)
    throw new GraphViewError(
      "invalid-input",
      "graph view report digest does not match its content",
    );
  if (report.selection.digest !== report.selectionDigest)
    throw new GraphViewError(
      "invalid-input",
      "graph view selection digest does not match its canonical selection",
    );
  if (selectionDigestFor(report.selection) !== report.selectionDigest)
    throw new GraphViewError(
      "invalid-input",
      "graph view selection digest does not match selected records",
    );
  const nodeIds = report.nodes.map((node) => node.id);
  const edgeIdentities = report.edges.map((edge) => edge.identity);
  if (
    stableStringify([...nodeIds].sort(compareStrings)) !==
      stableStringify([...report.selection.nodeIds].sort(compareStrings)) ||
    stableStringify([...edgeIdentities].sort(compareStrings)) !==
      stableStringify([...report.selection.edgeIdentities].sort(compareStrings))
  )
    throw new GraphViewError(
      "invalid-input",
      "graph view selection does not match its rendered records",
    );
  if (
    stableStringify(report.legend.omittedContext) !==
    stableStringify(report.omittedContext)
  )
    throw new GraphViewError(
      "invalid-input",
      "graph view legend and omitted-context metadata disagree",
    );
  const unresolved = report.edges.filter((edge) => edge.unresolved);
  if (
    report.legend.unresolvedEdges.count !== unresolved.length ||
    stableStringify(
      [...report.legend.unresolvedEdges.identities].sort(compareStrings),
    ) !==
      stableStringify(
        unresolved.map((edge) => edge.identity).sort(compareStrings),
      )
  )
    throw new GraphViewError(
      "invalid-input",
      "graph view unresolved-edge legend disagrees with selected edges",
    );
  for (const edge of report.edges) {
    if (edge.identity !== `${edge.from}|${edge.kind}|${edge.to}`)
      throw new GraphViewError(
        "invalid-input",
        `graph view edge identity is not canonical: ${edge.identity}`,
      );
  }
  return report;
};

export const serializeGraphViewReport = (input: unknown): string =>
  stableStringify(parseGraphViewReport(input));

export type GraphViewReportFormat = "json" | "markdown" | "html";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const markdownCode = (value: string): string =>
  `<code>${escapeHtml(value.replace(/\s+/gu, " ").trim())}</code>`;

const markdownOmitted = (
  value: GraphViewOmittedCategory,
  label: string,
): string =>
  `- ${label}: ${value.count}; samples: ${value.sampleIds.length === 0 ? markdownCode("none") : value.sampleIds.map(markdownCode).join(", ")}`;

const renderMarkdown = (report: GraphViewReport): string => {
  const lines = [
    `# Graph view ${markdownCode(report.viewId)}`,
    "",
    `Revision: ${markdownCode(report.snapshotRevision.commitSha)}; query: ${markdownCode(report.query.queryId)}; status: ${markdownCode(report.queryTruncated ? "truncated" : "complete")}.`,
    "",
    "## Selection",
    "",
    `- ${report.nodes.length} selected nodes; ${report.edges.length} selected typed edges; selection digest: ${markdownCode(report.selectionDigest)}`,
    `- Complete selection: ${markdownCode(String(report.selection.complete))}`,
    "",
    "## Legend",
    "",
    "### Confidence",
    "",
    ...report.legend.confidence.map(
      (item) =>
        `- ${markdownCode(item.value)}: ${item.count}; ${markdownCode(item.description)}`,
    ),
    "",
    "### Unresolved edges",
    "",
    `- ${report.legend.unresolvedEdges.count} unresolved edge(s): ${report.legend.unresolvedEdges.identities.length === 0 ? markdownCode("none") : report.legend.unresolvedEdges.identities.map(markdownCode).join(", ")}`,
    "",
    "### Omitted context",
    "",
    markdownOmitted(report.legend.omittedContext.nodes, "nodes"),
    markdownOmitted(report.legend.omittedContext.edges, "edges"),
    markdownOmitted(report.legend.omittedContext.diagnostics, "diagnostics"),
    "",
    "## Layout semantics",
    "",
    `- Algorithm: ${markdownCode(report.layout.algorithm)}; dimensions: ${report.layout.width} × ${report.layout.height}.`,
    `- ${report.semantics.warning}`,
    "",
    "## Groups",
    "",
    ...(report.groups.length === 0
      ? [`- ${markdownCode("none")}`]
      : report.groups.map(
          (group) =>
            `- ${markdownCode(group.id)} (${markdownCode(group.kind)}): ${group.nodeIds.map(markdownCode).join(", ")}`,
        )),
    "",
    "## Nodes",
    "",
    ...(report.nodes.length === 0
      ? [`- ${markdownCode("none")}`]
      : report.nodes.map(
          (node) =>
            `- ${markdownCode(node.id)} — ${markdownCode(node.kind)}; group ${markdownCode(node.groupId)}; position ${node.position.x},${node.position.y}`,
        )),
    "",
    "## Typed edges",
    "",
    ...(report.edges.length === 0
      ? [`- ${markdownCode("none")}`]
      : report.edges.map(
          (edge) =>
            `- ${markdownCode(edge.from)} ${markdownCode(edge.kind)} ${markdownCode(edge.to)} — confidence ${markdownCode(edge.confidence)}; ${edge.unresolved ? markdownCode(`unresolved: ${edge.unresolvedReason ?? "unspecified"}`) : `evidence: ${edge.evidencePaths.length === 0 ? markdownCode("none") : edge.evidencePaths.map(markdownCode).join(", ")}`}`,
        )),
    "",
    "## Omission warning",
    "",
    `- ${report.semantics.omittedContext}; this report is a filtered view, not a complete graph.`,
    "",
  ];
  return lines.join("\n");
};

const htmlList = (items: readonly string[]): string =>
  items.length === 0
    ? "<p>None.</p>"
    : `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;

const renderHtml = (report: GraphViewReport): string => {
  const nodeById = new Map(report.nodes.map((node) => [node.id, node]));
  const edgeLines = report.edges
    .map((edge) => {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) return "";
      return `<line x1="${from.position.x + 110}" y1="${from.position.y + 18}" x2="${to.position.x + 110}" y2="${to.position.y + 18}" data-edge-kind="${escapeHtml(edge.kind)}" aria-label="${escapeHtml(edge.identity)}" />`;
    })
    .join("");
  const nodeShapes = report.nodes
    .map(
      (node) =>
        `<g data-node-kind="${escapeHtml(node.kind)}"><rect x="${node.position.x}" y="${node.position.y}" width="220" height="36" rx="6" /><text x="${node.position.x + 8}" y="${node.position.y + 23}">${escapeHtml(node.name)}</text></g>`,
    )
    .join("");
  const confidence = report.legend.confidence.map(
    (item) =>
      `${markdownCode(item.value)}: ${item.count} — ${escapeHtml(item.description)}`,
  );
  const unresolved = report.legend.unresolvedEdges.identities.map((identity) =>
    markdownCode(identity),
  );
  const omitted = [
    markdownOmitted(report.legend.omittedContext.nodes, "nodes"),
    markdownOmitted(report.legend.omittedContext.edges, "edges"),
    markdownOmitted(report.legend.omittedContext.diagnostics, "diagnostics"),
  ].map((item) =>
    escapeHtml(item.replaceAll("<code>", "").replaceAll("</code>", "")),
  );
  const typedEdges = report.edges.map(
    (edge) =>
      `${markdownCode(edge.from)} <strong>${escapeHtml(edge.kind)}</strong> ${markdownCode(edge.to)} — confidence ${markdownCode(edge.confidence)}${edge.unresolved ? `; ${escapeHtml(`unresolved: ${edge.unresolvedReason ?? "unspecified"}`)}` : ""}`,
  );
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
<title>CARTOGRAPH graph view ${escapeHtml(report.viewId)}</title>
<style>body{font-family:system-ui,sans-serif;line-height:1.45;margin:2rem;color:#1f2937}svg{border:1px solid #d1d5db;max-width:100%;height:auto}line{stroke:#6b7280;stroke-width:1.5}rect{fill:#eef2ff;stroke:#4338ca}text{font-size:12px}code{background:#f3f4f6;padding:.1rem .25rem}</style>
</head>
<body>
<main>
<h1>Graph view <code>${escapeHtml(report.viewId)}</code></h1>
<p>Revision <code>${escapeHtml(report.snapshotRevision.commitSha)}</code>; query <code>${escapeHtml(report.query.queryId)}</code>; ${report.queryTruncated ? "truncated" : "complete"} selection.</p>
<section aria-labelledby="layout-heading"><h2 id="layout-heading">Filtered graph</h2><svg role="img" aria-label="Filtered architecture graph; layout is presentation-only" viewBox="0 0 ${report.layout.width} ${report.layout.height}" width="${report.layout.width}" height="${report.layout.height}">${edgeLines}${nodeShapes}</svg><p>${escapeHtml(report.semantics.warning)}</p></section>
<section aria-labelledby="legend-heading"><h2 id="legend-heading">Legend</h2><h3>Confidence</h3>${htmlList(confidence)}<h3>Unresolved edges</h3>${htmlList(unresolved)}<h3>Omitted context</h3>${htmlList(omitted)}</section>
<section aria-labelledby="edges-heading"><h2 id="edges-heading">Typed edges</h2>${htmlList(typedEdges)}</section>
<section aria-labelledby="groups-heading"><h2 id="groups-heading">Groups</h2>${htmlList(report.groups.map((group) => `${markdownCode(group.id)} (${markdownCode(group.kind)}): ${group.nodeIds.map(markdownCode).join(", ")}`))}</section>
</main>
</body>
</html>
`;
  return html;
};

const isReport = (input: unknown): input is GraphViewReport =>
  Boolean(
    input &&
    typeof input === "object" &&
    (input as Record<string, unknown>).contract === GRAPH_VIEW_CONTRACT,
  );

/** Render a report or build one from options in a local JSON/Markdown/HTML format. */
export const renderGraphViewReport = (
  input: GraphViewReport | GraphViewOptions,
  format: GraphViewReportFormat = "json",
): string => {
  const report = isReport(input)
    ? parseGraphViewReport(input)
    : createGraphViewReport(input);
  const rendered =
    format === "json"
      ? `${serializeGraphViewReport(report)}\n`
      : format === "markdown"
        ? renderMarkdown(report)
        : renderHtml(report);
  if (Buffer.byteLength(rendered, "utf8") > GRAPH_VIEW_MAX_BYTES)
    throw new ResourceLimitError(
      `graph view ${format} rendering exceeds the ${(GRAPH_VIEW_MAX_BYTES / (1024 * 1024)).toLocaleString("en-US")} MiB output ceiling`,
    );
  return rendered;
};

export const renderGraphView = renderGraphViewReport;
export const renderGraphViewMarkdown = (
  input: GraphViewReport | GraphViewOptions,
): string => renderGraphViewReport(input, "markdown");
export const renderGraphViewHtml = (
  input: GraphViewReport | GraphViewOptions,
): string => renderGraphViewReport(input, "html");
