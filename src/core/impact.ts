import { Buffer } from "node:buffer";

import { z } from "zod";

import {
  canonicalizeGraphSnapshot,
  GraphContractError,
  stableStringify,
} from "./canonical.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "./schemas.js";
import { isUnresolvedEdge } from "./schemas.js";
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
    if (isUnresolvedEdge(edge)) unresolvedEdges.push(impactEdge);
    return impactEdge;
  };

  // Seed all roots before expanding any branch. FIFO expansion gives every
  // node its minimum hop depth, independent of DFS branch or root ordering.
  const queue: string[] = [];
  for (const root of roots) {
    addNode(root, 0, true);
    queue.push(root.id);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const nodeId = queue[cursor]!;
    const depth = impactNodes.get(nodeId)!.depth;
    for (const edge of adjacency.get(nodeId) ?? []) {
      const impactEdge = addEdge(edge, depth);
      if (isUnresolvedEdge(edge) && !query.includeUnresolved) continue;
      const nextNodeId = query.direction === "forward" ? edge.to : edge.from;
      if (impactNodes.has(nextNodeId)) continue;
      if (depth >= query.maxDepth) {
        const identity = edgeIdentity(edge, query.direction);
        if (!emittedDepthLimitedEdges.has(identity)) {
          emittedDepthLimitedEdges.add(identity);
          depthLimitedEdges.push(impactEdge);
        }
        continue;
      }
      const nextNode = nodesById.get(nextNodeId);
      if (nextNode === undefined) continue;
      addNode(nextNode, depth + 1, false);
      queue.push(nextNodeId);
    }
  }

  // Cycle witnesses belong to the reached subgraph, rather than a root's
  // discovery path. Use an explicit DFS stack so many selected roots can
  // expose a long cycle without recursive-stack overflow or a false cutoff.
  const cycleAdjacency = new Map<string, ImpactEdge[]>();
  for (const edge of impactEdges) {
    if (isUnresolvedEdge(edge) && !query.includeUnresolved) continue;
    if (!impactNodes.has(edge.from) || !impactNodes.has(edge.to)) continue;
    const source = query.direction === "forward" ? edge.from : edge.to;
    const outgoing = cycleAdjacency.get(source) ?? [];
    outgoing.push(edge);
    cycleAdjacency.set(source, outgoing);
  }
  const complete = new Set<string>();
  const active = new Map<string, number>();
  const pathNodes: string[] = [];
  const pathEdges: ImpactEdge[] = [];
  const edgeBytes = new Map<ImpactEdge, number>();
  // Repeated witness paths can be much larger than the unique edge set.
  // Bound their raw materialization before copying or projecting them.
  const maxCycleBytes = 16 * 1024 * 1024;
  let cycleBytes = 0;
  for (const node of impactNodes.values()) {
    if (complete.has(node.id)) continue;
    const stack: { nodeId: string; cursor: number }[] = [
      { nodeId: node.id, cursor: 0 },
    ];
    active.set(node.id, 0);
    pathNodes.push(node.id);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edge = (cycleAdjacency.get(frame.nodeId) ?? [])[frame.cursor++];
      if (edge === undefined) {
        complete.add(frame.nodeId);
        active.delete(frame.nodeId);
        stack.pop();
        pathNodes.pop();
        pathEdges.pop();
        continue;
      }
      const nextNode = query.direction === "forward" ? edge.to : edge.from;
      const start = active.get(nextNode);
      if (start !== undefined) {
        let witnessBytes = 64 + Buffer.byteLength(JSON.stringify(nextNode));
        for (let index = start; index < pathNodes.length; index += 1) {
          witnessBytes +=
            Buffer.byteLength(JSON.stringify(pathNodes[index])) + 1;
          const item = index < pathEdges.length ? pathEdges[index]! : edge;
          let bytes = edgeBytes.get(item);
          if (bytes === undefined) {
            bytes = Buffer.byteLength(stableStringify(item));
            edgeBytes.set(item, bytes);
          }
          witnessBytes += bytes + 1;
          if (cycleBytes + witnessBytes > maxCycleBytes)
            throw new ResourceLimitError(
              `impact cycle witnesses exceed the ${maxCycleBytes} byte output ceiling`,
            );
        }
        cycleBytes += witnessBytes;
        const cycle: ImpactCycle = {
          nodes: [...pathNodes.slice(start), nextNode],
          edges: [...pathEdges.slice(start), edge],
          direction: query.direction,
        };
        cycles.set(cycleIdentity(cycle), cycle);
      } else if (!complete.has(nextNode)) {
        active.set(nextNode, pathNodes.length);
        pathNodes.push(nextNode);
        pathEdges.push(edge);
        stack.push({ nodeId: nextNode, cursor: 0 });
      }
    }
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
