import {
  GraphDiffSchema,
  GRAPH_DIFF_SCHEMA_VERSION,
  type ChangedDiagnostic,
  type ChangedEdge,
  type ChangedNode,
  type Diagnostic,
  type FieldChange,
  type GraphDiff,
  type GraphEdge,
  type GraphNode,
} from "./schemas.js";
import {
  assertCompatibleCapabilityRegistryVersion,
  assertSupportedCapabilityRegistryVersion,
} from "./capabilities.js";
import {
  canonicalizeDiagnostic,
  canonicalizeGraphEdge,
  canonicalizeGraphNode,
  canonicalizeGraphSnapshot,
  assertSupportedSchemaVersion,
  GraphContractError,
  stableStringify,
} from "./canonical.js";

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const valueOrNull = (record: Record<string, unknown>, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : null;

const fieldChanges = (before: object, after: object): FieldChange[] => {
  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(beforeRecord),
    ...Object.keys(afterRecord),
  ]);

  return [...keys].sort(compareStrings).flatMap((path) => {
    const beforeValue = valueOrNull(beforeRecord, path);
    const afterValue = valueOrNull(afterRecord, path);
    return stableStringify(beforeValue) === stableStringify(afterValue)
      ? []
      : [{ path, before: beforeValue, after: afterValue }];
  });
};

const edgeKey = (edge: Pick<GraphEdge, "from" | "to" | "kind">): string =>
  stableStringify([edge.from, edge.to, edge.kind]);

const nodeChanged = (before: GraphNode, after: GraphNode): ChangedNode => ({
  stableKey: before.stableKey,
  before,
  after,
  changes: fieldChanges(before, after),
});

const edgeChanged = (before: GraphEdge, after: GraphEdge): ChangedEdge => ({
  from: before.from,
  to: before.to,
  kind: before.kind,
  before,
  after,
  changes: fieldChanges(before, after),
});

const diagnosticChanged = (
  before: Diagnostic,
  after: Diagnostic,
): ChangedDiagnostic => ({
  id: before.id,
  before,
  after,
  changes: fieldChanges(before, after),
});

const nodeDiff = (
  before: readonly GraphNode[],
  after: readonly GraphNode[],
): GraphDiff["nodes"] => {
  const beforeByKey = new Map(before.map((node) => [node.stableKey, node]));
  const afterByKey = new Map(after.map((node) => [node.stableKey, node]));
  const added = after.filter((node) => !beforeByKey.has(node.stableKey));
  const removed = before.filter((node) => !afterByKey.has(node.stableKey));
  const changed = after
    .filter((node) => {
      const previous = beforeByKey.get(node.stableKey);
      return (
        previous !== undefined &&
        stableStringify(previous) !== stableStringify(node)
      );
    })
    .map((node) =>
      nodeChanged(beforeByKey.get(node.stableKey) as GraphNode, node),
    );

  return { added, removed, changed };
};

const edgeDiff = (
  before: readonly GraphEdge[],
  after: readonly GraphEdge[],
): GraphDiff["edges"] => {
  const beforeByKey = new Map(before.map((edge) => [edgeKey(edge), edge]));
  const afterByKey = new Map(after.map((edge) => [edgeKey(edge), edge]));
  const added = after.filter((edge) => !beforeByKey.has(edgeKey(edge)));
  const removed = before.filter((edge) => !afterByKey.has(edgeKey(edge)));
  const changed = after
    .filter((edge) => {
      const previous = beforeByKey.get(edgeKey(edge));
      return (
        previous !== undefined &&
        stableStringify(previous) !== stableStringify(edge)
      );
    })
    .map((edge) =>
      edgeChanged(beforeByKey.get(edgeKey(edge)) as GraphEdge, edge),
    );

  return { added, removed, changed };
};

