#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  OWNERSHIP_WAIVER_DRIFT_CONTRACT,
  OWNERSHIP_WAIVER_DRIFT_SCHEMA_VERSION,
  evaluateOwnershipWaiverDrift,
  serializeOwnershipWaiverDriftReport,
} from "../src/core/index.ts";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  argumentValue("--fixture") ??
    "test/fixtures/ownership-waiver-drift/scenarios.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/ownership-waiver-drift-fixtures.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const sortedUnique = (values) => [...new Set(values)].sort();
const fail = (message) => {
  throw new Error(
    `${OWNERSHIP_WAIVER_DRIFT_CONTRACT} validation failed: ${message}`,
  );
};

const validate = () => {
  const fixture = readJson(fixturePath);
  const schema = readJson(schemaPath);
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  if (
    fixture.contract !== OWNERSHIP_WAIVER_DRIFT_CONTRACT ||
    fixture.schemaVersion !== OWNERSHIP_WAIVER_DRIFT_SCHEMA_VERSION
  )
    fail("fixture contract or version drifted");
  if (
    fixture.method.network ||
    fixture.method.sourceBodiesIncluded ||
    fixture.method.credentialsUsed ||
    fixture.method.hiddenTelemetry ||
    !fixture.method.appendOnly ||
    !fixture.method.authorityFree
  )
    fail("fixture violates the offline append-only authority-free boundary");

  const results = [];
  for (const scenario of fixture.scenarios) {
    const report = evaluateOwnershipWaiverDrift(scenario.input);
    const expected = scenario.expected;
    const codes = sortedUnique(
      report.diagnostics.map((diagnostic) => diagnostic.code),
    );
    if (report.status !== expected.status)
      fail(
        `scenario ${scenario.id} status drifted: expected ${expected.status}, found ${report.status}`,
      );
    if (
      JSON.stringify(codes) !==
      JSON.stringify(sortedUnique(expected.diagnosticCodes))
    )
      fail(
        `scenario ${scenario.id} diagnostic codes drifted: expected ${JSON.stringify(expected.diagnosticCodes)}, found ${JSON.stringify(codes)}`,
      );
    if (JSON.stringify(report.summary) !== JSON.stringify(expected.summary))
      fail(
        `scenario ${scenario.id} summary drifted: expected ${JSON.stringify(expected.summary)}, found ${JSON.stringify(report.summary)}`,
      );
    const trailIds = new Set(report.decisionTrail.map((entry) => entry.id));
    for (const required of expected.trailIncludes) {
      if (!trailIds.has(required))
        fail(`scenario ${scenario.id} decision trail lost ${required}`);
    }
    if (
      report.provenance.network ||
      report.provenance.sourceBodiesIncluded ||
      report.provenance.privateKeysIncluded ||
      report.provenance.authorityGranted ||
      report.provenance.autoExtended ||
      !report.provenance.deterministic
    )
      fail(`scenario ${scenario.id} provenance boundary drifted`);
    const serialized = serializeOwnershipWaiverDriftReport(report);
    if (
      serialized !== serializeOwnershipWaiverDriftReport(JSON.parse(serialized))
    )
      fail(`scenario ${scenario.id} report serialization is not byte-stable`);
    if (
      serialized.includes('"privateKey"') ||
      serialized.includes('"signature"')
    )
      fail(`scenario ${scenario.id} report leaked signing material`);
    const replay = evaluateOwnershipWaiverDrift(scenario.input);
    if (serializeOwnershipWaiverDriftReport(replay) !== serialized)
      fail(`scenario ${scenario.id} evaluation is not deterministic`);
    results.push({
      id: scenario.id,
      status: report.status,
      diagnosticCodes: codes,
      summary: report.summary,
      decisionTrail: report.decisionTrail.length,
    });
  }
  return {
    ok: true,
    contract: OWNERSHIP_WAIVER_DRIFT_CONTRACT,
    schemaVersion: OWNERSHIP_WAIVER_DRIFT_SCHEMA_VERSION,
    fixtureId: fixture.fixtureId,
    scenarios: results,
    offline: true,
    privateKeysIncluded: false,
    authorityGranted: false,
    autoExtended: false,
    digest: digest(JSON.stringify(results)),
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node scripts/ownership-waiver-drift.mjs validate [--root path] [--fixture path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
