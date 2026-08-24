import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  computeForwardImpact,
  computeReverseImpact,
  createGraphSnapshot,
  serializeImpactSubgraph,
} from "../../src/core/index.js";

const evidence = (id: string, path = "src/graph.ts", line = 1) => ({
  id,
  kind: "source" as const,
  path,
  line,
  detector: "cartograph.impact@1",
  contentHash: "a".repeat(64),
});

const node = (id: string, name = id) => ({
  id,
  stableKey: `function:${id}`,
  kind: "function" as const,
  name,
  language: "typescript",
});

const impactFixture = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "impact-fixture" },
  nodes: [
    node("node-a", "root"),
    node("node-b"),
    node("node-c"),
    node("node-d"),
    node("node-e"),
  ],
  edges: [
    {
      from: "node-a",
      to: "node-b",
      kind: "calls",
      confidence: "certain",
      evidence: [evidence("edge-ab", "src/a.ts", 1)],
    },
    {
      from: "node-b",
      to: "node-c",
      kind: "imports",
      confidence: "inferred",
      evidence: [evidence("edge-bc", "src/b.ts", 2)],
    },
    {
      from: "node-c",
      to: "node-a",
      kind: "calls",
      confidence: "observed",
      evidence: [evidence("edge-ca", "src/c.ts", 3)],
    },
    {
      from: "node-c",
      to: "node-d",
      kind: "requests",
      confidence: "observed",
      evidence: [evidence("edge-cd", "src/c.ts", 4)],
    },
    {
      from: "node-d",
      to: "node-e",
      kind: "writes",
      confidence: "inferred",
      evidence: [evidence("edge-de", "src/d.ts", 5)],
    },
    {
      from: "node-b",
      to: "node-e",
      kind: "depends_on",
      confidence: "inferred",
      evidence: [],
      unresolvedReason: "dependency is selected by runtime configuration",
    },
  ],
  diagnostics: [],
});

describe("impact subgraphs", () => {
  it("computes deterministic forward reachability with cycles and evidence", () => {
    const impact = computeForwardImpact(impactFixture, ["node-a"], {
      maxDepth: 2,
    });

    expect(impact.roots).toEqual(["node-a"]);
    expect(impact.nodes.map((item) => [item.id, item.depth])).toEqual([
      ["node-a", 0],
      ["node-b", 1],
      ["node-c", 2],
      ["node-e", 2],
    ]);
    expect(impact.edges).toHaveLength(5);
    expect(
      impact.edges.find((edge) => edge.from === "node-a")?.confidence,
    ).toBe("certain");
    expect(
      impact.edges.find((edge) => edge.from === "node-a")?.evidence[0]?.id,
    ).toBe("edge-ab");
    expect(impact.unresolvedEdges.map((edge) => edge.to)).toEqual(["node-e"]);
    expect(impact.cycles).toHaveLength(1);
    expect(impact.cycles[0]?.nodes).toEqual([
      "node-a",
      "node-b",
      "node-c",
      "node-a",
    ]);
    expect(impact.depthLimitedEdges.map((edge) => edge.to)).toEqual(["node-d"]);
  });

  it("computes reverse reachability and can exclude unresolved traversal", () => {
    const impact = computeReverseImpact(impactFixture, ["node-e"], {
      maxDepth: 3,
      includeUnresolved: false,
    });

    expect(impact.nodes.map((item) => item.id)).toEqual([
      "node-e",
      "node-d",
      "node-c",
      "node-b",
    ]);
    expect(impact.direction).toBe("reverse");
    expect(impact.unresolvedEdges).toHaveLength(1);
    expect(impact.unresolvedEdges[0]?.from).toBe("node-b");
    expect(impact.edges.every((edge) => edge.confidence.length > 0)).toBe(true);
  });

  it("accepts stable keys and remains byte-stable under input reordering", () => {
    const first = computeForwardImpact(impactFixture, ["function:node-a"], {
      maxDepth: 3,
    });
    const reordered = createGraphSnapshot({
      ...impactFixture,
      nodes: [...impactFixture.nodes].reverse(),
      edges: [...impactFixture.edges].reverse(),
    });
    const second = computeForwardImpact(reordered, ["node-a"], {
      maxDepth: 3,
    });

    expect(serializeImpactSubgraph(first)).toBe(
      serializeImpactSubgraph(second),
    );
  });

  it("fails closed at the node resource ceiling", () => {
    expect(() =>
      computeForwardImpact(impactFixture, ["node-a"], {
        maxNodes: 2,
        maxDepth: 3,
      }),
    ).toThrow(/impact traversal exceeds the 2 node ceiling/u);
  });

  it("benchmarks known reachability without network or source execution", () => {
    const startedAt = performance.now();
    let last = "";
    for (let index = 0; index < 100; index += 1) {
      last = serializeImpactSubgraph(
        computeForwardImpact(impactFixture, ["node-a"], { maxDepth: 4 }),
      );
    }
    const elapsed = performance.now() - startedAt;

    const parsed: unknown = JSON.parse(last);
    expect(
      parsed !== null &&
        typeof parsed === "object" &&
        "nodes" in parsed &&
        Array.isArray(parsed.nodes),
    ).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  });
});