const diagnosticDiff = (
  before: readonly Diagnostic[],
  after: readonly Diagnostic[],
): GraphDiff["diagnostics"] => {
  const beforeById = new Map(
    before.map((diagnostic) => [diagnostic.id, diagnostic]),
  );
  const afterById = new Map(
    after.map((diagnostic) => [diagnostic.id, diagnostic]),
  );
  const added = after.filter((diagnostic) => !beforeById.has(diagnostic.id));
  const removed = before.filter((diagnostic) => !afterById.has(diagnostic.id));
  const changed = after
    .filter((diagnostic) => {
      const previous = beforeById.get(diagnostic.id);
      return (
        previous !== undefined &&
        stableStringify(previous) !== stableStringify(diagnostic)
      );
    })
    .map((diagnostic) =>
      diagnosticChanged(
        beforeById.get(diagnostic.id) as Diagnostic,
        diagnostic,
      ),
    );

  return { added, removed, changed };
};

const summarizeDiff = (
  nodes: GraphDiff["nodes"],
  edges: GraphDiff["edges"],
  diagnostics: GraphDiff["diagnostics"],
): GraphDiff["summary"] => ({
  nodesAdded: nodes.added.length,
  nodesRemoved: nodes.removed.length,
  nodesChanged: nodes.changed.length,
  edgesAdded: edges.added.length,
  edgesRemoved: edges.removed.length,
  edgesChanged: edges.changed.length,
  diagnosticsAdded: diagnostics.added.length,
  diagnosticsRemoved: diagnostics.removed.length,
  diagnosticsChanged: diagnostics.changed.length,
});

const deduplicateDiffRecords = <T>(
  records: readonly T[],
  identity: (record: T) => string,
  label: string,
): T[] => {
  const seen = new Map<string, T>();
  for (const record of records) {
    const key = identity(record);
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, record);
      continue;
    }
    if (stableStringify(existing) !== stableStringify(record)) {
      throw new GraphContractError(
        "conflict",
        `conflicting duplicate ${label} for identity ${key}`,
      );
    }
  }
  return [...seen.values()];
};

const sortNodes = (nodes: readonly GraphNode[]): GraphNode[] =>
  deduplicateDiffRecords(
    nodes.map(canonicalizeGraphNode),
    (node) => node.stableKey,
    "node",
  ).sort((left, right) => compareStrings(left.stableKey, right.stableKey));

const sortEdges = (edges: readonly GraphEdge[]): GraphEdge[] =>
  deduplicateDiffRecords(
    edges.map(canonicalizeGraphEdge),
    edgeKey,
    "edge",
  ).sort((left, right) => compareStrings(edgeKey(left), edgeKey(right)));

const sortDiagnostics = (diagnostics: readonly Diagnostic[]): Diagnostic[] =>
  deduplicateDiffRecords(
    diagnostics.map(canonicalizeDiagnostic),
    (diagnostic) => diagnostic.id,
    "diagnostic",
  ).sort((left, right) => compareStrings(left.id, right.id));

const canonicalizeChangedNodes = (
  changes: readonly ChangedNode[],
): ChangedNode[] =>
  deduplicateDiffRecords(
    changes.map((change) => {
      const before = canonicalizeGraphNode(change.before);
      const after = canonicalizeGraphNode(change.after);
      if (
        before.stableKey !== after.stableKey ||
        change.stableKey !== before.stableKey
      ) {
        throw new GraphContractError(
          "conflict",
          `changed node identity does not match stable key ${change.stableKey}`,
        );
      }
      return {
        stableKey: before.stableKey,
        before,
        after,
        changes: fieldChanges(before, after),
      };
    }),
    (change) => change.stableKey,
    "changed node",
  ).sort((left, right) => compareStrings(left.stableKey, right.stableKey));

const canonicalizeChangedEdges = (
  changes: readonly ChangedEdge[],
): ChangedEdge[] =>
  deduplicateDiffRecords(
    changes.map((change) => {
      const before = canonicalizeGraphEdge(change.before);
      const after = canonicalizeGraphEdge(change.after);
      const beforeKey = edgeKey(before);
      const afterKey = edgeKey(after);
      const changeKey = edgeKey(change);
      if (beforeKey !== afterKey || changeKey !== beforeKey) {
        throw new GraphContractError(
          "conflict",
          `changed edge identity does not match ${changeKey}`,
        );
      }
      return {
        from: before.from,
        to: before.to,
        kind: before.kind,
        before,
        after,
        changes: fieldChanges(before, after),
      };
    }),
    edgeKey,
    "changed edge",
  ).sort((left, right) => compareStrings(edgeKey(left), edgeKey(right)));

