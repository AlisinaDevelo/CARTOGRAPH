import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  computeTrendMetrics,
  createGraphSnapshot,
  createHistoryRecord,
  moduleBoundary,
  parseAdrReferenceDocument,
  parseGraphSnapshot,
  parsePolicyConfig,
  type GraphSnapshot,
  type TrendMetricValue,
} from "../../src/core/index.js";

const root = resolve(import.meta.dirname, "../..");

const module = (path: string) => ({
  id: `module:${path}`,
  stableKey: `module:${path}`,
  kind: "module" as const,
  name: path,
  location: { path, line: 1 },
});

const imports = (from: string, to: string) => ({
  from: `module:${from}`,
  to: `module:${to}`,
  kind: "imports" as const,
  confidence: "certain" as const,
  evidence: [
    {
      id: `${from}->${to}`,
      kind: "source" as const,
      path: from,
      line: 1,
      detector: "test@1",
      contentHash: "e".repeat(64),
    },
  ],
});

const graph = (
  commitSha: string,
  paths: string[],
  edges: [string, string][],
): GraphSnapshot =>
  createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha },
    nodes: paths.map(module),
    edges: edges.map(([from, to]) => imports(from, to)),
  });

const metric = (
  metrics: readonly TrendMetricValue[],
  id: string,
): TrendMetricValue => {
  const found = metrics.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no metric ${id}`);
  return found;
};

const base = graph(
  "base",
  ["src/api/a.ts", "src/api/b.ts", "src/db/c.ts"],
  [
    ["src/api/a.ts", "src/api/b.ts"],
    ["src/api/b.ts", "src/db/c.ts"],
  ],
);

describe("trend metrics", () => {
  it("assigns modules to boundaries", () => {
    expect(moduleBoundary("src/api/a.ts")).toBe("src/api");
    expect(moduleBoundary("src/index.ts")).toBe("src");
    expect(moduleBoundary("packages/core/src/x.ts")).toBe("packages/core");
    expect(moduleBoundary("index.ts")).toBe(".");
  });

  it("reports every metric with a numerator, denominator, and scope", () => {
    const report = computeTrendMetrics([{ revision: "base", snapshot: base }]);
    const metrics = report.revisions[0]?.metrics ?? [];
    expect(metric(metrics, "boundary-crossing-imports")).toEqual({
      id: "boundary-crossing-imports",
      status: "measured",
      value: 0.5,
      numerator: 1,
      denominator: 2,
      scope: "local module imports",
    });
    expect(metric(metrics, "modules-in-import-cycles")).toMatchObject({
      numerator: 0,
      denominator: 3,
    });
    for (const id of [
      "ownership-coverage",
      "active-waivers",
      "runtime-reconciled-edges",
      "policy-violation-rate",
      "decision-coverage",
    ])
      expect(metric(metrics, id).status).toBe("unavailable");
    expect(report.revisions[0]?.evidence).toEqual({
      snapshotSchemaVersion: 1,
      capabilityRegistryVersion: base.capabilityRegistryVersion ?? 0,
      extractors: ["test@1"],
      workspaceScope: [],
      evidenceKinds: ["source"],
    });
  });

  it("measures no churn and identical metrics when nothing changed", () => {
    const head = parseGraphSnapshot({
      ...base,
      revision: { commitSha: "head" },
    });
    const report = computeTrendMetrics([
      { revision: "base", snapshot: base },
      { revision: "head", snapshot: head },
    ]);
    expect(report.revisions[1]?.metrics).toEqual(report.revisions[0]?.metrics);
    expect(report.intervals[0]?.metrics).toEqual([
      expect.objectContaining({ id: "node-churn", value: 0 }),
      expect.objectContaining({ id: "renamed-nodes", value: 0 }),
      expect.objectContaining({ id: "edge-churn", value: 0 }),
    ]);
  });

  it("keeps structural metrics stable across a rename and reports it as a rename", () => {
    const renamed = graph(
      "head",
      ["src/api/a.ts", "src/api/renamed.ts", "src/db/c.ts"],
      [
        ["src/api/a.ts", "src/api/renamed.ts"],
        ["src/api/renamed.ts", "src/db/c.ts"],
      ],
    );
    const report = computeTrendMetrics([
      { revision: "base", snapshot: base },
      { revision: "head", snapshot: renamed },
    ]);
    const values = (index: number) =>
      report.revisions[index]?.metrics.map((item) =>
        item.status === "measured" ? item.value : item.status,
      );
    expect(values(1)).toEqual(values(0));
    const interval = report.intervals[0]?.metrics ?? [];
    expect(metric(interval, "node-churn")).toMatchObject({ numerator: 0 });
    expect(metric(interval, "renamed-nodes")).toMatchObject({ numerator: 1 });
  });

  it("reports missing history instead of bridging the gap", () => {
    const report = computeTrendMetrics([
      { revision: "base", snapshot: base },
      { revision: "gone" },
      { revision: "head", snapshot: base },
    ]);
    expect(report.revisions[1]).toEqual({
      revision: "gone",
      status: "missing",
      marks: [{ reason: "missing-revision" }],
      metrics: [],
    });
    for (const interval of report.intervals)
      for (const item of interval.metrics)
        expect(item.status).toBe("unavailable");
  });

  it("gives the same metrics for a legacy snapshot after migration", () => {
    const legacy = JSON.parse(
      readFileSync(
        resolve(root, "test/fixtures/snapshots/legacy-v0.graph.json"),
        "utf8",
      ),
    ) as unknown;
    const migrated = parseGraphSnapshot(
      createHistoryRecord("snapshot", legacy).body,
    );
    const roundTripped = parseGraphSnapshot(
      JSON.parse(JSON.stringify(migrated)),
    );
    const first = computeTrendMetrics([
      { revision: "legacy", snapshot: migrated, recordSchemaVersion: 1 },
    ]);
    const second = computeTrendMetrics([
      { revision: "legacy", snapshot: roundTripped, recordSchemaVersion: 1 },
    ]);
    expect(first).toEqual(second);
    expect(first.revisions[0]?.evidence?.snapshotSchemaVersion).toBe(1);
  });

  it("detects cycles and bidirectional boundaries", () => {
    const tangled = graph(
      "tangled",
      ["src/api/a.ts", "src/db/c.ts"],
      [
        ["src/api/a.ts", "src/db/c.ts"],
        ["src/db/c.ts", "src/api/a.ts"],
      ],
    );
    const metrics =
      computeTrendMetrics([{ revision: "t", snapshot: tangled }]).revisions[0]
        ?.metrics ?? [];
    expect(metric(metrics, "modules-in-import-cycles")).toMatchObject({
      value: 1,
    });
    expect(metric(metrics, "bidirectional-boundary-pairs")).toMatchObject({
      numerator: 1,
      denominator: 1,
    });
  });

  it("measures policy findings and decision coverage when records exist", () => {
    const policy = parsePolicyConfig({
      policyId: "trend",
      version: "1.0.0",
      mode: "enforce",
      rules: [
        {
          id: "api-not-db",
          target: "edge",
          assertion: "absent",
          selector: {
            kind: "imports",
            fromPath: "src/api/**",
            toPath: "src/db/**",
          },
        },
      ],
    });
    const decisions = parseAdrReferenceDocument({
      references: [
        {
          id: "ADR-1",
          file: "docs/adr/1.md",
          title: "Layering",
          status: "accepted",
          graphIds: ["node:module:src/db/c.ts", "module:src/api/a.ts"],
        },
      ],
    });
    const metrics =
      computeTrendMetrics([
        { revision: "base", snapshot: base, policy, decisions },
      ]).revisions[0]?.metrics ?? [];
    expect(metric(metrics, "policy-violation-rate")).toMatchObject({
      status: "measured",
      numerator: 1,
    });
    expect(metric(metrics, "decision-coverage")).toMatchObject({
      numerator: 2,
      denominator: 3,
    });
  });
});
