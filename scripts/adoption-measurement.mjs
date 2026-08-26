#!/usr/bin/env node
/* global URL, console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const CONTRACT = "cartograph.adoption-measurement";
const SCHEMA_VERSION = 1;
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/adoption-measurement/protocol.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/adoption-measurement.v0.1.schema.json",
);

const expectedSourceKinds = [
  "public-report",
  "public-issue",
  "public-pr",
  "release-metadata",
  "manual-repository-run",
  "consented-summary",
];

const expectedMetricIds = [
  "opt-in-public-reports",
  "issue-template-signals",
  "release-metadata-events",
  "manual-repository-runs",
  "repeat-consented-runs",
  "consented-feedback-records",
];

const expectedBiasIds = [
  "public-selection",
  "survivorship",
  "self-reporting",
  "revision-drift",
  "small-cells",
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

const requireOrdered = (actual, expected, label) => {
  if (stableStringify(actual) !== stableStringify(expected))
    fail(`${label} must remain ordered and complete`);
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
  if (Date.parse(fixture.decision.nextReview) <= windowEnd)
    fail("next review must be after the current snapshot");

  requireOrdered(
    fixture.scope.allowedSources,
    expectedSourceKinds,
    "allowed adoption evidence sources",
  );

  const metricsById = new Map();
  const metricIds = fixture.metricCatalog.map((metric) => metric.id);
  requireOrdered(metricIds, expectedMetricIds, "adoption metrics");
  for (const metric of fixture.metricCatalog) {
    if (metricsById.has(metric.id))
      fail(`duplicate adoption metric ${metric.id}`);
    metricsById.set(metric.id, metric);
    if (!metric.sourceKinds.every((kind) => expectedSourceKinds.includes(kind)))
      fail(`metric ${metric.id} uses an unsupported source kind`);
    assertPublicText(metric.description, `metric ${metric.id}`);
    assertPublicText(metric.collectionRule, `metric ${metric.id}`);
  }

  const observationsByMetric = new Map();
  const observationIds = new Set();
  const recordIds = new Set();
  let recordCount = 0;
  let publicRecordCount = 0;
  let consentedRecordCount = 0;
  for (const observation of fixture.observations) {
    if (observationIds.has(observation.id))
      fail(`duplicate adoption observation ${observation.id}`);
    observationIds.add(observation.id);
    if (observationsByMetric.has(observation.metricId))
      fail(`duplicate observation for ${observation.metricId}`);
    const metric = metricsById.get(observation.metricId);
    if (!metric)
      fail(`observation ${observation.id} references an unknown metric`);
    observationsByMetric.set(observation.metricId, observation);
    if (
      !observation.sourceKinds.every((kind) =>
        metric.sourceKinds.includes(kind),
      )
    )
      fail(
        `observation ${observation.id} uses a source outside its metric rule`,
      );
    for (const evidenceRef of observation.evidenceRefs)
      assertPublicText(evidenceRef, `observation ${observation.id} evidence`);
    for (const limitation of observation.limitations)
      assertPublicText(limitation, `observation ${observation.id} limitation`);

    const observedRecordKinds = new Set();
    for (const record of observation.records) {
      if (recordIds.has(record.id))
        fail(`duplicate adoption record ${record.id}`);
      recordIds.add(record.id);
      recordCount += 1;
      observedRecordKinds.add(record.sourceKind);
      assertPublicText(record.reference, `record ${record.id} reference`);
      if (!metric.sourceKinds.includes(record.sourceKind))
        fail(`record ${record.id} is outside metric ${metric.id}`);
      if (record.authorization === "public-opt-in") publicRecordCount += 1;
      if (record.authorization === "explicit-consent")
        consentedRecordCount += 1;
      if (
        record.sourceKind === "consented-summary" &&
        record.authorization !== "explicit-consent"
      )
        fail(`consented summary ${record.id} requires explicit consent`);
      if (record.sourceKind === "manual-repository-run" && !record.reproducible)
        fail(`manual repository run ${record.id} must be reproducible`);
      if (
        !record.anonymized ||
        record.sourcePayloadRetained ||
        record.rawInputRetained
      )
        fail(`record ${record.id} violates the aggregate-only boundary`);
    }
    if (observation.records.length > 0) {
      requireOrdered(
        [...observedRecordKinds].sort(),
        [...observation.sourceKinds].sort(),
        `observation ${observation.id} source kinds`,
      );
    } else if (observation.sourceKinds.length !== 0) {
      fail(
        `unobserved metric ${observation.metricId} cannot publish source kinds`,
      );
    }

    if (observation.status === "not-observed") {
      if (
        observation.value !== null ||
        observation.denominator !== null ||
        observation.records.length !== 0 ||
        observation.claim !== "not-a-claim"
      )
        fail(
          `not-observed metric ${observation.metricId} must not publish a value`,
        );
    } else if (observation.status === "suppressed") {
      if (
        observation.value !== null ||
        observation.denominator !== null ||
        observation.records.length !== 0 ||
        observation.claim !== "deferred"
      )
        fail(`suppressed metric ${observation.metricId} must be deferred`);
    } else if (
      typeof observation.value !== "number" ||
      !Number.isFinite(observation.value) ||
      observation.value < 0 ||
      observation.denominator === null ||
      observation.denominator < observation.value ||
      observation.denominator < observation.records.length ||
      observation.records.length === 0 ||
      !["descriptive-only", "technical-sample-only"].includes(observation.claim)
    ) {
      fail(`observed metric ${observation.metricId} has invalid evidence`);
    }
  }
  requireOrdered(
    [...observationsByMetric.keys()],
    expectedMetricIds,
    "adoption observations",
  );

  requireOrdered(
    fixture.sampling.biases.map((bias) => bias.id),
    expectedBiasIds,
    "sampling bias controls",
  );
  for (const bias of fixture.sampling.biases) {
    assertPublicText(bias.description, `sampling bias ${bias.id}`);
    assertPublicText(bias.effect, `sampling bias ${bias.id}`);
    assertPublicText(bias.mitigation, `sampling bias ${bias.id}`);
  }
  for (const exclusion of fixture.sampling.exclusions)
    assertPublicText(exclusion, "sampling exclusion");
  assertPublicText(fixture.sampling.reviewCadence, "sampling review cadence");
  assertPublicText(
    fixture.sampling.minimumEvidence,
    "sampling minimum evidence",
  );

  assertPublicText(
    fixture.retention.withdrawalRule,
    "retention withdrawal rule",
  );
  assertPublicText(fixture.deletion.requestRoute, "deletion request route");
  assertPublicText(fixture.deletion.verification, "deletion verification");
  for (const responsibility of fixture.deletion.responsibilities) {
    assertPublicText(
      responsibility.action,
      `${responsibility.actor} deletion action`,
    );
    assertPublicText(
      responsibility.verification,
      `${responsibility.actor} deletion verification`,
    );
  }
  requireOrdered(
    fixture.deletion.responsibilities.map(
      (responsibility) => responsibility.actor,
    ),
    ["evidence-publisher", "CARTOGRAPH-maintainer", "release-owner"],
    "deletion responsibilities",
  );
  for (const exception of fixture.deletion.exceptions)
    assertPublicText(exception, "deletion exception");
  assertPublicText(fixture.anonymization.review, "anonymization review");
  assertPublicText(fixture.decision.rationale, "adoption decision rationale");
  for (const requirement of fixture.decision.requiredBeforeChange)
    assertPublicText(requirement, "adoption decision requirement");
  assertPublicText(fixture.provenance.source, "adoption provenance source");
  assertPublicText(
    fixture.provenance.reference,
    "adoption provenance reference",
  );
  assertPublicText(
    fixture.provenance.transformation,
    "adoption provenance transformation",
  );

  const observedMetrics = fixture.observations.filter(
    (observation) => observation.status === "observed",
  ).length;
  const notObservedMetrics = fixture.observations.filter(
    (observation) => observation.status === "not-observed",
  ).length;
  const suppressedMetrics = fixture.observations.filter(
    (observation) => observation.status === "suppressed",
  ).length;
  if (
    fixture.summary.metricCount !== fixture.metricCatalog.length ||
    fixture.summary.observedMetrics !== observedMetrics ||
    fixture.summary.notObservedMetrics !== notObservedMetrics ||
    fixture.summary.suppressedMetrics !== suppressedMetrics ||
    fixture.summary.recordCount !== recordCount ||
    fixture.summary.publicRecords !== publicRecordCount ||
    fixture.summary.consentedRecords !== consentedRecordCount
  )
    fail("adoption summary counts drifted");
  if (
    fixture.summary.adoptionClaim !== "deferred" ||
    fixture.scope.hiddenTelemetry ||
    fixture.scope.network ||
    fixture.scope.sourceUpload ||
    fixture.scope.rawInputsRetained ||
    fixture.scope.personalData
  )
    fail("adoption measurement violates the local-only privacy boundary");
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
  return {
    ok: true,
    contract: CONTRACT,
    schemaVersion: SCHEMA_VERSION,
    protocolId: fixture.protocolId,
    metrics: fixture.summary.metricCount,
    observedMetrics: fixture.summary.observedMetrics,
    notObservedMetrics: fixture.summary.notObservedMetrics,
    records: fixture.summary.recordCount,
    publicRecords: fixture.summary.publicRecords,
    consentedRecords: fixture.summary.consentedRecords,
    adoptionClaim: fixture.summary.adoptionClaim,
    hiddenTelemetry: false,
    network: false,
    sourceUpload: false,
    digest: digest(stableStringify(fixture)),
  };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node scripts/adoption-measurement.mjs validate [--fixture path]",
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
