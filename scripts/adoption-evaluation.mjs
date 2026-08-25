#!/usr/bin/env node
/* global URL, console, process */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const CONTRACT = "cartograph.repository-adoption-evaluation";
const SCHEMA_VERSION = 1;
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/adoption-evaluation/report.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/adoption-evaluation.v0.1.schema.json",
);
const expectedRunIds = ["hono", "tsyringe", "zustand"];
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

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

const assertEvidenceRef = (value, label) => {
  assertPublicText(value, label);
  const [relativePath] = value.split("#", 1);
  if (/^[A-Z]+-[0-9]+$/u.test(relativePath)) return;
  if (!existsSync(resolve(repositoryRoot, relativePath)))
    fail(
      `${label} does not resolve to a checked-in path or roadmap issue: ${value}`,
    );
};

const assertCommit = (value, label) => {
  if (!COMMIT_PATTERN.test(value)) fail(`${label} is not a pinned commit`);
};

const validateSemantics = (fixture) => {
  if (
    fixture.contract !== CONTRACT ||
    fixture.schemaVersion !== SCHEMA_VERSION ||
    fixture.evaluationId !== "r017-v0.1"
  )
    fail("contract, schema version, or evaluation ID drifted");
  assertCommit(fixture.tool.commit, "tool commit");
  const method = fixture.method;
  if (
    method.replayMode !== "aggregate-fixture" ||
    !method.rerunnable ||
    method.network ||
    method.sourceBodiesIncluded ||
    method.credentialsUsed ||
    method.hiddenTelemetry ||
    method.userDataIncluded ||
    method.sourceAcquisition !== "not-run"
  )
    fail("method must remain an offline aggregate replay without collection");
  assertPublicText(method.command, "method command");
  for (const limitation of method.limitations)
    assertPublicText(limitation, "method limitation");

  const runIds = fixture.runs.map((run) => run.id);
  if (
    new Set(runIds).size !== runIds.length ||
    stableStringify(runIds) !== stableStringify(expectedRunIds)
  )
    fail("run inventory drifted");

  for (const run of fixture.runs) {
    assertPublicText(run.repository, `run ${run.id} repository`);
    assertPublicText(run.license, `run ${run.id} license`);
    assertCommit(run.commit, `run ${run.id} source commit`);
    assertCommit(run.scanRevision.toolCommit, `run ${run.id} tool commit`);
    if (run.scanRevision.toolCommit !== fixture.tool.commit)
      fail(`run ${run.id} scan tool commit differs from report tool`);
    if (
      run.languages.status !== "observed" ||
      !run.languages.values.includes("TypeScript")
    )
      fail(`run ${run.id} must record TypeScript as observed`);
    if (
      run.frameworks.status !== "not-observed" ||
      run.frameworks.values.length !== 0 ||
      run.repositorySize.status !== "not-observed" ||
      run.repositorySize.files !== null ||
      run.repositorySize.sourceLines !== null ||
      run.repositorySize.sourceBytes !== null ||
      run.timing.status !== "not-observed" ||
      run.timing.durationMs !== null ||
      run.reviewerUsefulness.status !== "not-observed" ||
      run.reviewerUsefulness.reviewerCount !== 0 ||
      run.reviewerUsefulness.rating !== null
    )
      fail(`run ${run.id} publishes an unobserved value`);
    if (
      run.coverage.graphEdges !== run.coverage.supportedEdges ||
      run.coverage.diagnostics !== run.coverage.unknownDiagnostics ||
      Object.values(run.unknowns).reduce((sum, count) => sum + count, 0) !==
        run.coverage.unknownDiagnostics
    )
      fail(`run ${run.id} aggregate coverage counts drifted`);
    if (!SHA256_PATTERN.test(run.snapshotSha256))
      fail(`run ${run.id} needs the pinned aggregate snapshot digest`);
    if (run.replayCommand !== method.command)
      fail(`run ${run.id} replay command differs from the method command`);
    assertEvidenceRef(run.replayFixture, `run ${run.id} replay fixture`);
    for (const value of [
      run.feedback,
      run.repositorySize.reason,
      run.languages.reason,
      run.frameworks.reason,
      run.coverage.reason,
      run.timing.reason,
      run.reviewerUsefulness.reason,
    ])
      assertPublicText(value, `run ${run.id} metadata`);
    for (const limitation of run.limitations)
      assertPublicText(limitation, `run ${run.id} limitation`);
  }

  const summary = fixture.summary;
  const expectedCount = fixture.runs.length;
  if (
    summary.runCount !== expectedCount ||
    summary.pinnedRevisionCount !== expectedCount ||
    summary.rerunnableRunCount !== expectedCount ||
    summary.aggregateObservedCount !== expectedCount ||
    summary.notObservedSizeCount !== expectedCount ||
    summary.notObservedTimingCount !== expectedCount ||
    summary.notObservedReviewerUsefulnessCount !== expectedCount
  )
    fail("summary counts drifted");
  if (
    summary.network ||
    summary.sourceBodiesIncluded ||
    summary.credentialsUsed ||
    summary.hiddenTelemetry ||
    summary.userDataIncluded ||
    summary.certificationClaim !== "deferred" ||
    summary.supportGuaranteeClaim !== "deferred" ||
    summary.adoptionClaim !== "deferred"
  )
    fail("summary violates the no-collection or no-claim boundary");

  for (const value of [
    fixture.evaluationId,
    fixture.provenance.source,
    fixture.provenance.reference,
    fixture.provenance.transformation,
  ])
    assertPublicText(value, "fixture metadata");
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
    reviewedAt: fixture.reviewedAt,
    runs: fixture.runs.length,
    pinnedRevisions: fixture.summary.pinnedRevisionCount,
    rerunnableRuns: fixture.summary.rerunnableRunCount,
    aggregateObservedRuns: fixture.summary.aggregateObservedCount,
    notObservedSizeRuns: fixture.summary.notObservedSizeCount,
    notObservedTimingRuns: fixture.summary.notObservedTimingCount,
    notObservedReviewerUsefulnessRuns:
      fixture.summary.notObservedReviewerUsefulnessCount,
    network: false,
    sourceBodiesIncluded: false,
    credentialsUsed: false,
    hiddenTelemetry: false,
    userDataIncluded: false,
    certificationClaim: "deferred",
    supportGuaranteeClaim: "deferred",
    adoptionClaim: "deferred",
    digest: `sha256:${createHash("sha256")
      .update(stableStringify(fixture))
      .digest("hex")}`,
  };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node scripts/adoption-evaluation.mjs validate [--fixture path]",
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
