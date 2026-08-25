#!/usr/bin/env node
/* global console, process */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import { stableStringify } from "../src/core/index.ts";

const CONTRACT = "cartograph.architecture-query-quality-gate";
const REQUIRED_METRICS = [
  "deterministic-correctness",
  "impact-precision",
  "impact-recall",
  "explanation-completeness",
  "resource-safety",
  "malformed-input-safety",
  "path-leakage-safety",
  "reviewer-task-completion",
  "repeatability",
  "multi-repository-readiness",
];

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const reportPath = resolve(
  repositoryRoot,
  argumentValue("--report") ??
    "test/fixtures/architecture-query-quality-gate/report.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/architecture-query-quality-gate.v0.1.schema.json",
);

const fail = (message, metric) => {
  throw new Error(
    `cartograph.architecture-query-quality-gate validation failed${
      metric === undefined ? "" : ` [metric=${metric}]`
    }: ${message}`,
  );
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const compareStrings = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;
const sorted = (values) => [...values].sort(compareStrings);

const compareThreshold = (operator, actual, target) => {
  if (operator === ">=") return actual >= target;
  if (operator === "<=") return actual <= target;
  return actual === target;
};

const containedPath = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0)
    fail(`${label} must be a non-empty repository-relative path`);
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.startsWith("~") ||
    value.includes("\0")
  )
    fail(`${label} must be repository-relative: ${value}`);
  const candidate = resolve(repositoryRoot, value);
  const relativePath = relative(repositoryRoot, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  )
    fail(`${label} escapes the repository: ${value}`);
  if (!existsSync(candidate)) fail(`${label} does not exist: ${value}`);
  return candidate;
};

const validateEvidenceRefs = (refs, label) => {
  for (const reference of refs) {
    if (reference.startsWith("command:")) {
      if (reference.length <= "command:".length)
        fail(`${label} contains an empty command reference`);
      continue;
    }
    if (/(?:https?:|file:|^\/|^~)/iu.test(reference))
      fail(`${label} contains a remote or absolute reference: ${reference}`);
    containedPath(reference, label);
  }
};

