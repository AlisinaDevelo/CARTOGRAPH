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
  stableStringify,
} from "../src/core/index.ts";

const SCHEMA_VERSION = 1;
const CONTRACT = "cartograph.runtime-reconciliation-uncertainty";
const MEDIA_TYPE =
  "application/vnd.cartograph.runtime-reconciliation-uncertainty+json";

const repositoryRoot = resolve(process.cwd());
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/runtime-reconciliation-uncertainty/scenarios.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-uncertainty-fixtures.v0.1.schema.json",
);
const reportSchemaPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-uncertainty.v0.1.schema.json",
);
const reportSamplePath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-uncertainty.v0.1.json",
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

const spanKey = (span) => `${span.traceId}:${span.spanId}`;

const traceRefKey = (reference) => {
  const match = /^trace:([0-9a-f]{32}):([0-9a-f]{16})$/u.exec(reference);
  return match ? `${match[1]}:${match[2]}` : undefined;
};

const compareStrings = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;

const sorted = (values) => [...values].sort(compareStrings);

const sortChanges = (changes) =>
  [...changes].sort((left, right) =>
    compareStrings(
      `${left.subject}\0${left.kind}\0${left.reasonCode}\0${left.from ?? ""}\0${left.to ?? ""}`,
      `${right.subject}\0${right.kind}\0${right.reasonCode}\0${right.from ?? ""}\0${right.to ?? ""}`,
    ),
  );

const canonicalizeFixture = (fixture) => ({
  ...fixture,
  limitations: sorted(fixture.limitations),
  samplingCaveats: sorted(fixture.samplingCaveats),
  cases: [...fixture.cases]
    .map((scenario) => ({
      ...scenario,
      dropSpanIds: sorted(scenario.dropSpanIds),
      dropBindingSpanIds: sorted(scenario.dropBindingSpanIds),
      uncertainty: {
        ...scenario.uncertainty,
        serviceAliases: [...scenario.uncertainty.serviceAliases]
          .map((alias) => ({ ...alias, aliases: sorted(alias.aliases) }))
          .sort((left, right) =>
            compareStrings(left.canonical, right.canonical),
          ),
        missingParents: [...scenario.uncertainty.missingParents].sort(
          (left, right) =>
            compareStrings(
              `${left.traceId}:${left.parentSpanId}:${left.childSpanId}`,
              `${right.traceId}:${right.parentSpanId}:${right.childSpanId}`,
            ),
        ),
      },
      expected: {
        ...scenario.expected,
        changes: sortChanges(scenario.expected.changes),
      },
    }))
    .sort((left, right) => compareStrings(left.id, right.id)),
});

