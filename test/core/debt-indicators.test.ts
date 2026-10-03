import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createAjv } from "../../scripts/json-schema.mjs";
import {
  computeDebtIndicators,
  computeTrendMetrics,
  createGraphSnapshot,
  parseCodeowners,
  parseDebtIndicatorsConfig,
  parseOwnershipInput,
  resolveOwnership,
  type DebtIndicator,
  type DebtIndicatorsReport,
} from "../../src/core/index.js";
import { evaluation, findings, waiver } from "./control-evidence.fixtures.js";

const root = resolve(import.meta.dirname, "../..");
const ownershipFixture = JSON.parse(
  readFileSync(
    resolve(root, "test/fixtures/ownership-resolution/report.v0.1.json"),
    "utf8",
  ),
) as {
  request: Record<string, unknown> & {
    sources: unknown[];
    sourceDiagnostics: unknown[];
  };
  codeowners: {
    id: string;
    repositoryId: string;
    path: string;
    revision: string;
    precedence: number;
    text: string;
  }[];
};
const parsed = ownershipFixture.codeowners.map((entry) =>
  parseCodeowners(entry.text, entry),
);
const ownership = resolveOwnership(
  parseOwnershipInput({
    ...ownershipFixture.request,
    sources: [
      ...ownershipFixture.request.sources,
      ...parsed.map((entry) => entry.source),
    ],
    sourceDiagnostics: [
      ...ownershipFixture.request.sourceDiagnostics,
      ...parsed.flatMap((entry) => entry.diagnostics),
    ],
  }),
);

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
      id: `${from}-${to}`,
      kind: "source" as const,
      path: from,
      line: 1,
      detector: "test@1",
      contentHash: "e".repeat(64),
    },
  ],
});
const graph = (commitSha: string, edges: [string, string][]) =>
  createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha },
    nodes: ["src/api/a.ts", "src/api/b.ts", "src/db/c.ts"].map(module),
    edges: edges.map(([from, to]) => imports(from, to)),
  });
const trends = computeTrendMetrics([
  {
    revision: "r1",
    snapshot: graph("r1", [
      ["src/api/a.ts", "src/api/b.ts"],
      ["src/api/b.ts", "src/api/a.ts"],
    ]),
  },
  {
    revision: "r2",
    snapshot: graph("r2", [
      ["src/api/a.ts", "src/api/b.ts"],
      ["src/api/b.ts", "src/db/c.ts"],
    ]),
  },
]);

const inputs = {
  findings: [findings],
  waivers: [waiver],
  ownership,
  evaluation,
  trends,
};
const at = (asOf: string, extra: object = {}): DebtIndicatorsReport =>
  computeDebtIndicators({ ...inputs, ...extra }, asOf);
const indicator = (report: DebtIndicatorsReport, id: string): DebtIndicator => {
  const found = report.indicators.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no indicator ${id}`);
  return found;
};

describe("debt indicators on a curated timeline", () => {
  const early = at("2030-03-01T00:00:00Z");
  const middle = at("2030-06-01T00:00:00Z");
  const late = at("2030-12-15T00:00:00Z");

  it("states its limitation and reports every indicator", () => {
    expect(middle.limitation).toMatch(/do not measure or predict/u);
    expect(middle.indicators.map((item) => item.id)).toEqual([
      "finding-age",
      "finding-recurrence",
      "waiver-history",
      "ownership-gaps",
      "policy-severity",
      "boundary-erosion",
      "unknown-coverage",
      "remediation-evidence",
    ]);
  });

  it("ages open findings past the threshold, with sensitivity", () => {
    expect(indicator(early, "finding-age")).toMatchObject({
      status: "within-threshold",
      numerator: 0,
      denominator: 4,
      sensitivity: { lower: "within-threshold", upper: "within-threshold" },
    });
    const aged = indicator(middle, "finding-age");
    expect(aged).toMatchObject({
      status: "above-threshold",
      numerator: 4,
      threshold: 90,
    });
    expect(aged.evidence).toContain("finding-policy");
    expect(aged.evidence).not.toContain("finding-api");
  });

  it("counts recurrence and remediation evidence from applied lifecycle events", () => {
    expect(indicator(middle, "finding-recurrence")).toMatchObject({
      status: "above-threshold",
      numerator: 1,
      denominator: 7,
      evidence: ["finding-api"],
    });
    expect(indicator(middle, "remediation-evidence")).toMatchObject({
      status: "within-threshold",
      numerator: 0,
      denominator: 1,
      counterexamples: ["finding-api"],
    });
  });

  it("flags waivers as they approach expiry", () => {
    expect(indicator(middle, "waiver-history").status).toBe("within-threshold");
    expect(indicator(late, "waiver-history")).toMatchObject({
      status: "above-threshold",
      evidence: ["waiver-signed-active (expiring)"],
    });
  });

  it("reports ownership gaps with unresolvable targets as uncertainty", () => {
    expect(indicator(middle, "ownership-gaps")).toMatchObject({
      status: "above-threshold",
      numerator: 2,
      denominator: 10,
      uncertainty: ["3 target(s) could not be resolved either way"],
    });
  });

  it("measures enforced violations, erosion across comparable intervals, and unknowns", () => {
    expect(indicator(middle, "policy-severity")).toMatchObject({
      status: "above-threshold",
      value: 1,
      evidence: ["no-db-from-api"],
    });
    expect(indicator(middle, "boundary-erosion")).toMatchObject({
      status: "above-threshold",
      value: 0.5,
      evidence: ["r1..r2 +0.5"],
    });
    expect(indicator(middle, "unknown-coverage")).toMatchObject({
      status: "within-threshold",
      value: 0,
    });
  });

  it("reports missing evidence as unavailable, never as zero", () => {
    const empty = computeDebtIndicators({}, "2030-06-01T00:00:00Z");
    expect(
      empty.indicators.every((item) => item.status === "unavailable"),
    ).toBe(true);
    expect(indicator(empty, "waiver-history").reason).toBe(
      "no waiver record is stored",
    );
  });

  it("applies configured thresholds and disabled indicators", () => {
    const config = parseDebtIndicatorsConfig({
      schemaVersion: 1,
      contract: "cartograph.debt-indicators-config",
      thresholds: { findingMaxOpenDays: 365, ownershipMaxGapRate: 0.5 },
      disabled: ["policy-severity"],
    });
    const report = computeDebtIndicators(
      inputs,
      "2030-06-01T00:00:00Z",
      config,
    );
    expect(indicator(report, "finding-age").status).toBe("within-threshold");
    expect(indicator(report, "ownership-gaps").status).toBe("within-threshold");
    expect(indicator(report, "policy-severity").status).toBe("disabled");
    expect(config.thresholds.unknownMaxRate).toBe(0.2);
  });

  it("matches its schema", () => {
    const validate = createAjv({ allErrors: true }).compile(
      JSON.parse(
        readFileSync(
          resolve(root, "schema/debt-indicators.v0.1.schema.json"),
          "utf8",
        ),
      ) as object,
    );
    for (const report of [early, middle, late])
      expect(
        validate(JSON.parse(JSON.stringify(report))),
        JSON.stringify(validate.errors),
      ).toBe(true);
  });
});
