import { z } from "zod";

import {
  canonicalizeGraphSnapshot,
  GraphContractError,
  stableStringify,
} from "./canonical.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "./schemas.js";
import { ResourceLimitError } from "../resources.js";

export const ImpactDirectionSchema = z.enum(["forward", "reverse"]);

export const ImpactQuerySchema = z
  .object({
    roots: z.array(z.string().trim().min(1)).min(1),
    direction: ImpactDirectionSchema.default("forward"),
    maxDepth: z.number().int().nonnegative().max(1024).default(8),
    maxNodes: z.number().int().positive().max(1_000_000).default(10_000),
    maxEdges: z.number().int().positive().max(1_000_000).default(20_000),
    includeUnresolved: z.boolean().default(true),
  })
  .strict();

export type ImpactDirection = z.infer<typeof ImpactDirectionSchema>;
export type ImpactQuery = z.infer<typeof ImpactQuerySchema>;
export type ImpactTraversalOptions = Partial<
  Pick<ImpactQuery, "maxDepth" | "maxNodes" | "maxEdges" | "includeUnresolved">
>;

export type ImpactNode = GraphNode & {
  depth: number;
  root: boolean;
};

export type ImpactEdge = GraphEdge & {
  depth: number;
  direction: ImpactDirection;
};

export type ImpactCycle = {
  nodes: string[];
  edges: ImpactEdge[];
  direction: ImpactDirection;
};

export type ImpactSubgraph = {
  roots: string[];
  direction: ImpactDirection;
  maxDepth: number;
  nodes: ImpactNode[];
  edges: ImpactEdge[];
  unresolvedEdges: ImpactEdge[];
  cycles: ImpactCycle[];
  depthLimitedEdges: ImpactEdge[];
};

type ImpactQueryInput = ImpactTraversalOptions & {
  roots: readonly string[];
  direction?: ImpactDirection;
};

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const nodeIdentity = (node: Pick<GraphNode, "stableKey" | "id">): string =>
  `${node.stableKey}\u0000${node.id}`;

const edgeIdentity = (
  edge: Pick<GraphEdge, "from" | "to" | "kind">,
  direction: ImpactDirection,
): string => stableStringify([direction, edge.from, edge.to, edge.kind]);

const impactEdgeSort = (left: ImpactEdge, right: ImpactEdge): number => {
  if (left.depth !== right.depth) return left.depth - right.depth;
  const identityOrder = compareStrings(
    edgeIdentity(left, left.direction),
    edgeIdentity(right, right.direction),
  );
  return identityOrder !== 0
    ? identityOrder
    : compareStrings(left.direction, right.direction);
};

const impactNodeSort = (left: ImpactNode, right: ImpactNode): number => {
  if (left.depth !== right.depth) return left.depth - right.depth;
  return compareStrings(nodeIdentity(left), nodeIdentity(right));
};

const cycleIdentity = (cycle: ImpactCycle): string =>
  stableStringify([
    cycle.direction,
    cycle.nodes,
    cycle.edges.map((edge) => edgeIdentity(edge, edge.direction)),
  ]);

const sortImpactEdges = (edges: readonly ImpactEdge[]): ImpactEdge[] => {
  const byIdentity = new Map<string, ImpactEdge>();
  for (const edge of edges) {
    const key = edgeIdentity(edge, edge.direction);
    const existing = byIdentity.get(key);
    if (existing === undefined || edge.depth < existing.depth)
      byIdentity.set(key, edge);
  }
  return [...byIdentity.values()].sort(impactEdgeSort);
};

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

/**
 * Compute a bounded, deterministic reachability view from one or more graph
 * nodes. Forward traversal follows edge sources to targets; reverse traversal
 * follows the same relationships backwards without rewriting the edge itself.
 * Unresolved edges remain visible in `unresolvedEdges` and are traversed only
 * when `includeUnresolved` is enabled. Added boundary edges are retained in
 * `depthLimitedEdges`, and cycles are emitted as closed node paths rather than
 * being silently discarded by the visited set.
 */
