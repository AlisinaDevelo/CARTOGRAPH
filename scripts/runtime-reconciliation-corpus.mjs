#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

import {
  RuntimeReconciliationInputSchema,
  RuntimeReconciliationSchema,
  RuntimeTraceSchema,
  reconcileRuntimeTrace,
  redactRuntimeTrace,
  serializeRuntimeReconciliation,
  serializeRuntimeTrace,
  stableStringify,
} from "../src/core/index.ts";

const SCHEMA_VERSION = 1;
const FIXTURE_CONTRACT = "cartograph.runtime-reconciliation-corpus-fixtures";
const REPORT_CONTRACT = "cartograph.runtime-reconciliation-corpus";
const REPORT_MEDIA_TYPE =
  "application/vnd.cartograph.runtime-reconciliation-corpus+json";
const REQUIRED_FAMILIES = [
  "http",
  "database",
  "messaging",
  "errors",
  "missing-parents",
  "sampling",
  "redaction",
  "static-runtime-disagreement",
];
const CLASSIFICATIONS = [
  "observed-and-modeled",
  "modeled-not-observed",
  "observed-but-unmodeled",
  "ambiguous",
];
const repositoryRoot = resolve(process.cwd());
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/runtime-reconciliation-corpus/scenarios.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-corpus-fixtures.v0.1.schema.json",
);
const reportSchemaPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-corpus.v0.1.schema.json",
);
const reportSamplePath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-corpus.v0.1.json",
);

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const readJson = (filePath) =>
  JSON.parse(readFileSync(resolve(repositoryRoot, filePath), "utf8"));

