#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  RuntimeReconciliationInputSchema,
  RuntimeReconciliationSchema,
  reconcileRuntimeTrace,
  serializeRuntimeReconciliation,
  stableStringify,
} from "../src/core/index.ts";

const RUNTIME_RECONCILIATION_EVALUATION_SCHEMA_VERSION = 1;
const RUNTIME_RECONCILIATION_EVALUATION_CONTRACT =
  "cartograph.runtime-reconciliation-evaluation";
const RUNTIME_RECONCILIATION_EVALUATION_MEDIA_TYPE =
  "application/vnd.cartograph.runtime-reconciliation-evaluation+json";

const repositoryRoot = resolve(process.cwd());
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/runtime-reconciliation-evaluation/scenarios.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-evaluation-fixtures.v0.1.schema.json",
);
const reportSchemaPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-evaluation.v0.1.schema.json",
);
const reportSamplePath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-evaluation.v0.1.json",
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

const clone = (value) => JSON.parse(JSON.stringify(value));

const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const rate = (numerator, denominator) =>
  denominator === 0 ? 0 : numerator / denominator;

const spanKey = (span) => `${span.traceId}:${span.spanId}`;

const pairKey = (record) => `${record.id}\0${record.classification}`;

const canonicalizeFixture = (fixture) => ({
  ...fixture,
  cases: [...fixture.cases]
    .map((scenario) => ({
      ...scenario,
      dropSpanIds: [...scenario.dropSpanIds].sort(),
      dropBindingSpanIds: [...scenario.dropBindingSpanIds].sort(),
      expectedRecords: [...scenario.expectedRecords].sort((left, right) => {
        const leftKey = pairKey(left);
        const rightKey = pairKey(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
    }))
    .sort((left, right) => left.id.localeCompare(right.id)),
});

const validateFixtureShape = (fixture) => {
  const fixtureSchema = readJson(fixtureSchemaPath);
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(
    fixtureSchema,
  );
  if (!validateSchema(fixture)) {
    fail(
      `runtime reconciliation evaluation fixture schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }
  const baseInput = RuntimeReconciliationInputSchema.parse(
    readJson(resolve(repositoryRoot, fixture.baseInput)),
  );
  const baseSpanKeys = new Set(baseInput.runtimeTrace.spans.map(spanKey));
  const baseBindingKeys = new Set(baseInput.bindings.map(spanKey));
  const caseIds = new Set();
  for (const scenario of fixture.cases) {
    if (caseIds.has(scenario.id)) {
      fail(`duplicate runtime reconciliation evaluation case: ${scenario.id}`);
    }
    caseIds.add(scenario.id);
    for (const key of scenario.dropSpanIds) {
      if (!baseSpanKeys.has(key)) {
        fail(`case ${scenario.id} drops an unknown span ${key}`);
      }
    }
    for (const key of scenario.dropBindingSpanIds) {
      if (!baseBindingKeys.has(key)) {
        fail(`case ${scenario.id} drops an unknown binding ${key}`);
      }
    }
    const expectedIds = new Set();
    for (const record of scenario.expectedRecords) {
      if (expectedIds.has(record.id)) {
        fail(`case ${scenario.id} repeats expected record ${record.id}`);
      }
      expectedIds.add(record.id);
    }
  }
  return baseInput;
};

const sampledInput = (baseInput, scenario) => {
  const dropSpans = new Set(scenario.dropSpanIds);
  const dropBindings = new Set(scenario.dropBindingSpanIds);
  const input = clone(baseInput);
  const removedSpanCount = input.runtimeTrace.spans.filter((span) =>
    dropSpans.has(spanKey(span)),
  ).length;
  input.runtimeTrace.spans = input.runtimeTrace.spans.filter(
    (span) => !dropSpans.has(spanKey(span)),
  );
  input.runtimeTrace.summary = {
    ...input.runtimeTrace.summary,
    inputSpans: input.runtimeTrace.summary.inputSpans - removedSpanCount,
    normalizedSpans:
      input.runtimeTrace.summary.normalizedSpans - removedSpanCount,
  };
  input.bindings = input.bindings.filter(
    (binding) =>
      !dropSpans.has(spanKey(binding)) && !dropBindings.has(spanKey(binding)),
  );
  return RuntimeReconciliationInputSchema.parse(input);
};

const evaluateCase = (baseInput, scenario) => {
  const input = sampledInput(baseInput, scenario);
  const result = RuntimeReconciliationSchema.parse(
    reconcileRuntimeTrace(input),
  );
  const repeat = RuntimeReconciliationSchema.parse(
    reconcileRuntimeTrace(input),
  );
  if (
    serializeRuntimeReconciliation(result) !==
    serializeRuntimeReconciliation(repeat)
  ) {
    fail(`case ${scenario.id} is not deterministic across repeated evaluation`);
  }

  const expectedPairs = new Set(scenario.expectedRecords.map(pairKey));
  const actualPairs = new Set(result.records.map(pairKey));
  const truePositives = [...actualPairs].filter((key) =>
    expectedPairs.has(key),
  ).length;
  const falsePositives = result.records.length - truePositives;
  const falseNegatives = scenario.expectedRecords.length - truePositives;
  const actualRuntimeSpanEdges = result.summary.runtimeSpanEdges;
  const metrics = {
    expectedRuntimeSpanEdges: scenario.expectedRuntimeSpanEdges,
    actualRuntimeSpanEdges,
    expectedRecords: scenario.expectedRecords.length,
    actualRecords: result.records.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: rate(truePositives, result.records.length),
    recall: rate(truePositives, scenario.expectedRecords.length),
    coverage: Math.min(
      1,
      rate(actualRuntimeSpanEdges, scenario.expectedRuntimeSpanEdges),
    ),
    ambiguousRecords: result.summary.ambiguous,
    ambiguityRate: rate(result.summary.ambiguous, result.records.length),
  };
  return { ...metrics, result };
};

const addMetrics = (left, right) => ({
  expectedRuntimeSpanEdges:
    left.expectedRuntimeSpanEdges + right.expectedRuntimeSpanEdges,
  actualRuntimeSpanEdges:
    left.actualRuntimeSpanEdges + right.actualRuntimeSpanEdges,
  expectedRecords: left.expectedRecords + right.expectedRecords,
  actualRecords: left.actualRecords + right.actualRecords,
  truePositives: left.truePositives + right.truePositives,
  falsePositives: left.falsePositives + right.falsePositives,
  falseNegatives: left.falseNegatives + right.falseNegatives,
  ambiguousRecords: left.ambiguousRecords + right.ambiguousRecords,
});

const finalizeMetrics = (metrics) => ({
  ...metrics,
  precision: rate(metrics.truePositives, metrics.actualRecords),
  recall: rate(metrics.truePositives, metrics.expectedRecords),
  coverage: Math.min(
    1,
    rate(metrics.actualRuntimeSpanEdges, metrics.expectedRuntimeSpanEdges),
  ),
  ambiguityRate: rate(metrics.ambiguousRecords, metrics.actualRecords),
});

export const validate = (fixturePath = defaultFixturePath) => {
  const fixture = readJson(fixturePath);
  const baseInput = validateFixtureShape(fixture);
  const results = fixture.cases
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((scenario) => ({
      id: scenario.id,
      ...evaluateCase(baseInput, scenario),
    }));
  const overall = finalizeMetrics(
    results.reduce(
      (accumulator, scenario) => addMetrics(accumulator, scenario),
      {
        expectedRuntimeSpanEdges: 0,
        actualRuntimeSpanEdges: 0,
        expectedRecords: 0,
        actualRecords: 0,
        truePositives: 0,
        falsePositives: 0,
        falseNegatives: 0,
        ambiguousRecords: 0,
      },
    ),
  );
  const reportWithoutDigest = {
    schemaVersion: RUNTIME_RECONCILIATION_EVALUATION_SCHEMA_VERSION,
    contract: RUNTIME_RECONCILIATION_EVALUATION_CONTRACT,
    mediaType: RUNTIME_RECONCILIATION_EVALUATION_MEDIA_TYPE,
    evaluationId: fixture.evaluationId,
    evaluatedAt: fixture.evaluatedAt,
    fixtureDigest: digest(stableStringify(canonicalizeFixture(fixture))),
    releaseGating: fixture.releaseGating,
    limitations: fixture.limitations,
    samplingCaveats: fixture.samplingCaveats,
    overall,
    caseResults: results.map(({ id, result: _result, ...metrics }) => ({
      id,
      ...metrics,
    })),
  };
  const report = {
    ...reportWithoutDigest,
    reportDigest: digest(stableStringify(reportWithoutDigest)),
  };

  const reportSchema = readJson(reportSchemaPath);
  const validateReport = new Ajv({ allErrors: true, strict: false }).compile(
    reportSchema,
  );
  if (!validateReport(report)) {
    fail(
      `runtime reconciliation evaluation report schema validation failed: ${JSON.stringify(validateReport.errors)}`,
    );
  }
  if (!process.argv.includes("--print-report")) {
    const publishedReport = readJson(reportSamplePath);
    if (stableStringify(publishedReport) !== stableStringify(report)) {
      fail("published runtime reconciliation evaluation report drifted");
    }
  }
  const reversedFixture = {
    ...fixture,
    cases: [...fixture.cases].reverse(),
  };
  if (
    digest(stableStringify(canonicalizeFixture(reversedFixture))) !==
    report.fixtureDigest
  ) {
    fail("fixture digest changed with scenario order");
  }
  if (digest(stableStringify(reportWithoutDigest)) !== report.reportDigest) {
    fail("report digest does not bind the report fields");
  }

  const summary = {
    ok: true,
    schemaVersion: RUNTIME_RECONCILIATION_EVALUATION_SCHEMA_VERSION,
    contract: RUNTIME_RECONCILIATION_EVALUATION_CONTRACT,
    mediaType: RUNTIME_RECONCILIATION_EVALUATION_MEDIA_TYPE,
    evaluationId: fixture.evaluationId,
    cases: results.length,
    expectedRecords: overall.expectedRecords,
    actualRecords: overall.actualRecords,
    truePositives: overall.truePositives,
    falsePositives: overall.falsePositives,
    falseNegatives: overall.falseNegatives,
    precision: overall.precision,
    recall: overall.recall,
    coverage: overall.coverage,
    ambiguousRecords: overall.ambiguousRecords,
    ambiguityRate: overall.ambiguityRate,
    releaseGating: fixture.releaseGating.enabled,
    fixtureDigest: report.fixtureDigest,
    reportDigest: report.reportDigest,
  };
  return process.argv.includes("--print-report") ? report : summary;
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/runtime-reconciliation-evaluation.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate(argumentValue("--fixture"))));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `runtime reconciliation evaluation validation failed: ${message}`,
  );
  process.exit(1);
}
