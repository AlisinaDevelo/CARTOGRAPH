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
  "test/fixtures/policy-adr-bindings/scenarios.v0.1.json",
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
      "schema/policy-adr-binding-fixtures.v0.1.schema.json",
    ),
  );
  const reportSchema = readJson(
    resolve(repositoryRoot, "schema/policy-evaluation.v0.1.schema.json"),
  );
  const bindingSchema = readJson(
    resolve(repositoryRoot, "schema/policy-adr-binding.v0.1.schema.json"),
  );
  const exceptionSchema = readJson(
    resolve(repositoryRoot, "schema/policy-exception.v0.1.schema.json"),
  );
  const adrSchema = readJson(
    resolve(repositoryRoot, "schema/adr-reference.v0.1.schema.json"),
  );
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateFixture = ajv.compile(fixtureSchema);
  const validateReport = ajv.compile(reportSchema);
  const validateBinding = ajv.compile(bindingSchema);
  const validateException = ajv.compile(exceptionSchema);
  const validateAdr = ajv.compile(adrSchema);
  if (!validateFixture(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validateFixture.errors)}`,
    );
  const snapshot = GraphSnapshotSchema.parse(fixture.snapshot);
  const results = [];
  for (const definition of fixture.cases) {
    const policy = parsePolicyConfig(definition.policy);
    for (const binding of policy.adrBindings) {
      if (!validateBinding(binding))
        fail(
          `ADR binding schema validation failed for ${definition.id}: ${JSON.stringify(validateBinding.errors)}`,
        );
    }
    for (const exception of policy.exceptions) {
      if (
        exception &&
        typeof exception === "object" &&
        "contract" in exception
      ) {
        if (!validateException(exception))
          fail(
            `exception schema validation failed for ${definition.id}: ${JSON.stringify(validateException.errors)}`,
          );
      }
    }
    if (
      definition.adrDocument !== undefined &&
      !validateAdr(definition.adrDocument)
    )
      fail(
        `ADR document schema validation failed for ${definition.id}: ${JSON.stringify(validateAdr.errors)}`,
      );
    const options = {
      asOf: fixture.asOf ?? "2026-08-24T00:00:00.000Z",
      ...(definition.adrDocument === undefined
        ? {}
        : { adr: { document: definition.adrDocument } }),
    };
    const report = PolicyEvaluationSchema.parse(
      evaluatePolicyOnSnapshot(policy, snapshot, options),
    );
    if (!validateReport(report))
      fail(
        `evaluation schema failed for ${definition.id}: ${JSON.stringify(validateReport.errors)}`,
      );
    const violationIds = report.violations.map((finding) => finding.id);
    if (
      JSON.stringify(violationIds) !==
      JSON.stringify(definition.expected.violationIds)
    )
      fail(
        `case ${definition.id} expected violations ${JSON.stringify(definition.expected.violationIds)}, found ${JSON.stringify(violationIds)}`,
      );
    const suppressedIds = report.exceptions
      .filter((exception) => exception.suppresses)
      .map((exception) => exception.id);
    if (
      JSON.stringify(suppressedIds) !==
      JSON.stringify(definition.expected.suppressedIds)
    )
      fail(
        `case ${definition.id} expected suppressed exceptions ${JSON.stringify(definition.expected.suppressedIds)}, found ${JSON.stringify(suppressedIds)}`,
      );
    if (report.status !== definition.expected.status)
      fail(
        `case ${definition.id} expected status ${definition.expected.status}, found ${report.status}`,
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
      violations: violationIds,
      suppressed: suppressedIds,
    });
  }
  return {
    ok: true,
    fixtureId: fixture.fixtureId,
    cases: results,
    positiveCases: results.filter((result) => result.kind === "positive")
      .length,
    negativeCases: results.filter((result) => result.kind === "negative")
      .length,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/policy-adr-bindings.mjs validate",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`policy ADR binding validation failed: ${error.message}`);
  process.exit(1);
}
