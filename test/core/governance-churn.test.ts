import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createAjv } from "../../scripts/json-schema.mjs";
import {
  computeGovernanceChurn,
  parseCodeowners,
  parseOwnershipInput,
  resolveOwnership,
  type ArchitectureWaiver,
  type GovernanceChurnReport,
  type OwnershipResolutionReport,
} from "../../src/core/index.js";
import { findings, waiver } from "./control-evidence.fixtures.js";

const root = resolve(import.meta.dirname, "../..");
const fixture = JSON.parse(
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
const parsed = fixture.codeowners.map((entry) =>
  parseCodeowners(entry.text, entry),
);
const base = resolveOwnership(
  parseOwnershipInput({
    ...fixture.request,
    sources: [
      ...fixture.request.sources,
      ...parsed.map((entry) => entry.source),
    ],
    sourceDiagnostics: [
      ...fixture.request.sourceDiagnostics,
      ...parsed.flatMap((entry) => entry.diagnostics),
    ],
  }),
);

type Change = { owners?: string[]; status?: string };
const mutate = (
  report: OwnershipResolutionReport,
  changes: Record<string, Change>,
): OwnershipResolutionReport => ({
  ...report,
  results: report.results.map((result) => {
    const change = changes[result.target.id];
    return change === undefined
      ? result
      : ({
          ...result,
          ...(change.owners === undefined ? {} : { owners: change.owners }),
          ...(change.status === undefined ? {} : { status: change.status }),
        } as typeof result);
  }),
});

const r2 = mutate(base, {
  "api-file": { owners: ["@new-team"] },
  "unowned-file": { status: "resolved", owners: ["@platform"] },
  "docs-file": { status: "unowned", owners: [] },
});
const r4 = mutate(r2, { "unowned-file": { status: "unowned", owners: [] } });

const waivers: ArchitectureWaiver[] = [
  waiver,
  {
    ...waiver,
    id: "waiver-renewed",
    createdAt: "2031-01-10T00:00:00.000Z",
    expiresAt: "2031-06-30T00:00:00.000Z",
    changeScope: {
      ...waiver.changeScope,
      affectedIds: ["node:endpoint:health", "node:endpoint:ready"],
    },
  },
  {
    ...waiver,
    id: "waiver-lapsed",
    ruleId: "no-queues",
    createdAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-03-01T00:00:00.000Z",
  },
];

const report = computeGovernanceChurn(
  {
    ownership: [
      { revision: "r1", recordId: "a".repeat(64), report: base },
      { revision: "r2", recordId: "b".repeat(64), report: r2 },
      { revision: "r3" },
      { revision: "r4", recordId: "c".repeat(64), report: r4 },
      { revision: "r5", recordId: "c".repeat(64), report: r4 },
    ],
    waivers,
    findings: [findings],
  },
  "2031-02-01T00:00:00Z",
);
const ownership = report.ownership as Extract<
  GovernanceChurnReport["ownership"],
  { status: "measured" }
>;

describe("governance churn", () => {
  it("measures owner changes and gap transitions between measured revisions", () => {
    const first = ownership.intervals[0];
    expect(first).toMatchObject({
      from: "r1",
      to: "r2",
      status: "measured",
      verifiedNoChange: false,
      ownerChanges: { numerator: 3, denominator: 10 },
      gapsOpened: { numerator: 1, evidence: ["docs-file"] },
      gapsClosed: { numerator: 1, evidence: ["unowned-file"] },
    });
    expect(
      first?.status === "measured" ? first.ownerChanges.evidence : [],
    ).toEqual(["api-file", "docs-file", "unowned-file"]);
  });

  it("keeps missing history apart from a verified no-change", () => {
    expect(ownership.points[2]).toEqual({ revision: "r3", status: "missing" });
    expect(ownership.intervals.map((item) => item.status)).toEqual([
      "measured",
      "missing-history",
      "missing-history",
      "measured",
    ]);
    expect(ownership.intervals[3]).toMatchObject({ verifiedNoChange: true });
  });

  it("detects a gap that closed and reopened", () => {
    expect(ownership.gapRecurrence).toMatchObject({
      numerator: 1,
      evidence: ["unowned-file"],
    });
  });

  it("tracks renewals, scope growth, expiry, and lapses per rule", () => {
    expect(report.waivers).toMatchObject({
      status: "measured",
      renewalGraceDays: 30,
      rules: [
        {
          ruleId: "no-endpoints",
          waivers: ["waiver-signed-active", "waiver-renewed"],
          renewals: 1,
          expired: 1,
          lapsed: 0,
          active: 1,
          scopeGrowth: { first: 1, last: 2 },
        },
        { ruleId: "no-queues", renewals: 0, expired: 1, lapsed: 1, active: 0 },
      ],
      totals: { waivers: 3, renewals: 1, lapsed: 1, rulesWithScopeGrowth: 1 },
    });
  });

  it("measures review latency from applied lifecycle events", () => {
    expect(report.reviewLatency).toMatchObject({
      status: "measured",
      findings: 7,
      reviewed: 7,
      unreviewed: [],
    });
    const latency = report.reviewLatency as {
      medianDays: number;
      p90Days: number;
    };
    expect(latency.medianDays).toBeGreaterThan(1);
    expect(latency.p90Days).toBeGreaterThanOrEqual(latency.medianDays);
  });

  it("reports absent inputs as unavailable and never combines measures", () => {
    const empty = computeGovernanceChurn({}, "2031-02-01T00:00:00Z");
    expect(empty.ownership.status).toBe("unavailable");
    expect(empty.waivers.status).toBe("unavailable");
    expect(empty.reviewLatency.status).toBe("unavailable");
    expect(empty.limitation).toMatch(/none is combined into a score/u);
    expect(JSON.stringify(report)).not.toMatch(/"score"/u);
  });

  it("matches its schema", () => {
    const validate = createAjv({ allErrors: true }).compile(
      JSON.parse(
        readFileSync(
          resolve(root, "schema/governance-churn.v0.1.schema.json"),
          "utf8",
        ),
      ) as object,
    );
    expect(
      validate(JSON.parse(JSON.stringify(report))),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });
});
