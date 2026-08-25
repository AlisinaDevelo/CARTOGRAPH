#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  evaluatePolicyOnSnapshot,
  PolicyEvaluationSchema,
  serializePolicyEvaluation,
} from "../src/core/index.ts";
import { parsePolicyConfig } from "../src/core/policy.ts";
import { GraphSnapshotSchema } from "../src/core/schemas.ts";

const repositoryRoot = resolve(process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/policy-exceptions/scenarios.v0.1.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(message);
};

const validate = () => {
  const fixture = readJson(fixturePath);
  const fixtureSchema = readJson(
    resolve(
      repositoryRoot,
      "schema/policy-exception-fixtures.v0.1.schema.json",
    ),
  );
  const reportSchema = readJson(
    resolve(repositoryRoot, "schema/policy-evaluation.v0.1.schema.json"),
  );
  const exceptionSchema = readJson(
    resolve(repositoryRoot, "schema/policy-exception.v0.1.schema.json"),
  );
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateFixture = ajv.compile(fixtureSchema);
  const validateReport = ajv.compile(reportSchema);
  const validateException = ajv.compile(exceptionSchema);
  if (!validateFixture(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validateFixture.errors)}`,
    );
  const snapshot = GraphSnapshotSchema.parse(fixture.snapshot);
  const results = [];
  for (const definition of fixture.cases) {
    const policy = parsePolicyConfig(definition.policy);
    for (const exception of policy.exceptions) {
      const valid = validateException(exception);
      const malformed =
        exception === null ||
        typeof exception !== "object" ||
        Array.isArray(exception) ||
        typeof exception.owner !== "string";
      if (!malformed && !valid)
        fail(
          `valid exception schema failed for ${definition.id}: ${JSON.stringify(validateException.errors)}`,
        );
    }
    const options = {
      asOf: fixture.asOf,
      expiringWithinDays: fixture.expiringWithinDays,
    };
    const report = PolicyEvaluationSchema.parse(
      evaluatePolicyOnSnapshot(policy, snapshot, options),
    );
    if (!validateReport(report))
      fail(
        `evaluation schema failed for ${definition.id}: ${JSON.stringify(validateReport.errors)}`,
      );
    const expected = definition.expected;
    const violationIds = report.violations.map((finding) => finding.id);
    if (JSON.stringify(violationIds) !== JSON.stringify(expected.violationIds))
      fail(
        `case ${definition.id} expected violations ${JSON.stringify(expected.violationIds)}, found ${JSON.stringify(violationIds)}`,
      );
    const statuses = report.exceptions.map((exception) => exception.status);
    if (JSON.stringify(statuses) !== JSON.stringify(expected.exceptionStatuses))
      fail(
        `case ${definition.id} expected exception statuses ${JSON.stringify(expected.exceptionStatuses)}, found ${JSON.stringify(statuses)}`,
      );
    const suppressedIds = report.exceptions
      .filter((exception) => exception.suppresses)
      .map((exception) => exception.id);
    if (
      JSON.stringify(suppressedIds) !== JSON.stringify(expected.suppressedIds)
    )
      fail(
        `case ${definition.id} expected suppressed exceptions ${JSON.stringify(expected.suppressedIds)}, found ${JSON.stringify(suppressedIds)}`,
      );
    if (report.status !== expected.status)
      fail(
        `case ${definition.id} expected status ${expected.status}, found ${report.status}`,
      );
    const serialized = serializePolicyEvaluation(report);
    const repeated = serializePolicyEvaluation(
      evaluatePolicyOnSnapshot(policy, snapshot, options),
    );
    if (serialized !== repeated)
      fail(
        `case ${definition.id} evaluation serialization is not deterministic`,
      );
    results.push({
      id: definition.id,
      kind: definition.kind,
      status: report.status,
      exceptions: report.exceptions.map((exception) => exception.status),
      suppressed: suppressedIds,
    });
  }
  return {
    ok: true,
    fixtureId: fixture.fixtureId,
    asOf: fixture.asOf,
    cases: results,
    positiveCases: results.filter((result) => result.kind === "positive")
      .length,
    negativeCases: results.filter((result) => result.kind === "negative")
      .length,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/policy-exceptions.mjs validate",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`policy exception validation failed: ${error.message}`);
  process.exit(1);
}
