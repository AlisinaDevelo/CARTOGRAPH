import { z } from "zod";

import {
  GraphTopologySummarySchema,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
  type GraphTopologyEdge,
  type GraphTopologySummary,
} from "./schemas.js";
import { canonicalizeGraphSnapshot, stableStringify } from "./canonical.js";
import {
  LocalPolicyNodeSelectorSchema,
  type LocalPolicyNodeSelector,
} from "./policy.js";

const LayerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u,
    "must be a portable lower-case layer identifier",
  );

export const GraphLayerDefinitionSchema = z
  .object({
    id: LayerIdSchema,
    order: z.number().int().nonnegative().max(1_000),
    selector: LocalPolicyNodeSelectorSchema,
  })
  .strict();

export const GraphTopologyOptionsSchema = z
  .object({
    layers: z.array(GraphLayerDefinitionSchema).max(256).optional(),
  })
  .strict();

export type GraphLayerDefinition = z.infer<typeof GraphLayerDefinitionSchema>;
export type GraphTopologyOptions = z.infer<typeof GraphTopologyOptionsSchema>;

export class GraphTopologyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphTopologyValidationError";
  }
}

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const edgeKey = (edge: Pick<GraphEdge, "from" | "to" | "kind">): string =>
  stableStringify([edge.from, edge.to, edge.kind]);

const topologyEdge = (
  edge: Pick<GraphEdge, "from" | "to" | "kind" | "evidence">,
): GraphTopologyEdge => ({
  from: edge.from,
  to: edge.to,
  kind: edge.kind,
  evidence: [...edge.evidence].sort((left, right) =>
    compareStrings(left.id, right.id),
  ),
});

const topologyEdgeCompare = (
  left: Pick<GraphTopologyEdge, "from" | "to" | "kind">,
  right: Pick<GraphTopologyEdge, "from" | "to" | "kind">,
): number => compareStrings(edgeKey(left), edgeKey(right));

const matchesNodeSelector = (
  node: GraphNode,
  selector: LocalPolicyNodeSelector,
): boolean =>
  (selector.kind === undefined || selector.kind === node.kind) &&
  (selector.id === undefined ||
    selector.id === node.id ||
    selector.id === node.stableKey) &&
  (selector.name === undefined || selector.name === node.name);

const incidentEvidence = (
  snapshot: GraphSnapshot,
  nodeId: string,
): Evidence[] => {
  const evidence = new Map<string, Evidence>();
  for (const edge of snapshot.edges) {
    if (edge.from !== nodeId && edge.to !== nodeId) continue;
    for (const item of edge.evidence) evidence.set(item.id, item);
  }
  return [...evidence.values()].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
};

const stronglyConnectedComponents = (snapshot: GraphSnapshot): string[][] => {
  const nodeIds = snapshot.nodes.map((node) => node.id).sort(compareStrings);
  const adjacency = new Map<string, string[]>(
    nodeIds.map((nodeId) => [nodeId, []]),
  );
  const reverse = new Map<string, string[]>(
    nodeIds.map((nodeId) => [nodeId, []]),
  );
  for (const edge of snapshot.edges) {
    adjacency.get(edge.from)?.push(edge.to);
    reverse.get(edge.to)?.push(edge.from);
  }
  for (const neighbors of adjacency.values()) neighbors.sort(compareStrings);
  for (const neighbors of reverse.values()) neighbors.sort(compareStrings);

  const finishOrder: string[] = [];
  const visited = new Set<string>();
  for (const start of nodeIds) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: Array<{ nodeId: string; nextIndex: number }> = [
      { nodeId: start, nextIndex: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      const neighbors = adjacency.get(frame.nodeId) ?? [];
      const next = neighbors[frame.nextIndex];
      if (next === undefined) {
        finishOrder.push(frame.nodeId);
        stack.pop();
        continue;
      }
      frame.nextIndex += 1;
      if (visited.has(next)) continue;
      visited.add(next);
      stack.push({ nodeId: next, nextIndex: 0 });
    }
  }

  const components: string[][] = [];
  const assigned = new Set<string>();
  for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
    const start = finishOrder[index];
    if (start === undefined || assigned.has(start)) continue;
    assigned.add(start);
    const component: string[] = [];
    const stack = [start];
    while (stack.length > 0) {
      const nodeId = stack.pop();
      if (nodeId === undefined) break;
      component.push(nodeId);
      for (const next of reverse.get(nodeId) ?? []) {
        if (assigned.has(next)) continue;
        assigned.add(next);
        stack.push(next);
      }
    }
    components.push(component.sort(compareStrings));
  }
  return components.sort((left, right) =>
    compareStrings(left.join("\u0000"), right.join("\u0000")),
  );
};