const validateFixtureShape = (fixture) => {
  const fixtureSchema = readJson(fixtureSchemaPath);
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(
    fixtureSchema,
  );
  if (!validateSchema(fixture)) {
    fail(
      `runtime reconciliation uncertainty fixture schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
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
      fail(`duplicate runtime reconciliation uncertainty case: ${scenario.id}`);
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
    const missingParentKeys = new Set();
    for (const missingParent of scenario.uncertainty.missingParents) {
      const parentKey = `${missingParent.traceId}:${missingParent.parentSpanId}`;
      const childKey = `${missingParent.traceId}:${missingParent.childSpanId}`;
      if (!scenario.dropSpanIds.includes(parentKey)) {
        fail(
          `case ${scenario.id} declares a missing parent that was not dropped: ${parentKey}`,
        );
      }
      if (
        !baseSpanKeys.has(childKey) ||
        scenario.dropSpanIds.includes(childKey)
      ) {
        fail(
          `case ${scenario.id} missing-parent child must remain in the sampled trace: ${childKey}`,
        );
      }
      missingParentKeys.add(`${parentKey}->${childKey}`);
    }
    if (
      new Set(
        scenario.uncertainty.missingParents.map(
          (item) =>
            `${item.traceId}:${item.parentSpanId}->${item.traceId}:${item.childSpanId}`,
        ),
      ).size !== missingParentKeys.size
    ) {
      fail(`case ${scenario.id} repeats a missing-parent relationship`);
    }
  }
  if (!caseIds.has(fixture.baselineCase ?? "complete-synchronized")) {
    fail("uncertainty fixture must include its complete baseline case");
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

const semanticKey = (record) => {
  if (record.classification === "ambiguous") {
    return `endpoint:${record.id.slice("ambiguous:".length)}`;
  }
  if (record.staticEdgeIds.length > 0) {
    return `edge:${record.staticEdgeIds[0]}`;
  }
  const suffix = record.id.slice("observed-but-unmodeled:".length);
  return suffix.startsWith("trace:") ? suffix : `endpoint:${suffix}`;
};

const bindingConfidence = (record, input) => {
  const references = record.traceRefs.map(traceRefKey).filter(Boolean);
  if (references.length === 0) return "unknown";
  let sawInferred = false;
  for (const reference of references) {
    const binding = input.bindings.find(
      (candidate) => spanKey(candidate) === reference,
    );
    if (!binding) return "unknown";
    if (binding.confidence === "inferred") sawInferred = true;
  }
  return sawInferred ? "inferred" : "certain";
};

const confidenceFor = (record, input, scenario) => {
  if (record.classification === "modeled-not-observed") return "unknown";
  if (record.reason.includes("absent from the imported trace"))
    return "unknown";
  let confidence = bindingConfidence(record, input);
  if (record.classification === "ambiguous" && confidence === "certain") {
    confidence = "inferred";
  }
  if (
    confidence === "certain" &&
    (scenario.uncertainty.clock.uncertaintyNanoseconds > 0 ||
      scenario.uncertainty.clock.ordering !== "exact")
  ) {
    confidence = "inferred";
  }
  return confidence;
};

const deriveRecord = (record, input, scenario) => ({
  id: record.id,
  semanticKey: semanticKey(record),
  classification: record.classification,
  confidence: confidenceFor(record, input, scenario),
  uncertainty: record.uncertainty,
  observedCount: record.observedCount,
  reason: record.reason,
  evidenceRefs: sorted(record.evidenceRefs),
});

const missingParentTouches = (scenario, subject) =>
  scenario.uncertainty.missingParents.some(
    (missingParent) =>
      subject.includes(missingParent.parentSpanId) ||
      subject.includes(missingParent.childSpanId),
  );

const reasonCodeFor = (scenario, subject, kind) => {
  if (missingParentTouches(scenario, subject)) return "missing-parent";
  if (scenario.uncertainty.sampling.strategy !== "complete") return "sampling";
  if (
    kind === "confidence" &&
    (scenario.uncertainty.clock.uncertaintyNanoseconds > 0 ||
      scenario.uncertainty.clock.ordering !== "exact")
  ) {
    return "clock";
  }
  return kind === "confidence" ? "binding-confidence" : "sampling";
};

const explainChange = (change) => {
  const subject = change.subject;
  if (change.reasonCode === "missing-parent") {
    return `The sampled trace contains an explicitly missing parent for ${subject}; the resulting unmodeled evidence is not proof that the behavior is absent.`;
  }
  if (change.reasonCode === "clock") {
    return `Clock offset or ordering uncertainty changes confidence for ${subject} only; it does not change the runtime/static classification.`;
  }
  if (change.reasonCode === "binding-confidence") {
    return `The explicit span-to-node binding confidence changed for ${subject}; no unobserved behavior is treated as absent.`;
  }
  return `Sampling changed the retained observations for ${subject}; missing spans are not treated as absent, so the report explains the classification change as evidence of limited observation.`;
};

const compareCases = (baselineRecords, currentRecords, scenario) => {
  const baselineByKey = new Map(
    baselineRecords.map((record) => [record.semanticKey, record]),
  );
  const currentByKey = new Map(
    currentRecords.map((record) => [record.semanticKey, record]),
  );
  const subjects = sorted(
    new Set([...baselineByKey.keys(), ...currentByKey.keys()]),
  );
  const changes = [];
  for (const subject of subjects) {
    const before = baselineByKey.get(subject);
    const after = currentByKey.get(subject);
    if (!before && after) {
      const change = {
        kind: "classification",
        subject,
        from: null,
        to: after.classification,
        reasonCode: reasonCodeFor(scenario, subject, "classification"),
      };
      changes.push({ ...change, explanation: explainChange(change) });
      continue;
    }
    if (before && !after) {
      const change = {
        kind: "classification",
        subject,
        from: before.classification,
        to: null,
        reasonCode: reasonCodeFor(scenario, subject, "classification"),
      };
      changes.push({ ...change, explanation: explainChange(change) });
      continue;
    }
    if (!before || !after) continue;
    if (before.classification !== after.classification) {
      const change = {
        kind: "classification",
        subject,
        from: before.classification,
        to: after.classification,
        reasonCode: reasonCodeFor(scenario, subject, "classification"),
      };
      changes.push({ ...change, explanation: explainChange(change) });
    }
    if (before.confidence !== after.confidence) {
      const change = {
        kind: "confidence",
        subject,
        from: before.confidence,
        to: after.confidence,
        reasonCode: reasonCodeFor(scenario, subject, "confidence"),
      };
      changes.push({ ...change, explanation: explainChange(change) });
    }
  }
  return sortChanges(changes);
};

const countValues = (records) => ({
  "observed-and-modeled": records.filter(
    (record) => record.classification === "observed-and-modeled",
  ).length,
  "modeled-not-observed": records.filter(
    (record) => record.classification === "modeled-not-observed",
  ).length,
  "observed-but-unmodeled": records.filter(
    (record) => record.classification === "observed-but-unmodeled",
  ).length,
  ambiguous: records.filter((record) => record.classification === "ambiguous")
    .length,
});

const confidenceCounts = (records) => ({
  certain: records.filter((record) => record.confidence === "certain").length,
  inferred: records.filter((record) => record.confidence === "inferred").length,
  unknown: records.filter((record) => record.confidence === "unknown").length,
});

const evaluateCase = (baseInput, scenario, baselineRecords) => {
  const input = sampledInput(baseInput, scenario);
  const result = RuntimeReconciliationSchema.parse(
    reconcileRuntimeTrace(input),
  );
  const repeat = RuntimeReconciliationSchema.parse(
    reconcileRuntimeTrace(input),
  );
  if (stableStringify(result) !== stableStringify(repeat)) {
    fail(`case ${scenario.id} is not deterministic across repeated evaluation`);
  }
  const records = result.records.map((record) =>
    deriveRecord(record, input, scenario),
  );
  const changes = compareCases(baselineRecords, records, scenario);
  const classificationCounts = countValues(records);
  const actualConfidenceCounts = confidenceCounts(records);
  if (
    stableStringify(classificationCounts) !==
    stableStringify(scenario.expected.classificationCounts)
  ) {
    fail(
      `case ${scenario.id} classification counts drifted: expected ${stableStringify(scenario.expected.classificationCounts)}, got ${stableStringify(classificationCounts)}`,
    );
  }
  if (
    stableStringify(actualConfidenceCounts) !==
    stableStringify(scenario.expected.confidenceCounts)
  ) {
    fail(
      `case ${scenario.id} confidence counts drifted: expected ${stableStringify(scenario.expected.confidenceCounts)}, got ${stableStringify(actualConfidenceCounts)}`,
    );
  }
  if (
    stableStringify(changes) !==
    stableStringify(sortChanges(scenario.expected.changes))
  ) {
    fail(
      `case ${scenario.id} classification/confidence changes drifted: expected ${stableStringify(sortChanges(scenario.expected.changes))}, got ${stableStringify(changes)}`,
    );
  }
  return {
    id: scenario.id,
    description: scenario.description,
    uncertainty: scenario.uncertainty,
    records,
    changes,
    classificationCounts,
    confidenceCounts: actualConfidenceCounts,
  };
};

export const validate = (fixturePath = defaultFixturePath) => {
  const fixture = readJson(fixturePath);
  const baseInput = validateFixtureShape(fixture);
  const orderedCases = fixture.cases
    .slice()
    .sort((left, right) => compareStrings(left.id, right.id));
  const baselineScenario = fixture.cases.find(
    (scenario) => scenario.id === "complete-synchronized",
  );
  if (!baselineScenario)
    fail("complete-synchronized baseline case is required");
  const baselineInput = sampledInput(baseInput, baselineScenario);
  const baselineCore = RuntimeReconciliationSchema.parse(
    reconcileRuntimeTrace(baselineInput),
  );
  const baselineRecords = baselineCore.records.map((record) =>
    deriveRecord(record, baselineInput, baselineScenario),
  );
  const results = orderedCases.map((scenario) =>
    evaluateCase(baseInput, scenario, baselineRecords),
  );
  const classificationChanges = results.reduce(
    (total, result) =>
      total +
      result.changes.filter((change) => change.kind === "classification")
        .length,
    0,
  );
  const confidenceChanges = results.reduce(
    (total, result) =>
      total +
      result.changes.filter((change) => change.kind === "confidence").length,
    0,
  );
  const reportWithoutDigest = {
    schemaVersion: SCHEMA_VERSION,
    contract: CONTRACT,
    mediaType: MEDIA_TYPE,
    fixtureId: fixture.fixtureId,
    baselineCase: baselineScenario.id,
    cases: results,
    summary: {
      cases: results.length,
      samplingVariants: results.filter(
        (result) => result.uncertainty.sampling.strategy !== "complete",
      ).length,
      clockVariants: results.filter(
        (result) =>
          result.uncertainty.clock.ordering !== "exact" ||
          result.uncertainty.clock.uncertaintyNanoseconds > 0,
      ).length,
      aliasCases: results.filter(
        (result) => result.uncertainty.serviceAliases.length > 0,
      ).length,
      missingParentCases: results.filter(
        (result) => result.uncertainty.missingParents.length > 0,
      ).length,
      classificationChanges,
      confidenceChanges,
      unobservedNeverMeansAbsent: true,
    },
  };
  const report = {
    ...reportWithoutDigest,
    fixtureDigest: digest(stableStringify(canonicalizeFixture(fixture))),
  };
  const reportSchema = readJson(reportSchemaPath);
  const validateReport = new Ajv({ allErrors: true, strict: false }).compile(
    reportSchema,
  );
  if (!validateReport(report)) {
    fail(
      `runtime reconciliation uncertainty report schema validation failed: ${JSON.stringify(validateReport.errors)}`,
    );
  }
  if (!process.argv.includes("--print-report")) {
    const publishedReport = readJson(reportSamplePath);
    if (stableStringify(publishedReport) !== stableStringify(report)) {
      fail("published runtime reconciliation uncertainty report drifted");
    }
  }
  const reversedFixture = { ...fixture, cases: [...fixture.cases].reverse() };
  if (
    digest(stableStringify(canonicalizeFixture(reversedFixture))) !==
    report.fixtureDigest
  ) {
    fail("uncertainty fixture digest changed with scenario order");
  }
  const summary = {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    contract: CONTRACT,
    mediaType: MEDIA_TYPE,
    fixtureId: fixture.fixtureId,
    cases: results.length,
    samplingVariants: report.summary.samplingVariants,
    clockVariants: report.summary.clockVariants,
    aliasCases: report.summary.aliasCases,
    missingParentCases: report.summary.missingParentCases,
    classificationChanges,
    confidenceChanges,
    fixtureDigest: report.fixtureDigest,
  };
  return process.argv.includes("--print-report") ? report : summary;
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/runtime-reconciliation-uncertainty.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate(argumentValue("--fixture"))));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `runtime reconciliation uncertainty validation failed: ${message}`,
  );
  process.exit(1);
}
