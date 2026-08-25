#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import {
  ArchitectureImpactAssessmentSchema,
  stableStringify,
} from "../src/core/index.ts";

const repositoryRoot = resolve(process.cwd());
const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const fixturePath = resolve(
  repositoryRoot,
  argumentValue("--fixture") ??
    "test/fixtures/architecture-impact/scenarios.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/architecture-impact-fixtures.v0.1.schema.json",
);
const impactSchemaPath = resolve(
  repositoryRoot,
  "schema/architecture-impact.v0.1.schema.json",
);
const assessmentSchemaPath = resolve(
  repositoryRoot,
  "schema/architecture-impact-evaluation.v0.1.schema.json",
);
const baselinePath = resolve(
  repositoryRoot,
  "schema/architecture-impact-evaluation.v0.1.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(
    `cartograph.architecture-impact validation failed: ${message}`,
  );
};
const compareStrings = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;
const stable = (value) => stableStringify(value);
const digest = (value) =>
  `sha256:${createHash("sha256").update(stable(value), "utf8").digest("hex")}`;
const ratio = (numerator, denominator) =>
  denominator === 0 ? (numerator === 0 ? 1 : 0) : numerator / denominator;

const impactOverreachCategory = (node) => {
  const codes = new Set((node.uncertainty ?? []).map((item) => item.code));
  for (const code of [
    "unresolved-edge",
    "boundary-stop",
    "depth-limit",
    "cycle",
    "unsupported-change",
  ]) {
    if (codes.has(code)) return code;
  }
  return "transitive-reachability";
};

const expectedCategoryKey = (entry) => `${entry.category}:${entry.count}`;
const sortedUnique = (values) => [...new Set(values)].sort(compareStrings);

const visibleUncertainty = (assessment) => {
  const counts = new Map();
  const add = (code) => counts.set(code, (counts.get(code) ?? 0) + 1);
  for (const unknown of assessment.unknowns) add(unknown.code);
  for (const node of assessment.affected)
    for (const uncertainty of node.uncertainty) add(uncertainty.code);
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => compareStrings(left.code, right.code));
};

const scoreCase = (scenario, assessment) => {
  const expected = new Set(scenario.expected.affected);
  const actual = new Set(assessment.affected.map((node) => node.id));
  const truePositives = [...actual].filter((id) => expected.has(id)).length;
  const falsePositives = [...actual].filter((id) => !expected.has(id)).length;
  const falseNegatives = [...expected].filter((id) => !actual.has(id)).length;

  const overreachCounts = new Map();
  for (const node of assessment.affected) {
    if (expected.has(node.id)) continue;
    const category = impactOverreachCategory(node);
    overreachCounts.set(category, (overreachCounts.get(category) ?? 0) + 1);
  }
  const overreachCategories = [...overreachCounts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) =>
      compareStrings(expectedCategoryKey(left), expectedCategoryKey(right)),
    );
  const uncertaintyCodes = visibleUncertainty(assessment);
  const expectedOverreach = [...scenario.expected.overreachCategories].sort(
    (left, right) =>
      compareStrings(expectedCategoryKey(left), expectedCategoryKey(right)),
  );
  if (
    stable(overreachCategories) !== stable(expectedOverreach) ||
    stable(uncertaintyCodes.map((item) => item.code)) !==
      stable([...scenario.expected.uncertaintyCodes].sort(compareStrings))
  ) {
    fail(
      `${scenario.id} reviewer uncertainty or overreach categories drifted: ${JSON.stringify({ overreachCategories, uncertaintyCodes })}`,
    );
  }

  return {
    id: scenario.id,
    changeKind: assessment.changeKind,
    expectedAffected: [...scenario.expected.affected].sort(compareStrings),
    actualAffected: [...actual].sort(compareStrings),
    truePositives,
    falsePositives,
    falseNegatives,
    precision: ratio(truePositives, actual.size),
    recall: ratio(truePositives, expected.size),
    overreachCategories,
    uncertaintyCodes,
    reviewerReasons: assessment.affected.map((node) => ({
      nodeId: node.id,
      codes: sortedUnique(node.reasons.map((reason) => reason.code)),
      messages: sortedUnique(node.reasons.map((reason) => reason.message)),
    })),
    pass: falseNegatives === 0,
  };
};

const aggregateMetrics = (cases) => {
  const expectedAffected = cases.reduce(
    (total, item) => total + item.expectedAffected.length,
    0,
  );
  const actualAffected = cases.reduce(
    (total, item) => total + item.actualAffected.length,
    0,
  );
  const truePositives = cases.reduce(
    (total, item) => total + item.truePositives,
    0,
  );
  const falsePositives = cases.reduce(
    (total, item) => total + item.falsePositives,
    0,
  );
  const falseNegatives = cases.reduce(
    (total, item) => total + item.falseNegatives,
    0,
  );
  const overreach = new Map();
  const uncertainty = new Map();
  for (const item of cases) {
    for (const entry of item.overreachCategories)
      overreach.set(
        entry.category,
        (overreach.get(entry.category) ?? 0) + entry.count,
      );
    for (const entry of item.uncertaintyCodes)
      uncertainty.set(
        entry.code,
        (uncertainty.get(entry.code) ?? 0) + entry.count,
      );
  }
  return {
    cases: cases.length,
    expectedAffected,
    actualAffected,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: ratio(truePositives, actualAffected),
    recall: ratio(truePositives, expectedAffected),
    overreachCategories: [...overreach.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((left, right) =>
        compareStrings(expectedCategoryKey(left), expectedCategoryKey(right)),
      ),
    uncertaintyCodes: [...uncertainty.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) =>
        compareStrings(
          `${left.code}:${left.count}`,
          `${right.code}:${right.count}`,
        ),
      ),
    reviewerReasonCount: cases.reduce(
      (total, item) => total + item.reviewerReasons.length,
      0,
    ),
  };
};

