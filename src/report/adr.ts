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
export const ADR_COVERAGE_SCHEMA_VERSION = 1 as const;

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

export type AdrCoverageTargetType = "node" | "edge";
export type AdrCoverageResolution = "resolved" | "ambiguous" | "unresolved";

export type AdrCoverageTarget = {
  id: string;
  type: AdrCoverageTargetType;
  kind: GraphNode["kind"] | GraphEdge["kind"];
};

export type AdrCoverageGraphLink = {
  graphId: string;
  resolution: AdrCoverageResolution;
  targets: AdrCoverageTarget[];
};

export type AdrCoverageAdrEntry = {
  id: string;
  file: string;
  status: AdrReference["status"];
  links: AdrCoverageGraphLink[];
};

export type AdrCoverageGraphEntry = AdrCoverageTarget & {
  adrIds: string[];
  ambiguousAdrIds: string[];
};

export type AdrCoverageKindCount = {
  kind: GraphNode["kind"] | GraphEdge["kind"];
  total: number;
  linked: number;
  ambiguous: number;
  unlinked: number;
};

export type AdrCoverageObjectCounts = {
  total: number;
  linked: number;
  ambiguous: number;
  unlinked: number;
  byKind: AdrCoverageKindCount[];
};

export type AdrCoverage = {
  schemaVersion: typeof ADR_COVERAGE_SCHEMA_VERSION;
  snapshotRevision?: string;
  adrReferences: {
    total: number;
    linked: number;
    ambiguous: number;
    unlinked: number;
  };
  graphLinks: {
    total: number;
    resolved: number;
    ambiguous: number;
    unresolved: number;
  };
  nodes: AdrCoverageObjectCounts;
  edges: AdrCoverageObjectCounts;
  adrToGraph: AdrCoverageAdrEntry[];
  graphToAdr: AdrCoverageGraphEntry[];
};

export type AdrReportCoverage = {
  current?: AdrCoverage;
  previous?: AdrCoverage;
};

export type AdrReport = {
  schemaVersion: typeof ADR_REPORT_SCHEMA_VERSION;
  summary: AdrReportSummary;
  references: AdrReportReference[];
  diagnostics: AdrReferenceDiagnostic[];
  coverage?: AdrReportCoverage;
};

