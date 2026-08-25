#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

import {
  evaluateCaseResult,
  validate as validateCorpus,
} from "./runtime-reconciliation-corpus.mjs";
import { RuntimeReconciliationInputSchema } from "../src/core/index.ts";
import { stableStringify } from "../src/core/index.ts";

const SCHEMA_VERSION = 1;
const FIXTURE_CONTRACT =
  "cartograph.runtime-reconciliation-reproducibility-fixtures";
const REPORT_CONTRACT = "cartograph.runtime-reconciliation-reproducibility";
const REPORT_MEDIA_TYPE =
  "application/vnd.cartograph.runtime-reconciliation-reproducibility+json";
const repositoryRoot = resolve(process.cwd());
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/runtime-reconciliation-reproducibility/study.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-reproducibility-fixtures.v0.1.schema.json",
);
const reportSchemaPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-reproducibility.v0.1.schema.json",
);
const reportSamplePath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-reproducibility.v0.1.json",
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

const canonicalizeMethod = (method) => ({
  ...method,
  perturbations: [...method.perturbations]
    .map((perturbation) => ({
      ...perturbation,
      dropSpanIds: sorted(perturbation.dropSpanIds ?? []),
      dropBindingSpanIds: sorted(perturbation.dropBindingSpanIds ?? []),
      ...(perturbation.redaction
        ? {
            redaction: {
              ...perturbation.redaction,
              fields: sorted(perturbation.redaction.fields),
            },
          }
        : {}),
    }))
    .sort((left, right) => compareStrings(left.id, right.id)),
});

const recordKey = (record) => {
  if (record.staticEdgeIds.length === 1) {
    return `edge:${record.staticEdgeIds[0]}`;
  }
  if (record.classification === "ambiguous") {
    return `endpoint:${record.id.slice("ambiguous:".length)}`;
  }
  if (record.classification === "observed-but-unmodeled") {
    return `runtime:${record.id.slice("observed-but-unmodeled:".length)}`;
  }
  return `record:${record.id}`;
};

const classificationChanges = (before, after) => {
  const beforeByKey = new Map(
    before.records.map((record) => [recordKey(record), record.classification]),
  );
  const afterByKey = new Map(
    after.records.map((record) => [recordKey(record), record.classification]),
  );
  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
  let changes = 0;
  for (const key of keys) {
    if (beforeByKey.get(key) !== afterByKey.get(key)) changes += 1;
  }
  return changes;
};

const range = (values) => ({
  minimum: Math.min(...values),
  maximum: Math.max(...values),
});

