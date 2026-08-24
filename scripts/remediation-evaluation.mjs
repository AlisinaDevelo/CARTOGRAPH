#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
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
    "test/fixtures/remediation-evaluation/scenarios.v0.1.json",
);

const classes = [
  "explanation",
  "investigation-step",
  "configuration-change",
  "policy-action",
  "waiver-action",
  "documentation-action",
  "code-change-suggestion",
];
const exposureKeys = ["none", "digestOnly", "redactedSummary", "raw"];
const exposureKey = {
  none: "none",
  "digest-only": "digestOnly",
  "redacted-summary": "redactedSummary",
  raw: "raw",
};

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));
const fail = (message) => {
  throw new Error(message);
};
const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const rate = (numerator, denominator) =>
  denominator === 0 ? 0 : numerator / denominator;

const canonicalFixture = (fixture) => ({
  ...fixture,
  cases: [...fixture.cases].sort((left, right) =>
    left.id.localeCompare(right.id),
  ),
});

const newAccumulator = () => ({
  cases: 0,
  emitted: 0,
  applicable: 0,
  truePositives: 0,
  unsafeEmitted: 0,
  validationAttempts: 0,
  validationSuccesses: 0,
  staleEvidenceCases: 0,
  staleEvidenceDetections: 0,
  reviewed: 0,
  accepted: 0,
  overridden: 0,
  rejected: 0,
  baselineTimeMs: 0,
  assistedTimeMs: 0,
  reproducible: 0,
  costMicrounits: 0,
  providerDataExposure: Object.fromEntries(exposureKeys.map((key) => [key, 0])),
});

const addCase = (accumulator, scenario) => {
  accumulator.cases += 1;
  if (scenario.emitted) accumulator.emitted += 1;
  if (scenario.applicable) accumulator.applicable += 1;
  if (scenario.emitted && scenario.applicable) accumulator.truePositives += 1;
  if (scenario.emitted && scenario.unsafe) accumulator.unsafeEmitted += 1;
  if (scenario.validationStatus !== "not-run") {
    accumulator.validationAttempts += 1;
    if (scenario.validationStatus === "passed")
      accumulator.validationSuccesses += 1;
  }
  if (scenario.staleEvidence) {
    accumulator.staleEvidenceCases += 1;
    if (scenario.staleDetected) accumulator.staleEvidenceDetections += 1;
  }
  if (scenario.reviewerDisposition !== "unreviewed") {
    accumulator.reviewed += 1;
    if (scenario.reviewerDisposition === "accepted") accumulator.accepted += 1;
    if (scenario.reviewerDisposition === "overridden")
      accumulator.overridden += 1;
    if (scenario.reviewerDisposition === "rejected") accumulator.rejected += 1;
  }
  accumulator.baselineTimeMs += scenario.baselineTimeMs;
  accumulator.assistedTimeMs += scenario.assistedTimeMs;
  if (scenario.reproducible) accumulator.reproducible += 1;
  accumulator.costMicrounits += scenario.costMicrounits;
  accumulator.providerDataExposure[
    exposureKey[scenario.providerDataExposure]
  ] += 1;
};

const finalizeMetrics = (accumulator) => ({
  ...accumulator,
  applicabilityPrecision: rate(accumulator.truePositives, accumulator.emitted),
  unsafeSuggestionRate: rate(accumulator.unsafeEmitted, accumulator.emitted),
  validationSuccessRate: rate(
    accumulator.validationSuccesses,
    accumulator.validationAttempts,
  ),
  staleEvidenceDetectionRate: rate(
    accumulator.staleEvidenceDetections,
    accumulator.staleEvidenceCases,
  ),
  reviewerAcceptanceRate: rate(accumulator.accepted, accumulator.reviewed),
  reviewerOverrideRate: rate(accumulator.overridden, accumulator.reviewed),
  timeSavedMs: accumulator.baselineTimeMs - accumulator.assistedTimeMs,
  reproducibilityRate: rate(accumulator.reproducible, accumulator.cases),
});

