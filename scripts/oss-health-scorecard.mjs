#!/usr/bin/env node
/* global URL, console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const CONTRACT = "cartograph.oss-health-scorecard";
const SCHEMA_VERSION = 1;
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/oss-health/scorecard.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/oss-health-scorecard.v0.1.schema.json",
);

const expectedDimensionIds = [
  "external-repository-runs",
  "repeat-non-maintainer-contributors",
  "release-stability",
  "issue-quality",
  "maintainer-load",
  "security-history",
  "retention-feedback",
  "adopter-feedback",
];

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
};

const stableStringify = (value) => JSON.stringify(stableValue(value));

const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const fail = (message) => {
  throw new Error(`${CONTRACT} validation failed: ${message}`);
};

const assertPublicText = (value, label) => {
  if (
    /(?:\/Users\/|\/home\/|password=|BEGIN (?:RSA|OPENSSH) PRIVATE KEY|gh[pous]_[A-Za-z0-9]+)/u.test(
      value,
    )
  )
    fail(`${label} contains a private path or secret marker`);
};

const validateSemantics = (fixture) => {
  if (fixture.contract !== CONTRACT || fixture.schemaVersion !== SCHEMA_VERSION)
    fail("contract or schema version drifted");
  if (fixture.asOf !== fixture.window.end)
    fail("asOf must match the snapshot window end");
  const windowStart = Date.parse(fixture.window.start);
  const windowEnd = Date.parse(fixture.window.end);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd))
    fail("snapshot window dates must be valid timestamps");
  if (windowStart >= windowEnd)
    fail("snapshot window must have a positive duration");

  const dimensionsById = new Map();
  const dimensionIds = fixture.dimensions.map((dimension) => dimension.id);
  if (stableStringify(dimensionIds) !== stableStringify(expectedDimensionIds))
    fail("scorecard dimensions must remain ordered and complete");
  for (const dimension of fixture.dimensions) {
    if (dimensionsById.has(dimension.id))
      fail(`duplicate scorecard dimension ${dimension.id}`);
    dimensionsById.set(dimension.id, dimension);
    assertPublicText(dimension.description, `dimension ${dimension.id}`);
    assertPublicText(dimension.collectionRule, `dimension ${dimension.id}`);
  }

  const observationsByDimension = new Map();
  const observationIds = new Set();
  for (const observation of fixture.observations) {
    if (observationIds.has(observation.id))
      fail(`duplicate scorecard observation ${observation.id}`);
    observationIds.add(observation.id);
    if (observationsByDimension.has(observation.dimensionId))
      fail(`duplicate observation for dimension ${observation.dimensionId}`);
    const dimension = dimensionsById.get(observation.dimensionId);
    if (!dimension)
      fail(`observation ${observation.id} references an unknown dimension`);
    if (observation.unit !== dimension.unit)
      fail(`observation ${observation.id} unit does not match its dimension`);
    observationsByDimension.set(observation.dimensionId, observation);
    for (const evidenceRef of observation.evidenceRefs)
      assertPublicText(evidenceRef, `observation ${observation.id} evidence`);
    for (const limitation of observation.limitations)
      assertPublicText(limitation, `observation ${observation.id} limitation`);

    if (observation.status === "not-observed") {
      if (
        observation.value !== null ||
        observation.denominator !== null ||
        observation.records.length !== 0 ||
        observation.claim !== "not-a-claim"
      )
        fail(
          `not-observed dimension ${observation.dimensionId} must not publish a value or claim`,
        );
    } else {
      if (
        typeof observation.value !== "number" ||
        !Number.isFinite(observation.value) ||
        observation.denominator === null ||
        observation.denominator < observation.value ||
        observation.claim !== "descriptive-only"
      )
        fail(
          `observed dimension ${observation.dimensionId} has invalid metrics`,
        );
    }

    if (observation.dimensionId !== "external-repository-runs") {
      if (observation.records.length !== 0)
        fail(
          `non-external dimension ${observation.dimensionId} has run records`,
        );
    } else if (observation.status !== "observed") {
      fail("external repository runs must retain an observed denominator");
    }
  }
  if (observationsByDimension.size !== expectedDimensionIds.length)
    fail("every scorecard dimension needs exactly one observation");

  const externalObservation = observationsByDimension.get(
    "external-repository-runs",
  );
  if (!externalObservation) fail("external repository observation is missing");
  const repositoryIds = new Set();
  for (const record of externalObservation.records) {
    if (repositoryIds.has(record.repositoryId))
      fail(`external repository is repeated: ${record.repositoryId}`);
    repositoryIds.add(record.repositoryId);
    assertPublicText(record.evidenceRef, `run ${record.repositoryId} evidence`);
  }
  const successfulRuns = externalObservation.records.filter(
    (record) => record.outcome === "successful",
  ).length;
  const boundedFailures = externalObservation.records.filter(
    (record) => record.outcome === "bounded-failure",
  ).length;
  if (externalObservation.value !== successfulRuns)
    fail("successful external repository count drifted");
  if (externalObservation.denominator !== externalObservation.records.length)
    fail("external repository denominator drifted");
  if (successfulRuns === 0 || boundedFailures === 0)
    fail("scorecard must retain successful runs and bounded failures");

  const requiredEvidence = fixture.strategyGate.requiredEvidence;
  if (
    stableStringify(requiredEvidence) !== stableStringify(expectedDimensionIds)
  )
    fail("strategy gate evidence requirements must cover every dimension");
  assertPublicText(fixture.strategyGate.reason, "strategy gate reason");

  const observedDimensionCount = fixture.observations.filter(
    (observation) => observation.status === "observed",
  ).length;
  const notObservedDimensionCount = fixture.observations.filter(
    (observation) => observation.status === "not-observed",
  ).length;
  if (
    fixture.summary.observedDimensionCount !== observedDimensionCount ||
    fixture.summary.notObservedDimensionCount !== notObservedDimensionCount ||
    fixture.summary.externalRepositoryCount !==
      externalObservation.records.length ||
    fixture.summary.successfulExternalRepositoryCount !== successfulRuns ||
    fixture.summary.boundedFailureExternalRepositoryCount !== boundedFailures
  )
    fail("scorecard summary counts drifted");
  if (
    fixture.scope.network ||
    fixture.scope.hiddenTelemetry ||
    fixture.scope.sourcePayloads ||
    fixture.summary.network ||
    fixture.summary.hiddenTelemetry ||
    fixture.summary.sourcePayloads ||
    fixture.summary.claimsPermitted ||
    fixture.strategyGate.tractionClaim !== "deferred" ||
    fixture.strategyGate.hostedInvestment !== "deferred"
  )
    fail("scorecard violates the transparent local-only strategy boundary");
};

export const validate = (fixturePath = defaultFixturePath) => {
  const fixture = readJson(fixturePath);
  const schema = readJson(schemaPath);
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(
    schema,
  );
  if (!validateSchema(fixture))
    fail(`schema validation failed: ${JSON.stringify(validateSchema.errors)}`);
  validateSemantics(fixture);
  const externalObservation = fixture.observations.find(
    (observation) => observation.dimensionId === "external-repository-runs",
  );
  return {
    ok: true,
    contract: CONTRACT,
    schemaVersion: SCHEMA_VERSION,
    asOf: fixture.asOf,
    dimensions: fixture.dimensions.length,
    observedDimensions: fixture.summary.observedDimensionCount,
    notObservedDimensions: fixture.summary.notObservedDimensionCount,
    externalRepositories: fixture.summary.externalRepositoryCount,
    successfulExternalRepositories:
      fixture.summary.successfulExternalRepositoryCount,
    boundedFailureExternalRepositories:
      fixture.summary.boundedFailureExternalRepositoryCount,
    records: externalObservation?.records.length ?? 0,
    tractionClaim: fixture.strategyGate.tractionClaim,
    hostedInvestment: fixture.strategyGate.hostedInvestment,
    network: false,
    hiddenTelemetry: false,
    digest: digest(stableStringify(fixture)),
  };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node scripts/oss-health-scorecard.mjs validate [--fixture path]",
    );
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(validate(argumentValue("--fixture"))));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
