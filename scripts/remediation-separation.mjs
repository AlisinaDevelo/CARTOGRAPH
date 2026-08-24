#!/usr/bin/env node
/* global console, process */

import { resolve } from "node:path";

import Ajv from "ajv";

const repositoryRoot = resolve(
  process.argv.includes("--root")
    ? process.argv[process.argv.indexOf("--root") + 1]
    : process.cwd(),
);
const fail = (message) => {
  throw new Error(message);
};

const digest =
  "sha256:3e2d9a1a2c5b4d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6";
const staleBaseline =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const staleEvidence =
  "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

const makeFinding = (id, overrides = {}) => ({
  findingId: id,
  findingCode: "policy.unknown-edge",
  severity: "warning",
  summary: "Synthetic finding for the separation audit.",
  baselineDigest: digest,
  evidenceDigest: digest,
  evidence: [
    {
      id: `evidence-${id}`,
      kind: "policy",
      digest,
      reference: `graph://separation/${id}`,
    },
  ],
  inputs: [
    {
      name: "baseline",
      reference: ".cartograph/baseline.json",
      valueDigest: digest,
    },
  ],
  ownerId: "team-architecture",
  ambiguity: "clear",
  securitySensitive: false,
  ...overrides,
});

const rule = {
  ruleId: "policy-unknown-edge-review",
  findingCode: "policy.unknown-edge",
  kind: "configuration-change",
  title: "Review the unknown-edge policy boundary.",
  rationale: "The finding needs a human-reviewed policy boundary decision.",
  proposal: {
    operation: "configure",
    description: "Prepare a reversible policy configuration review.",
    targets: [".cartograph/policy.json"],
    edits: [
      {
        target: ".cartograph/policy.json",
        change: "Propose an explicit allow or deny entry after review.",
        reversible: true,
      },
    ],
  },
  confidence: 0.72,
  assumptions: ["The baseline digest is current."],
  risk: "medium",
  validationPlan: [
    {
      id: "policy-diff",
      action: "Compare the proposal with the current policy baseline.",
      expected: "The comparison is deterministic and read-only.",
    },
  ],
};

const validate = async () => {
  const reportSchema = JSON.parse(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(
        resolve(
          repositoryRoot,
          "schema/remediation-suggestion-report.v0.1.schema.json",
        ),
        "utf8",
      ),
    ),
  );
  const validateReport = new Ajv({ allErrors: true }).compile(reportSchema);
  const {
    generateRemediationSuggestions,
    serializeRemediationSuggestion,
    serializeRemediationSuggestionReport,
  } = await import("../src/core/index.ts");
  const cases = [
    {
      id: "supported",
      finding: makeFinding("finding-supported"),
      expected: "suggestion",
    },
    {
      id: "stale-baseline",
      finding: makeFinding("finding-stale-baseline", {
        baselineDigest: staleBaseline,
      }),
      expected: "stale-baseline",
    },
    {
      id: "stale-evidence",
      finding: makeFinding("finding-stale-evidence", {
        evidenceDigest: staleEvidence,
      }),
      expected: "stale-evidence",
    },
  ];
  const results = [];
  for (const scenario of cases) {
    const before = JSON.stringify(scenario.finding);
    const report = generateRemediationSuggestions([scenario.finding], {
      enabled: true,
      currentBaselineDigest: digest,
      currentEvidenceDigests: {
        "finding-supported": digest,
        "finding-stale-baseline": digest,
        "finding-stale-evidence": digest,
      },
      rules: [rule],
    });
    if (!validateReport(report))
      fail(
        `suggestion report schema validation failed: ${JSON.stringify(validateReport.errors)}`,
      );
    if (JSON.stringify(scenario.finding) !== before)
      fail(`finding ${scenario.id} was mutated during suggestion generation`);
    if (
      report.readOnly !== true ||
      Object.values(report.authority).some(Boolean) ||
      serializeRemediationSuggestionReport(report).includes('"apply"')
    )
      fail(`report ${scenario.id} crossed the canonical-truth boundary`);
    const actual =
      report.suggestions.length > 0 ? "suggestion" : report.skipped[0]?.reason;
    if (actual !== scenario.expected)
      fail(
        `case ${scenario.id} expected ${scenario.expected}, found ${actual}`,
      );
    if (actual === "suggestion") {
      const suggestion = report.suggestions[0];
      if (!suggestion) fail("supported case did not emit a suggestion");
      if (
        suggestion.status !== "unverified" ||
        suggestion.findingId !== scenario.finding.findingId ||
        suggestion.baselineDigest !== scenario.finding.baselineDigest ||
        suggestion.evidenceDigest !== scenario.finding.evidenceDigest ||
        suggestion.readOnly !== true ||
        Object.values(suggestion.authority).some(Boolean) ||
        serializeRemediationSuggestion(suggestion).includes('"apply"')
      )
        fail(`suggestion ${scenario.id} crossed the canonical-truth boundary`);
    }
    results.push({ id: scenario.id, outcome: actual });
  }
  console.log(
    JSON.stringify({
      ok: true,
      contract: "cartograph.remediation-suggestion-separation",
      cases: results,
      mutation: "none",
      staleDigests: "rejected",
      status: "unverified",
    }),
  );
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/remediation-separation.mjs validate [--root path]",
  );
  process.exit(2);
}

try {
  await validate();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`remediation separation validation failed: ${message}`);
  process.exit(1);
}