const topologyDiagnostic = (input: {
  readonly id: string;
  readonly code:
    | "UNRESOLVED_LAYER_ASSIGNMENT"
    | "AMBIGUOUS_LAYER_ASSIGNMENT"
    | "LAYER_BOUNDARY_VIOLATION";
  readonly message: string;
  readonly remediation: string;
  readonly nodeId?: string;
  readonly edge?: Pick<GraphEdge, "from" | "to" | "kind">;
  readonly evidence?: readonly Evidence[];
}) => ({
  id: input.id,
  code: input.code,
  severity: "warning" as const,
  message: input.message,
  remediation: input.remediation,
  ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
  ...(input.edge === undefined
    ? {}
    : {
        edge: {
          from: input.edge.from,
          to: input.edge.to,
          kind: input.edge.kind,
        },
      }),
  evidence: [...(input.evidence ?? [])].sort((left, right) =>
    compareStrings(left.id, right.id),
  ),
});

const summarizeCycles = (snapshot: GraphSnapshot) => {
  const cycles = [];
  for (const nodes of stronglyConnectedComponents(snapshot)) {
    const nodeSet = new Set(nodes);
    const edges = snapshot.edges
      .filter((edge) => nodeSet.has(edge.from) && nodeSet.has(edge.to))
      .sort(topologyEdgeCompare)
      .map(topologyEdge);
    if (nodes.length < 2 && !edges.some((edge) => edge.from === edge.to)) {
      continue;
    }
    cycles.push({
      id: `topology:cycle:${nodes.join("|")}`,
      nodes,
      edges,
    });
  }
  return cycles.sort((left, right) => compareStrings(left.id, right.id));
};