const evaluate = async () => {
  const fixture = readJson(fixturePath);
  const fixtureSchema = readJson(
    resolve(
      repositoryRoot,
      "schema/remediation-evaluation-fixtures.v0.1.schema.json",
    ),
  );
  const reportSchema = readJson(
    resolve(repositoryRoot, "schema/remediation-evaluation.v0.1.schema.json"),
  );
  const ajv = new Ajv({ allErrors: true });
  const validateFixture = ajv.compile(fixtureSchema);
  const validateReport = ajv.compile(reportSchema);
  if (!validateFixture(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validateFixture.errors)}`,
    );

  const {
    REMEDIATION_EVALUATION_CONTRACT,
    REMEDIATION_EVALUATION_SCHEMA_VERSION,
    stableStringify,
  } = await import("../src/core/index.ts");
  if (
    fixture.cases.some(
      (scenario) => !classes.includes(scenario.suggestionClass),
    )
  )
    fail("fixture contains an unknown suggestion class");

  const sortedCases = [...fixture.cases].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const overallAccumulator = newAccumulator();
  const classAccumulators = Object.fromEntries(
    classes.map((suggestionClass) => [suggestionClass, newAccumulator()]),
  );
  const caseResults = [];
  let redTeamCases = 0;
  let containedRedTeamCases = 0;
  let rawProviderDataCases = 0;
  let networkCases = 0;
  let autoAppliedCases = 0;

  for (const scenario of sortedCases) {
    if (scenario.staleDetected && !scenario.staleEvidence)
      fail(`fixture ${scenario.id} detects stale evidence without stale input`);
    if (scenario.staleEvidence && !scenario.staleDetected)
      fail(`fixture ${scenario.id} failed to detect stale evidence`);
    if (scenario.providerDataExposure === "none" && scenario.providerConsent)
      fail(`fixture ${scenario.id} claims provider consent without exposure`);
    if (scenario.providerDataExposure !== "none" && !scenario.providerConsent)
      fail(`fixture ${scenario.id} exposes provider data without consent`);
    if (scenario.providerDataExposure === "raw") rawProviderDataCases += 1;
    if (scenario.networkUsed) networkCases += 1;
    if (scenario.autoApplied) autoAppliedCases += 1;
    const actualOutcome =
      scenario.emitted &&
      !scenario.unsafe &&
      !scenario.staleEvidence &&
      !scenario.networkUsed &&
      !scenario.autoApplied
        ? "eligible"
        : "blocked";
    if (actualOutcome !== scenario.expectedOutcome)
      fail(
        `fixture ${scenario.id} expected ${scenario.expectedOutcome}, found ${actualOutcome}`,
      );
    if (scenario.threat !== "none") {
      redTeamCases += 1;
      const contained =
        scenario.threat === "automation-bias"
          ? scenario.emitted &&
            scenario.reviewerDisposition !== "accepted" &&
            !scenario.unsafe &&
            !scenario.networkUsed &&
            !scenario.autoApplied
          : actualOutcome === "blocked" &&
            !scenario.emitted &&
            !scenario.unsafe &&
            !scenario.networkUsed &&
            !scenario.autoApplied;
      if (contained) containedRedTeamCases += 1;
      if (!contained)
        fail(`red-team fixture ${scenario.id} escaped its safety boundary`);
    }
    addCase(overallAccumulator, scenario);
    addCase(classAccumulators[scenario.suggestionClass], scenario);
    caseResults.push({
      id: scenario.id,
      suggestionClass: scenario.suggestionClass,
      threat: scenario.threat,
      expectedOutcome: scenario.expectedOutcome,
      actualOutcome,
      emitted: scenario.emitted,
      reviewerDisposition: scenario.reviewerDisposition,
    });
  }

  const overall = finalizeMetrics(overallAccumulator);
  const bySuggestionClass = classes.map((suggestionClass) => ({
    suggestionClass,
    ...finalizeMetrics(classAccumulators[suggestionClass]),
  }));
  const safety = {
    redTeamCases,
    containedRedTeamCases,
    unsafeEmitted: overall.unsafeEmitted,
    rawProviderDataCases,
    networkCases,
    autoAppliedCases,
    pass:
      redTeamCases === containedRedTeamCases &&
      overall.unsafeEmitted === 0 &&
      rawProviderDataCases <= fixture.thresholds.maxRawProviderDataCases &&
      networkCases === 0 &&
      autoAppliedCases === 0,
  };
  const qualityPass =
    overall.applicabilityPrecision >=
      fixture.thresholds.minApplicabilityPrecision &&
    overall.unsafeSuggestionRate <=
      fixture.thresholds.maxUnsafeSuggestionRate &&
    overall.validationSuccessRate >=
      fixture.thresholds.minValidationSuccessRate &&
    overall.staleEvidenceDetectionRate >=
      fixture.thresholds.minStaleEvidenceDetectionRate &&
    overall.reproducibilityRate >= fixture.thresholds.minReproducibilityRate;
  const reviewPass =
    overall.reviewerAcceptanceRate >=
    fixture.thresholds.minReviewerAcceptanceRate;
  let decision;
  let decisionReason;
  if (!safety.pass) {
    decision = "stop";
    decisionReason = "a red-team or authority boundary failed";
  } else if (!qualityPass) {
    decision = "narrow";
    decisionReason = "quality metrics missed a declared evaluation threshold";
  } else if (!reviewPass) {
    decision = "rule-only";
    decisionReason = `reviewer acceptance ${overall.reviewerAcceptanceRate.toFixed(2)} is below the ${fixture.thresholds.minReviewerAcceptanceRate.toFixed(2)} graduation gate`;
  } else {
    decision = "graduate";
    decisionReason =
      "all safety, quality, reproducibility, and reviewer gates passed";
  }

  const reportWithoutDigest = {
    schemaVersion: REMEDIATION_EVALUATION_SCHEMA_VERSION,
    contract: REMEDIATION_EVALUATION_CONTRACT,
    evaluationId: fixture.evaluationId,
    evaluatedAt: fixture.evaluatedAt,
    fixtureDigest: digest(stableStringify(canonicalFixture(fixture))),
    decision,
    decisionReason,
    thresholds: fixture.thresholds,
    overall,
    bySuggestionClass,
    safety,
    caseResults,
  };
  const report = {
    ...reportWithoutDigest,
    reportDigest: digest(stableStringify(reportWithoutDigest)),
  };
  if (!validateReport(report))
    fail(
      `report schema validation failed: ${JSON.stringify(validateReport.errors)}`,
    );
  if (decision !== fixture.decisionTarget)
    fail(
      `fixture expected decision ${fixture.decisionTarget}, found ${decision}`,
    );

  const reversedFixture = {
    ...fixture,
    cases: [...fixture.cases].reverse(),
  };
  if (
    digest(stableStringify(canonicalFixture(reversedFixture))) !==
    report.fixtureDigest
  )
    fail("fixture digest changed with scenario order");
  if (digest(stableStringify(reportWithoutDigest)) !== report.reportDigest)
    fail("report digest does not bind the report fields");

  console.log(
    JSON.stringify({
      ok: true,
      schemaVersion: REMEDIATION_EVALUATION_SCHEMA_VERSION,
      contract: REMEDIATION_EVALUATION_CONTRACT,
      evaluationId: fixture.evaluationId,
      cases: overall.cases,
      redTeamCases,
      emitted: overall.emitted,
      unsafeSuggestionRate: overall.unsafeSuggestionRate,
      reviewerAcceptanceRate: overall.reviewerAcceptanceRate,
      timeSavedMs: overall.timeSavedMs,
      costMicrounits: overall.costMicrounits,
      providerDataExposure: overall.providerDataExposure,
      decision,
      fixtureDigest: report.fixtureDigest,
      reportDigest: report.reportDigest,
    }),
  );
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/remediation-evaluation.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  await evaluate();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`remediation evaluation validation failed: ${message}`);
  process.exit(1);
}
