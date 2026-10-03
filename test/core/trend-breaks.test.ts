import { describe, expect, it } from "vitest";

import {
  computeTrendMetrics,
  createGraphSnapshot,
  parsePolicyConfig,
  parseTrendExplanations,
  type Diagnostic,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
  type TrendMetricsReport,
  type TrendRevisionInput,
} from "../../src/core/index.js";

const evidence = (path: string, detector = "test@1", kind = "source") =>
  kind === "source"
    ? {
        id: `${path}-${detector}`,
        kind: "source" as const,
        path,
        line: 1,
        detector,
        contentHash: "e".repeat(64),
      }
    : {
        id: `${path}-${detector}-runtime`,
        kind: "runtime" as const,
        detector,
        contentHash: "f".repeat(64),
      };

const module = (path: string) => ({
  id: `module:${path}`,
  stableKey: `module:${path}`,
  kind: "module" as const,
  name: path,
  location: { path, line: 1 },
});

type Options = {
  detector?: string;
  extraNodes?: Partial<GraphNode>[];
  extraEdges?: Partial<GraphEdge>[];
  diagnostics?: Partial<Diagnostic>[];
};

const graph = (commitSha: string, options: Options = {}): GraphSnapshot =>
  createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha },
    nodes: [
      module("src/api/a.ts"),
      module("src/db/b.ts"),
      ...(options.extraNodes ?? []),
    ],
    edges: [
      {
        from: "module:src/api/a.ts",
        to: "module:src/db/b.ts",
        kind: "imports",
        confidence: "certain",
        evidence: [evidence("src/api/a.ts", options.detector)],
      },
      ...(options.extraEdges ?? []),
    ],
    ...(options.diagnostics === undefined
      ? {}
      : { diagnostics: options.diagnostics }),
  });

const pair = (
  after: Partial<TrendRevisionInput> & { snapshot?: GraphSnapshot },
  before: Partial<TrendRevisionInput> = {},
): TrendMetricsReport =>
  computeTrendMetrics([
    { revision: "r1", snapshot: graph("r1"), ...before },
    { revision: "r2", snapshot: graph("r2"), ...after },
  ]);

const reasons = (report: TrendMetricsReport): string[] =>
  report.intervals[0]?.breaks.map((item) => item.reason) ?? [];

describe("trend breaks", () => {
  it("finds no break between comparable revisions and gives deltas", () => {
    const report = pair({});
    expect(reasons(report)).toEqual([]);
    expect(report.unexplainedBreaks).toBe(0);
    const change = report.intervals[0]?.changes.find(
      (item) => item.id === "boundary-crossing-imports",
    );
    expect(change).toEqual({
      id: "boundary-crossing-imports",
      status: "comparable",
      from: 1,
      to: 1,
      delta: 0,
    });
  });

  it("marks an extractor version change and withholds every delta", () => {
    const report = pair({ snapshot: graph("r2", { detector: "test@2" }) });
    expect(reasons(report)).toEqual(["adapter-change"]);
    expect(report.intervals[0]?.breaks[0]?.detail).toBe("test@2");
    for (const change of report.intervals[0]?.changes ?? []) {
      expect(change.status).not.toBe("comparable");
      expect(change).not.toHaveProperty("delta");
    }
  });

  it("marks a contract change", () => {
    const report = pair({
      // A future registry version, as an older store might hold after an upgrade.
      snapshot: {
        ...graph("r2"),
        capabilityRegistryVersion: 99,
      } as unknown as GraphSnapshot,
    });
    expect(reasons(report)).toContain("contract-change");
  });

  it("marks workspace scope, sampling, and partial-snapshot changes", () => {
    expect(
      reasons(
        pair({
          snapshot: graph("r2", {
            extraNodes: [
              {
                id: "package:packages/new",
                stableKey: "package:packages/new",
                kind: "package",
                name: "new",
              },
            ],
          }),
        }),
      ),
    ).toEqual(["workspace-scope-change"]);
    expect(
      reasons(
        pair({
          snapshot: graph("r2", {
            extraEdges: [
              {
                from: "module:src/db/b.ts",
                to: "module:src/api/a.ts",
                kind: "calls",
                confidence: "observed",
                evidence: [evidence("x", "trace@1", "runtime")],
              },
            ],
          }),
        }),
      ),
    ).toEqual(["sampling-change"]);
    const partial = pair({
      snapshot: graph("r2", {
        diagnostics: [
          {
            id: "d1",
            code: "PARTIAL_API_SCHEMA_GENERATION",
            severity: "warning",
            message: "partial",
          },
        ],
      }),
    });
    expect(partial.revisions[1]?.marks.map((item) => item.reason)).toEqual([
      "partial-snapshot",
    ]);
    expect(reasons(partial)).toEqual(["partial-snapshot"]);
  });

  it("marks migrated revisions", () => {
    const report = pair({ migratedFrom: 0 });
    expect(report.revisions[1]?.marks).toEqual([
      { reason: "migration", detail: "snapshot migrated from contract v0" },
    ]);
    expect(reasons(report)).toEqual(["migration"]);
  });

  it("limits a policy change to the policy metric", () => {
    const policy = parsePolicyConfig({
      policyId: "p",
      version: "1.0.0",
      mode: "enforce",
      rules: [
        {
          id: "no-db",
          target: "edge",
          assertion: "absent",
          selector: { kind: "imports", toPath: "src/db/**" },
        },
      ],
    });
    const report = pair(
      { policy, policyRecordId: "b".repeat(64) },
      { policy, policyRecordId: "a".repeat(64) },
    );
    expect(reasons(report)).toEqual(["policy-change"]);
    const byId = new Map(
      report.intervals[0]?.changes.map((item) => [item.id, item.status]),
    );
    expect(byId.get("policy-violation-rate")).toBe("incomparable");
    expect(byId.get("boundary-crossing-imports")).toBe("comparable");
  });

  it("never bridges missing or removed revisions", () => {
    const report = computeTrendMetrics([
      { revision: "r1", snapshot: graph("r1") },
      { revision: "r2", removed: true },
      { revision: "r3", snapshot: graph("r3") },
    ]);
    expect(report.revisions[1]?.marks).toEqual([
      { reason: "removed-by-retention" },
    ]);
    expect(report.intervals.map((item) => item.from + item.to)).toEqual([
      "r1r2",
      "r2r3",
    ]);
    for (const interval of report.intervals) {
      expect(interval.breaks.map((item) => item.reason)).toEqual([
        "removed-by-retention",
      ]);
      expect(
        interval.changes.every((item) => item.status === "unavailable"),
      ).toBe(true);
    }
  });
});

