import {
  serializeAdrGraphEdgeId,
  stableStringify,
  validateAdrReferences,
  type AdrReference,
  type AdrReferenceDiagnostic,
  type AdrReferenceDocument,
  type GraphDiff,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
  type Evidence,
} from "../core/index.js";

export const ADR_REPORT_SCHEMA_VERSION = 1 as const;

export type AdrReferenceChange = "added" | "removed" | "changed" | "unchanged";
export type AdrReferenceState = AdrReferenceChange | "stale";
export type AdrEvidenceRelation = "added" | "removed" | "changed" | "unchanged";

export type AdrGraphEvidence = {
  graphId: string;
  relation: AdrEvidenceRelation;
  sources: string[];
};

export type AdrReportReference = {
  id: string;
  file: string;
  title: string;
  status: AdrReference["status"];
  change: AdrReferenceChange;
  state: AdrReferenceState;
  graphIds: string[];
  evidence: AdrGraphEvidence[];
  diagnostics: AdrReferenceDiagnostic[];
};

export type AdrReportSummary = {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  stale: number;
};

export type AdrReport = {
  schemaVersion: typeof ADR_REPORT_SCHEMA_VERSION;
  summary: AdrReportSummary;
  references: AdrReportReference[];
  diagnostics: AdrReferenceDiagnostic[];
};

export type AdrReportBuildOptions = {
  current?: AdrReferenceDocument;
  previous?: AdrReferenceDocument;
  root?: string;
  currentSnapshot?: Pick<GraphSnapshot, "nodes" | "edges">;
  previousSnapshot?: Pick<GraphSnapshot, "nodes" | "edges">;
};

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const sortUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const evidenceLabel = (evidence: Evidence): string => {
  const path = evidence.location?.path ?? evidence.path;
  const line = evidence.location?.line ?? evidence.line;
  const position =
    path === undefined
      ? (evidence.reference ?? evidence.id)
      : `${path}${line === undefined ? "" : `:${line}`}`;
  return evidence.detector === undefined
    ? position
    : `${position} (${evidence.detector})`;
};

const nodeSources = (node: GraphNode): string[] =>
  node.location === undefined
    ? [node.id]
    : [
        `${node.location.path}:${node.location.line}`,
        ...(node.location.column === undefined
          ? []
          : [
              `${node.location.path}:${node.location.line}:${node.location.column}`,
            ]),
      ];

const edgeSources = (edge: GraphEdge): string[] =>
  edge.evidence.length > 0
    ? edge.evidence.map(evidenceLabel)
    : [`unresolved: ${edge.unresolvedReason ?? "unspecified"}`];

const nodeAliases = (node: GraphNode): string[] =>
  sortUnique([
    node.id,
    node.stableKey,
    `node:${node.id}`,
    `node:${node.stableKey}`,
  ]);

const edgeAlias = (edge: GraphEdge): string => serializeAdrGraphEdgeId(edge);

type EvidenceAccumulator = Map<string, Map<AdrEvidenceRelation, Set<string>>>;

const addEvidence = (
  accumulator: EvidenceAccumulator,
  aliases: readonly string[],
  relation: AdrEvidenceRelation,
  sources: readonly string[],
): void => {
  const normalizedSources = sortUnique(sources);
  for (const alias of aliases) {
    const records =
      accumulator.get(alias) ?? new Map<AdrEvidenceRelation, Set<string>>();
    const existing = records.get(relation) ?? new Set<string>();
    normalizedSources.forEach((source) => existing.add(source));
    records.set(relation, existing);
    accumulator.set(alias, records);
  }
};

const addSnapshotEvidence = (
  accumulator: EvidenceAccumulator,
  snapshot: Pick<GraphSnapshot, "nodes" | "edges">,
): void => {
  for (const node of snapshot.nodes)
    addEvidence(accumulator, nodeAliases(node), "unchanged", nodeSources(node));
  for (const edge of snapshot.edges)
    addEvidence(accumulator, [edgeAlias(edge)], "unchanged", edgeSources(edge));
};

const addDiffEvidence = (
  accumulator: EvidenceAccumulator,
  diff: GraphDiff,
): void => {
  for (const node of diff.nodes.added)
    addEvidence(accumulator, nodeAliases(node), "added", nodeSources(node));
  for (const node of diff.nodes.removed)
    addEvidence(accumulator, nodeAliases(node), "removed", nodeSources(node));
  for (const change of diff.nodes.changed) {
    addEvidence(
      accumulator,
      nodeAliases(change.before),
      "changed",
      nodeSources(change.before),
    );
    addEvidence(
      accumulator,
      nodeAliases(change.after),
      "changed",
      nodeSources(change.after),
    );
  }

  for (const edge of diff.edges.added)
    addEvidence(accumulator, [edgeAlias(edge)], "added", edgeSources(edge));
  for (const edge of diff.edges.removed)
    addEvidence(accumulator, [edgeAlias(edge)], "removed", edgeSources(edge));
  for (const change of diff.edges.changed) {
    addEvidence(
      accumulator,
      [edgeAlias(change.before), edgeAlias(change.after)],
      "changed",
      [...edgeSources(change.before), ...edgeSources(change.after)],
    );
  }
  for (const change of diff.edges.rewired) {
    addEvidence(
      accumulator,
      [edgeAlias(change.before), edgeAlias(change.after)],
      "changed",
      [...edgeSources(change.before), ...edgeSources(change.after)],
    );
  }
};

