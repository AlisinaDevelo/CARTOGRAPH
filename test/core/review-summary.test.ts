import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ArchitectureWaiverEvaluationSchema,
  ReviewSummaryValidationError,
  buildReviewSummary,
  parseReviewSummaryReport,
  serializeReviewSummary,
} from "../../src/core/index.js";
import {
  renderReviewSummary,
  renderReviewSummaryHtml,
  renderReviewSummaryMarkdown,
} from "../../src/report/review.js";
import { GraphDiffSchema } from "../../src/core/schemas.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const diff = GraphDiffSchema.parse(
  JSON.parse(
    readFileSync(
      resolve(repositoryRoot, "test/fixtures/snapshots/valid.graph-diff.json"),
      "utf8",
    ),
  ),
);

const policy = {
  schemaVersion: 1,
  contract: "cartograph.policy-evaluation",
  policyId: "review-policy",
  policyVersion: "1.0.0",
  inputKind: "diff",
  mode: "enforce",
  status: "violations",
  evaluatedRules: 2,
  passedRules: 0,
  unsupportedRules: 1,
  violations: [
    {
      id: "violation-1",
      policyId: "review-policy",
      ruleId: "rule-1",
      target: "node",
      assertion: "exists",
      effect: "enforce",
      count: 1,
      matches: ["node-a"],
      reason: "A bounded policy fixture violation.",
      evidenceRefs: ["policy://violation-1"],
    },
  ],
  unsupported: [
    {
      id: "unsupported-1",
      policyId: "review-policy",
      ruleId: "rule-unsupported",
      target: "diff",
      code: "unsupported-target",
      reason: "The fixture retains an unsupported rule.",
      evidenceRefs: ["policy://unsupported-1"],
    },
  ],
  exceptions: [],
};

const waiverEvaluation = ArchitectureWaiverEvaluationSchema.parse({
  schemaVersion: 1,
  contract: "cartograph.architecture-waiver",
  mediaType: "application/vnd.cartograph.architecture-waiver+json",
  policyId: "review-policy",
  policyVersion: "1.0.0",
  policyStatus: "violations",
  inputKind: "diff",
  inputDigest: `sha256:${"1".repeat(64)}`,
  status: "violations",
  authorityGranted: false,
  violations: [policy.violations[0]],
  unsupported: [],
  suppressed: [],
  waivers: [
    {
      id: "waiver-expiring",
      ruleId: "rule-1",
      status: "expiring",
      code: "WAIVER_EXPIRING",
      suppresses: false,
      authorityGranted: false,
      reason: "Review fixture waiver.",
      evidenceRefs: ["waiver://expiring"],
    },
  ],
  summary: {
    waivers: 1,
    active: 0,
    expiring: 1,
    suppressed: 0,
    invalid: 0,
    unsigned: 0,
    replayed: 0,
    expired: 0,
  },
  provenance: {
    resolver: "cartograph.architecture-waiver",
    resolverVersion: "1",
    inputDigest: `sha256:${"2".repeat(64)}`,
    network: false,
    sourceBodiesIncluded: false,
    privateKeysIncluded: false,
    authorityGranted: false,
    deterministic: true,
  },
});

describe("review summary contract", () => {
  it("represents missing context as bounded non-mutating next steps", () => {
    const report = buildReviewSummary({
      schemaVersion: 1,
      contract: "cartograph.review-summary",
      diff,
      context: {},
    });
    expect(report.status).toBe("attention");
    expect(report.summary.actionable).toBe(5);
    expect(report.nextSteps.every((step) => step.mutates === false)).toBe(true);
    expect(serializeReviewSummary(report)).toBe(
      serializeReviewSummary(JSON.parse(serializeReviewSummary(report))),
    );
  });

  it("joins policy and waiver state without granting authority", () => {
    const report = buildReviewSummary({
      schemaVersion: 1,
      contract: "cartograph.review-summary",
      diff,
      context: { policy, waiverEvaluation },
    });
    expect(report.context.policy).toMatchObject({
      available: true,
      violations: 1,
      unsupported: 1,
    });
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "policy",
      "policy",
      "waiver",
    ]);
    expect(report.summary.waiverExpiring).toBe(1);
    expect(report.provenance.authorityGranted).toBe(false);
    expect(report.nextSteps.every((step) => step.mutates === false)).toBe(true);
  });

  it("treats snapshot-only waivers as available and bounds policy evidence", () => {
    const snapshot = {
      id: "waiver-snapshot",
      ruleId: "rule-1",
      policyVersion: "1.0.0",
      evidenceRevision: "evidence-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      waiverDigest: `sha256:${"3".repeat(64)}`,
      scopeDigest: `sha256:${"4".repeat(64)}`,
      affectedIds: ["node-a"],
      status: "shadowed",
      code: "WAIVER_SHADOWED",
      evidenceRefs: ["waiver://snapshot"],
    } as const;
    const report = buildReviewSummary({
      schemaVersion: 1,
      contract: "cartograph.review-summary",
      diff,
      context: {
        waiverSnapshots: [snapshot],
        policy: {
          ...policy,
          violations: [
            {
              ...policy.violations[0],
              evidenceRefs: Array.from(
                { length: 256 },
                (_, index) => `policy://evidence/${index}`,
              ),
            },
          ],
        },
      },
    });
    expect(report.context.waivers).toMatchObject({
      available: true,
      total: 1,
      invalid: 1,
    });
    expect(
      report.nextSteps.some((step) => step.code === "provide-waiver"),
    ).toBe(false);
    expect(
      report.findings.find((finding) => finding.kind === "waiver"),
    ).toMatchObject({
      severity: "warning",
      waiver: { status: "shadowed" },
    });
    expect(
      report.findings.find((finding) => finding.id === "violation-1")?.policy
        ?.evidenceRefs,
    ).toHaveLength(128);
  });

  it("renders deterministic JSON, Markdown, and escaped HTML", () => {
    const report = buildReviewSummary({
      schemaVersion: 1,
      contract: "cartograph.review-summary",
      diff,
      context: { policy },
    });
    expect(parseReviewSummaryReport(report)).toEqual(report);
    expect(renderReviewSummary(report, "json")).toContain(
      '"contract":"cartograph.review-summary"',
    );
    expect(renderReviewSummaryMarkdown(report)).toContain("## Next steps");
    expect(renderReviewSummaryHtml(report)).toContain(
      "CARTOGRAPH review summary",
    );
    expect(renderReviewSummaryHtml(report)).not.toContain("<script");
  });

  it("rejects absolute paths and credential-shaped context", () => {
    expect(() =>
      buildReviewSummary({
        schemaVersion: 1,
        contract: "cartograph.review-summary",
        diff,
        context: {
          artifacts: [
            {
              id: "unsafe",
              label: "unsafe",
              kind: "review",
              path: "/tmp/review.json",
              local: true,
            },
          ],
        },
      }),
    ).toThrow(ReviewSummaryValidationError);
    expect(() =>
      buildReviewSummary({
        schemaVersion: 1,
        contract: "cartograph.review-summary",
        diff,
        context: {
          artifacts: [],
          policy: { ...policy, policyId: "ghp_fake_secret" },
        },
      }),
    ).toThrow(ReviewSummaryValidationError);
  });
});