describe("trend uncertainty", () => {
  it("widens the boundary-crossing band by unresolved imports", () => {
    const snapshot = graph("r1", {
      extraNodes: [
        {
          id: "unknown:dynamic",
          stableKey: "unknown:dynamic",
          kind: "unknown",
          name: "dynamic",
        },
      ],
      extraEdges: [
        {
          from: "module:src/api/a.ts",
          to: "unknown:dynamic",
          kind: "imports",
          confidence: "inferred",
          evidence: [],
          unresolvedReason: "dynamic import specifier",
        },
      ],
    });
    const metric = computeTrendMetrics([
      { revision: "r1", snapshot },
    ]).revisions[0]?.metrics.find(
      (item) => item.id === "boundary-crossing-imports",
    );
    expect(metric).toMatchObject({
      value: 1,
      uncertainty: { lower: 0.5, upper: 1, unknowns: 1 },
    });
  });
});

describe("trend explanations and restatements", () => {
  it("attaches reviewer notes to the breaks they explain", () => {
    const explanations = parseTrendExplanations({
      schemaVersion: 1,
      contract: "cartograph.trend-explanations",
      explanations: [
        {
          from: "r1",
          to: "r2",
          reason: "adapter-change",
          reviewer: "arch-review",
          note: "Extractor 2 resolves re-exports; the jump is a measurement change.",
        },
      ],
    });
    const report = computeTrendMetrics(
      [
        { revision: "r1", snapshot: graph("r1") },
        { revision: "r2", snapshot: graph("r2", { detector: "test@2" }) },
      ],
      { explanations },
    );
    expect(report.intervals[0]?.breaks[0]?.explanation).toEqual({
      reviewer: "arch-review",
      note: "Extractor 2 resolves re-exports; the jump is a measurement change.",
    });
    expect(report.unexplainedBreaks).toBe(0);
  });

  it("lists values that changed since an earlier report", () => {
    const earlier = computeTrendMetrics([
      { revision: "r1", snapshot: graph("r1"), recordId: "a".repeat(64) },
    ]);
    const restated = graph("r1", {
      extraNodes: [module("src/api/c.ts")],
      extraEdges: [
        {
          from: "module:src/api/a.ts",
          to: "module:src/api/c.ts",
          kind: "imports",
          confidence: "certain",
          evidence: [evidence("src/api/a.ts")],
        },
      ],
    });
    const report = computeTrendMetrics(
      [{ revision: "r1", snapshot: restated, recordId: "b".repeat(64) }],
      { previous: earlier },
    );
    expect(
      report.restatements.find(
        (item) => item.metric === "boundary-crossing-imports",
      ),
    ).toEqual({
      revision: "r1",
      metric: "boundary-crossing-imports",
      previous: 1,
      current: 0.5,
      reasons: ["evidence-changed"],
    });
    expect(
      computeTrendMetrics([{ revision: "r1", snapshot: graph("r1") }], {
        previous: computeTrendMetrics([
          { revision: "r1", snapshot: graph("r1") },
        ]),
      }).restatements,
    ).toEqual([]);
  });

  it("rejects explanations for unknown break reasons", () => {
    expect(() =>
      parseTrendExplanations({
        schemaVersion: 1,
        contract: "cartograph.trend-explanations",
        explanations: [
          { from: "a", to: "b", reason: "vibes", reviewer: "r", note: "n" },
        ],
      }),
    ).toThrow();
  });
});