export type AdrReportBuildOptions = {
  current?: AdrReferenceDocument;
  previous?: AdrReferenceDocument;
  root?: string;
  currentSnapshot?: Pick<GraphSnapshot, "nodes" | "edges"> &
    Partial<Pick<GraphSnapshot, "revision">>;
  previousSnapshot?: Pick<GraphSnapshot, "nodes" | "edges"> &
    Partial<Pick<GraphSnapshot, "revision">>;
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

const nodeKinds: readonly GraphNode["kind"][] = [
  "database_table",
  "endpoint",
  "external_service",
  "file",
  "function",
  "module",
  "package",
  "queue",
  "service",
  "unknown",
];

const edgeKinds: readonly GraphEdge["kind"][] = [
  "calls",
  "contains",
  "depends_on",
  "implements",
  "imports",
  "publishes",
  "reads",
  "requests",
  "routes_to",
  "subscribes",
  "unknown",
  "writes",
];

type CoverageTargetRecord = AdrCoverageTarget & { aliases: string[] };

const coverageNodeTarget = (node: GraphNode): CoverageTargetRecord => ({
  id: `node:${node.id}`,
  type: "node",
  kind: node.kind,
  aliases: sortUnique([
    node.id,
    node.stableKey,
    `node:${node.id}`,
    `node:${node.stableKey}`,
  ]),
});

const coverageEdgeTarget = (edge: GraphEdge): CoverageTargetRecord => {
  const id = serializeAdrGraphEdgeId(edge);
  return { id, type: "edge", kind: edge.kind, aliases: [id] };
};

const targetForOutput = ({
  aliases: _aliases,
  ...target
}: CoverageTargetRecord) => target;

const resolveCoverageGraphId = (
  graphId: string,
  targets: readonly CoverageTargetRecord[],
): { resolution: AdrCoverageResolution; targets: AdrCoverageTarget[] } => {
  const matches = targets.filter((target) => target.aliases.includes(graphId));
  const unique = new Map(matches.map((target) => [target.id, target]));
  const resolvedTargets = [...unique.values()]
    .sort((left, right) => compareStrings(left.id, right.id))
    .map(targetForOutput);
  return {
    resolution:
      resolvedTargets.length === 0
        ? "unresolved"
        : resolvedTargets.length === 1
          ? "resolved"
          : "ambiguous",
    targets: resolvedTargets,
  };
};

const emptyKindCounts = (
  kinds: readonly (GraphNode["kind"] | GraphEdge["kind"])[],
): AdrCoverageKindCount[] =>
  kinds.map((kind) => ({
    kind,
    total: 0,
    linked: 0,
    ambiguous: 0,
    unlinked: 0,
  }));

const summarizeCoverageObjects = (
  targets: readonly CoverageTargetRecord[],
  adrIdsByTarget: ReadonlyMap<string, ReadonlySet<string>>,
  ambiguousAdrIdsByTarget: ReadonlyMap<string, ReadonlySet<string>>,
  kinds: readonly (GraphNode["kind"] | GraphEdge["kind"])[],
): AdrCoverageObjectCounts => {
  const byKind = new Map(
    emptyKindCounts(kinds).map((entry) => [entry.kind, entry]),
  );
  let linked = 0;
  let ambiguous = 0;
  let unlinked = 0;
  for (const target of targets) {
    const exactAdrIds = adrIdsByTarget.get(target.id) ?? new Set<string>();
    const ambiguousAdrIds =
      ambiguousAdrIdsByTarget.get(target.id) ?? new Set<string>();
    const status =
      exactAdrIds.size > 0
        ? "linked"
        : ambiguousAdrIds.size > 0
          ? "ambiguous"
          : "unlinked";
    if (status === "linked") linked += 1;
    else if (status === "ambiguous") ambiguous += 1;
    else unlinked += 1;
    const count = byKind.get(target.kind);
    if (count === undefined) continue;
    count.total += 1;
    if (status === "linked") count.linked += 1;
    else if (status === "ambiguous") count.ambiguous += 1;
    else count.unlinked += 1;
  }
  return {
    total: targets.length,
    linked,
    ambiguous,
    unlinked,
    byKind: [...byKind.values()],
  };
};

/**
 * Build the deterministic bidirectional ADR coverage index for one graph
 * snapshot. Coverage is descriptive: unresolved and ambiguous references stay
 * visible and are never counted as a definite link.
 */
export const buildAdrCoverage = (
  snapshot: Pick<GraphSnapshot, "nodes" | "edges"> &
    Partial<Pick<GraphSnapshot, "revision">>,
  document: AdrReferenceDocument,
): AdrCoverage => {
  const nodeTargets = snapshot.nodes.map(coverageNodeTarget);
  const edgeTargets = snapshot.edges.map(coverageEdgeTarget);
  const targets = [...nodeTargets, ...edgeTargets];
  const adrIdsByTarget = new Map<string, Set<string>>();
  const ambiguousAdrIdsByTarget = new Map<string, Set<string>>();
  const adrToGraph: AdrCoverageAdrEntry[] = [];
  let resolvedLinks = 0;
  let ambiguousLinks = 0;
  let unresolvedLinks = 0;

  for (const reference of [...document.references].sort((left, right) =>
    compareStrings(left.id, right.id),
  )) {
    const links: AdrCoverageGraphLink[] = [];
    for (const graphId of sortUnique(reference.graphIds)) {
      const resolution = resolveCoverageGraphId(graphId, targets);
      links.push({ graphId, ...resolution });
      if (resolution.resolution === "resolved") resolvedLinks += 1;
      else if (resolution.resolution === "ambiguous") ambiguousLinks += 1;
      else unresolvedLinks += 1;
      for (const target of resolution.targets) {
        const targetMap =
          resolution.resolution === "ambiguous"
            ? ambiguousAdrIdsByTarget
            : adrIdsByTarget;
        const adrIds = targetMap.get(target.id) ?? new Set<string>();
        adrIds.add(reference.id);
        targetMap.set(target.id, adrIds);
      }
    }
    adrToGraph.push({
      id: reference.id,
      file: reference.file,
      status: reference.status,
      links,
    });
  }

  const graphToAdr = targets
    .map((target) => ({
      id: target.id,
      type: target.type,
      kind: target.kind,
      adrIds: sortUnique([...(adrIdsByTarget.get(target.id) ?? [])]),
      ambiguousAdrIds: sortUnique([
        ...(ambiguousAdrIdsByTarget.get(target.id) ?? []),
      ]),
    }))
    .sort((left, right) =>
      compareStrings(
        `${left.type}\u0000${left.id}`,
        `${right.type}\u0000${right.id}`,
      ),
    );

  let linkedReferences = 0;
  let ambiguousReferences = 0;
  let unlinkedReferences = 0;
  for (const entry of adrToGraph) {
    if (entry.links.some((link) => link.resolution === "resolved"))
      linkedReferences += 1;
    else if (entry.links.some((link) => link.resolution === "ambiguous"))
      ambiguousReferences += 1;
    else unlinkedReferences += 1;
  }

  return {
    schemaVersion: ADR_COVERAGE_SCHEMA_VERSION,
    ...(snapshot.revision?.commitSha === undefined
      ? {}
      : { snapshotRevision: snapshot.revision.commitSha }),
    adrReferences: {
      total: adrToGraph.length,
      linked: linkedReferences,
      ambiguous: ambiguousReferences,
      unlinked: unlinkedReferences,
    },
    graphLinks: {
      total: resolvedLinks + ambiguousLinks + unresolvedLinks,
      resolved: resolvedLinks,
      ambiguous: ambiguousLinks,
      unresolved: unresolvedLinks,
    },
    nodes: summarizeCoverageObjects(
      nodeTargets,
      adrIdsByTarget,
      ambiguousAdrIdsByTarget,
      nodeKinds,
    ),
    edges: summarizeCoverageObjects(
      edgeTargets,
      adrIdsByTarget,
      ambiguousAdrIdsByTarget,
      edgeKinds,
    ),
    adrToGraph,
    graphToAdr,
  };
};

export const serializeAdrCoverage = (coverage: AdrCoverage): string =>
  stableStringify(coverage);

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

  const currentCoverage =
    options.current === undefined || options.currentSnapshot === undefined
      ? undefined
      : buildAdrCoverage(options.currentSnapshot, options.current);
  const previousCoverage =
    options.previous === undefined || options.previousSnapshot === undefined
      ? undefined
      : buildAdrCoverage(options.previousSnapshot, options.previous);
  const coverage =
    currentCoverage === undefined && previousCoverage === undefined
      ? undefined
      : {
          ...(currentCoverage === undefined
            ? {}
            : { current: currentCoverage }),
          ...(previousCoverage === undefined
            ? {}
            : { previous: previousCoverage }),
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
    ...(coverage === undefined ? {} : { coverage }),
  };
};
