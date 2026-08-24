import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  createRemediationSuggestion,
  generateRemediationSuggestions,
  REMEDIATION_SUGGESTION_CONTRACT,
  REMEDIATION_SUGGESTION_SCHEMA_VERSION,
  RemediationFindingSchema,
  RemediationSuggestionError,
  RemediationSuggestionReportSchema,
  RemediationSuggestionSchema,
  remediationFindingDigest,
  serializeRemediationSuggestion,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixture = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "test/fixtures/remediation-suggestions/scenarios.v0.1.json",
    ),
    "utf8",
  ),
) as {
  baselineDigest: `sha256:${string}`;
  evidenceDigests: Record<string, `sha256:${string}`>;
};

const evidenceDigest = fixture.evidenceDigests["finding-supported"];
if (!evidenceDigest) throw new Error("fixture evidence digest missing");

const finding = (overrides: Record<string, unknown> = {}) => ({
  findingId: "finding-supported",
  findingCode: "policy.unknown-edge",
  severity: "warning" as const,
  summary: "Unknown edge requires a bounded policy review.",
  baselineDigest: fixture.baselineDigest,
  evidenceDigest,
  evidence: [
    {
      id: "evidence-supported",
      kind: "policy" as const,
      digest: evidenceDigest,
      reference: "graph://diagnostic/finding-supported",
    },
  ],
  inputs: [
    {
      name: "baseline",
      reference: ".cartograph/baseline.json",
      valueDigest: fixture.baselineDigest,
    },
  ],
  ownerId: "team-architecture",
  ambiguity: "clear" as const,
  securitySensitive: false,
  ...overrides,
});

const rule = {
  ruleId: "policy-unknown-edge-review",
  findingCode: "policy.unknown-edge",
  kind: "configuration-change" as const,
  title: "Review the unknown-edge policy boundary.",
  rationale: "The finding needs a human-reviewed policy boundary decision.",
  proposal: {
    operation: "configure" as const,
    description: "Prepare a reversible policy configuration review.",
    targets: [".cartograph/policy.json"],
    edits: [
      {
        target: ".cartograph/policy.json",
        change: "Propose an explicit allow or deny entry after review.",
        reversible: true as const,
      },
    ],
  },
  confidence: 0.72,
  assumptions: ["The baseline digest is current."],
  risk: "medium" as const,
  validationPlan: [
    {
      id: "policy-diff",
      action: "Compare the proposal with the current policy baseline.",
      expected: "The comparison is deterministic and read-only.",
    },
  ],
};

const options = (overrides: Record<string, unknown> = {}) => ({
  enabled: true as const,
  currentBaselineDigest: fixture.baselineDigest,
  currentEvidenceDigests: { "finding-supported": evidenceDigest },
  rules: [rule],
  ...overrides,
});

describe("governed remediation suggestions", () => {
  it("is opt-in and read-only by default", () => {
    const report = generateRemediationSuggestions([finding()], {
      rules: [rule],
    });

    expect(report).toMatchObject({
      schemaVersion: REMEDIATION_SUGGESTION_SCHEMA_VERSION,
      contract: REMEDIATION_SUGGESTION_CONTRACT,
      mode: "disabled",
      readOnly: true,
      authority: { network: false, filesystem: false, execution: false },
      suggestions: [],
      skipped: [
        {
          findingId: "finding-supported",
          reason: "generation-disabled",
        },
      ],
    });
  });

  it("binds a suggestion to finding, baseline, and evidence digests", () => {
    const input = finding();
    const before = JSON.stringify(input);
    const report = generateRemediationSuggestions([input], options());
    const suggestion = report.suggestions[0];
    if (!suggestion) throw new Error("expected a suggestion");

    expect(JSON.stringify(input)).toBe(before);
    expect(suggestion).toMatchObject({
      contract: REMEDIATION_SUGGESTION_CONTRACT,
      findingId: input.findingId,
      findingCode: input.findingCode,
      findingDigest: remediationFindingDigest(input),
      baselineDigest: input.baselineDigest,
      evidenceDigest: input.evidenceDigest,
      kind: "configuration-change",
      status: "unverified",
      readOnly: true,
      authority: { network: false, filesystem: false, execution: false },
    });
    expect(serializeRemediationSuggestion(suggestion)).not.toContain("apply");
  });

  it("rejects unsupported, stale, ambiguous, ownerless, and security-sensitive findings", () => {
    const cases = [
      ["unsupported-finding", finding({ findingCode: "future.rule" })],
      [
        "stale-baseline",
        finding({
          baselineDigest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      ],
      [
        "stale-evidence",
        finding({
          evidenceDigest:
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        }),
      ],
      ["ambiguous-finding", finding({ ambiguity: "ambiguous" })],
      ["ownerless-finding", finding({ ownerId: null })],
      ["security-sensitive", finding({ securitySensitive: true })],
    ] as const;

    for (const [reason, input] of cases) {
      const report = generateRemediationSuggestions([input], options());
      expect(report.suggestions).toHaveLength(0);
      expect(report.skipped[0]?.reason).toBe(reason);
    }
  });

  it("enforces an explicit suggestion budget", () => {
    const first = finding({ findingId: "finding-first" });
    const second = finding({ findingId: "finding-second" });
    const report = generateRemediationSuggestions([first, second], {
      ...options({
        currentEvidenceDigests: {
          "finding-first": evidenceDigest,
          "finding-second": evidenceDigest,
        },
      }),
      maxSuggestions: 1,
    });

    expect(report.suggestions).toHaveLength(1);
    expect(report.skipped).toEqual([
      {
        findingId: "finding-second",
        findingCode: "policy.unknown-edge",
        reason: "resource-limit",
      },
    ]);
  });

  it("fails closed on malformed rules, invalid digests, and mismatched rule codes", () => {
    expect(() =>
      generateRemediationSuggestions([finding()], {
        ...options(),
        currentBaselineDigest: "not-a-digest",
      }),
    ).toThrowError(RemediationSuggestionError);
    expect(() =>
      createRemediationSuggestion(finding(), {
        ...rule,
        findingCode: "other.rule",
      }),
    ).toThrowError(RemediationSuggestionError);
    expect(() =>
      RemediationFindingSchema.parse({
        ...finding(),
        evidence: [{ ...finding().evidence[0], reference: "/tmp/secret" }],
      }),
    ).toThrow();
  });

  it("keeps runtime schemas and JSON Schemas aligned", () => {
    const report = generateRemediationSuggestions([finding()], options());
    const suggestion = report.suggestions[0];
    if (!suggestion) throw new Error("expected a suggestion");
    expect(RemediationSuggestionSchema.parse(suggestion)).toEqual(suggestion);
    expect(RemediationSuggestionReportSchema.parse(report)).toEqual(report);

    const ajv = new Ajv({ allErrors: true });
    const suggestionSchema = JSON.parse(
      readFileSync(
        resolve(
          repositoryRoot,
          "schema/remediation-suggestion.v0.1.schema.json",
        ),
        "utf8",
      ),
    ) as object;
    const reportSchema = JSON.parse(
      readFileSync(
        resolve(
          repositoryRoot,
          "schema/remediation-suggestion-report.v0.1.schema.json",
        ),
        "utf8",
      ),
    ) as object;
    expect(ajv.compile(suggestionSchema)(suggestion)).toBe(true);
    expect(ajv.compile(reportSchema)(report)).toBe(true);
  });
});
