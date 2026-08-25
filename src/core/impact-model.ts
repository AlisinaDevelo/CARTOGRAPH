import { z } from "zod";

import {
  canonicalizeGraphSnapshot,
  GraphContractError,
  stableStringify,
} from "./canonical.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "./schemas.js";
import { ResourceLimitError } from "../resources.js";

export const ARCHITECTURE_IMPACT_SCHEMA_VERSION = 1 as const;
export const ARCHITECTURE_IMPACT_CONTRACT =
  "cartograph.architecture-impact" as const;

const IMPACT_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u;

const ImpactIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(
    IMPACT_IDENTIFIER_PATTERN,
    "must be a portable lower-case architecture identifier",
  );

export const ImpactNodeKindSchema = z.enum([
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

export const ImpactEdgeKindSchema = z.enum([
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

export const ImpactConfidenceSchema = z.enum([
  "certain",
  "inferred",
  "observed",
  "user_confirmed",
]);

export const ImpactDirectionSchema = z.enum(["forward", "reverse"]);

/** Change categories understood by the v0.1 impact model. */
export const ImpactChangeKindSchema = z.enum([
  "node-added",
  "node-removed",
  "node-changed",
  "edge-added",
  "edge-removed",
  "edge-changed",
  "diagnostic-changed",
  "unsupported",
]);

export const ImpactBoundarySchema = z
  .object({
    stopNodeKinds: z.array(ImpactNodeKindSchema).max(16).default([]),
    stopNodeIds: z.array(ImpactIdentifierSchema).max(128).default([]),
    stopEdgeKinds: z.array(ImpactEdgeKindSchema).max(16).default([]),
  })
  .strict()
  .default({
    stopNodeKinds: [],
    stopNodeIds: [],
    stopEdgeKinds: [],
  });

const IMPACT_EDGE_KINDS = ImpactEdgeKindSchema.options;

export const ImpactChangeSchema = z
  .object({
    kind: ImpactChangeKindSchema,
    roots: z.array(ImpactIdentifierSchema).min(1).max(64),
    confidence: ImpactConfidenceSchema.default("certain"),
    evidenceIds: z.array(ImpactIdentifierSchema).max(128).default([]),
  })
  .strict();

export const ImpactTraversalRuleSchema = z
  .object({
    direction: ImpactDirectionSchema.default("forward"),
    edgeKinds: z
      .array(ImpactEdgeKindSchema)
      .min(1)
      .max(IMPACT_EDGE_KINDS.length)
      .default([...IMPACT_EDGE_KINDS]),
    maxDepth: z.number().int().nonnegative().max(1024).default(8),
    maxNodes: z.number().int().positive().max(1_000_000).default(10_000),
    maxEdges: z.number().int().positive().max(1_000_000).default(20_000),
    includeUnresolved: z.boolean().default(true),
    boundary: ImpactBoundarySchema,
  })
  .strict()
  .default({
    direction: "forward",
    edgeKinds: [...IMPACT_EDGE_KINDS],
    maxDepth: 8,
    maxNodes: 10_000,
    maxEdges: 20_000,
    includeUnresolved: true,
    boundary: {
      stopNodeKinds: [],
      stopNodeIds: [],
      stopEdgeKinds: [],
    },
  });

export const ArchitectureImpactScenarioSchema = z
  .object({
    schemaVersion: z.literal(ARCHITECTURE_IMPACT_SCHEMA_VERSION),
    contract: z.literal(ARCHITECTURE_IMPACT_CONTRACT),
    scenarioId: ImpactIdentifierSchema,
    change: ImpactChangeSchema,
    traversal: ImpactTraversalRuleSchema,
  })
  .strict();

export const ArchitectureImpactReasonCodeSchema = z.enum([
  "changed-root",
  "traversed-edge",
  "unresolved-edge",
  "boundary-stop",
  "depth-limit",
  "cycle",
]);

export const ArchitectureImpactReasonSchema = z
  .object({
    code: ArchitectureImpactReasonCodeSchema,
    message: z.string().trim().min(1).max(2048),
    path: z.array(ImpactIdentifierSchema).min(1).max(1024),
    edge: z
      .object({
        from: ImpactIdentifierSchema,
        to: ImpactIdentifierSchema,
        kind: ImpactEdgeKindSchema,
      })
      .strict()
      .optional(),
    evidenceIds: z.array(ImpactIdentifierSchema).max(128).default([]),
  })
  .strict();

export const ArchitectureImpactUncertaintyCodeSchema = z.enum([
  "unresolved-edge",
  "boundary-stop",
  "depth-limit",
  "cycle",
  "edge-kind-excluded",
  "unsupported-change",
]);

export const ArchitectureImpactUncertaintySchema = z
  .object({
    code: ArchitectureImpactUncertaintyCodeSchema,
    message: z.string().trim().min(1).max(2048),
    evidenceIds: z.array(ImpactIdentifierSchema).max(128).default([]),
  })
  .strict();

export const ArchitectureImpactAffectedNodeSchema = z
  .object({
    id: ImpactIdentifierSchema,
    stableKey: ImpactIdentifierSchema,
    kind: ImpactNodeKindSchema,
    name: z.string().trim().min(1).max(512),
    language: z.string().trim().min(1).max(128).optional(),
    depth: z.number().int().nonnegative(),
    root: z.boolean(),
    confidence: ImpactConfidenceSchema,
    evidenceIds: z.array(ImpactIdentifierSchema).max(128),
    reasons: z.array(ArchitectureImpactReasonSchema).min(1).max(128),
    uncertainty: z.array(ArchitectureImpactUncertaintySchema).max(32),
  })
  .strict();

export const ArchitectureImpactTraversedEdgeSchema = z
  .object({
    from: ImpactIdentifierSchema,
    to: ImpactIdentifierSchema,
    kind: ImpactEdgeKindSchema,
    direction: ImpactDirectionSchema,
    depth: z.number().int().nonnegative(),
    confidence: ImpactConfidenceSchema,
    evidenceIds: z.array(ImpactIdentifierSchema).max(128),
    unresolvedReason: z.string().trim().min(1).max(2048).optional(),
  })
  .strict();

export const ArchitectureImpactUnknownCodeSchema = z.enum([
  "unresolved-edge",
  "boundary-stop",
  "depth-limit",
  "cycle",
  "edge-kind-excluded",
  "missing-target",
  "unsupported-change",
]);

export const ArchitectureImpactUnknownSchema = z
  .object({
    code: ArchitectureImpactUnknownCodeSchema,
    from: ImpactIdentifierSchema.optional(),
    to: ImpactIdentifierSchema.optional(),
    kind: ImpactEdgeKindSchema.optional(),
    nodeId: ImpactIdentifierSchema.optional(),
    traversed: z.boolean(),
    reason: z.string().trim().min(1).max(2048),
    evidenceIds: z.array(ImpactIdentifierSchema).max(128),
  })
  .strict();

export const ArchitectureImpactAssessmentSchema = z
  .object({
    schemaVersion: z.literal(ARCHITECTURE_IMPACT_SCHEMA_VERSION),
    contract: z.literal(ARCHITECTURE_IMPACT_CONTRACT),
    scenarioId: ImpactIdentifierSchema,
    changeKind: ImpactChangeKindSchema,
    supportedChangeKind: z.boolean(),
    direction: ImpactDirectionSchema,
    roots: z.array(ImpactIdentifierSchema).min(1),
    maxDepth: z.number().int().nonnegative(),
    affected: z.array(ArchitectureImpactAffectedNodeSchema),
    traversedEdges: z.array(ArchitectureImpactTraversedEdgeSchema),
    unknowns: z.array(ArchitectureImpactUnknownSchema),
    deterministic: z.literal(true),
    readOnly: z.literal(true),
  })
  .strict();

export type ImpactNodeKind = z.infer<typeof ImpactNodeKindSchema>;
export type ImpactEdgeKind = z.infer<typeof ImpactEdgeKindSchema>;
export type ImpactConfidence = z.infer<typeof ImpactConfidenceSchema>;
export type ImpactDirection = z.infer<typeof ImpactDirectionSchema>;
export type ImpactChangeKind = z.infer<typeof ImpactChangeKindSchema>;
export type ImpactBoundary = z.infer<typeof ImpactBoundarySchema>;
export type ImpactChange = z.infer<typeof ImpactChangeSchema>;
export type ImpactTraversalRule = z.infer<typeof ImpactTraversalRuleSchema>;
export type ArchitectureImpactScenario = z.infer<
  typeof ArchitectureImpactScenarioSchema
>;
export type ArchitectureImpactReason = z.infer<
  typeof ArchitectureImpactReasonSchema
>;
export type ArchitectureImpactUncertainty = z.infer<
  typeof ArchitectureImpactUncertaintySchema
>;
export type ArchitectureImpactAffectedNode = z.infer<
  typeof ArchitectureImpactAffectedNodeSchema
>;
export type ArchitectureImpactTraversedEdge = z.infer<
  typeof ArchitectureImpactTraversedEdgeSchema
>;
export type ArchitectureImpactUnknown = z.infer<
  typeof ArchitectureImpactUnknownSchema
>;
export type ArchitectureImpactAssessment = z.infer<
  typeof ArchitectureImpactAssessmentSchema
>;

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const nodeIdentity = (node: Pick<GraphNode, "stableKey" | "id">): string =>
  `${node.stableKey}\u0000${node.id}`;

const edgeIdentity = (edge: Pick<GraphEdge, "from" | "to" | "kind">): string =>
  stableStringify([edge.from, edge.to, edge.kind]);

const confidenceRank: Record<ImpactConfidence, number> = {
  inferred: 1,
  observed: 2,
  certain: 3,
  user_confirmed: 4,
};

const weakestConfidence = (
  left: ImpactConfidence,
  right: ImpactConfidence,
): ImpactConfidence =>
  confidenceRank[left] <= confidenceRank[right] ? left : right;

const resolveRoots = (
  snapshot: GraphSnapshot,
  roots: readonly string[],
): GraphNode[] => {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const byStableKey = new Map(
    snapshot.nodes.map((node) => [node.stableKey, node]),
  );
  const resolved = new Map<string, GraphNode>();
  for (const requested of roots) {
    const node = byId.get(requested) ?? byStableKey.get(requested);
    if (node === undefined) {
      throw new GraphContractError(
        "conflict",
        `impact root does not match a graph node: ${requested}`,
      );
    }
    resolved.set(node.id, node);
  }
  return [...resolved.values()].sort((left, right) =>
    compareStrings(nodeIdentity(left), nodeIdentity(right)),
  );
};

const reasonIdentity = (reason: ArchitectureImpactReason): string =>
  stableStringify([reason.code, reason.path, reason.edge, reason.evidenceIds]);

const uncertaintyIdentity = (
  uncertainty: ArchitectureImpactUncertainty,
): string => stableStringify([uncertainty.code, uncertainty.evidenceIds]);

const unknownIdentity = (unknown: ArchitectureImpactUnknown): string =>
  stableStringify([
    unknown.code,
    unknown.from,
    unknown.to,
    unknown.kind,
    unknown.nodeId,
  ]);

const edgeForReason = (
  edge: Pick<GraphEdge, "from" | "to" | "kind">,
): ArchitectureImpactReason["edge"] => ({
  from: edge.from,
  to: edge.to,
  kind: edge.kind,
});

const isBoundaryNode = (node: GraphNode, boundary: ImpactBoundary): boolean =>
  boundary.stopNodeIds.includes(node.id) ||
  boundary.stopNodeKinds.includes(node.kind);

const uncertaintyFor = (
  code: z.infer<typeof ArchitectureImpactUncertaintyCodeSchema>,
  message: string,
  evidenceIds: readonly string[],
): ArchitectureImpactUncertainty => ({
  code,
  message,
  evidenceIds: [...new Set(evidenceIds)].sort(compareStrings),
});

const sortReasons = (
  reasons: readonly ArchitectureImpactReason[],
): ArchitectureImpactReason[] =>
  [...reasons].sort((left, right) =>
    compareStrings(reasonIdentity(left), reasonIdentity(right)),
  );

const sortUncertainties = (
  uncertainties: readonly ArchitectureImpactUncertainty[],
): ArchitectureImpactUncertainty[] =>
  [...uncertainties].sort((left, right) =>
    compareStrings(uncertaintyIdentity(left), uncertaintyIdentity(right)),
  );

const addUnique = <T>(
  values: readonly T[],
  value: T,
  identity: (item: T) => string,
): T[] => {
  const key = identity(value);
  return values.some((item) => identity(item) === key)
    ? [...values]
    : [...values, value];
};

type PendingNode = {
  node: GraphNode;
  depth: number;
  root: boolean;
  confidence: ImpactConfidence;
  path: string[];
  evidenceIds: string[];
  reasons: ArchitectureImpactReason[];
  uncertainty: ArchitectureImpactUncertainty[];
};

type WalkState = {
  nodeId: string;
  depth: number;
  path: string[];
  confidence: ImpactConfidence;
  evidenceIds: string[];
};

const sortEdges = (
  edges: readonly ArchitectureImpactTraversedEdge[],
): ArchitectureImpactTraversedEdge[] =>
  [...edges].sort((left, right) => {
    if (left.depth !== right.depth) return left.depth - right.depth;
    return compareStrings(edgeIdentity(left), edgeIdentity(right));
  });

/**
 * Assess a changed graph node or edge with explicit traversal and boundary
 * rules. The assessment is deliberately explanation-first: every affected
 * node has a path, confidence, reason, evidence IDs, and any visible
 * uncertainty; omitted relationships remain in `unknowns`.
 */
export const assessArchitectureImpact = (
  snapshotInput: unknown,
  scenarioInput: unknown,
): ArchitectureImpactAssessment => {
  const scenario = ArchitectureImpactScenarioSchema.parse(scenarioInput);
  const snapshot = canonicalizeGraphSnapshot(snapshotInput);
  const roots = resolveRoots(snapshot, scenario.change.roots);
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const allowedEdgeKinds = new Set(scenario.traversal.edgeKinds);
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of snapshot.edges) {
    const source =
      scenario.traversal.direction === "forward" ? edge.from : edge.to;
    const outgoing = adjacency.get(source) ?? [];
    outgoing.push(edge);
    adjacency.set(source, outgoing);
  }
  for (const outgoing of adjacency.values()) {
    outgoing.sort((left, right) =>
      compareStrings(edgeIdentity(left), edgeIdentity(right)),
    );
  }

  const affected = new Map<string, PendingNode>();
  const traversedEdges = new Map<string, ArchitectureImpactTraversedEdge>();
  const unknowns = new Map<string, ArchitectureImpactUnknown>();
  const visitedDepth = new Map<string, number>();
  const queue: WalkState[] = [];

  const addUnknown = (unknown: ArchitectureImpactUnknown): void => {
    const key = unknownIdentity(unknown);
    if (!unknowns.has(key)) unknowns.set(key, unknown);
  };

  const addAffected = (pending: PendingNode): void => {
    const existing = affected.get(pending.node.id);
    if (existing === undefined || pending.depth < existing.depth) {
      if (
        existing === undefined &&
        affected.size >= scenario.traversal.maxNodes
      )
        throw new ResourceLimitError(
          `impact assessment exceeds the ${scenario.traversal.maxNodes.toLocaleString("en-US")} node ceiling; reduce roots or maxDepth`,
        );
      affected.set(pending.node.id, pending);
      return;
    }
    if (pending.depth !== existing.depth) return;
    existing.root ||= pending.root;
    existing.confidence = weakestConfidence(
      existing.confidence,
      pending.confidence,
    );
    existing.evidenceIds = [
      ...new Set([...existing.evidenceIds, ...pending.evidenceIds]),
    ].sort(compareStrings);
    for (const reason of pending.reasons)
      existing.reasons = addUnique(existing.reasons, reason, reasonIdentity);
    for (const uncertainty of pending.uncertainty)
      existing.uncertainty = addUnique(
        existing.uncertainty,
        uncertainty,
        uncertaintyIdentity,
      );
  };

  if (scenario.change.kind === "unsupported") {
    addUnknown({
      code: "unsupported-change",
      traversed: false,
      reason:
        "change kind is outside the v0.1 supported set; no transitive impact was inferred",
      evidenceIds: [...scenario.change.evidenceIds].sort(compareStrings),
    });
  } else {
    for (const root of roots) {
      const rootReason: ArchitectureImpactReason = {
        code: "changed-root",
        message: `root ${root.id} was selected for ${scenario.change.kind}`,
        path: [root.id],
        evidenceIds: [...scenario.change.evidenceIds].sort(compareStrings),
      };
      const rootUncertainty = isBoundaryNode(root, scenario.traversal.boundary)
        ? [
            uncertaintyFor(
              "boundary-stop",
              `root ${root.id} matches an explicit boundary stop`,
              scenario.change.evidenceIds,
            ),
          ]
        : [];
      addAffected({
        node: root,
        depth: 0,
        root: true,
        confidence: scenario.change.confidence,
        path: [root.id],
        evidenceIds: [...scenario.change.evidenceIds].sort(compareStrings),
        reasons: [rootReason],
        uncertainty: rootUncertainty,
      });
      queue.push({
        nodeId: root.id,
        depth: 0,
        path: [root.id],
        confidence: scenario.change.confidence,
        evidenceIds: [...scenario.change.evidenceIds],
      });
      visitedDepth.set(root.id, 0);
    }
  }

  while (queue.length > 0) {
    const state = queue.shift();
    if (state === undefined) break;
    const currentNode = nodesById.get(state.nodeId);
    if (currentNode === undefined) continue;
    if (isBoundaryNode(currentNode, scenario.traversal.boundary)) {
      addUnknown({
        code: "boundary-stop",
        nodeId: currentNode.id,
        traversed: false,
        reason: `traversal stopped at explicit boundary node ${currentNode.id}`,
        evidenceIds: state.evidenceIds,
      });
      continue;
    }

    for (const edge of adjacency.get(state.nodeId) ?? []) {
      const edgeKey = edgeIdentity(edge);
      const nextNodeId =
        scenario.traversal.direction === "forward" ? edge.to : edge.from;
      const edgeEvidenceIds = edge.evidence.map((evidence) => evidence.id);
      const traversedEdge: ArchitectureImpactTraversedEdge = {
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        direction: scenario.traversal.direction,
        depth: state.depth,
        confidence: edge.confidence,
        evidenceIds: [...edgeEvidenceIds].sort(compareStrings),
        ...(edge.unresolvedReason === undefined
          ? {}
          : { unresolvedReason: edge.unresolvedReason }),
      };

      if (!allowedEdgeKinds.has(edge.kind)) {
        addUnknown({
          code: "edge-kind-excluded",
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          traversed: false,
          reason: `edge kind ${edge.kind} is excluded by the traversal rule`,
          evidenceIds: edgeEvidenceIds,
        });
        continue;
      }

      if (state.depth >= scenario.traversal.maxDepth) {
        addUnknown({
          code: "depth-limit",
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          traversed: false,
          reason: `traversal stopped at maxDepth ${scenario.traversal.maxDepth}`,
          evidenceIds: edgeEvidenceIds,
        });
        continue;
      }

      if (edge.evidence.length === 0 && !scenario.traversal.includeUnresolved) {
        addUnknown({
          code: "unresolved-edge",
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          traversed: false,
          reason:
            edge.unresolvedReason ??
            "edge has no evidence and unresolved traversal is disabled",
          evidenceIds: edgeEvidenceIds,
        });
        continue;
      }

      if (
        !traversedEdges.has(edgeKey) &&
        traversedEdges.size >= scenario.traversal.maxEdges
      ) {
        throw new ResourceLimitError(
          `impact assessment exceeds the ${scenario.traversal.maxEdges.toLocaleString("en-US")} edge ceiling; reduce roots or maxDepth`,
        );
      }
      traversedEdges.set(edgeKey, traversedEdge);
      if (edge.evidence.length === 0) {
        addUnknown({
          code: "unresolved-edge",
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          traversed: true,
          reason:
            edge.unresolvedReason ??
            "edge has no source evidence; downstream impact is uncertain",
          evidenceIds: edgeEvidenceIds,
        });
      }
      const nextNode = nodesById.get(nextNodeId);
      if (nextNode === undefined) {
        addUnknown({
          code: "missing-target",
          from: edge.from,
          to: nextNodeId,
          kind: edge.kind,
          traversed: true,
          reason: `edge target ${nextNodeId} is absent from the canonical snapshot`,
          evidenceIds: edgeEvidenceIds,
        });
        continue;
      }

      const nextPath = [...state.path, nextNodeId];
      const confidence = weakestConfidence(state.confidence, edge.confidence);
      const evidenceIds = [
        ...new Set([...state.evidenceIds, ...edgeEvidenceIds]),
      ].sort(compareStrings);
      const isCycle = state.path.includes(nextNodeId);
      const isBoundary =
        scenario.traversal.boundary.stopEdgeKinds.includes(edge.kind) ||
        isBoundaryNode(nextNode, scenario.traversal.boundary);
      const unresolved = edge.evidence.length === 0;
      const uncertainty = [
        ...(unresolved
          ? [
              uncertaintyFor(
                "unresolved-edge",
                edge.unresolvedReason ??
                  "edge has no source evidence; downstream impact is uncertain",
                edgeEvidenceIds,
              ),
            ]
          : []),
        ...(isBoundary
          ? [
              uncertaintyFor(
                "boundary-stop",
                `traversal stopped at the declared ${edge.kind} boundary`,
                edgeEvidenceIds,
              ),
            ]
          : []),
        ...(isCycle
          ? [
              uncertaintyFor(
                "cycle",
                `cycle closes at ${nextNodeId}; repeated traversal is suppressed`,
                edgeEvidenceIds,
              ),
            ]
          : []),
      ];
      const reasonCode = unresolved
        ? "unresolved-edge"
        : isBoundary
          ? "boundary-stop"
          : isCycle
            ? "cycle"
            : "traversed-edge";
      const reason: ArchitectureImpactReason = {
        code: reasonCode,
        message: unresolved
          ? `included through an unresolved ${edge.kind} edge`
          : isBoundary
            ? `included at the declared ${edge.kind} boundary stop`
            : isCycle
              ? `included through a cycle-closing ${edge.kind} edge`
              : `included through ${edge.kind} from ${state.nodeId}`,
        path: nextPath,
        edge: edgeForReason(edge),
        evidenceIds: edgeEvidenceIds,
      };
      addAffected({
        node: nextNode,
        depth: state.depth + 1,
        root: false,
        confidence,
        path: nextPath,
        evidenceIds,
        reasons: [reason],
        uncertainty,
      });

      if (isCycle) {
        addUnknown({
          code: "cycle",
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          traversed: true,
          reason: `cycle closes at ${nextNodeId}; repeated traversal is suppressed`,
          evidenceIds: edgeEvidenceIds,
        });
        continue;
      }
      if (isBoundary) {
        addUnknown({
          code: "boundary-stop",
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          traversed: true,
          reason: `traversal stopped at the declared ${edge.kind} boundary`,
          evidenceIds: edgeEvidenceIds,
        });
        continue;
      }
      const previousDepth = visitedDepth.get(nextNodeId);
      if (previousDepth !== undefined && previousDepth <= state.depth + 1)
        continue;
      visitedDepth.set(nextNodeId, state.depth + 1);
      queue.push({
        nodeId: nextNodeId,
        depth: state.depth + 1,
        path: nextPath,
        confidence,
        evidenceIds,
      });
    }
  }

  const affectedOutput = [...affected.values()]
    .map((item) => ({
      id: item.node.id,
      stableKey: item.node.stableKey,
      kind: item.node.kind,
      name: item.node.name,
      ...(item.node.language === undefined
        ? {}
        : { language: item.node.language }),
      depth: item.depth,
      root: item.root,
      confidence: item.confidence,
      evidenceIds: [...new Set(item.evidenceIds)].sort(compareStrings),
      reasons: sortReasons(item.reasons),
      uncertainty: sortUncertainties(item.uncertainty),
    }))
    .sort((left, right) => {
      if (left.depth !== right.depth) return left.depth - right.depth;
      return compareStrings(
        `${left.stableKey}\u0000${left.id}`,
        `${right.stableKey}\u0000${right.id}`,
      );
    });

  const assessment = {
    schemaVersion: ARCHITECTURE_IMPACT_SCHEMA_VERSION,
    contract: ARCHITECTURE_IMPACT_CONTRACT,
    scenarioId: scenario.scenarioId,
    changeKind: scenario.change.kind,
    supportedChangeKind: scenario.change.kind !== "unsupported",
    direction: scenario.traversal.direction,
    roots: roots.map((root) => root.id),
    maxDepth: scenario.traversal.maxDepth,
    affected: affectedOutput,
    traversedEdges: sortEdges([...traversedEdges.values()]),
    unknowns: [...unknowns.values()].sort((left, right) =>
      compareStrings(unknownIdentity(left), unknownIdentity(right)),
    ),
    deterministic: true as const,
    readOnly: true as const,
  };
  return ArchitectureImpactAssessmentSchema.parse(assessment);
};

export const serializeArchitectureImpactAssessment = (
  assessment: ArchitectureImpactAssessment,
): string => stableStringify(assessment);
