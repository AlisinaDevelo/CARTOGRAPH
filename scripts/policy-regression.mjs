#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  diffGraphSnapshots,
  evaluatePolicy,
  GraphSnapshotSchema,
  PolicyEvaluationSchema,
  parsePolicyConfig,
  stableStringify,
  serializePolicyEvaluation,
} from "../src/core/index.ts";

const repositoryRoot = resolve(process.cwd());
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/policy-regression.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/policy-regression.v0.1.schema.json",
);

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const readJson = (filePath) =>
  JSON.parse(readFileSync(resolve(filePath), "utf8"));

const fail = (message) => {
  throw new Error(message);
};

const requireRecord = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
};

const requireString = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
};

const idsEqual = (left, right) =>
  stableStringify(left) === stableStringify(right);

const validateFixtureShape = (fixture) => {
  const schema = readJson(fixtureSchemaPath);
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(
    schema,
  );
  if (!validateSchema(fixture)) {
    fail(
      `policy regression fixture schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }
  requireString(fixture.fixtureId, "fixtureId");
  const snapshots = requireRecord(fixture.snapshots, "snapshots");
  for (const [snapshotId, snapshot] of Object.entries(snapshots)) {
    try {
      GraphSnapshotSchema.parse(snapshot);
    } catch (error) {
      fail(`snapshot ${snapshotId} is invalid: ${error.message}`);
    }
  }
  const diffs = requireRecord(fixture.diffs, "diffs");
  for (const [diffId, diff] of Object.entries(diffs)) {
    requireRecord(diff, `diff ${diffId}`);
    requireString(diff.before, `diff ${diffId}.before`);
    requireString(diff.after, `diff ${diffId}.after`);
    if (!(diff.before in snapshots) || !(diff.after in snapshots)) {
      fail(`diff ${diffId} references an unknown snapshot`);
    }
  }
  if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    fail("policy regression fixture must contain at least one case");
  }
  return { snapshots, diffs };
};

const inputForCase = (fixture, indexes, definition) => {
  const input = requireRecord(definition.input, `case ${definition.id}.input`);
  const kind = requireString(input.kind, `case ${definition.id}.input.kind`);
  const reference = requireString(input.ref, `case ${definition.id}.input.ref`);
  if (kind === "snapshot") {
    if (!(reference in indexes.snapshots)) {
      fail(`case ${definition.id} references unknown snapshot ${reference}`);
    }
    return {
      kind,
      snapshot: GraphSnapshotSchema.parse(indexes.snapshots[reference]),
    };
  }
  if (kind === "diff") {
    const diffDefinition = indexes.diffs[reference];
    if (diffDefinition === undefined) {
      fail(`case ${definition.id} references unknown diff ${reference}`);
    }
    return {
      kind,
      diff: diffGraphSnapshots(
        indexes.snapshots[diffDefinition.before],
        indexes.snapshots[diffDefinition.after],
      ),
    };
  }
  fail(`case ${definition.id} has unsupported input kind ${kind}`);
};

const checkFinding = (actual, check, caseId, counters, errors) => {
  const finding =
    check.kind === "violation"
      ? actual.violations.find((candidate) => candidate.id === check.id)
      : actual.unsupported.find((candidate) => candidate.id === check.id);
  if (finding === undefined) {
    errors.push(`case ${caseId} is missing expected ${check.kind} ${check.id}`);
    if (check.reasonIncludes !== undefined)
      counters.explanationRegressions += 1;
    if ((check.evidenceIncludes ?? []).length > 0)
      counters.evidenceRegressions += 1;
    return;
  }
  if (
    check.reasonIncludes !== undefined &&
    !finding.reason.includes(check.reasonIncludes)
  ) {
    counters.explanationRegressions += 1;
    errors.push(
      `case ${caseId} explanation drift for ${check.id}: expected text ${JSON.stringify(check.reasonIncludes)}`,
    );
  }
  const missingEvidence = (check.evidenceIncludes ?? []).filter(
    (reference) => !finding.evidenceRefs.includes(reference),
  );
  if (missingEvidence.length > 0) {
    counters.evidenceRegressions += 1;
    errors.push(
      `case ${caseId} evidence drift for ${check.id}: missing ${missingEvidence.join(", ")}`,
    );
  }
};

const evaluateCase = (fixture, indexes, definition) => {
  const caseId = requireString(definition.id, "case.id");
  const policy = parsePolicyConfig(definition.policy);
  const input = inputForCase(fixture, indexes, definition);
  const actual = PolicyEvaluationSchema.parse(evaluatePolicy(policy, input));
  const repeat = PolicyEvaluationSchema.parse(evaluatePolicy(policy, input));
  const errors = [];
  const counters = {
    falsePositives: 0,
    falseNegatives: 0,
    explanationRegressions: 0,
    evidenceRegressions: 0,
  };
  const expected = requireRecord(
    definition.expected,
    `case ${caseId}.expected`,
  );
  const expectedStatus = requireString(
    expected.status,
    `case ${caseId}.expected.status`,
  );
  const expectedViolationIds = expected.violationIds ?? [];
  const expectedUnsupportedIds = expected.unsupportedIds ?? [];
  const actualViolationIds = actual.violations.map((violation) => violation.id);
  const actualUnsupportedIds = actual.unsupported.map(
    (unsupported) => unsupported.id,
  );

  if (actual.status !== expectedStatus) {
    errors.push(
      `case ${caseId} status drift: expected ${expectedStatus}, found ${actual.status}`,
    );
  }
  if (!idsEqual(actualViolationIds, expectedViolationIds)) {
    errors.push(
      `case ${caseId} violation drift: expected ${JSON.stringify(expectedViolationIds)}, found ${JSON.stringify(actualViolationIds)}`,
    );
  }
  if (!idsEqual(actualUnsupportedIds, expectedUnsupportedIds)) {
    errors.push(
      `case ${caseId} unsupported drift: expected ${JSON.stringify(expectedUnsupportedIds)}, found ${JSON.stringify(actualUnsupportedIds)}`,
    );
  }

  const expectedFinding = expectedStatus !== "passed";
  const actualFinding = actual.status !== "passed";
  if (!expectedFinding && actualFinding) counters.falsePositives += 1;
  if (expectedFinding && !actualFinding) counters.falseNegatives += 1;

  if (serializePolicyEvaluation(actual) !== serializePolicyEvaluation(repeat)) {
    errors.push(
      `case ${caseId} is not deterministic across repeated evaluation`,
    );
  }

  for (const check of expected.checks ?? []) {
    checkFinding(actual, check, caseId, counters, errors);
  }

  const fixtureClass = requireString(definition.class, `case ${caseId}.class`);
  const expectedClassStatus = {
    positive: "passed",
    negative: "violations",
    unsupported: "unsupported",
  }[fixtureClass];
  if (expectedClassStatus !== expectedStatus) {
    errors.push(
      `case ${caseId} class ${fixtureClass} does not describe expected status ${expectedStatus}`,
    );
  }

  return {
    id: caseId,
    class: fixtureClass,
    expectedStatus,
    actualStatus: actual.status,
    evaluatedRules: actual.evaluatedRules,
    violations: actualViolationIds,
    unsupported: actualUnsupportedIds,
    counters,
    errors,
  };
};

export const validate = (fixturePath = defaultFixturePath) => {
  const fixture = readJson(fixturePath);
  const indexes = validateFixtureShape(fixture);
  const caseIds = new Set();
  const coverage = new Map();
  const caseResults = [];
  const errors = [];
  const totals = {
    falsePositives: 0,
    falseNegatives: 0,
    explanationRegressions: 0,
    evidenceRegressions: 0,
  };

  for (const definition of fixture.cases) {
    const caseId = requireString(definition.id, "case.id");
    if (caseIds.has(caseId))
      errors.push(`duplicate policy regression case: ${caseId}`);
    caseIds.add(caseId);
    const policy = parsePolicyConfig(definition.policy);
    for (const rule of policy.rules) {
      const ruleType = `${rule.target}:${rule.assertion}`;
      if (!coverage.has(ruleType)) coverage.set(ruleType, new Set());
      coverage.get(ruleType).add(definition.class);
    }
    const result = evaluateCase(fixture, indexes, definition);
    caseResults.push(result);
    errors.push(...result.errors);
    for (const [key, value] of Object.entries(result.counters)) {
      totals[key] += value;
    }
  }

  const requiredRuleTypes = [...fixture.requiredRuleTypes].sort();
  const observedRuleTypes = [...coverage.keys()].sort();
  for (const ruleType of requiredRuleTypes) {
    if (!coverage.has(ruleType)) {
      errors.push(`required policy rule type is not covered: ${ruleType}`);
      continue;
    }
    const classes = coverage.get(ruleType);
    if (!classes.has("positive"))
      errors.push(`rule type ${ruleType} lacks a positive fixture`);
    if (!classes.has("negative"))
      errors.push(`rule type ${ruleType} lacks a negative fixture`);
  }
  for (const ruleType of observedRuleTypes) {
    if (!requiredRuleTypes.includes(ruleType)) {
      errors.push(`unexpected policy rule type in corpus: ${ruleType}`);
    }
  }

  for (const [key, expected] of Object.entries(fixture.baseline)) {
    if (totals[key] !== expected) {
      errors.push(
        `published ${key} baseline drift: expected ${expected}, found ${totals[key]}`,
      );
    }
  }

  const report = {
    ok: errors.length === 0,
    schemaVersion: fixture.schemaVersion,
    contract: fixture.contract,
    fixtureId: fixture.fixtureId,
    cases: fixture.cases.length,
    positiveCases: fixture.cases.filter(
      (definition) => definition.class === "positive",
    ).length,
    negativeCases: fixture.cases.filter(
      (definition) => definition.class === "negative",
    ).length,
    unsupportedCases: fixture.cases.filter(
      (definition) => definition.class === "unsupported",
    ).length,
    requiredRuleTypes,
    observedRuleTypes,
    ...totals,
    baseline: fixture.baseline,
    deterministic: caseResults.every((result) =>
      result.errors.every((error) => !error.includes("not deterministic")),
    ),
    caseResults: caseResults.map(
      ({
        id,
        class: fixtureClass,
        expectedStatus,
        actualStatus,
        evaluatedRules,
        violations,
        unsupported,
      }) => ({
        id,
        class: fixtureClass,
        expectedStatus,
        actualStatus,
        evaluatedRules,
        violations,
        unsupported,
      }),
    ),
  };
  const digest = createHash("sha256")
    .update(stableStringify(report))
    .digest("hex");
  const published = { ...report, digest: `sha256:${digest}` };
  if (errors.length > 0) {
    fail(
      `policy regression validation failed: ${JSON.stringify({ errors, report: published })}`,
    );
  }
  return published;
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node --import tsx scripts/policy-regression.mjs validate [--fixture path]",
    );
    process.exit(2);
  }
  try {
    console.log(
      stableStringify(
        validate(argumentValue("--fixture") ?? defaultFixturePath),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