const canonicalizeChangedDiagnostics = (
  changes: readonly ChangedDiagnostic[],
): ChangedDiagnostic[] =>
  deduplicateDiffRecords(
    changes.map((change) => {
      const before = canonicalizeDiagnostic(change.before);
      const after = canonicalizeDiagnostic(change.after);
      if (before.id !== after.id || change.id !== before.id) {
        throw new GraphContractError(
          "conflict",
          `changed diagnostic identity does not match ${change.id}`,
        );
      }
      return {
        id: before.id,
        before,
        after,
        changes: fieldChanges(before, after),
      };
    }),
    (change) => change.id,
    "changed diagnostic",
  ).sort((left, right) => compareStrings(left.id, right.id));

export const canonicalizeGraphDiff = (input: unknown): GraphDiff => {
  assertSupportedSchemaVersion(input, "GraphDiff", GRAPH_DIFF_SCHEMA_VERSION);
  assertSupportedCapabilityRegistryVersion(input);
  const parsed = GraphDiffSchema.parse(input);
  const nodes = {
    added: sortNodes(parsed.nodes.added),
    removed: sortNodes(parsed.nodes.removed),
    changed: canonicalizeChangedNodes(parsed.nodes.changed),
  };
  const edges = {
    added: sortEdges(parsed.edges.added),
    removed: sortEdges(parsed.edges.removed),
    changed: canonicalizeChangedEdges(parsed.edges.changed),
  };
  const diagnostics = {
    added: sortDiagnostics(parsed.diagnostics.added),
    removed: sortDiagnostics(parsed.diagnostics.removed),
    changed: canonicalizeChangedDiagnostics(parsed.diagnostics.changed),
  };
  const summary = summarizeDiff(nodes, edges, diagnostics);
  if (stableStringify(parsed.summary) !== stableStringify(summary)) {
    throw new GraphContractError(
      "conflict",
      "graph diff summary does not match its change arrays",
    );
  }
  const canonical = {
    ...parsed,
    summary,
    nodes,
    edges,
    diagnostics,
  };

  return GraphDiffSchema.parse(canonical);
};

/**
 * Compare two snapshots using semantic identities instead of serialized
 * positions. Nodes are identified by stableKey, edges by from/to/kind, and
 * diagnostics by id. A matching identity is classified as changed when any
 * canonical field differs; the field list therefore makes confidence,
 * evidence, unresolved reasons, and diagnostic context reviewable without
 * treating a reordering as a graph change.
 */
export const diffGraphSnapshots = (
  beforeInput: unknown,
  afterInput: unknown,
): GraphDiff => {
  const before = canonicalizeGraphSnapshot(beforeInput);
  const after = canonicalizeGraphSnapshot(afterInput);
  assertCompatibleCapabilityRegistryVersion(
    before.capabilityRegistryVersion,
    after.capabilityRegistryVersion,
  );
  const nodes = nodeDiff(before.nodes, after.nodes);
  const edges = edgeDiff(before.edges, after.edges);
  const diagnostics = diagnosticDiff(before.diagnostics, after.diagnostics);
  const diff = {
    schemaVersion: 1 as const,
    capabilityRegistryVersion: before.capabilityRegistryVersion,
    summary: summarizeDiff(nodes, edges, diagnostics),
    fromRevision: before.revision,
    toRevision: after.revision,
    nodes,
    edges,
    diagnostics,
  };

  return canonicalizeGraphDiff(diff);
};

export const diffSnapshots = diffGraphSnapshots;

export const parseGraphDiff = (input: unknown): GraphDiff =>
  canonicalizeGraphDiff(input);

export const serializeGraphDiff = (diff: unknown): string =>
  stableStringify(canonicalizeGraphDiff(diff));