const relationRank: Record<AdrEvidenceRelation, number> = {
  changed: 4,
  added: 3,
  removed: 2,
  unchanged: 1,
};

const graphEvidenceFor = (
  graphId: string,
  accumulator: EvidenceAccumulator,
): AdrGraphEvidence => {
  const aliases = graphId.startsWith("node:")
    ? [graphId, graphId.slice("node:".length)]
    : [graphId, `node:${graphId}`];
  const records = aliases.flatMap((alias) => {
    const found = accumulator.get(alias);
    return found === undefined ? [] : [...found.entries()];
  });
  const relation = records.reduce<AdrEvidenceRelation>(
    (best, [candidate]) =>
      relationRank[candidate] > relationRank[best] ? candidate : best,
    "unchanged",
  );
  return {
    graphId,
    relation,
    sources: sortUnique(records.flatMap(([, sources]) => [...sources])),
  };
};

const staleDiagnosticCodes = new Set<AdrReferenceDiagnostic["code"]>([
  "ADR_REFERENCE_MISSING_FILE",
  "ADR_REFERENCE_MALFORMED_FILE",
  "ADR_REFERENCE_STALE_FILE",
  "ADR_REFERENCE_MALFORMED_GRAPH_ID",
  "ADR_REFERENCE_STALE_GRAPH_ID",
  "ADR_REFERENCE_MISSING_GRAPH_ID",
]);

const diagnosticsFor = (
  diagnostics: readonly AdrReferenceDiagnostic[],
  referenceId: string,
): AdrReferenceDiagnostic[] =>
  diagnostics
    .filter((diagnostic) => diagnostic.referenceId === referenceId)
    .sort((left, right) => {
      const leftKey = `${left.code}\u0000${left.graphId ?? ""}\u0000${left.message}`;
      const rightKey = `${right.code}\u0000${right.graphId ?? ""}\u0000${right.message}`;
      return compareStrings(leftKey, rightKey);
    });

const hasStaleDiagnostics = (
  diagnostics: readonly AdrReferenceDiagnostic[],
): boolean =>
  diagnostics.some((diagnostic) => staleDiagnosticCodes.has(diagnostic.code));

const referenceById = (
  document: AdrReferenceDocument | undefined,
): Map<string, AdrReference> =>
  new Map(
    (document?.references ?? []).map((reference) => [reference.id, reference]),
  );

export const buildAdrReport = (
  diff: GraphDiff,
  options: AdrReportBuildOptions,
): AdrReport | undefined => {
  if (options.current === undefined && options.previous === undefined)
    return undefined;

  const diagnostics =
    options.current === undefined
      ? []
      : validateAdrReferences(options.current, {
          ...(options.root === undefined ? {} : { root: options.root }),
          ...(options.currentSnapshot === undefined
            ? {}
            : { snapshot: options.currentSnapshot }),
        }).diagnostics;

  const current = referenceById(options.current);
  const previous = referenceById(options.previous);
  const accumulator: EvidenceAccumulator = new Map();
  if (options.previousSnapshot !== undefined)
    addSnapshotEvidence(accumulator, options.previousSnapshot);
  if (options.currentSnapshot !== undefined)
    addSnapshotEvidence(accumulator, options.currentSnapshot);
  addDiffEvidence(accumulator, diff);

  const references: AdrReportReference[] = [];
  for (const reference of current.values()) {
    const previousReference = previous.get(reference.id);
    const change: AdrReferenceChange =
      previousReference === undefined
        ? "added"
        : stableStringify(previousReference) === stableStringify(reference)
          ? "unchanged"
          : "changed";
    const referenceDiagnostics = diagnosticsFor(diagnostics, reference.id);
    const stale = hasStaleDiagnostics(referenceDiagnostics);
    references.push({
      id: reference.id,
      file: reference.file,
      title: reference.title,
      status: reference.status,
      change,
      state: stale ? "stale" : change,
      graphIds: sortUnique(reference.graphIds),
      evidence: sortUnique(reference.graphIds).map((graphId) =>
        graphEvidenceFor(graphId, accumulator),
      ),
      diagnostics: referenceDiagnostics,
    });
  }

  for (const reference of previous.values()) {
    if (current.has(reference.id)) continue;
    const graphIds = sortUnique(reference.graphIds);
    references.push({
      id: reference.id,
      file: reference.file,
      title: reference.title,
      status: reference.status,
      change: "removed",
      state: "removed",
      graphIds,
      evidence: graphIds.map((graphId) =>
        graphEvidenceFor(graphId, accumulator),
      ),
      diagnostics: [],
    });
  }

  references.sort((left, right) => compareStrings(left.id, right.id));
  const summary: AdrReportSummary = {
    added: references.filter((reference) => reference.change === "added")
      .length,
    removed: references.filter((reference) => reference.change === "removed")
      .length,
    changed: references.filter((reference) => reference.change === "changed")
      .length,
    unchanged: references.filter(
      (reference) => reference.change === "unchanged",
    ).length,
    stale: references.filter((reference) => reference.state === "stale").length,
  };

  return {
    schemaVersion: ADR_REPORT_SCHEMA_VERSION,
    summary,
    references,
    diagnostics: [...diagnostics].sort((left, right) => {
      const leftKey = `${left.referenceId ?? ""}\u0000${left.code}\u0000${left.graphId ?? ""}\u0000${left.message}`;
      const rightKey = `${right.referenceId ?? ""}\u0000${right.code}\u0000${right.graphId ?? ""}\u0000${right.message}`;
      return compareStrings(leftKey, rightKey);
    }),
  };
};
