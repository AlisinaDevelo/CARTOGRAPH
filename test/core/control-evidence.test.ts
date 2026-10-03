import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createAjv } from "../../scripts/json-schema.mjs";
import {
  CONTROL_EVIDENCE_LIMITATIONS,
  evaluateControlEvidence,
  parseControlMapping,
  type ControlBundleEvidence,
  type ControlEvidenceReport,
  type ControlResult,
} from "../../src/core/index.js";
import {
  AS_OF,
  decisions,
  evaluation,
  findings,
  mapping,
  policy,
  waiver,
} from "./control-evidence.fixtures.js";

const bundle: ControlBundleEvidence = {
  bundleId: "f".repeat(64),
  roles: [
    "policy",
    "policy-evaluation",
    "decisions",
    "waiver",
    "finding-lifecycle",
  ],
  declaredMissing: [{ role: "diff", reason: "no base revision" }],
  policies: [policy],
  evaluations: [evaluation],
  decisions: [decisions],
  waivers: [waiver],
  findings: [findings],
};

const report = evaluateControlEvidence(mapping, bundle, AS_OF);
const control = (id: string): ControlResult => {
  const found = report.controls.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no control ${id}`);
  return found;
};

describe("control evidence", () => {
  it("leads with the non-certification limitations", () => {
    expect(report.limitations).toEqual(CONTROL_EVIDENCE_LIMITATIONS);
    expect(report.limitations[0]).toMatch(/not a certification/u);
  });

  it("separates observed evidence from owner assertions", () => {
    const supported = control("C-supported");
    expect(supported.status).toBe("supported");
    expect(supported.observed.map((item) => item.type)).toEqual([
      "policy-rule",
      "decision",
    ]);
    expect(supported.asserted).toEqual([
      expect.objectContaining({
        type: "owner-assertion",
        basis: "asserted",
        by: "team-platform",
      }),
    ]);
    expect(control("C-asserted").status).toBe("asserted-only");
  });

  it("reports violated rules, rejected decisions, unexpected finding states, and failed tests as conflicts", () => {
    expect(control("C-violated")).toMatchObject({
      status: "conflicting",
      conflicts: [expect.objectContaining({ reason: "rule-violated" })],
    });
    expect(
      control("C-conflicts").conflicts.map((item) =>
        item.basis === "conflict" ? item.reason : "",
      ),
    ).toEqual(["decision-rejected", "finding-state", "test-failed"]);
  });

  it("lists missing, stale, unaccepted, and declared-missing evidence as gaps", () => {
    const gaps = control("C-gaps");
    expect(gaps.status).toBe("gaps");
    expect(
      gaps.gaps.map((item) => (item.basis === "gap" ? item.reason : "")),
    ).toEqual([
      "stale",
      "decision-not-accepted",
      "missing",
      "missing",
      "missing",
    ]);
    expect(control("C-stale-assertion").gaps[0]).toMatchObject({
      reason: "stale",
    });
    expect(control("C-declared-missing").gaps[0]).toMatchObject({
      reason: "declared-missing",
      detail: "no base revision",
    });
  });

  it("keeps partial applicability visible and honours periods", () => {
    expect(control("C-partial")).toMatchObject({
      status: "supported",
      applicability: "partial",
      applicabilityNote:
        "Covers the API package only; workers are out of scope.",
    });
    expect(control("C-na").status).toBe("not-applicable");
    expect(control("C-expired-period").status).toBe("out-of-period");
  });

  it("treats a waiver as stale once it expires", () => {
    const later = evaluateControlEvidence(
      mapping,
      bundle,
      "2031-01-15T00:00:00Z",
    );
    expect(later.controls.find((item) => item.id === "C-partial")?.status).toBe(
      "out-of-period",
    );
    const extended = parseControlMapping({
      ...mapping,
      controls: [
        {
          ...mapping.controls.find((item) => item.id === "C-partial"),
          period: { from: "2030-01-01T00:00:00Z", to: "2031-12-31T00:00:00Z" },
        },
      ],
    });
    const result = evaluateControlEvidence(
      extended,
      bundle,
      "2031-01-15T00:00:00Z",
    ).controls[0];
    expect(result?.gaps[0]).toMatchObject({
      reason: "stale",
      detail: "waiver expired",
    });
  });

  it("summarizes statuses and matches its schema", () => {
    expect(report.summary).toEqual({
      supported: 2,
      "asserted-only": 1,
      gaps: 3,
      conflicting: 2,
      "out-of-period": 1,
      "not-applicable": 1,
    });
    const validate = (name: string) =>
      createAjv({ allErrors: true }).compile(
        JSON.parse(
          readFileSync(
            resolve(import.meta.dirname, `../../schema/${name}`),
            "utf8",
          ),
        ) as object,
      );
    const reportSchema = validate("control-evidence.v0.1.schema.json");
    expect(
      reportSchema(JSON.parse(JSON.stringify(report)) as ControlEvidenceReport),
      JSON.stringify(reportSchema.errors),
    ).toBe(true);
    const mappingSchema = validate("control-mapping.v0.1.schema.json");
    expect(mappingSchema(mapping), JSON.stringify(mappingSchema.errors)).toBe(
      true,
    );
  });

  it("rejects malformed mappings", () => {
    const base = { schemaVersion: 1, contract: "cartograph.control-mapping" };
    const one = mapping.controls[0];
    expect(() =>
      parseControlMapping({ ...base, controls: [one, one] }),
    ).toThrow(/duplicate control id/u);
    expect(() =>
      parseControlMapping({
        ...base,
        controls: [{ ...one, applicability: "partial" }],
      }),
    ).toThrow(/applicabilityNote/u);
    expect(() =>
      parseControlMapping({
        ...base,
        controls: [
          {
            ...one,
            period: {
              from: "2031-01-01T00:00:00Z",
              to: "2030-01-01T00:00:00Z",
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseControlMapping({
        ...base,
        controls: [{ ...one, evidence: [{ type: "certificate" }] }],
      }),
    ).toThrow();
  });
});