const validateFixtureShape = (fixture) => {
  const fixtureSchema = readJson(fixtureSchemaPath);
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(
    fixtureSchema,
  );
  if (!validateSchema(fixture)) {
    fail(
      `runtime reproducibility fixture schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }
  if (fixture.contract !== FIXTURE_CONTRACT || fixture.schemaVersion !== 1) {
    fail("runtime reproducibility fixture contract drifted");
  }
  const ids = new Set();
  for (const perturbation of fixture.method.perturbations) {
    if (ids.has(perturbation.id)) {
      fail(
        `duplicate runtime reproducibility perturbation: ${perturbation.id}`,
      );
    }
    ids.add(perturbation.id);
    if (perturbation.kind === "redaction" && !perturbation.redaction) {
      fail(`redaction perturbation ${perturbation.id} needs redaction options`);
    }
    if (
      perturbation.kind === "missingness" &&
      (!perturbation.dropSpanIds || perturbation.dropSpanIds.length === 0)
    ) {
      fail(`missingness perturbation ${perturbation.id} needs dropped spans`);
    }
  }
  if (
    fixture.method.offlineBoundary.network ||
    fixture.method.offlineBoundary.liveTraces ||
    fixture.method.offlineBoundary.exporter
  ) {
    fail("runtime reproducibility study must remain offline");
  }
};

const perturbationScenario = (baseScenario, perturbation) => {
  const scenario = clone(baseScenario);
  scenario.dropSpanIds = sorted([
    ...scenario.dropSpanIds,
    ...(perturbation.dropSpanIds ?? []),
  ]);
  scenario.dropBindingSpanIds = sorted([
    ...scenario.dropBindingSpanIds,
    ...(perturbation.dropBindingSpanIds ?? []),
  ]);
  if (perturbation.kind === "redaction") {
    scenario.families = sorted([...scenario.families, "redaction"]);
    scenario.redaction = {
      enabled: true,
      fields: perturbation.redaction.fields,
      replacement: perturbation.redaction.replacement,
    };
  }
  return scenario;
};

const perturbedBaseInput = (baseInput, perturbation, runIndex) => {
  const input = clone(baseInput);
  if (perturbation.kind === "ordering" && runIndex % 2 === 0) {
    input.staticSnapshot.edges.reverse();
    input.runtimeTrace.spans.reverse();
    input.bindings.reverse();
  }
  return RuntimeReconciliationInputSchema.parse(input);
};

const evaluatePerturbation = (
  baseInput,
  baseScenario,
  perturbation,
  repetitions,
) => {
  const baseline = evaluateCaseResult(baseInput, baseScenario);
  const baselineResultDigest = digest(baseline.serializedResult);
  const scenario = perturbationScenario(baseScenario, perturbation);
  const runs = [];
  for (let runIndex = 0; runIndex < repetitions; runIndex += 1) {
    const input = perturbedBaseInput(baseInput, perturbation, runIndex);
    const evaluated = evaluateCaseResult(input, scenario);
    const marker = `fixture-secret-${scenario.id}`;
    if (
      perturbation.kind === "redaction" &&
      evaluated.serializedTrace.includes(marker)
    ) {
      fail(`redaction marker leaked during ${perturbation.id}`);
    }
    runs.push({
      resultDigest: digest(evaluated.serializedResult),
      classificationChanges: classificationChanges(
        baseline.result,
        evaluated.result,
      ),
      missingRuntimeSpanEdges: Math.max(
        0,
        baseline.result.summary.runtimeSpanEdges -
          evaluated.result.summary.runtimeSpanEdges,
      ),
      missingParentRecords: evaluated.result.records.filter((record) =>
        record.reason.includes("parent span is absent"),
      ).length,
      redactionInvariant:
        perturbation.kind !== "redaction" ||
        digest(evaluated.serializedResult) === baselineResultDigest,
    });
  }
  const distinctResultDigests = new Set(runs.map((run) => run.resultDigest))
    .size;
  const redactionInvariant = runs.every((run) => run.redactionInvariant);
  if (
    perturbation.expected.invariant === "stable-result" &&
    (distinctResultDigests !== 1 ||
      runs.some((run) => run.classificationChanges !== 0))
  ) {
    fail(`ordering stability drifted for ${perturbation.id}`);
  }
  if (
    perturbation.expected.invariant === "missingness-delta" &&
    runs.every(
      (run) =>
        run.missingRuntimeSpanEdges === 0 && run.missingParentRecords === 0,
    )
  ) {
    fail(
      `missingness perturbation produced no missingness for ${perturbation.id}`,
    );
  }
  if (
    perturbation.expected.invariant === "redaction-no-leak" &&
    !redactionInvariant
  ) {
    fail(`redaction invariant failed for ${perturbation.id}`);
  }
  return {
    id: perturbation.id,
    kind: perturbation.kind,
    caseId: perturbation.caseId,
    runs: runs.length,
    baselineResultDigest,
    digestVariance: {
      distinctResultDigests,
      stable: distinctResultDigests === 1,
    },
    variance: {
      classificationChanges: range(
        runs.map((run) => run.classificationChanges),
      ),
      missingRuntimeSpanEdges: range(
        runs.map((run) => run.missingRuntimeSpanEdges),
      ),
      missingParentRecords: range(runs.map((run) => run.missingParentRecords)),
    },
    redactionInvariant,
  };
};

export const validate = (fixturePath = defaultFixturePath) => {
  const fixture = readJson(fixturePath);
  validateFixtureShape(fixture);
  const corpusPath = resolve(repositoryRoot, fixture.corpusFixture);
  const corpus = readJson(corpusPath);
  const corpusSummary = validateCorpus(corpusPath);
  const baseInput = RuntimeReconciliationInputSchema.parse(
    readJson(corpus.baseInput),
  );
  const caseById = new Map(
    corpus.cases.map((scenario) => [scenario.id, scenario]),
  );
  const results = fixture.method.perturbations
    .slice()
    .sort((left, right) => compareStrings(left.id, right.id))
    .map((perturbation) => {
      const baseScenario = caseById.get(perturbation.caseId);
      if (!baseScenario) {
        fail(
          `runtime reproducibility perturbation ${perturbation.id} references unknown case ${perturbation.caseId}`,
        );
      }
      return evaluatePerturbation(
        baseInput,
        baseScenario,
        perturbation,
        fixture.repetitions,
      );
    });
  const totalRuns = results.reduce((sum, result) => sum + result.runs, 0);
  const stableRuns = results.reduce(
    (sum, result) => sum + (result.digestVariance.stable ? result.runs : 0),
    0,
  );
  const summary = {
    perturbations: results.length,
    totalRuns,
    stableRuns,
    stabilityRate: totalRuns === 0 ? 0 : stableRuns / totalRuns,
    classificationChanges: results.reduce(
      (sum, result) => sum + result.variance.classificationChanges.maximum,
      0,
    ),
    missingRuntimeSpanEdges: results.reduce(
      (sum, result) => sum + result.variance.missingRuntimeSpanEdges.maximum,
      0,
    ),
    missingParentRecords: results.reduce(
      (sum, result) => sum + result.variance.missingParentRecords.maximum,
      0,
    ),
    redactionInvariantCases: results.filter(
      (result) => result.kind === "redaction" && result.redactionInvariant,
    ).length,
    network: false,
    liveTraces: false,
    exporter: false,
  };
  const reportWithoutDigest = {
    $schema:
      "../schema/runtime-reconciliation-reproducibility.v0.1.schema.json",
    schemaVersion: SCHEMA_VERSION,
    contract: REPORT_CONTRACT,
    mediaType: REPORT_MEDIA_TYPE,
    studyId: fixture.studyId,
    evaluatedAt: fixture.evaluatedAt,
    corpusDigest: corpusSummary.fixtureDigest,
    methodDigest: digest(stableStringify(canonicalizeMethod(fixture.method))),
    repetitions: fixture.repetitions,
    nonGuarantees: fixture.nonGuarantees,
    perturbations: results,
    summary,
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
      `runtime reproducibility report schema validation failed: ${JSON.stringify(validateReport.errors)}`,
    );
  }
  if (!process.argv.includes("--print-report")) {
    const publishedReport = readJson(reportSamplePath);
    if (stableStringify(publishedReport) !== stableStringify(report)) {
      fail("published runtime reproducibility report drifted");
    }
  }
  if (digest(stableStringify(reportWithoutDigest)) !== report.reportDigest) {
    fail("runtime reproducibility report digest does not bind report fields");
  }
  return process.argv.includes("--print-report")
    ? report
    : {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        contract: REPORT_CONTRACT,
        studyId: fixture.studyId,
        corpusDigest: report.corpusDigest,
        methodDigest: report.methodDigest,
        repetitions: fixture.repetitions,
        summary,
        reportDigest: report.reportDigest,
      };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node --import tsx scripts/runtime-reconciliation-reproducibility.mjs validate [--fixture path] [--print-report]",
    );
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(validate(argumentValue("--fixture"))));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`runtime reproducibility validation failed: ${message}`);
    process.exit(1);
  }
}
