#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  argumentValue("--fixture") ??
    "test/fixtures/remediation-suggestions/scenarios.v0.1.json",
);

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));

const fail = (message) => {
  throw new Error(message);
};

const validate = async () => {
  const fixture = readJson(fixturePath);
  const fixtureSchema = readJson(
    resolve(
      repositoryRoot,
      "schema/remediation-suggestion-fixtures.v0.1.schema.json",
    ),
  );
  const suggestionSchema = readJson(
    resolve(repositoryRoot, "schema/remediation-suggestion.v0.1.schema.json"),
  );
  const reportSchema = readJson(
    resolve(
      repositoryRoot,
      "schema/remediation-suggestion-report.v0.1.schema.json",
    ),
  );
  const ajv = new Ajv({ allErrors: true });
  const validateFixture = ajv.compile(fixtureSchema);
  const validateSuggestion = ajv.compile(suggestionSchema);
  const validateReport = ajv.compile(reportSchema);
  if (!validateFixture(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validateFixture.errors)}`,
    );

  const {
    REMEDIATION_SUGGESTION_CONTRACT,
    REMEDIATION_SUGGESTION_SCHEMA_VERSION,
    generateRemediationSuggestions,
  } = await import("../src/core/index.ts");

  const evidenceDigest =
    "sha256:3e2d9a1a2c5b4d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6";
  const staleEvidenceDigest =
    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  const staleBaselineDigest =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const makeFinding = (scenario, id = `finding-${scenario}`) => ({
    findingId: id,
    findingCode:
      scenario === "unsupported"
        ? "future.unsupported-rule"
        : "policy.unknown-edge",
    severity: "warning",
    summary: `Synthetic ${scenario} finding`,
    baselineDigest:
      scenario === "stale-baseline"
        ? staleBaselineDigest
        : fixture.baselineDigest,
    evidenceDigest:
      scenario === "stale-evidence" ? staleEvidenceDigest : evidenceDigest,
    evidence: [
      {
        id: `evidence-${scenario}`,
        kind: "policy",
        digest: evidenceDigest,
        reference: `graph://diagnostic/${id}`,
      },
    ],
    inputs: [
      {
        name: "baseline",
        reference: ".cartograph/baseline.json",
        valueDigest: fixture.baselineDigest,
      },
    ],
    ownerId: scenario === "ownerless" ? null : "team-architecture",
    ambiguity: scenario === "ambiguous" ? "ambiguous" : "clear",
    securitySensitive: scenario === "security-sensitive",
  });
  const rule = {
    ruleId: "policy-unknown-edge-review",
    findingCode: "policy.unknown-edge",
    kind: "configuration-change",
    title: "Review the unknown-edge policy boundary",
    rationale:
      "The policy finding indicates an edge that needs a bounded configuration review before any edit is considered.",
    proposal: {
      operation: "configure",
      description:
        "Prepare a human-reviewed policy configuration change; do not apply it automatically.",
      targets: [".cartograph/policy.json"],
      edits: [
        {
          target: ".cartograph/policy.json",
          change:
            "Review the unknown-edge rule and propose an explicit allow or deny entry.",
          reversible: true,
        },
      ],
    },
    confidence: 0.72,
    assumptions: [
      "The current policy baseline remains authoritative for review.",
    ],
    risk: "medium",
    validationPlan: [
      {
        id: "policy-diff",
        action: "Compare the proposed policy change with the current baseline.",
        expected:
          "The comparison is deterministic and does not change graph or policy truth.",
      },
    ],
  };
  const currentEvidenceDigests = Object.fromEntries(
    Object.keys(fixture.evidenceDigests).map((id) => [id, evidenceDigest]),
  );
  const results = [];
  for (const scenario of fixture.cases) {
    const findings =
      scenario.scenario === "resource-limit"
        ? [
            makeFinding("resource-a", "finding-resource-a"),
            makeFinding("resource-b", "finding-resource-b"),
          ]
        : [makeFinding(scenario.scenario)];
    const report = generateRemediationSuggestions(findings, {
      enabled: true,
      currentBaselineDigest: fixture.baselineDigest,
      currentEvidenceDigests,
      rules: [rule],
      maxSuggestions: scenario.scenario === "resource-limit" ? 1 : 32,
    });
    if (!validateReport(report))
      fail(
        `report schema validation failed for ${scenario.id}: ${JSON.stringify(validateReport.errors)}`,
      );
    for (const suggestion of report.suggestions) {
      if (!validateSuggestion(suggestion))
        fail(
          `suggestion schema validation failed for ${scenario.id}: ${JSON.stringify(validateSuggestion.errors)}`,
        );
      if (suggestion.status !== "unverified" || !suggestion.readOnly)
        fail(
          `suggestion ${scenario.id} was not explicitly unverified/read-only`,
        );
    }
    const actual =
      report.skipped[0]?.reason ??
      (report.suggestions.length > 0 ? "suggestion" : undefined);
    if (actual !== scenario.expected)
      fail(
        `fixture ${scenario.id} expected ${scenario.expected}, found ${actual}`,
      );
    results.push({
      id: scenario.id,
      mode: report.mode,
      suggestions: report.suggestions.length,
      skipped: report.skipped.map((item) => item.reason),
    });
  }

  const disabled = generateRemediationSuggestions([makeFinding("supported")], {
    rules: [rule],
  });
  if (
    !validateReport(disabled) ||
    disabled.mode !== "disabled" ||
    disabled.suggestions.length !== 0
  )
    fail("default remediation generation must be disabled and empty");

  console.log(
    JSON.stringify({
      ok: true,
      schemaVersion: REMEDIATION_SUGGESTION_SCHEMA_VERSION,
      contract: REMEDIATION_SUGGESTION_CONTRACT,
      cases: results,
      defaultMode: disabled.mode,
    }),
  );
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/remediation-suggestions.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  await validate();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`remediation suggestion validation failed: ${message}`);
  process.exit(1);
}
