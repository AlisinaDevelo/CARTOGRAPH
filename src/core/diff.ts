import {
  GraphDiffSchema,
  GRAPH_DIFF_SCHEMA_VERSION,
  type ChangedDiagnostic,
  type ChangedEdge,
  type ChangedNode,
  type Diagnostic,
  type EdgeChangeClassification,
  type FieldChange,
  type GraphDiff,
  type GraphEdge,
  type GraphNode,
  type DiffComparison,
  type RewiredEdge,
} from "./schemas.js";
import {
  reconcileGraphNodeIdentities,
  type IdentityReconciliation,
  type IdentityReconciliationOptions,
} from "./identity.js";
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

const classifyEdgeChange = (
  changes: readonly FieldChange[],
): EdgeChangeClassification => {
  const paths = changes.map((change) => change.path);
  if (paths.length === 1 && paths[0] === "evidence") return "evidence-only";
  if (paths.length === 1 && paths[0] === "confidence") {
    return "confidence-changed";
  }
  return "edge-changed";
};

const nodeChanged = (before: GraphNode, after: GraphNode): ChangedNode => {
  const changes = fieldChanges(before, after);
  return {
    stableKey: before.stableKey,
    before,
    after,
    changes,
    classification: "node-changed",
  };
};

const edgeChanged = (before: GraphEdge, after: GraphEdge): ChangedEdge => {
  const changes = fieldChanges(before, after);
  return {
    from: before.from,
    to: before.to,
    kind: before.kind,
    before,
    after,
    changes,
    classification: classifyEdgeChange(changes),
  };
};

const diagnosticChanged = (
  before: Diagnostic,
  after: Diagnostic,
): ChangedDiagnostic => {
  const changes = fieldChanges(before, after);
  return {
    id: before.id,
    before,
    after,
    changes,
    classification: "diagnostic-changed",
  };
};

const evidenceIds = (edge: GraphEdge): Set<string> =>
  new Set(edge.evidence.map((evidence) => evidence.id));

const rewireScore = (before: GraphEdge, after: GraphEdge): number => {
  if (before.kind !== after.kind || edgeKey(before) === edgeKey(after)) {
    return -1;
  }

  const beforeEvidence = evidenceIds(before);
  const sharedEvidence = after.evidence.reduce(
    (count, evidence) => count + (beforeEvidence.has(evidence.id) ? 1 : 0),
    0,
  );
  if (sharedEvidence > 0) return 100 + sharedEvidence;

  const sameFrom = before.from === after.from;
  const sameTo = before.to === after.to;
  if (sameFrom === sameTo) return -1;
  return 10;
};

const rewireIdentity = (
  change: Pick<RewiredEdge, "before" | "after">,
): string => `${edgeKey(change.before)}=>${edgeKey(change.after)}`;

const makeRewiredEdge = (before: GraphEdge, after: GraphEdge): RewiredEdge => ({
  before,
  after,
  changes: fieldChanges(before, after),
  classification: "endpoint-rewired",
});

/**
 * Pair an edge removal with an edge addition only when the pairing is
 * unambiguous. Shared evidence is the strongest identity signal; otherwise
 * a shared source or target plus edge kind is sufficient for a one-to-one
 * endpoint rewire. The original added/removed sets are intentionally kept so
 * consumers that only understand the v0.1 set-difference shape remain valid.
 */
