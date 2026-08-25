import { describe, expect, it } from "vitest";

import {
  createGraphSnapshot,
  diffGraphSnapshots,
  serializeGraphDiff,
  serializeGraphTopology,
  summarizeGraphTopology,
} from "../../src/core/index.js";

const hash = `sha256:${"b".repeat(64)}`;

const evidence = (id: string, line: number) => ({
  id,
  kind: "source" as const,
  path: "src/topology.ts",
  line,
  detector: "topology-test@0.1.0",
  contentHash: hash,
});

const snapshot = (commitSha: string, includeCycle = true) =>
  createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha },
    nodes: [
      { id: "node:ui", kind: "module", name: "ui" },
      { id: "node:domain", kind: "module", name: "domain" },
      { id: "node:data", kind: "module", name: "data" },
    ],
    edges: [
      {
        from: "node:ui",
        to: "node:domain",
        kind: "imports",
        confidence: "certain",
        evidence: [evidence("edge:ui-domain", 1)],
      },
      {
        from: "node:domain",
        to: "node:data",
        kind: "imports",
        confidence: "certain",
        evidence: [evidence("edge:domain-data", 2)],
      },
      ...(includeCycle
        ? [
            {
              from: "node:domain" as const,
              to: "node:ui" as const,
              kind: "imports" as const,
              confidence: "inferred" as const,
              evidence: [evidence("edge:domain-ui", 3)],
            },
          ]
        : []),
    ],
    diagnostics: [],
  });

const layers = [
  { id: "ui", order: 2, selector: { id: "node:ui" } },
  { id: "domain", order: 1, selector: { id: "node:domain" } },
  { id: "data", order: 0, selector: { id: "node:data" } },
];

describe("graph topology summaries", () => {
  it("summarizes deterministic cycles, explicit layers, violations, and evidence", () => {
    const result = summarizeGraphTopology(snapshot("1".repeat(40)), { layers });

    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]).toMatchObject({
      nodes: ["node:domain", "node:ui"],
      edges: [
        { from: "node:domain", to: "node:ui" },
        { from: "node:ui", to: "node:domain" },
      ],
    });
    expect(result.cycles[0]?.edges[0]?.evidence[0]?.id).toBe("edge:domain-ui");
    expect(result.layers).toEqual([
      { id: "data", order: 0, nodeIds: ["node:data"] },
      { id: "domain", order: 1, nodeIds: ["node:domain"] },
      { id: "ui", order: 2, nodeIds: ["node:ui"] },
    ]);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      fromLayer: "domain",
      toLayer: "ui",
      edge: { from: "node:domain", to: "node:ui" },
    });
    expect(result.violations[0]?.edge.evidence[0]?.id).toBe("edge:domain-ui");
    expect(result.diagnostics).toMatchObject([
      { code: "LAYER_BOUNDARY_VIOLATION" },
    ]);
  });

  it("fails closed with an unresolved diagnostic when layer metadata is absent", () => {
    const result = summarizeGraphTopology(snapshot("2".repeat(40)));

    expect(result.cycles).toHaveLength(1);
    expect(result.layers).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(result.diagnostics).toMatchObject([
      {
        code: "UNRESOLVED_LAYER_ASSIGNMENT",
        id: "diagnostic:topology:layer-policy-missing",
      },
    ]);
  });

  it("reports overlapping selectors and uncovered edge endpoints without guessing", () => {
    const result = summarizeGraphTopology(snapshot("3".repeat(40), false), {
      layers: [
        { id: "one", order: 1, selector: { id: "node:ui" } },
        { id: "two", order: 2, selector: { id: "node:ui" } },
      ],
    });

    expect(result.layers).toEqual([
      { id: "one", order: 1, nodeIds: [] },
      { id: "two", order: 2, nodeIds: [] },
    ]);
    expect(result.violations).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "AMBIGUOUS_LAYER_ASSIGNMENT",
      "UNRESOLVED_LAYER_ASSIGNMENT",
      "UNRESOLVED_LAYER_ASSIGNMENT",
    ]);
    expect(result.diagnostics[1]?.edge).toMatchObject({
      from: "node:domain",
      to: "node:data",
    });
  });

  it("keeps topology canonical and embeds it in a graph diff when requested", () => {
    const before = snapshot("4".repeat(40), false);
    const after = snapshot("5".repeat(40));
    const diff = diffGraphSnapshots(before, after, { topology: { layers } });
    const serialized = serializeGraphDiff(diff);
    const parsed = JSON.parse(serialized) as {
      topology: { after: { violations: unknown[] } };
    };

    expect(diff.topology?.before.cycles).toEqual([]);
    expect(diff.topology?.after.cycles).toHaveLength(1);
    expect(parsed.topology.after.violations).toHaveLength(1);
    expect(serializeGraphTopology(diff.topology?.after)).toBe(
      serializeGraphTopology(diff.topology?.after),
    );
    expect(
      serializeGraphTopology(
        summarizeGraphTopology(before, { layers: [...layers].reverse() }),
      ),
    ).toBe(serializeGraphTopology(diff.topology?.before));
  });

  it("rejects duplicate layer identifiers", () => {
    expect(() =>
      summarizeGraphTopology(snapshot("6".repeat(40)), {
        layers: [
          { id: "same", order: 0, selector: { id: "node:ui" } },
          { id: "same", order: 1, selector: { id: "node:domain" } },
        ],
      }),
    ).toThrow(/duplicate topology layer id/u);
  });
});
