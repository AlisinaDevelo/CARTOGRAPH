#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  parseFindingLifecycleInput,
  replayFindingLifecycle,
  serializeFindingLifecycleReport,
  stableStringify,
} from "../src/core/index.ts";

const CONTRACT = "cartograph.finding-lifecycle";
const SCHEMA_VERSION = 1;
const repositoryRoot = resolve(process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  process.argv.includes("--fixture")
    ? process.argv[process.argv.indexOf("--fixture") + 1]
    : "test/fixtures/finding-lifecycle/replay.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/finding-lifecycle.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(`${CONTRACT} validation failed: ${message}`);
};
const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const validate = () => {
  const fixture = readJson(fixturePath);
  const schema = readJson(schemaPath);
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(fixture))
    fail(`schema validation failed: ${JSON.stringify(validateSchema.errors)}`);
  if (fixture.contract !== CONTRACT || fixture.schemaVersion !== SCHEMA_VERSION)
    fail("fixture contract or version drifted");
  if (
    fixture.method.network ||
    fixture.method.sourceBodiesIncluded ||
    fixture.method.credentialsUsed ||
    fixture.method.hiddenTelemetry ||
    !fixture.method.appendOnly
  )
    fail("fixture violates the offline append-only boundary");

  const input = parseFindingLifecycleInput(fixture.input);
  const report = replayFindingLifecycle(input);
  if (
    stableStringify(report) !== stableStringify(replayFindingLifecycle(input))
  )
    fail("lifecycle replay is not deterministic");
  const serialized = serializeFindingLifecycleReport(report);
  if (serialized !== serializeFindingLifecycleReport(JSON.parse(serialized)))
    fail("lifecycle report serialization is not byte-stable");
  if (
    stableStringify(report.summary) !==
    stableStringify(fixture.expected.summary)
  )
    fail(
      `summary drifted: expected ${JSON.stringify(fixture.expected.summary)}, found ${JSON.stringify(report.summary)}`,
    );

  const states = Object.fromEntries(
    report.findings.map((finding) => [finding.findingId, finding.state]),
  );
  if (stableStringify(states) !== stableStringify(fixture.expected.states))
    fail(
      `states drifted: expected ${JSON.stringify(fixture.expected.states)}, found ${JSON.stringify(states)}`,
    );
  const eventIds = Object.fromEntries(
    report.findings.map((finding) => [finding.findingId, finding.eventIds]),
  );
  if (stableStringify(eventIds) !== stableStringify(fixture.expected.eventIds))
    fail(
      `event replay drifted: expected ${JSON.stringify(fixture.expected.eventIds)}, found ${JSON.stringify(eventIds)}`,
    );
  const diagnosticCodes = report.diagnostics
    .map((diagnostic) => diagnostic.code)
    .sort();
  if (
    stableStringify(diagnosticCodes) !==
    stableStringify(fixture.expected.diagnosticCodes)
  )
    fail(
      `diagnostics drifted: expected ${JSON.stringify(fixture.expected.diagnosticCodes)}, found ${JSON.stringify(diagnosticCodes)}`,
    );

  const tamperedInput = JSON.parse(JSON.stringify(input));
  const tamperedEvent = tamperedInput.events.find(
    (event) => event.id === "event-api-ack",
  );
  if (!tamperedEvent) fail("tamper fixture setup");
  tamperedEvent.digest = digest("tampered-event");
  const tamperedReport = replayFindingLifecycle(tamperedInput);
  if (
    !tamperedReport.diagnostics.some(
      (diagnostic) => diagnostic.code === fixture.expected.tamperDiagnostic,
    )
  )
    fail("tampered event was not rejected with an explicit diagnostic");

  return {
    ok: true,
    contract: CONTRACT,
    schemaVersion: SCHEMA_VERSION,
    fixtureId: fixture.fixtureId,
    summary: report.summary,
    states,
    diagnosticCodes,
    tamperDiagnostic: fixture.expected.tamperDiagnostic,
    appendOnly: report.provenance.appendOnly,
    sourceBodiesIncluded: report.provenance.sourceBodiesIncluded,
    network: false,
    digest: digest(serialized),
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/finding-lifecycle.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`${CONTRACT} validation failed: ${error.message}`);
  process.exit(1);
}