const inferRewiredEdges = (
  removed: readonly GraphEdge[],
  added: readonly GraphEdge[],
): RewiredEdge[] => {
  type Candidate = {
    before: GraphEdge;
    after: GraphEdge;
    score: number;
  };
  const candidates: Candidate[] = [];
  for (const before of removed) {
    for (const after of added) {
      const score = rewireScore(before, after);
      if (score >= 0) candidates.push({ before, after, score });
    }
  }

  const bestForBefore = new Map<string, Candidate[]>();
  const bestForAfter = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const beforeKey = edgeKey(candidate.before);
    const afterKey = edgeKey(candidate.after);
    const beforeCandidates = bestForBefore.get(beforeKey) ?? [];
    beforeCandidates.push(candidate);
    bestForBefore.set(beforeKey, beforeCandidates);
    const afterCandidates = bestForAfter.get(afterKey) ?? [];
    afterCandidates.push(candidate);
    bestForAfter.set(afterKey, afterCandidates);
  }

  const uniqueBest = (items: readonly Candidate[]): Candidate | undefined => {
    const maxScore = Math.max(...items.map((item) => item.score));
    const best = items.filter((item) => item.score === maxScore);
    return best.length === 1 ? best[0] : undefined;
  };

  const paired = candidates.filter((candidate) => {
    const beforeBest = uniqueBest(
      bestForBefore.get(edgeKey(candidate.before)) ?? [],
    );
    const afterBest = uniqueBest(
      bestForAfter.get(edgeKey(candidate.after)) ?? [],
    );
    return beforeBest === candidate && afterBest === candidate;
  });

  return paired
    .map((candidate) => makeRewiredEdge(candidate.before, candidate.after))
    .sort((left, right) => {
      const beforeOrder = compareStrings(
        edgeKey(left.before),
        edgeKey(right.before),
      );
      return beforeOrder !== 0
        ? beforeOrder
        : compareStrings(edgeKey(left.after), edgeKey(right.after));
    });
};

const nodeDiff = (
  before: readonly GraphNode[],
  after: readonly GraphNode[],
  identity: IdentityReconciliation,
): GraphDiff["nodes"] => {
  const beforeByKey = new Map(before.map((node) => [node.stableKey, node]));
  const added = identity.added;
  const removed = identity.removed;
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

const identityEvidence = (key: string, detail: string) => ({
  id: `identity-evidence:${key}:${encodeURIComponent(detail)}`,
  kind: "user" as const,
  reference: `graph://identity/${key}/${encodeURIComponent(detail)}`,
});

const identityAmbiguityDiagnostic = (
  ambiguity: IdentityReconciliation["ambiguous"][number],
): Diagnostic => {
  const key = encodeURIComponent(ambiguity.before.stableKey);
  const code =
    ambiguity.reason === "non-mutual-best"
      ? "IDENTITY_COLLISION"
      : "AMBIGUOUS_IDENTITY_MATCH";
  const candidateKeys = ambiguity.candidates
    .map((candidate) => candidate.afterStableKey)
    .sort(compareStrings)
    .join(", ");
  const message =
    ambiguity.reason === "non-mutual-best"
      ? `Identity candidates collide for ${ambiguity.before.stableKey}; candidates: ${candidateKeys}.`
      : `Could not safely match ${ambiguity.before.stableKey}; candidates: ${candidateKeys}.`;
  const remediation =
    ambiguity.reason === "non-mutual-best"
      ? "Review every candidate and add stable source, path, or neighborhood evidence before accepting identity continuity."
      : "Review the candidate identities and add stable source or path evidence before accepting the refactor match.";
  return {
    id: `diagnostic:identity:${code.toLowerCase()}:${key}`,
    code,
    severity: "warning",
    message,
    remediation,
    nodeId: ambiguity.before.id,
    evidence: ambiguity.candidates.map((candidate) =>
      identityEvidence(`ambiguity/${key}`, candidate.afterStableKey),
    ),
  };
};

const identityFallbackDiagnostic = (
  match: IdentityReconciliation["matches"][number],
): Diagnostic => ({
  id: `diagnostic:identity-fallback:${encodeURIComponent(match.beforeStableKey)}`,
  code: "IDENTITY_FALLBACK_MATCH",
  severity: "info",
  message: `Used ${match.method} fallback identity for ${match.beforeStableKey} => ${match.afterStableKey}; evidence: ${match.signals.join(", ")}.`,
  remediation:
    "Review the contributing identity signals before treating the fallback match as canonical history.",
  nodeId: match.after.id,
  evidence: match.signals.map((signal) =>
    identityEvidence(
      `fallback/${encodeURIComponent(match.beforeStableKey)}`,
      signal,
    ),
  ),
});

const identityUnsupportedDiagnostic = (
  candidate: IdentityReconciliation["unsupported"][number],
): Diagnostic => ({
  id: `diagnostic:identity-unsupported:${encodeURIComponent(candidate.before.stableKey)}:${encodeURIComponent(candidate.after.stableKey)}`,
  code: "UNSUPPORTED_IDENTITY_RENAME",
  severity: "warning",
  message: `Could not safely reconcile a possible rename from ${candidate.before.stableKey} to ${candidate.after.stableKey}; similarity score ${candidate.score}.`,
  remediation:
    "Review the rename manually or provide path-history, source, or neighborhood evidence before accepting identity continuity.",
  nodeId: candidate.after.id,
  evidence: candidate.signals.map((signal) =>
    identityEvidence(
      `unsupported/${encodeURIComponent(candidate.before.stableKey)}`,
      signal,
    ),
  ),
});

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

  return {
    added,
    removed,
    changed,
    rewired: inferRewiredEdges(removed, added),
  };
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
        classification: "node-changed" as const,
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
        classification: classifyEdgeChange(fieldChanges(before, after)),
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
        classification: "diagnostic-changed" as const,
      };
    }),
    (change) => change.id,
    "changed diagnostic",
  ).sort((left, right) => compareStrings(left.id, right.id));