const byChangeKind = (cases) => {
  const groups = new Map();
  for (const item of cases) {
    const group = groups.get(item.changeKind) ?? [];
    group.push(item);
    groups.set(item.changeKind, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([changeKind, group]) => {
      const metrics = aggregateMetrics(group);
      return {
        changeKind,
        cases: group.length,
        precision: metrics.precision,
        recall: metrics.recall,
        overreachCategories: metrics.overreachCategories,
        uncertaintyCodes: metrics.uncertaintyCodes,
      };
    });
};

const validate = async () => {
  const fixture = readJson(fixturePath);
  const ajv = new Ajv({ allErrors: true });
  const validateFixture = ajv.compile(readJson(fixtureSchemaPath));
  const validateImpact = ajv.compile(readJson(impactSchemaPath));
  const validateReport = ajv.compile(readJson(assessmentSchemaPath));
  if (!validateFixture(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validateFixture.errors)}`,
    );
  if (
    fixture.scope.network ||
    fixture.scope.filesystemWrites ||
    fixture.scope.sourceBodiesIncluded ||
    fixture.scope.execution ||
    !fixture.scope.deterministic
  )
    fail(
      "fixture scope must remain local, read-only, source-free, and deterministic",
    );
  const serializedFixture = stable(fixture).toLowerCase();
  if (
    /"(?:body|content|sourcebody|sourcecode|sourcetext|snippet|excerpt)"/u.test(
      serializedFixture,
    )
  )
    fail("fixture contains a source-body field");

  const { assessArchitectureImpact, serializeArchitectureImpactAssessment } =
    await import("../src/core/index.ts");
  const scenarioIds = new Set();
  const caseResults = [];
  const graphSerializations = new Map();
  for (const scenario of fixture.scenarios) {
    if (scenarioIds.has(scenario.id)) fail(`duplicate scenario ${scenario.id}`);
    scenarioIds.add(scenario.id);
    const graph = fixture.graphs[scenario.graphId];
    if (graph === undefined)
      fail(`${scenario.id} references missing graph ${scenario.graphId}`);
    if (!validateImpact(scenario.impact))
      fail(
        `${scenario.id} impact schema validation failed: ${JSON.stringify(validateImpact.errors)}`,
      );
    const before = stable(graph);
    graphSerializations.set(scenario.graphId, before);
    const assessment = assessArchitectureImpact(graph, scenario.impact);
    try {
      ArchitectureImpactAssessmentSchema.parse(assessment);
    } catch (error) {
      fail(
        `${scenario.id} assessment schema validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const repeated = assessArchitectureImpact(graph, scenario.impact);
    if (
      serializeArchitectureImpactAssessment(assessment) !==
      serializeArchitectureImpactAssessment(repeated)
    )
      fail(`${scenario.id} assessment is not byte-stable across repeated runs`);
    const result = scoreCase(scenario, assessment);
    caseResults.push(result);
    if (stable(graph) !== before)
      fail(`${scenario.id} mutated its input graph`);
  }
  for (const [graphId, before] of graphSerializations) {
    if (stable(fixture.graphs[graphId]) !== before)
      fail(`${graphId} was mutated`);
  }

  const reportWithoutDigest = {
    schemaVersion: 1,
    contract: "cartograph.architecture-impact-evaluation",
    fixtureId: fixture.fixtureId,
    fixtureDigest: digest(fixture),
    cases: caseResults.sort((left, right) => compareStrings(left.id, right.id)),
    overall: aggregateMetrics(caseResults),
    byChangeKind: byChangeKind(caseResults),
    deterministic: true,
    readOnly: true,
  };
  const report = {
    ...reportWithoutDigest,
    reportDigest: digest(reportWithoutDigest),
  };
  if (!validateReport(report))
    fail(
      `evaluation report schema validation failed: ${JSON.stringify(validateReport.errors)}`,
    );

  if (process.argv.includes("--write")) {
    writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } else {
    if (!existsSync(baselinePath))
      fail("published architecture impact evaluation report is missing");
    const baseline = readJson(baselinePath);
    if (stable(report) !== stable(baseline))
      fail("published architecture impact evaluation report drifted");
  }

  return {
    ok: true,
    contract: report.contract,
    schemaVersion: report.schemaVersion,
    fixtureId: report.fixtureId,
    cases: report.cases.length,
    expectedAffected: report.overall.expectedAffected,
    actualAffected: report.overall.actualAffected,
    truePositives: report.overall.truePositives,
    falsePositives: report.overall.falsePositives,
    falseNegatives: report.overall.falseNegatives,
    precision: report.overall.precision,
    recall: report.overall.recall,
    overreachCategories: report.overall.overreachCategories,
    uncertaintyCodes: report.overall.uncertaintyCodes,
    reviewerReasonCount: report.overall.reviewerReasonCount,
    deterministic: report.deterministic,
    readOnly: report.readOnly,
    fixtureDigest: report.fixtureDigest,
    reportDigest: report.reportDigest,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/impact-evaluation.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(await validate()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
