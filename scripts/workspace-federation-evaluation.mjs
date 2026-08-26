#!/usr/bin/env node
/* global URL, console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const CONTRACT = "cartograph.workspace-federation-evaluation";
const SCHEMA_VERSION = 1;
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/workspace-federation-evaluation/report.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/workspace-federation-evaluation.v0.1.schema.json",
);
const expectedScenarioKinds = [
  "package",
  "service",
  "schema",
  "missing-repository",
  "version-skew",
  "cross-boundary-change",
];

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
};

const stableStringify = (value) => JSON.stringify(stableValue(value));

const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const fail = (message) => {
  throw new Error(`${CONTRACT} validation failed: ${message}`);
};

const assertPublicText = (value, label) => {
  if (
    /(?:\/Users\/|\/home\/|password=|BEGIN (?:RSA|OPENSSH) PRIVATE KEY|gh[pous]_[A-Za-z0-9]+)/u.test(
      value,
    )
  )
    fail(`${label} contains a private path or secret marker`);
};

const requireOrdered = (actual, expected, label) => {
  if (stableStringify(actual) !== stableStringify(expected))
    fail(`${label} must remain ordered and complete`);
};

const requireClose = (actual, expected, label) => {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-12)
    fail(`${label} drifted: expected ${expected}, found ${actual}`);
};

const unique = (values, label) => {
  if (new Set(values).size !== values.length)
    fail(`${label} contains duplicates`);
};

const validateResolution = (metrics, label) => {
  const emitted = metrics.truePositives + metrics.falsePositives;
  const expected = metrics.truePositives + metrics.falseNegatives;
  if (emitted === 0 || expected === 0)
    fail(`${label} has no evaluable records`);
  requireClose(
    metrics.precision,
    metrics.truePositives / emitted,
    `${label} precision`,
  );
  requireClose(
    metrics.recall,
    metrics.truePositives / expected,
    `${label} recall`,
  );
  return {
    truePositives: metrics.truePositives,
    falsePositives: metrics.falsePositives,
    falseNegatives: metrics.falseNegatives,
  };
};

const validateUnknownCoverage = (metrics, label) => {
  if (metrics.knownRecords + metrics.unknownRecords !== metrics.totalRecords)
    fail(`${label} total does not equal known plus unknown records`);
  requireClose(
    metrics.rate,
    metrics.unknownRecords / metrics.totalRecords,
    `${label} rate`,
  );
  return {
    knownRecords: metrics.knownRecords,
    unknownRecords: metrics.unknownRecords,
    totalRecords: metrics.totalRecords,
  };
};

const validateIdentityStability = (metrics, label) => {
  if (
    metrics.stableIdentities +
      metrics.changedIdentities +
      metrics.ambiguousIdentities !==
    metrics.comparedIdentities
  )
    fail(`${label} compared count does not match identity categories`);
  requireClose(
    metrics.stability,
    metrics.stableIdentities / metrics.comparedIdentities,
    `${label} stability`,
  );
  return {
    stableIdentities: metrics.stableIdentities,
    changedIdentities: metrics.changedIdentities,
    ambiguousIdentities: metrics.ambiguousIdentities,
    comparedIdentities: metrics.comparedIdentities,
  };
};

const validatePerformance = (metrics, label) => {
  if (metrics.warmDurationMs >= metrics.coldDurationMs)
    fail(`${label} warm duration must be below cold duration`);
  if (metrics.changedUnits + metrics.reusedUnits !== metrics.totalUnits)
    fail(`${label} units do not partition changed and reused work`);
  if (metrics.recomputedUnits !== metrics.changedUnits)
    fail(`${label} recomputed units must equal changed units`);
  requireClose(
    metrics.speedup,
    metrics.coldDurationMs / metrics.warmDurationMs,
    `${label} speedup`,
  );
  return {
    coldDurationMs: metrics.coldDurationMs,
    warmDurationMs: metrics.warmDurationMs,
    totalUnits: metrics.totalUnits,
    changedUnits: metrics.changedUnits,
    recomputedUnits: metrics.recomputedUnits,
    reusedUnits: metrics.reusedUnits,
  };
};

const validateReviewerUsefulness = (metrics, label) => {
  if (metrics.completedTasks > metrics.taskCount)
    fail(`${label} completed tasks exceed task count`);
  if (metrics.status === "not-observed") {
    if (
      metrics.taskCount !== 0 ||
      metrics.completedTasks !== 0 ||
      metrics.completionRate !== null
    )
      fail(`${label} not-observed status must not publish reviewer results`);
  } else {
    if (metrics.taskCount === 0 || metrics.completionRate === null)
      fail(
        `${label} observed status requires reviewer tasks and completion rate`,
      );
    requireClose(
      metrics.completionRate,
      metrics.completedTasks / metrics.taskCount,
      `${label} completion rate`,
    );
  }
  assertPublicText(metrics.reason, `${label} reason`);
};

const validateSemantics = (fixture) => {
  if (fixture.contract !== CONTRACT || fixture.schemaVersion !== SCHEMA_VERSION)
    fail("contract or schema version drifted");
  if (Date.parse(fixture.decision.nextReview) <= Date.parse(fixture.reviewedAt))
    fail("next review must be after the report review timestamp");

  if (
    fixture.method.network ||
    fixture.method.sourceBodiesIncluded ||
    fixture.method.credentialsUsed ||
    fixture.method.hiddenTelemetry ||
    fixture.method.userDataIncluded
  )
    fail("method violates the offline aggregate-only boundary");
  for (const limitation of fixture.method.limitations)
    assertPublicText(limitation, "method limitation");

  const portfolioIds = fixture.portfolios.map((portfolio) => portfolio.id);
  unique(portfolioIds, "portfolio IDs");
  const allScenarioKinds = new Set();
  const aggregate = {
    resolution: { truePositives: 0, falsePositives: 0, falseNegatives: 0 },
    unknownCoverage: { knownRecords: 0, unknownRecords: 0, totalRecords: 0 },
    identityStability: {
      stableIdentities: 0,
      changedIdentities: 0,
      ambiguousIdentities: 0,
      comparedIdentities: 0,
    },
    incrementalPerformance: {
      coldDurationMs: 0,
      warmDurationMs: 0,
      totalUnits: 0,
      changedUnits: 0,
      recomputedUnits: 0,
      reusedUnits: 0,
    },
    privacyFindingCount: 0,
    reviewerStatuses: new Set(),
  };

  for (const portfolio of fixture.portfolios) {
    assertPublicText(portfolio.title, `portfolio ${portfolio.id} title`);
    assertPublicText(
      portfolio.source.reference,
      `portfolio ${portfolio.id} reference`,
    );
    assertPublicText(
      portfolio.source.license,
      `portfolio ${portfolio.id} license`,
    );
    if (portfolio.source.sourceBodiesIncluded)
      fail(`portfolio ${portfolio.id} includes source bodies`);

    const repositoriesById = new Set();
    let graphNodes = 0;
    let graphEdges = 0;
    const roles = new Set();
    let missingRepositories = 0;
    for (const repository of portfolio.repositories) {
      if (repositoriesById.has(repository.id))
        fail(
          `portfolio ${portfolio.id} contains duplicate repository ${repository.id}`,
        );
      repositoriesById.add(repository.id);
      roles.add(repository.role);
      if (repository.status === "missing") {
        missingRepositories += 1;
        if (repository.revision !== null || repository.version !== null)
          fail(
            `missing repository ${repository.id} has a pinned revision or version`,
          );
        if (repository.graphNodes !== 0 || repository.graphEdges !== 0)
          fail(`missing repository ${repository.id} has graph cardinality`);
      } else if (repository.revision === null || repository.version === null) {
        fail(`present repository ${repository.id} lacks revision or version`);
      }
      assertPublicText(
        repository.identity,
        `repository ${repository.id} identity`,
      );
      graphNodes += repository.graphNodes;
      graphEdges += repository.graphEdges;
    }
    if (!roles.has("package") || !roles.has("service") || !roles.has("schema"))
      fail(
        `portfolio ${portfolio.id} does not cover package, service, and schema roles`,
      );
    if (missingRepositories === 0)
      fail(`portfolio ${portfolio.id} does not include a missing repository`);
    if (
      graphNodes !== portfolio.declaredSize.graphNodes ||
      graphEdges !== portfolio.declaredSize.graphEdges ||
      portfolio.repositories.length !== portfolio.declaredSize.repositories
    )
      fail(
        `portfolio ${portfolio.id} declared size does not match repository records`,
      );

    const scenarioIds = new Set();
    const scenarioKinds = portfolio.scenarios.map((scenario) => scenario.kind);
    requireOrdered(
      scenarioKinds,
      expectedScenarioKinds,
      `portfolio ${portfolio.id} scenario kinds`,
    );
    for (const scenario of portfolio.scenarios) {
      if (scenarioIds.has(scenario.id))
        fail(
          `portfolio ${portfolio.id} contains duplicate scenario ${scenario.id}`,
        );
      scenarioIds.add(scenario.id);
      allScenarioKinds.add(scenario.kind);
      if (
        scenario.expected.state !== scenario.observed.state ||
        scenario.expected.count !== scenario.observed.count
      )
        fail(
          `scenario ${scenario.id} observed outcome differs from its replay expectation`,
        );
      assertPublicText(
        scenario.description,
        `scenario ${scenario.id} description`,
      );
      assertPublicText(
        scenario.evidenceRef,
        `scenario ${scenario.id} evidence`,
      );
    }

    const metrics = portfolio.metrics;
    const resolution = validateResolution(
      metrics.resolution,
      `portfolio ${portfolio.id}`,
    );
    const unknownCoverage = validateUnknownCoverage(
      metrics.unknownCoverage,
      `portfolio ${portfolio.id}`,
    );
    const identityStability = validateIdentityStability(
      metrics.identityStability,
      `portfolio ${portfolio.id}`,
    );
    const performance = validatePerformance(
      metrics.incrementalPerformance,
      `portfolio ${portfolio.id}`,
    );
    validateReviewerUsefulness(
      metrics.reviewerUsefulness,
      `portfolio ${portfolio.id}`,
    );
    if (
      metrics.privacy.network ||
      metrics.privacy.hiddenTelemetry ||
      metrics.privacy.sourceBodiesIncluded ||
      metrics.privacy.findingCount !== metrics.privacy.findings.length
    )
      fail(`portfolio ${portfolio.id} privacy boundary is invalid`);
    for (const finding of metrics.privacy.findings)
      assertPublicText(finding, `portfolio ${portfolio.id} privacy finding`);
    for (const limitation of portfolio.limitations)
      assertPublicText(limitation, `portfolio ${portfolio.id} limitation`);

    for (const key of Object.keys(resolution))
      aggregate.resolution[key] += resolution[key];
    for (const key of Object.keys(unknownCoverage))
      aggregate.unknownCoverage[key] += unknownCoverage[key];
    for (const key of Object.keys(identityStability))
      aggregate.identityStability[key] += identityStability[key];
    for (const key of Object.keys(performance))
      aggregate.incrementalPerformance[key] += performance[key];
    aggregate.privacyFindingCount += metrics.privacy.findingCount;
    aggregate.reviewerStatuses.add(metrics.reviewerUsefulness.status);
  }

  requireOrdered(
    fixture.summary.scenarioKinds,
    expectedScenarioKinds,
    "summary scenario kinds",
  );
  requireOrdered(
    [...allScenarioKinds].sort(),
    [...expectedScenarioKinds].sort(),
    "portfolio scenario coverage",
  );
  if (fixture.summary.portfolioCount !== fixture.portfolios.length)
    fail("summary portfolio count drifted");

  const summaryResolution = fixture.summary.resolution;
  for (const key of ["truePositives", "falsePositives", "falseNegatives"])
    if (summaryResolution[key] !== aggregate.resolution[key])
      fail(`summary resolution ${key} drifted`);
  requireClose(
    summaryResolution.precision,
    aggregate.resolution.truePositives /
      (aggregate.resolution.truePositives +
        aggregate.resolution.falsePositives),
    "summary resolution precision",
  );
  requireClose(
    summaryResolution.recall,
    aggregate.resolution.truePositives /
      (aggregate.resolution.truePositives +
        aggregate.resolution.falseNegatives),
    "summary resolution recall",
  );

  for (const key of ["knownRecords", "unknownRecords", "totalRecords"])
    if (fixture.summary.unknownCoverage[key] !== aggregate.unknownCoverage[key])
      fail(`summary unknown coverage ${key} drifted`);
  requireClose(
    fixture.summary.unknownCoverage.rate,
    aggregate.unknownCoverage.unknownRecords /
      aggregate.unknownCoverage.totalRecords,
    "summary unknown coverage rate",
  );

  for (const key of [
    "stableIdentities",
    "changedIdentities",
    "ambiguousIdentities",
    "comparedIdentities",
  ])
    if (
      fixture.summary.identityStability[key] !==
      aggregate.identityStability[key]
    )
      fail(`summary identity stability ${key} drifted`);
  requireClose(
    fixture.summary.identityStability.stability,
    aggregate.identityStability.stableIdentities /
      aggregate.identityStability.comparedIdentities,
    "summary identity stability",
  );

  for (const key of [
    "coldDurationMs",
    "warmDurationMs",
    "totalUnits",
    "changedUnits",
    "recomputedUnits",
    "reusedUnits",
  ])
    if (
      fixture.summary.incrementalPerformance[key] !==
      aggregate.incrementalPerformance[key]
    )
      fail(`summary incremental performance ${key} drifted`);
  requireClose(
    fixture.summary.incrementalPerformance.speedup,
    aggregate.incrementalPerformance.coldDurationMs /
      aggregate.incrementalPerformance.warmDurationMs,
    "summary incremental performance speedup",
  );
  if (fixture.summary.privacyFindingCount !== aggregate.privacyFindingCount)
    fail("summary privacy finding count drifted");
  const reviewerStatus =
    aggregate.reviewerStatuses.size === 1 &&
    aggregate.reviewerStatuses.has("observed")
      ? "observed"
      : "not-observed";
  if (fixture.summary.reviewerUsefulnessStatus !== reviewerStatus)
    fail("summary reviewer usefulness status drifted");
  if (fixture.decision.outcome === "graduate" && reviewerStatus !== "observed")
    fail("graduate decision requires observed reviewer usefulness");
  assertPublicText(fixture.decision.rationale, "decision rationale");
  assertPublicText(fixture.decision.allowedScope, "decision allowed scope");
  for (const requirement of fixture.decision.requiredBeforeChange)
    assertPublicText(requirement, "decision requirement");
  for (const field of ["source", "license", "reference", "transformation"])
    assertPublicText(fixture.provenance[field], `provenance ${field}`);
};

export const validate = (fixturePath = defaultFixturePath) => {
  const fixture = readJson(fixturePath);
  const schema = readJson(schemaPath);
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(
    schema,
  );
  if (!validateSchema(fixture))
    fail(`schema validation failed: ${JSON.stringify(validateSchema.errors)}`);
  validateSemantics(fixture);
  return {
    ok: true,
    contract: CONTRACT,
    schemaVersion: SCHEMA_VERSION,
    evaluationId: fixture.evaluationId,
    portfolios: fixture.summary.portfolioCount,
    scenarioKinds: fixture.summary.scenarioKinds,
    precision: fixture.summary.resolution.precision,
    recall: fixture.summary.resolution.recall,
    unknownCoverage: fixture.summary.unknownCoverage.rate,
    identityStability: fixture.summary.identityStability.stability,
    incrementalSpeedup: fixture.summary.incrementalPerformance.speedup,
    reviewerUsefulness: fixture.summary.reviewerUsefulnessStatus,
    privacyFindings: fixture.summary.privacyFindingCount,
    decision: fixture.decision.outcome,
    network: false,
    sourceBodiesIncluded: false,
    hiddenTelemetry: false,
    digest: digest(stableStringify(fixture)),
  };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node scripts/workspace-federation-evaluation.mjs validate [--fixture path]",
    );
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(validate(argumentValue("--fixture"))));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