const canonicalizeRewiredEdges = (
  changes: readonly RewiredEdge[],
): RewiredEdge[] =>
  deduplicateDiffRecords(
    changes.map((change) => {
      const before = canonicalizeGraphEdge(change.before);
      const after = canonicalizeGraphEdge(change.after);
      if (before.kind !== after.kind || edgeKey(before) === edgeKey(after)) {
        throw new GraphContractError(
          "conflict",
          "rewired edge must preserve kind and change at least one endpoint",
        );
      }
      return makeRewiredEdge(before, after);
    }),
    rewireIdentity,
    "rewired edge",
  ).sort((left, right) => {
    const beforeOrder = compareStrings(
      edgeKey(left.before),
      edgeKey(right.before),
    );
    return beforeOrder !== 0
      ? beforeOrder
      : compareStrings(edgeKey(left.after), edgeKey(right.after));
  });

const identityMatchKey = (
  match: GraphDiff["identity"]["matches"][number],
): string => `${match.beforeStableKey}\u0000${match.afterStableKey}`;

type IdentityCandidateRecord =
  GraphDiff["identity"]["ambiguous"][number]["candidates"][number];

const sortIdentityCandidates = (
  candidates: readonly IdentityCandidateRecord[],
): IdentityCandidateRecord[] =>
  [...candidates].sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    const beforeOrder = compareStrings(
      left.beforeStableKey,
      right.beforeStableKey,
    );
    return beforeOrder !== 0
      ? beforeOrder
      : compareStrings(left.afterStableKey, right.afterStableKey);
  });

const canonicalizeIdentity = (
  identity: GraphDiff["identity"],
): GraphDiff["identity"] => {
  const matches = deduplicateDiffRecords(
    identity.matches.map((match) => {
      const before = canonicalizeGraphNode(match.before);
      const after = canonicalizeGraphNode(match.after);
      if (
        before.stableKey !== match.beforeStableKey ||
        after.stableKey !== match.afterStableKey
      ) {
        throw new GraphContractError(
          "conflict",
          `identity match does not match stable keys ${match.beforeStableKey}=>${match.afterStableKey}`,
        );
      }
      return {
        ...match,
        before,
        after,
        signals: [...match.signals].sort(compareStrings),
      };
    }),
    identityMatchKey,
    "identity match",
  ).sort((left, right) => {
    const beforeOrder = compareStrings(
      left.beforeStableKey,
      right.beforeStableKey,
    );
    return beforeOrder !== 0
      ? beforeOrder
      : compareStrings(left.afterStableKey, right.afterStableKey);
  });

  const ambiguous = deduplicateDiffRecords(
    identity.ambiguous.map((ambiguity) => {
      const before = canonicalizeGraphNode(ambiguity.before);
      const candidates = sortIdentityCandidates(
        ambiguity.candidates.map((candidate) => ({
          ...candidate,
          signals: [...candidate.signals].sort(compareStrings),
        })),
      );
      if (
        candidates.some(
          (candidate) => candidate.beforeStableKey !== before.stableKey,
        )
      ) {
        throw new GraphContractError(
          "conflict",
          `identity ambiguity candidates do not match ${before.stableKey}`,
        );
      }
      return { ...ambiguity, before, candidates };
    }),
    (ambiguity) => ambiguity.before.stableKey,
    "identity ambiguity",
  ).sort((left, right) =>
    compareStrings(left.before.stableKey, right.before.stableKey),
  );

  const unsupported = deduplicateDiffRecords(
    identity.unsupported.map((candidate) => ({
      ...candidate,
      before: canonicalizeGraphNode(candidate.before),
      after: canonicalizeGraphNode(candidate.after),
      signals: [...candidate.signals].sort(compareStrings),
    })),
    (candidate) =>
      `${candidate.before.stableKey}\u0000${candidate.after.stableKey}`,
    "unsupported identity candidate",
  ).sort((left, right) => {
    const beforeOrder = compareStrings(
      left.before.stableKey,
      right.before.stableKey,
    );
    return beforeOrder !== 0
      ? beforeOrder
      : compareStrings(left.after.stableKey, right.after.stableKey);
  });

  return { matches, ambiguous, unsupported };
};