const fail = (message) => {
  throw new Error(message);
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const compareStrings = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;

const sorted = (values) => [...values].sort(compareStrings);

const spanKey = (span) => `${span.traceId}:${span.spanId}`;

const edgeId = (edge) => `edge:${edge.from}|${edge.kind}|${edge.to}`;

const classificationCounts = (result) => ({
  observedAndModeled: result.summary.observedAndModeled,
  modeledNotObserved: result.summary.modeledNotObserved,
  observedButUnmodeled: result.summary.observedButUnmodeled,
  ambiguous: result.summary.ambiguous,
});

const expectedClassificationCounts = (expected) => ({
  "observed-and-modeled": expected["observed-and-modeled"],
  "modeled-not-observed": expected["modeled-not-observed"],
  "observed-but-unmodeled": expected["observed-but-unmodeled"],
  ambiguous: expected.ambiguous,
});

const canonicalizeFixture = (fixture) => ({
  ...fixture,
  limitations: sorted(fixture.limitations),
  cases: [...fixture.cases]
    .map((scenario) => ({
      ...scenario,
      families: sorted(scenario.families),
      traceIds: sorted(scenario.traceIds),
      staticEdgeIds: sorted(scenario.staticEdgeIds),
      dropSpanIds: sorted(scenario.dropSpanIds),
      dropBindingSpanIds: sorted(scenario.dropBindingSpanIds),
      redaction: {
        ...scenario.redaction,
        fields: sorted(scenario.redaction.fields),
      },
      expected: {
        ...scenario.expected,
        records: [...scenario.expected.records].sort((left, right) =>
          compareStrings(
            `${left.id}\0${left.classification}`,
            `${right.id}\0${right.classification}`,
          ),
        ),
      },
    }))
    .sort((left, right) => compareStrings(left.id, right.id)),
});

const validateFixtureShape = (fixture, baseInput) => {
  const fixtureSchema = readJson(fixtureSchemaPath);
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(
    fixtureSchema,
  );
  if (!validateSchema(fixture)) {
    fail(
      `runtime reconciliation corpus fixture schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }
  if (fixture.contract !== FIXTURE_CONTRACT || fixture.schemaVersion !== 1) {
    fail("runtime reconciliation corpus fixture contract drifted");
  }

  const baseTrace = RuntimeTraceSchema.parse(baseInput.runtimeTrace);
  const traceIds = new Set(baseTrace.spans.map((span) => span.traceId));
  const spanKeys = new Set(baseTrace.spans.map(spanKey));
  const edgeIds = new Set(baseInput.staticSnapshot.edges.map(edgeId));
  const bindingKeys = new Set(baseInput.bindings.map(spanKey));
  const caseIds = new Set();
  const coveredFamilies = new Set();

  for (const scenario of fixture.cases) {
    if (caseIds.has(scenario.id)) {
      fail(`duplicate runtime reconciliation corpus case: ${scenario.id}`);
    }
    caseIds.add(scenario.id);
    for (const family of scenario.families) coveredFamilies.add(family);

    const selectedTraceIds = new Set(scenario.traceIds);
    for (const traceId of selectedTraceIds) {
      if (!traceIds.has(traceId)) {
        fail(`case ${scenario.id} selects an unknown trace ${traceId}`);
      }
    }
    for (const selectedEdgeId of scenario.staticEdgeIds) {
      if (!edgeIds.has(selectedEdgeId)) {
        fail(
          `case ${scenario.id} selects an unknown static edge ${selectedEdgeId}`,
        );
      }
    }
    for (const droppedSpan of scenario.dropSpanIds) {
      if (!spanKeys.has(droppedSpan)) {
        fail(`case ${scenario.id} drops an unknown span ${droppedSpan}`);
      }
      if (!selectedTraceIds.has(droppedSpan.split(":", 1)[0])) {
        fail(`case ${scenario.id} drops a span outside its selected trace set`);
      }
    }
    for (const droppedBinding of scenario.dropBindingSpanIds) {
      if (!bindingKeys.has(droppedBinding)) {
        fail(`case ${scenario.id} drops an unknown binding ${droppedBinding}`);
      }
      if (!selectedTraceIds.has(droppedBinding.split(":", 1)[0])) {
        fail(
          `case ${scenario.id} drops a binding outside its selected trace set`,
        );
      }
    }
    const expectedIds = new Set();
    for (const record of scenario.expected.records) {
      if (expectedIds.has(record.id)) {
        fail(`case ${scenario.id} repeats expected record ${record.id}`);
      }
      expectedIds.add(record.id);
    }
    const expectedCounts = expectedClassificationCounts(
      scenario.expected.classificationCounts,
    );
    for (const classification of CLASSIFICATIONS) {
      const count = scenario.expected.records.filter(
        (record) => record.classification === classification,
      ).length;
      if (count !== expectedCounts[classification]) {
        fail(
          `case ${scenario.id} expected classification count drifted for ${classification}`,
        );
      }
    }
    if (
      scenario.redaction.enabled &&
      !scenario.families.includes("redaction")
    ) {
      fail(`redacted case ${scenario.id} must declare the redaction family`);
    }
    if (
      scenario.families.includes("redaction") &&
      !scenario.redaction.enabled
    ) {
      fail(`redaction family ${scenario.id} must enable redaction`);
    }
    if (
      scenario.families.includes("sampling") &&
      scenario.sampling.strategy === "complete"
    ) {
      fail(`sampling case ${scenario.id} must use an incomplete strategy`);
    }
  }

  for (const family of REQUIRED_FAMILIES) {
    if (!coveredFamilies.has(family)) {
      fail(`runtime reconciliation corpus is missing family ${family}`);
    }
  }
  return { traceIds, spanKeys, edgeIds, bindingKeys };
};

const sampledInput = (baseInput, scenario) => {
  const selectedTraceIds = new Set(scenario.traceIds);
  const droppedSpans = new Set(scenario.dropSpanIds);
  const droppedBindings = new Set(scenario.dropBindingSpanIds);
  const input = clone(baseInput);
  const selectedSpans = input.runtimeTrace.spans.filter(
    (span) =>
      selectedTraceIds.has(span.traceId) && !droppedSpans.has(spanKey(span)),
  );
  input.runtimeTrace.spans = selectedSpans;
  input.runtimeTrace.summary = {
    ...input.runtimeTrace.summary,
    resourceSpans: selectedTraceIds.size,
    scopeSpans: selectedTraceIds.size,
    inputSpans: selectedSpans.length,
    normalizedSpans: selectedSpans.length,
  };
  input.bindings = input.bindings.filter(
    (binding) =>
      selectedTraceIds.has(binding.traceId) &&
      !droppedSpans.has(spanKey(binding)) &&
      !droppedBindings.has(spanKey(binding)),
  );
  const selectedEdges = new Set(scenario.staticEdgeIds);
  input.staticSnapshot.edges = input.staticSnapshot.edges.filter((edge) =>
    selectedEdges.has(edgeId(edge)),
  );

  if (scenario.redaction.enabled) {
    const marker = `fixture-secret-${scenario.id}`;
    const redactionInput = {
      ...input.runtimeTrace,
      spans: input.runtimeTrace.spans.map((span) => ({
        ...span,
        name: `${span.name}-${marker}`,
        serviceName: `${span.serviceName ?? "service"}-${marker}`,
      })),
    };
    input.runtimeTrace = redactRuntimeTrace(redactionInput, {
      fields: scenario.redaction.fields,
      replacement: scenario.redaction.replacement,
    });
    if (JSON.stringify(input.runtimeTrace).includes(marker)) {
      fail(`redaction leaked the synthetic marker for case ${scenario.id}`);
    }
  }
  return RuntimeReconciliationInputSchema.parse(input);
};

const assertFamilySignals = (scenario, input, result) => {
  const spans = input.runtimeTrace.spans;
  const edges = input.staticSnapshot.edges;
  if (
    scenario.families.includes("http") &&
    !edges.some((edge) => edge.kind === "requests")
  ) {
    fail(`HTTP case ${scenario.id} has no requests edge`);
  }
  if (
    scenario.families.includes("database") &&
    !edges.some((edge) => edge.kind === "reads" || edge.kind === "writes")
  ) {
    fail(`database case ${scenario.id} has no reads/writes edge`);
  }
  if (
    scenario.families.includes("messaging") &&
    (!edges.some((edge) => edge.kind === "publishes") ||
      !edges.some((edge) => edge.kind === "subscribes"))
  ) {
    fail(`messaging case ${scenario.id} does not cover publish and subscribe`);
  }
  if (
    scenario.families.includes("errors") &&
    !spans.some((span) => span.status === "error")
  ) {
    fail(`error case ${scenario.id} has no error-status span`);
  }
  if (scenario.families.includes("missing-parents")) {
    const spanKeysInCase = new Set(spans.map(spanKey));
    if (
      !spans.some(
        (span) =>
          span.parentSpanId &&
          !spanKeysInCase.has(`${span.traceId}:${span.parentSpanId}`),
      )
    ) {
      fail(`missing-parent case ${scenario.id} has no missing parent`);
    }
  }
  if (scenario.families.includes("static-runtime-disagreement")) {
    const classes = new Set(
      result.records.map((record) => record.classification),
    );
    if (
      !classes.has("ambiguous") &&
      !(
        classes.has("modeled-not-observed") &&
        classes.has("observed-but-unmodeled")
      )
    ) {
      fail(
        `disagreement case ${scenario.id} has no disagreement classification`,
      );
    }
  }
};

export const evaluateCaseResult = (baseInput, scenario) => {
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
  assertFamilySignals(scenario, input, result);
  return {
    input,
    result,
    serializedTrace: serializeRuntimeTrace(input.runtimeTrace),
    serializedResult: serializeRuntimeReconciliation(result),
  };
};

const evaluateCase = (baseInput, scenario) => {
  const { input, result, serializedTrace, serializedResult } =
    evaluateCaseResult(baseInput, scenario);

  const expectedPairs = new Set(
    scenario.expected.records.map(
      (record) => `${record.id}\0${record.classification}`,
    ),
  );
  const actualPairs = new Set(
    result.records.map((record) => `${record.id}\0${record.classification}`),
  );
  if (
    expectedPairs.size !== actualPairs.size ||
    [...expectedPairs].some((pair) => !actualPairs.has(pair))
  ) {
    fail(
      `case ${scenario.id} classification drifted: ${JSON.stringify(result.records.map(({ id, classification }) => ({ id, classification })))} `,
    );
  }
  const actualCounts = classificationCounts(result);
  const expectedCounts = scenario.expected.classificationCounts;
  const expectedDigestCounts = {
    observedAndModeled: expectedCounts["observed-and-modeled"],
    modeledNotObserved: expectedCounts["modeled-not-observed"],
    observedButUnmodeled: expectedCounts["observed-but-unmodeled"],
    ambiguous: expectedCounts.ambiguous,
  };
  if (stableStringify(actualCounts) !== stableStringify(expectedDigestCounts)) {
    fail(`case ${scenario.id} classification counts drifted`);
  }
  const inputDigest = digest(
    stableStringify({
      staticSnapshot: input.staticSnapshot,
      runtimeTrace: input.runtimeTrace,
      bindings: input.bindings,
    }),
  );
  return {
    id: scenario.id,
    families: sorted(scenario.families),
    inputDigest,
    traceDigest: digest(serializedTrace),
    resultDigest: digest(serializedResult),
    classificationCounts: actualCounts,
    redactionApplied: scenario.redaction.enabled,
  };
};

export const validate = (fixturePath = defaultFixturePath) => {
  const fixture = readJson(fixturePath);
  const baseInput = RuntimeReconciliationInputSchema.parse(
    readJson(fixture.baseInput),
  );
  validateFixtureShape(fixture, baseInput);
  const results = fixture.cases
    .slice()
    .sort((left, right) => compareStrings(left.id, right.id))
    .map((scenario) => evaluateCase(baseInput, scenario));

  const overall = results.reduce(
    (accumulator, result) => ({
      observedAndModeled:
        accumulator.observedAndModeled +
        result.classificationCounts.observedAndModeled,
      modeledNotObserved:
        accumulator.modeledNotObserved +
        result.classificationCounts.modeledNotObserved,
      observedButUnmodeled:
        accumulator.observedButUnmodeled +
        result.classificationCounts.observedButUnmodeled,
      ambiguous: accumulator.ambiguous + result.classificationCounts.ambiguous,
    }),
    {
      observedAndModeled: 0,
      modeledNotObserved: 0,
      observedButUnmodeled: 0,
      ambiguous: 0,
    },
  );
  const reportWithoutDigest = {
    $schema: "../schema/runtime-reconciliation-corpus.v0.1.schema.json",
    schemaVersion: SCHEMA_VERSION,
    contract: REPORT_CONTRACT,
    mediaType: REPORT_MEDIA_TYPE,
    fixtureId: fixture.fixtureId,
    evaluatedAt: fixture.evaluatedAt,
    fixtureDigest: digest(stableStringify(canonicalizeFixture(fixture))),
    releaseGating: fixture.releaseGating,
    limitations: fixture.limitations,
    cases: results,
    summary: {
      cases: results.length,
      families: REQUIRED_FAMILIES,
      classificationCounts: overall,
      redactedCases: results.filter((result) => result.redactionApplied).length,
      network: false,
      exporter: false,
    },
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
      `runtime reconciliation corpus report schema validation failed: ${JSON.stringify(validateReport.errors)}`,
    );
  }
  if (!process.argv.includes("--print-report")) {
    const publishedReport = readJson(reportSamplePath);
    if (stableStringify(publishedReport) !== stableStringify(report)) {
      fail("published runtime reconciliation corpus report drifted");
    }
  }
  const reordered = {
    ...fixture,
    cases: [...fixture.cases].reverse(),
  };
  if (
    digest(stableStringify(canonicalizeFixture(reordered))) !==
    report.fixtureDigest
  ) {
    fail("corpus fixture digest changed with case order");
  }
  if (digest(stableStringify(reportWithoutDigest)) !== report.reportDigest) {
    fail("corpus report digest does not bind report fields");
  }

  return process.argv.includes("--print-report")
    ? report
    : {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        contract: REPORT_CONTRACT,
        fixtureId: fixture.fixtureId,
        cases: results.length,
        families: REQUIRED_FAMILIES,
        classificationCounts: overall,
        redactedCases: results.filter((result) => result.redactionApplied)
          .length,
        network: false,
        exporter: false,
        fixtureDigest: report.fixtureDigest,
        reportDigest: report.reportDigest,
      };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node --import tsx scripts/runtime-reconciliation-corpus.mjs validate [--fixture path] [--print-report]",
    );
    process.exit(2);
  }

  try {
    console.log(JSON.stringify(validate(argumentValue("--fixture"))));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `runtime reconciliation corpus validation failed: ${message}`,
    );
    process.exit(1);
  }
}