export const computeImpactSubgraph = (
  snapshotInput: unknown,
  queryInput: ImpactQueryInput,
): ImpactSubgraph => {
  const query = ImpactQuerySchema.parse(queryInput);
  const snapshot = canonicalizeGraphSnapshot(snapshotInput);
  const roots = resolveRoots(snapshot, query.roots);
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, GraphEdge[]>();

  for (const edge of snapshot.edges) {
    const source = query.direction === "forward" ? edge.from : edge.to;
    const outgoing = adjacency.get(source) ?? [];
    outgoing.push(edge);
    adjacency.set(source, outgoing);
  }
  for (const outgoing of adjacency.values()) {
    outgoing.sort((left, right) =>
      compareStrings(
        edgeIdentity(left, query.direction),
        edgeIdentity(right, query.direction),
      ),
    );
  }

  const impactNodes = new Map<string, ImpactNode>();
  const visited = new Set<string>();
  const impactEdges: ImpactEdge[] = [];
  const unresolvedEdges: ImpactEdge[] = [];
  const depthLimitedEdges: ImpactEdge[] = [];
  const cycles = new Map<string, ImpactCycle>();
  const impactEdgesByIdentity = new Map<string, ImpactEdge>();
  const emittedDepthLimitedEdges = new Set<string>();

  const addNode = (node: GraphNode, depth: number, root: boolean): void => {
    const existing = impactNodes.get(node.id);
    if (existing !== undefined) {
      if (depth < existing.depth) existing.depth = depth;
      if (root) existing.root = true;
      return;
    }
    if (impactNodes.size >= query.maxNodes) {
      throw new ResourceLimitError(
        `impact traversal exceeds the ${query.maxNodes.toLocaleString("en-US")} node ceiling; reduce roots or maxDepth`,
      );
    }
    impactNodes.set(node.id, { ...node, depth, root });
  };

  const addEdge = (edge: GraphEdge, depth: number): ImpactEdge => {
    const impactEdge: ImpactEdge = {
      ...edge,
      depth,
      direction: query.direction,
    };
    const identity = edgeIdentity(edge, query.direction);
    const existing = impactEdgesByIdentity.get(identity);
    if (existing !== undefined) return existing;
    if (impactEdgesByIdentity.size >= query.maxEdges) {
      throw new ResourceLimitError(
        `impact traversal exceeds the ${query.maxEdges.toLocaleString("en-US")} edge ceiling; reduce roots or maxDepth`,
      );
    }
    impactEdgesByIdentity.set(identity, impactEdge);
    impactEdges.push(impactEdge);
    if (edge.evidence.length === 0) unresolvedEdges.push(impactEdge);
    return impactEdge;
  };

  const addCycle = (
    pathNodes: readonly string[],
    pathEdgesWithCurrent: readonly ImpactEdge[],
    nextNode: string,
  ): void => {
    const start = pathNodes.indexOf(nextNode);
    if (start < 0) return;
    const nodes = [...pathNodes.slice(start), nextNode];
    const edges = [...pathEdgesWithCurrent.slice(start)];
    const cycle: ImpactCycle = {
      nodes,
      edges,
      direction: query.direction,
    };
    cycles.set(cycleIdentity(cycle), cycle);
  };

  const walk = (
    nodeId: string,
    depth: number,
    pathNodes: readonly string[],
    pathEdges: readonly ImpactEdge[],
  ): void => {
    for (const edge of adjacency.get(nodeId) ?? []) {
      const nextNodeId = query.direction === "forward" ? edge.to : edge.from;
      const impactEdge = addEdge(edge, depth);

      if (pathNodes.includes(nextNodeId)) {
        addCycle(pathNodes, pathEdges.concat(impactEdge), nextNodeId);
        continue;
      }

      if (depth >= query.maxDepth) {
        const identity = edgeIdentity(edge, query.direction);
        if (!emittedDepthLimitedEdges.has(identity)) {
          emittedDepthLimitedEdges.add(identity);
          depthLimitedEdges.push(impactEdge);
        }
        continue;
      }

      if (edge.evidence.length === 0 && !query.includeUnresolved) continue;
      const nextNode = nodesById.get(nextNodeId);
      if (nextNode === undefined) continue;
      addNode(nextNode, depth + 1, false);
      if (visited.has(nextNodeId)) continue;
      visited.add(nextNodeId);
      walk(
        nextNodeId,
        depth + 1,
        [...pathNodes, nextNodeId],
        [...pathEdges, impactEdge],
      );
    }
  };

  for (const root of roots) {
    addNode(root, 0, true);
    if (visited.has(root.id)) continue;
    visited.add(root.id);
    walk(root.id, 0, [root.id], []);
  }

  const sortedEdges = sortImpactEdges(impactEdges);
  const sortedUnresolvedEdges = sortImpactEdges(unresolvedEdges);
  const sortedDepthLimitedEdges = sortImpactEdges(depthLimitedEdges);
  const sortedCycles = [...cycles.values()].sort((left, right) =>
    compareStrings(cycleIdentity(left), cycleIdentity(right)),
  );

  return {
    roots: roots.map((root) => root.id),
    direction: query.direction,
    maxDepth: query.maxDepth,
    nodes: [...impactNodes.values()].sort(impactNodeSort),
    edges: sortedEdges,
    unresolvedEdges: sortedUnresolvedEdges,
    cycles: sortedCycles,
    depthLimitedEdges: sortedDepthLimitedEdges,
  };
};

export const computeForwardImpact = (
  snapshotInput: unknown,
  roots: readonly string[],
  options: ImpactTraversalOptions = {},
): ImpactSubgraph =>
  computeImpactSubgraph(snapshotInput, {
    ...options,
    roots,
    direction: "forward",
  });

export const computeReverseImpact = (
  snapshotInput: unknown,
  roots: readonly string[],
  options: ImpactTraversalOptions = {},
): ImpactSubgraph =>
  computeImpactSubgraph(snapshotInput, {
    ...options,
    roots,
    direction: "reverse",
  });

export const serializeImpactSubgraph = (impact: ImpactSubgraph): string =>
  stableStringify(impact);