export const canonicalizeGraphDiff = (input: unknown): GraphDiff => {
  assertSupportedSchemaVersion(input, "GraphDiff", GRAPH_DIFF_SCHEMA_VERSION);
  assertSupportedCapabilityRegistryVersion(input);
  const parsed = GraphDiffSchema.parse(input);
  if (parsed.comparison !== undefined) {
    if (parsed.toRevision.commitSha !== parsed.comparison.headCommitSha)
      throw new GraphContractError(
        "conflict",
        "graph diff comparison head commit does not match toRevision",
      );
    const expectedFromCommit =
      parsed.comparison.mode === "merge-base"
        ? parsed.comparison.mergeBaseSha
        : parsed.comparison.baseCommitSha;
    if (parsed.fromRevision.commitSha !== expectedFromCommit)
      throw new GraphContractError(
        "conflict",
        "graph diff comparison base commit does not match fromRevision",
      );
  }
  const nodes = {
    added: sortNodes(parsed.nodes.added),
    removed: sortNodes(parsed.nodes.removed),
    changed: canonicalizeChangedNodes(parsed.nodes.changed),
  };
  const identity = canonicalizeIdentity(parsed.identity);
  const edgesAdded = sortEdges(parsed.edges.added);
  const edgesRemoved = sortEdges(parsed.edges.removed);
  const edges = {
    added: edgesAdded,
    removed: edgesRemoved,
    changed: canonicalizeChangedEdges(parsed.edges.changed),
    rewired: canonicalizeRewiredEdges([
      ...parsed.edges.rewired,
      ...inferRewiredEdges(edgesRemoved, edgesAdded),
    ]),
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
    identity,
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
export type GraphDiffOptions = {
  comparison?: DiffComparison;
  identity?: IdentityReconciliationOptions;
};

export const diffGraphSnapshots = (
  beforeInput: unknown,
  afterInput: unknown,
  options: GraphDiffOptions = {},
): GraphDiff => {
  const before = canonicalizeGraphSnapshot(beforeInput);
  const after = canonicalizeGraphSnapshot(afterInput);
  assertCompatibleCapabilityRegistryVersion(
    before.capabilityRegistryVersion,
    after.capabilityRegistryVersion,
  );
  const identity = reconcileGraphNodeIdentities(
    before,
    after,
    options.identity,
  );
  const nodes = nodeDiff(before.nodes, after.nodes, identity);
  const edges = edgeDiff(before.edges, after.edges);
  const baseDiagnostics = diagnosticDiff(before.diagnostics, after.diagnostics);
  const diagnostics = {
    ...baseDiagnostics,
    added: [
      ...baseDiagnostics.added,
      ...identity.ambiguous.map(identityAmbiguityDiagnostic),
      ...identity.matches
        .filter((match) => match.method !== "stable-key")
        .map(identityFallbackDiagnostic),
      ...identity.unsupported.map(identityUnsupportedDiagnostic),
    ],
  };
  const diff = {
    schemaVersion: 1 as const,
    capabilityRegistryVersion: before.capabilityRegistryVersion,
    summary: summarizeDiff(nodes, edges, diagnostics),
    ...(options.comparison === undefined
      ? {}
      : { comparison: options.comparison }),
    fromRevision: before.revision,
    toRevision: after.revision,
    nodes,
    identity: {
      matches: identity.matches,
      ambiguous: identity.ambiguous,
      unsupported: identity.unsupported,
    },
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
