import { describe, expect, it } from "vitest";

import {
  computeForwardImpact,
  computeReverseImpact,
  createGraphSnapshot,
  executeArchitectureQuery,
  serializeImpactSubgraph,
} from "../../src/core/index.js";

const graph = (count: number, pairs: [number, number][]) =>
  createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha: "synthetic-depth-regression" },
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `module:${String(index).padStart(4, "0")}`,
      stableKey: `module:${String(index).padStart(4, "0")}`,
      kind: "module",
      name: `module ${index}`,
    })),
    edges: pairs.map(([from, to]) => ({
      from: `module:${String(from).padStart(4, "0")}`,
      to: `module:${String(to).padStart(4, "0")}`,
      kind: "imports",
      confidence: "certain",
      evidence: [
        {
          id: `source:${from}-${to}`,
          kind: "source",
          path: `src/module-${from}.ts`,
          line: 1,
          detector: "synthetic-depth-test@1",
          contentHash: "b".repeat(64),
        },
      ],
    })),
    diagnostics: [],
  });

describe("shortest-depth impact traversal", () => {
  it.each(["forward", "reverse"] as const)(
    "uses the shortest %s path when an earlier DFS branch is longer",
    (direction) => {
      const pairs: [number, number][] = [
        [0, 1],
        [1, 2],
        [2, 3],
        [0, 3],
        [3, 4],
      ];
      const snapshot = graph(
        5,
        direction === "forward" ? pairs : pairs.map(([a, b]) => [b, a]),
      );
      const impact = (
        direction === "forward" ? computeForwardImpact : computeReverseImpact
      )(snapshot, ["module:0000"], { maxDepth: 3 });
      expect(impact.nodes.map(({ id, depth }) => [id, depth])).toEqual([
        ["module:0000", 0],
        ["module:0001", 1],
        ["module:0003", 1],
        ["module:0002", 2],
        ["module:0004", 2],
      ]);
      expect(impact.depthLimitedEdges).toEqual([]);
      expect(
        impact.edges.find(
          ({ from, to }) =>
            from ===
              (direction === "forward" ? "module:0003" : "module:0004") &&
            to === (direction === "forward" ? "module:0004" : "module:0003"),
        )?.depth,
      ).toBe(1);
    },
  );

  it("seeds every selected root at depth zero before traversing a long chain", () => {
    const snapshot = graph(
      30,
      Array.from({ length: 29 }, (_, index) => [index, index + 1]),
    );
    const impact = computeForwardImpact(
      snapshot,
      snapshot.nodes.map(({ id }) => id),
    );
    expect(impact.nodes.every(({ depth, root }) => depth === 0 && root)).toBe(
      true,
    );
    expect(impact.edges).toHaveLength(29);
    expect(impact.edges.every(({ depth }) => depth === 0)).toBe(true);
    expect(impact.depthLimitedEdges).toEqual([]);
    expect(impact.cycles).toEqual([]);
  });

  it("reports a complete module-cycle query beyond the default depth without raising limits", () => {
    const snapshot = graph(30, [
      ...Array.from({ length: 29 }, (_, index): [number, number] => [
        index,
        index + 1,
      ]),
      [29, 0],
    ]);
    const query = {
      schemaVersion: 1,
      contract: "cartograph.architecture-query",
      queryId: "all-module-cycles",
      operation: "cycles",
      selectors: { nodes: [{ kind: "module" }] },
      traversal: { edgeKinds: ["imports"], includeUnresolved: false },
    };
    const result = executeArchitectureQuery(snapshot, query);
    expect(result).toMatchObject({
      status: "ok",
      truncated: false,
      truncatedEdges: [],
    });
    expect(result.limits.maxDepth).toBe(8);
    expect(result.diagnostics).toEqual([]);
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]?.nodes).toEqual([
      ...snapshot.nodes.map(({ id }) => id),
      "module:0000",
    ]);
    expect(result.cycles[0]?.edges).toHaveLength(30);
  });

  it("keeps a genuine single-root depth boundary visible and respects zero depth", () => {
    const snapshot = graph(4, [
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    const impact = computeForwardImpact(snapshot, ["module:0000"], {
      maxDepth: 1,
    });
    expect(impact.nodes.map(({ id }) => id)).toEqual([
      "module:0000",
      "module:0001",
    ]);
    expect(impact.depthLimitedEdges.map(({ to }) => to)).toEqual([
      "module:0002",
    ]);
    expect(
      computeForwardImpact(snapshot, ["module:0000"], { maxDepth: 0 }).nodes,
    ).toHaveLength(1);
  });

  it("preserves node and edge ceilings and deterministic ordering", () => {
    const snapshot = graph(4, [
      [0, 1],
      [1, 2],
      [2, 0],
      [2, 3],
    ]);
    expect(() =>
      computeForwardImpact(
        snapshot,
        snapshot.nodes.map(({ id }) => id),
        { maxNodes: 2 },
      ),
    ).toThrow(/node ceiling/u);
    expect(() =>
      computeForwardImpact(snapshot, ["module:0000"], { maxEdges: 2 }),
    ).toThrow(/edge ceiling/u);
    const reordered = createGraphSnapshot({
      ...snapshot,
      nodes: [...snapshot.nodes].reverse(),
      edges: [...snapshot.edges].reverse(),
    });
    expect(
      serializeImpactSubgraph(
        computeForwardImpact(snapshot, ["module:0000", "module:0003"]),
      ),
    ).toBe(
      serializeImpactSubgraph(
        computeForwardImpact(reordered, ["module:0003", "module:0000"]),
      ),
    );
  });

  it("finds a long selected-root cycle without recursive traversal", () => {
    const snapshot = graph(
      2000,
      Array.from({ length: 2000 }, (_, index) => [index, (index + 1) % 2000]),
    );
    const impact = computeForwardImpact(
      snapshot,
      snapshot.nodes.map(({ id }) => id),
    );
    expect(impact.depthLimitedEdges).toEqual([]);
    expect(impact.cycles).toHaveLength(1);
    expect(impact.cycles[0]?.nodes).toHaveLength(2001);
    expect(impact.cycles[0]?.edges).toHaveLength(2000);
  });

  it("bounds repeated cycle-witness materialization and identifies its byte limit", () => {
    const pairs: [number, number][] = [];
    for (let from = 0; from < 100; from += 1)
      for (let to = 0; to < 100; to += 1)
        if (from !== to) pairs.push([from, to]);
    const snapshot = graph(100, pairs);
    expect(() =>
      computeForwardImpact(
        snapshot,
        snapshot.nodes.map(({ id }) => id),
      ),
    ).toThrow(/cycle witnesses exceed the 16777216 byte output ceiling/u);
    expect(
      executeArchitectureQuery(snapshot, {
        schemaVersion: 1,
        contract: "cartograph.architecture-query",
        queryId: "bounded-cycle-witnesses",
        operation: "cycles",
        selectors: { nodes: [{ kind: "module" }] },
        traversal: { edgeKinds: ["imports"] },
      }),
    ).toMatchObject({
      status: "resource-limit",
      cycles: [],
      diagnostics: [expect.objectContaining({ limit: "maxResultBytes" })],
    });
  });

  it("describes separate direction cutoffs without claiming an endpoint is absent from their union", () => {
    const snapshot = graph(3, [
      [0, 1],
      [1, 2],
      [2, 0],
    ]);
    const result = executeArchitectureQuery(snapshot, {
      schemaVersion: 1,
      contract: "cartograph.architecture-query",
      queryId: "both-direction-cutoff",
      operation: "reachability",
      selectors: { nodes: [{ id: "module:0000" }] },
      traversal: { direction: "both", edgeKinds: ["imports"] },
      limits: { maxDepth: 1 },
    });
    expect(result.nodeDepths).toEqual([
      { nodeId: "module:0000", depth: 0, root: true },
      { nodeId: "module:0001", depth: 1, root: false },
      { nodeId: "module:0002", depth: 1, root: false },
    ]);
    expect(result.truncated).toBe(true);
    expect(result.truncatedEdges.map(({ from, to }) => [from, to])).toEqual([
      ["module:0001", "module:0002"],
    ]);
    expect(result.diagnostics[0]?.message).toContain(
      "was not fully traversed in a requested direction",
    );
    expect(result.diagnostics[0]?.message).not.toContain(
      "outside the returned node set",
    );
  });

  it("matches an independent all-pairs distance oracle on seeded small graphs", () => {
    let seed = 425;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let sample = 0; sample < 20; sample += 1) {
      const size = 12;
      const pairs: [number, number][] = [];
      const distance = Array.from({ length: size }, (_, from) =>
        Array.from({ length: size }, (_, to) => (from === to ? 0 : Infinity)),
      );
      for (let from = 0; from < size; from += 1)
        for (let to = 0; to < size; to += 1)
          if (random() < 0.12) {
            pairs.push([from, to]);
            distance[from]![to] = Math.min(distance[from]![to]!, 1);
          }
      for (let via = 0; via < size; via += 1)
        for (let from = 0; from < size; from += 1)
          for (let to = 0; to < size; to += 1)
            distance[from]![to] = Math.min(
              distance[from]![to]!,
              distance[from]![via]! + distance[via]![to]!,
            );
      const roots = [0, 7];
      const expected = new Map<string, number>();
      for (let index = 0; index < size; index += 1) {
        const depth = Math.min(...roots.map((root) => distance[root]![index]!));
        if (depth <= 3)
          expected.set(`module:${String(index).padStart(4, "0")}`, depth);
      }
      const impact = computeForwardImpact(
        graph(size, pairs),
        roots.map((root) => `module:${String(root).padStart(4, "0")}`),
        { maxDepth: 3 },
      );
      expect(new Map(impact.nodes.map(({ id, depth }) => [id, depth]))).toEqual(
        expected,
      );
      expect(
        impact.depthLimitedEdges.every(({ to }) => !expected.has(to)),
      ).toBe(true);
    }
  });
});
