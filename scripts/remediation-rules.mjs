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
    "test/fixtures/remediation-rules/scenarios.v0.1.json",
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
      "schema/remediation-rule-fixtures.v0.1.schema.json",
    ),
  );
  const catalogSchema = readJson(
    resolve(repositoryRoot, "schema/remediation-rules.v0.1.schema.json"),
  );
  const reportSchema = readJson(
    resolve(
      repositoryRoot,
      "schema/remediation-suggestion-report.v0.1.schema.json",
    ),
  );
  const ajv = new Ajv({ allErrors: true });
  const validateFixture = ajv.compile(fixtureSchema);
  const validateCatalog = ajv.compile(catalogSchema);
  const validateReport = ajv.compile(reportSchema);
  if (!validateFixture(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validateFixture.errors)}`,
    );

  const {
    defaultRemediationRuleCatalog,
    generateDeterministicRemediationSuggestions,
    remediationRuleCatalogDigest,
    REMEDIATION_RULESET_CONTRACT,
    REMEDIATION_RULESET_ID,
    REMEDIATION_RULESET_SCHEMA_VERSION,
    serializeRemediationRuleCatalog,
    serializeRemediationSuggestionReport,
  } = await import("../src/core/index.ts");

  const catalog = defaultRemediationRuleCatalog();
  if (!validateCatalog(catalog))
    fail(
      `catalog schema validation failed: ${JSON.stringify(validateCatalog.errors)}`,
    );
  if (
    catalog.rules.length < 6 ||
    catalog.rules.some((entry) => !entry.readOnly)
  )
    fail("reviewed catalog must contain at least six read-only rules");

  const staleBaselineDigest =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const makeFinding = (fixtureCase) => ({
    findingId: `finding-${fixtureCase.id}`,
    findingCode: fixtureCase.findingCode,
    severity: "warning",
    summary: `Golden ${fixtureCase.expectation} fixture for ${fixtureCase.ruleId}`,
    baselineDigest:
      fixtureCase.expectation === "negative"
        ? staleBaselineDigest
        : fixture.baselineDigest,
    evidenceDigest: fixture.evidenceDigest,
    evidence: [
      {
        id: `evidence-${fixtureCase.id}`,
        kind: "review",
        digest: fixture.evidenceDigest,
        reference: `graph://remediation-rule/${fixtureCase.ruleId}`,
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
    ambiguity: "clear",
    securitySensitive: false,
  });
  const currentEvidenceDigests = Object.fromEntries(
    fixture.cases.map((fixtureCase) => [
      `finding-${fixtureCase.id}`,
      fixture.evidenceDigest,
    ]),
  );
  const results = [];
  for (const fixtureCase of fixture.cases) {
    const report = generateDeterministicRemediationSuggestions(
      [makeFinding(fixtureCase)],
      {
        enabled: true,
        currentBaselineDigest: fixture.baselineDigest,
        currentEvidenceDigests,
        catalog,
      },
    );
    if (!validateReport(report))
      fail(
        `report schema validation failed for ${fixtureCase.id}: ${JSON.stringify(validateReport.errors)}`,
      );
    const actual =
      report.suggestions.length > 0 ? "positive" : report.skipped[0]?.reason;
    if (
      actual !==
      (fixtureCase.expectation === "positive"
        ? "positive"
        : fixtureCase.negativeReason)
    )
      fail(
        `fixture ${fixtureCase.id} expected ${fixtureCase.expectation}, found ${actual}`,
      );
    results.push({
      id: fixtureCase.id,
      expectation: fixtureCase.expectation,
      suggestions: report.suggestions.length,
      skipped: report.skipped.map((item) => item.reason),
    });
  }

  const positiveCases = fixture.cases.filter(
    (fixtureCase) => fixtureCase.expectation === "positive",
  );
  const firstOrder = positiveCases.map(makeFinding);
  const secondOrder = [...firstOrder].reverse();
  const firstReport = generateDeterministicRemediationSuggestions(firstOrder, {
    enabled: true,
    currentBaselineDigest: fixture.baselineDigest,
    currentEvidenceDigests,
    catalog,
  });
  const secondReport = generateDeterministicRemediationSuggestions(
    secondOrder,
    {
      enabled: true,
      currentBaselineDigest: fixture.baselineDigest,
      currentEvidenceDigests,
      catalog,
    },
  );
  if (
    serializeRemediationSuggestionReport(firstReport) !==
    serializeRemediationSuggestionReport(secondReport)
  )
    fail("deterministic rule output changed with input order");
  if (
    serializeRemediationRuleCatalog(catalog) !==
    serializeRemediationRuleCatalog(defaultRemediationRuleCatalog())
  )
    fail("default remediation rule catalog is not byte-stable");

  console.log(
    JSON.stringify({
      ok: true,
      schemaVersion: REMEDIATION_RULESET_SCHEMA_VERSION,
      contract: REMEDIATION_RULESET_CONTRACT,
      catalogId: REMEDIATION_RULESET_ID,
      catalogDigest: remediationRuleCatalogDigest(catalog),
      rules: catalog.rules.map((entry) => entry.rule.ruleId),
      cases: results,
    }),
  );
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/remediation-rules.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  await validate();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`remediation rule validation failed: ${message}`);
  process.exit(1);
}