const summarizeLayers = (
  snapshot: GraphSnapshot,
  options: GraphTopologyOptions,
) => {
  const layers = options.layers ?? [];
  const layerIds = new Set<string>();
  for (const layer of layers) {
    if (layerIds.has(layer.id)) {
      throw new GraphTopologyValidationError(
        `duplicate topology layer id: ${layer.id}`,
      );
    }
    layerIds.add(layer.id);
  }

  const diagnostics = [];
  const assignments = new Map<string, GraphLayerDefinition>();
  const ambiguous = new Set<string>();
  const layerNodes = new Map<string, string[]>(
    layers.map((layer) => [layer.id, []]),
  );
  for (const node of snapshot.nodes) {
    const matches = layers.filter((layer) =>
      matchesNodeSelector(node, layer.selector),
    );
    if (matches.length > 1) {
      ambiguous.add(node.id);
      diagnostics.push(
        topologyDiagnostic({
          id: `diagnostic:topology:ambiguous-layer:${node.id}`,
          code: "AMBIGUOUS_LAYER_ASSIGNMENT",
          message: `Node ${node.id} matches multiple configured layers and was not assigned.`,
          remediation:
            "Narrow the layer selectors so every node has at most one explicit layer.",
          nodeId: node.id,
          evidence: incidentEvidence(snapshot, node.id),
        }),
      );
      continue;
    }
    const layer = matches[0];
    if (layer === undefined) continue;
    assignments.set(node.id, layer);
    layerNodes.get(layer.id)?.push(node.id);
  }

  if (layers.length === 0) {
    diagnostics.push(
      topologyDiagnostic({
        id: "diagnostic:topology:layer-policy-missing",
        code: "UNRESOLVED_LAYER_ASSIGNMENT",
        message:
          "No layer policy metadata was supplied; layer assignments were not inferred.",
        remediation:
          "Provide explicit ordered layer selectors when reviewing layer boundaries.",
      }),
    );
  }

  const violations = [];
  for (const edge of [...snapshot.edges].sort(topologyEdgeCompare)) {
    const fromLayer = assignments.get(edge.from);
    const toLayer = assignments.get(edge.to);
    if (fromLayer === undefined || toLayer === undefined) {
      if (layers.length > 0) {
        diagnostics.push(
          topologyDiagnostic({
            id: `diagnostic:topology:unresolved-layer:${edgeKey(edge)}`,
            code: "UNRESOLVED_LAYER_ASSIGNMENT",
            message: `Layer assignment is unresolved for edge ${edge.from} ${edge.kind} ${edge.to}.`,
            remediation:
              ambiguous.has(edge.from) || ambiguous.has(edge.to)
                ? "Resolve overlapping layer selectors before evaluating this boundary."
                : "Add explicit selectors covering both edge endpoints before evaluating this boundary.",
            edge,
            evidence: edge.evidence,
          }),
        );
      }
      continue;
    }
    // Layer order follows dependency direction: a higher-order layer may
    // depend on an equal or lower-order layer, never the reverse.
    if (fromLayer.order >= toLayer.order) continue;
    const id = `topology:layer-violation:${edgeKey(edge)}`;
    violations.push({
      id,
      fromLayer: fromLayer.id,
      toLayer: toLayer.id,
      edge: topologyEdge(edge),
    });
    diagnostics.push(
      topologyDiagnostic({
        id: `diagnostic:topology:layer-violation:${edgeKey(edge)}`,
        code: "LAYER_BOUNDARY_VIOLATION",
        message: `Layer ${fromLayer.id} (${fromLayer.order}) depends on higher layer ${toLayer.id} (${toLayer.order}).`,
        remediation:
          "Move the dependency to an allowed direction or record an explicit reviewed policy exception.",
        edge,
        evidence: edge.evidence,
      }),
    );
  }

  return {
    layers: layers
      .map((layer) => ({
        id: layer.id,
        order: layer.order,
        nodeIds: [...(layerNodes.get(layer.id) ?? [])].sort(compareStrings),
      }))
      .sort((left, right) =>
        left.order !== right.order
          ? left.order - right.order
          : compareStrings(left.id, right.id),
      ),
    violations,
    diagnostics,
  };
};

export const canonicalizeGraphTopology = (
  input: unknown,
): GraphTopologySummary => {
  const parsed = GraphTopologySummarySchema.parse(input);
  return GraphTopologySummarySchema.parse({
    cycles: [...parsed.cycles]
      .map((cycle) => ({
        ...cycle,
        nodes: [...cycle.nodes].sort(compareStrings),
        edges: [...cycle.edges]
          .map((edge) => topologyEdge({ ...edge, evidence: edge.evidence }))
          .sort(topologyEdgeCompare),
      }))
      .sort((left, right) => compareStrings(left.id, right.id)),
    layers: [...parsed.layers]
      .map((layer) => ({
        ...layer,
        nodeIds: [...layer.nodeIds].sort(compareStrings),
      }))
      .sort((left, right) =>
        left.order !== right.order
          ? left.order - right.order
          : compareStrings(left.id, right.id),
      ),
    violations: [...parsed.violations]
      .map((violation) => ({
        ...violation,
        edge: topologyEdge({
          ...violation.edge,
          evidence: violation.edge.evidence,
        }),
      }))
      .sort((left, right) => compareStrings(left.id, right.id)),
    diagnostics: [...parsed.diagnostics].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
  });
};

export const summarizeGraphTopology = (
  snapshotInput: unknown,
  options: GraphTopologyOptions = {},
): GraphTopologySummary => {
  const snapshot = canonicalizeGraphSnapshot(snapshotInput);
  const parsedOptions = GraphTopologyOptionsSchema.parse(options);
  const layerSummary = summarizeLayers(snapshot, parsedOptions);
  return canonicalizeGraphTopology({
    cycles: summarizeCycles(snapshot),
    layers: layerSummary.layers,
    violations: layerSummary.violations,
    diagnostics: layerSummary.diagnostics,
  });
};

export const serializeGraphTopology = (input: unknown): string =>
  stableStringify(canonicalizeGraphTopology(input));
