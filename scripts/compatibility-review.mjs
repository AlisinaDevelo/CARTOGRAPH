#!/usr/bin/env node
/* global URL, console, process */

import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/compatibility-review/scenarios.v0.1.json",
);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const ISSUE_PATTERN = /^[A-Z]-[0-9]{3}$/u;

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
  throw new Error(message);
};

const nonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const sumValues = (value) =>
  Object.values(value).reduce((total, count) => total + count, 0);

export const loadCompatibilityReview = () =>
  JSON.parse(readFileSync(fixturePath, "utf8"));

const validateRun = (run) => {
  if (!nonEmptyString(run.id)) fail("compatibility run id is required");
  if (!/^[a-z0-9-]+$/u.test(run.id))
    fail(`invalid compatibility run id: ${run.id}`);
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(run.url)
  )
    fail(`repository URL must be a public GitHub URL: ${run.id}`);
  if (!nonEmptyString(run.repository) || !nonEmptyString(run.license))
    fail(`repository metadata is incomplete: ${run.id}`);
  if (!COMMIT_PATTERN.test(run.commit))
    fail(`invalid source commit: ${run.id}`);
  if (!nonEmptyString(run.tsconfig)) fail(`tsconfig is required: ${run.id}`);
  if (!new Set(["analyzed", "failed"]).has(run.status))
    fail(`invalid compatibility status: ${run.id}`);
  if (!run.counts || typeof run.counts !== "object")
    fail(`compatibility counts are required: ${run.id}`);
  for (const field of [
    "nodes",
    "edges",
    "diagnostics",
    "supported",
    "unknown",
    "failed",
  ]) {
    if (!Number.isInteger(run.counts[field]) || run.counts[field] < 0)
      fail(`invalid ${field} count: ${run.id}`);
  }
  if (!run.supportedConstructs || !run.unknownDiagnostics)
    fail(`construct and diagnostic counts are required: ${run.id}`);
  if (sumValues(run.supportedConstructs) !== run.counts.supported)
    fail(`supported construct total drift: ${run.id}`);
  if (sumValues(run.unknownDiagnostics) !== run.counts.unknown)
    fail(`unknown diagnostic total drift: ${run.id}`);
  if (!nonEmptyString(run.feedback)) fail(`feedback is required: ${run.id}`);
  if (
    !Array.isArray(run.followUps) ||
    run.followUps.length === 0 ||
    run.followUps.some((issue) => !ISSUE_PATTERN.test(issue))
  )
    fail(`follow-up issue IDs are required: ${run.id}`);

  if (run.status === "analyzed") {
    if (!SHA256_PATTERN.test(run.snapshotSha256))
      fail(`analyzed run needs a snapshot digest: ${run.id}`);
    if (run.counts.edges !== run.counts.supported)
      fail(`analyzed supported edge count drift: ${run.id}`);
    if (run.counts.diagnostics !== run.counts.unknown)
      fail(`analyzed unknown diagnostic count drift: ${run.id}`);
    if (run.counts.failed !== 0 || run.failure !== undefined)
      fail(`analyzed run contains failure output: ${run.id}`);
  } else {
    if (run.snapshotSha256 !== null)
      fail(`failed run has a snapshot digest: ${run.id}`);
    if (run.counts.failed !== 1 || run.failure === undefined)
      fail(`failed run needs one failure record: ${run.id}`);
    if (!nonEmptyString(run.failure.code) || !nonEmptyString(run.failure.stage))
      fail(`failed run needs a code and stage: ${run.id}`);
    if (!nonEmptyString(run.failure.message))
      fail(`failed run needs a bounded message: ${run.id}`);
    if (
      run.counts.nodes !== 0 ||
      run.counts.edges !== 0 ||
      run.counts.diagnostics !== 0
    )
      fail(`failed run must not claim graph output: ${run.id}`);
  }
};

export const runCompatibilityReview = () => {
  const fixture = loadCompatibilityReview();
  if (
    fixture.schemaVersion !== 1 ||
    fixture.contract !== "cartograph.compatibility-review" ||
    fixture.reviewId !== "r005-v0.1"
  )
    fail("unsupported compatibility review contract");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(fixture.reviewedAt))
    fail("review timestamp must be UTC and second-precision");
  if (!fixture.tool || !COMMIT_PATTERN.test(fixture.tool.commit))
    fail("tool commit is required");
  if (
    !nonEmptyString(fixture.sourcePolicy) ||
    !/no third-party source/iu.test(fixture.sourcePolicy)
  )
    fail("source policy must forbid third-party source redistribution");
  if (!Array.isArray(fixture.runs) || fixture.runs.length < 3)
    fail(
      "compatibility review must analyze at least three repositories or snapshots",
    );

  const ids = new Set();
  for (const run of fixture.runs) {
    if (ids.has(run.id)) fail(`duplicate compatibility run: ${run.id}`);
    ids.add(run.id);
    validateRun(run);
  }
  const analyzed = fixture.runs.filter((run) => run.status === "analyzed");
  const failed = fixture.runs.filter((run) => run.status === "failed");
  if (analyzed.length < 3)
    fail("compatibility review needs three successful analyses");
  if (failed.length === 0)
    fail("compatibility review must retain observed failures");

  const report = {
    ok: true,
    contract: fixture.contract,
    reviewId: fixture.reviewId,
    repositories: fixture.runs.length,
    analyzed: analyzed.length,
    failed: failed.length,
    supportedConstructs: analyzed.reduce(
      (total, run) => total + run.counts.supported,
      0,
    ),
    unknownDiagnostics: analyzed.reduce(
      (total, run) => total + run.counts.unknown,
      0,
    ),
    failureCodes: failed.map((run) => run.failure.code).sort(),
    followUpIssues: [
      ...new Set(fixture.runs.flatMap((run) => run.followUps)),
    ].sort(),
    fixtureDigest: `sha256:${createHash("sha256")
      .update(stableStringify(fixture))
      .digest("hex")}`,
  };
  return report;
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    const report = runCompatibilityReview();
    console.log(JSON.stringify(report));
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath !== undefined) {
      appendFileSync(
        summaryPath,
        `## CARTOGRAPH compatibility review\n\n- Repositories: ${report.repositories}\n- Successful analyses: ${report.analyzed}\n- Bounded failures: ${report.failed}\n- Supported constructs: ${report.supportedConstructs}\n- Unknown diagnostics: ${report.unknownDiagnostics}\n- Result: passed\n`,
        "utf8",
      );
    }
  } catch (error) {
    console.error(`compatibility review validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
