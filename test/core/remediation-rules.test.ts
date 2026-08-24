import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  defaultRemediationRuleCatalog,
  generateDeterministicRemediationSuggestions,
  remediationRuleCatalogDigest,
  RemediationRuleCatalogSchema,
  REMEDIATION_RULESET_CONTRACT,
  REMEDIATION_RULESET_ID,
  REMEDIATION_RULESET_SCHEMA_VERSION,
  serializeRemediationRuleCatalog,
  serializeRemediationSuggestionReport,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixture = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "test/fixtures/remediation-rules/scenarios.v0.1.json",
    ),
    "utf8",
  ),
) as {
  baselineDigest: `sha256:${string}`;
  evidenceDigest: `sha256:${string}`;
};

const catalog = defaultRemediationRuleCatalog();

const findingFor = (entry: (typeof catalog.rules)[number], index: number) => ({
  findingId: `finding-${index}`,
  findingCode: entry.rule.findingCode,
  severity: "warning" as const,
  summary: `Finding for ${entry.rule.ruleId}`,
  baselineDigest: fixture.baselineDigest,
  evidenceDigest: fixture.evidenceDigest,
  evidence: [
    {
      id: `evidence-${index}`,
      kind: "review" as const,
      digest: fixture.evidenceDigest,
      reference: `graph://rule/${entry.rule.ruleId}`,
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
});

describe("deterministic remediation rules", () => {
  it("publishes six reviewed, bounded, read-only rules with stable metadata", () => {
    expect(catalog).toMatchObject({
      schemaVersion: REMEDIATION_RULESET_SCHEMA_VERSION,
      contract: REMEDIATION_RULESET_CONTRACT,
      catalogId: REMEDIATION_RULESET_ID,
    });
    expect(catalog.rules).toHaveLength(6);
    expect(
      catalog.rules.every((entry) => entry.reviewStatus === "reviewed"),
    ).toBe(true);
    expect(catalog.rules.every((entry) => entry.readOnly)).toBe(true);
    expect(
      new Set(catalog.rules.map((entry) => entry.rule.findingCode)).size,
    ).toBe(catalog.rules.length);
    expect(serializeRemediationRuleCatalog(catalog)).toBe(
      serializeRemediationRuleCatalog(defaultRemediationRuleCatalog()),
    );
    expect(remediationRuleCatalogDigest(catalog)).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
  });

  it("generates evidence-linked suggestions in a byte-stable order", () => {
    const findings = catalog.rules.map(findingFor);
    const currentEvidenceDigests = Object.fromEntries(
      findings.map((finding) => [finding.findingId, finding.evidenceDigest]),
    );
    const first = generateDeterministicRemediationSuggestions(findings, {
      enabled: true,
      currentBaselineDigest: fixture.baselineDigest,
      currentEvidenceDigests,
      catalog,
    });
    const second = generateDeterministicRemediationSuggestions(
      [...findings].reverse(),
      {
        enabled: true,
        currentBaselineDigest: fixture.baselineDigest,
        currentEvidenceDigests,
        catalog,
      },
    );

    expect(first.suggestions).toHaveLength(6);
    expect(first.skipped).toHaveLength(0);
    expect(serializeRemediationSuggestionReport(first)).toBe(
      serializeRemediationSuggestionReport(second),
    );
    expect(first.suggestions.map((suggestion) => suggestion.ruleId)).toEqual([
      "configuration-missing-boundary-review",
      "decision-reference-missing-review",
      "dependency-unresolved-review",
      "exception-expired-review",
      "ownership-missing-owner-review",
      "policy-unknown-edge-review",
    ]);
  });

  it("keeps negative golden cases stale instead of emitting guidance", () => {
    const entry = catalog.rules[0];
    if (!entry) throw new Error("catalog rule missing");
    const stale = findingFor(entry, 99);
    stale.baselineDigest =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const report = generateDeterministicRemediationSuggestions([stale], {
      enabled: true,
      currentBaselineDigest: fixture.baselineDigest,
      currentEvidenceDigests: { [stale.findingId]: stale.evidenceDigest },
      catalog,
    });
    expect(report.suggestions).toHaveLength(0);
    expect(report.skipped).toEqual([
      {
        findingId: stale.findingId,
        findingCode: stale.findingCode,
        reason: "stale-baseline",
      },
    ]);
  });

  it("keeps runtime and catalog JSON Schemas aligned", () => {
    expect(RemediationRuleCatalogSchema.parse(catalog)).toEqual(catalog);
    const schema = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "schema/remediation-rules.v0.1.schema.json"),
        "utf8",
      ),
    ) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(catalog)).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