const validate = () => {
  const report = readJson(reportPath);
  const schema = readJson(schemaPath);
  const schemaValidator = new Ajv({ allErrors: true, strict: false }).compile(
    schema,
  );
  if (!schemaValidator(report))
    fail(`schema validation failed: ${JSON.stringify(schemaValidator.errors)}`);
  if (report.contract !== CONTRACT)
    fail(`unsupported contract: ${report.contract}`);
  if (
    report.scope.network ||
    report.scope.filesystemWrites ||
    report.scope.sourceBodiesIncluded ||
    report.scope.execution ||
    !report.scope.deterministic ||
    report.provenance.externalSources ||
    report.provenance.sourceBodiesIncluded ||
    report.provenance.secretsIncluded
  )
    fail(
      "report scope must remain local, read-only, source-free, and deterministic",
    );

  const thresholdById = new Map();
  for (const threshold of report.thresholds) {
    if (thresholdById.has(threshold.id))
      fail(`duplicate threshold: ${threshold.id}`, threshold.id);
    thresholdById.set(threshold.id, threshold);
  }
  const measurementById = new Map();
  for (const measurement of report.measurements) {
    if (measurementById.has(measurement.id))
      fail(`duplicate measurement: ${measurement.id}`, measurement.id);
    measurementById.set(measurement.id, measurement);
  }
  if (
    stableStringify(sorted(thresholdById.keys())) !==
    stableStringify(sorted(REQUIRED_METRICS))
  )
    fail("threshold set must exactly match the quality-gate metrics");
  if (
    stableStringify(sorted(measurementById.keys())) !==
    stableStringify(sorted(REQUIRED_METRICS))
  )
    fail("measurement set must exactly match the quality-gate metrics");

  const reviewerIds = new Set();
  for (const task of report.reviewerTasks) {
    if (reviewerIds.has(task.id)) fail(`duplicate reviewer task: ${task.id}`);
    reviewerIds.add(task.id);
    if (
      (task.completed && task.outcome !== "complete") ||
      (!task.completed && task.outcome === "complete")
    )
      fail(`reviewer task outcome disagrees with completion: ${task.id}`);
    validateEvidenceRefs(
      task.evidenceRefs,
      `evidence reference for ${task.id}`,
    );
  }
  const reviewerCompletion =
    report.reviewerTasks.filter((task) => task.completed).length /
    report.reviewerTasks.length;
  const reviewerMeasurement = measurementById.get("reviewer-task-completion");
  if (reviewerMeasurement.value !== reviewerCompletion)
    fail(
      `reviewer completion value ${reviewerMeasurement.value} does not match ${reviewerCompletion}`,
      "reviewer-task-completion",
    );

  const results = [];
  for (const metric of REQUIRED_METRICS) {
    const threshold = thresholdById.get(metric);
    const measurement = measurementById.get(metric);
    const passed = compareThreshold(
      threshold.operator,
      measurement.value,
      threshold.target,
    );
    const expectedStatus = passed ? "pass" : "miss";
    if (measurement.status !== expectedStatus)
      fail(
        `status does not match threshold (${expectedStatus} required)`,
        metric,
      );
    validateEvidenceRefs(
      measurement.evidenceRefs,
      `evidence reference for ${metric}`,
    );
    results.push({
      id: metric,
      value: measurement.value,
      target: threshold.target,
      operator: threshold.operator,
      status: measurement.status,
    });
  }

  const limitations = new Set();
  for (const limitation of report.limitations) {
    if (limitations.has(limitation.id))
      fail(`duplicate limitation: ${limitation.id}`);
    limitations.add(limitation.id);
    validateEvidenceRefs(
      limitation.evidenceRefs,
      `evidence reference for limitation ${limitation.id}`,
    );
  }
  const misses = results
    .filter((result) => result.status === "miss")
    .map((result) => result.id)
    .sort(compareStrings);
  if (
    stableStringify(misses) !==
    stableStringify([...report.decision.failedThresholds].sort(compareStrings))
  )
    fail("failed threshold list does not match measured misses");
  if (report.publicReport.decision !== report.decision.outcome)
    fail("public report decision does not match the gate decision");
  if (
    report.publicReport.multiRepositoryDecision !==
    report.decision.multiRepositoryOutcome
  )
    fail("public multi-repository decision does not match the gate decision");
  if (misses.length === 0 && report.decision.outcome !== "continue")
    fail("a gate with no failed threshold must continue");
  if (
    measurementById.get("multi-repository-readiness").value === false &&
    report.decision.multiRepositoryOutcome === "continue"
  )
    fail("multi-repository work cannot continue when readiness is false");
  validateEvidenceRefs(
    report.provenance.commands.map((command) => `command:${command}`),
    "provenance command",
  );
  const reportDigest = digest(stableStringify(report));
  const publicReportPath = containedPath(
    report.publicReport.path,
    "public report",
  );
  const publicReport = readFileSync(publicReportPath, "utf8");
  if (!publicReport.includes(report.gateId))
    fail("public report does not identify the gate");
  if (!publicReport.includes(`Report digest: ${reportDigest}`))
    fail("public report digest does not match the checked-in gate report");
  if (!publicReport.includes(`Decision: ${report.decision.outcome}`))
    fail("public report decision is missing");
  if (
    !publicReport.includes(
      `Multi-repository decision: ${report.decision.multiRepositoryOutcome}`,
    )
  )
    fail("public report multi-repository decision is missing");
  const raw = stableStringify(report);
  if (
    /(?:\/(?:Users|home|private|tmp)\/|[A-Za-z]:\\|BEGIN (?:RSA|OPENSSH) PRIVATE KEY|ghp_[A-Za-z0-9]+)/u.test(
      raw,
    )
  )
    fail("report contains an absolute path or secret disclosure marker");

  return {
    ok: true,
    contract: report.contract,
    schemaVersion: report.schemaVersion,
    gateId: report.gateId,
    reportDigest,
    measurements: results,
    reviewerTasks: report.reviewerTasks.length,
    reviewerTaskCompletion: reviewerCompletion,
    decision: report.decision.outcome,
    multiRepositoryDecision: report.decision.multiRepositoryOutcome,
    failedThresholds: misses,
    externalSources: report.provenance.externalSources,
    sourceBodiesIncluded: report.provenance.sourceBodiesIncluded,
    secretsIncluded: report.provenance.secretsIncluded,
  };
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node --import tsx scripts/query-quality-gate.mjs validate [--root path] [--report path]",
    );
    process.exitCode = 2;
  } else {
    try {
      const result = validate();
      console.log(JSON.stringify(result));
      const summaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (summaryPath !== undefined) {
        appendFileSync(
          summaryPath,
          `## CARTOGRAPH architecture-query quality gate\n\n- Decision: ${result.decision}\n- Multi-repository decision: ${result.multiRepositoryDecision}\n- Failed thresholds: ${result.failedThresholds.join(", ") || "none"}\n- Result: passed\n`,
          "utf8",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    }
  }
}

export { validate as validateArchitectureQueryQualityGate };
