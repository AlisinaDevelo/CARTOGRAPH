#!/usr/bin/env node
/* global URL, console, process */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

import { stableStringify } from "../src/index.js";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(
  argumentValue("--root") ?? fileURLToPath(new URL("..", import.meta.url)),
);
const reportPath = resolve(
  argumentValue("--report") ??
    "test/fixtures/language-expansion-gate/report.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/language-expansion-gate.v0.1.schema.json",
);

const CONTRACT = "cartograph.language-expansion-gate";
const REQUIRED_METRICS = [
  "conformance",
  "semantic-coverage",
  "unknown-rate",
  "precision",
  "recall",
  "performance",
  "maintenance-cost",
  "demand",
  "security-ownership",
  "evidence-completeness",
];
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const fail = (message, metric) => {
  throw new Error(
    `cartograph.language-expansion-gate validation failed${
      metric === undefined ? "" : ` [metric=${metric}]`
    }: ${message}`,
  );
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

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

const compare = (operator, actual, target) => {
  if (operator === ">=") return actual >= target;
  if (operator === "<=") return actual <= target;
  return actual === target;
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
  for (const metric of REQUIRED_METRICS) {
    if (!thresholdById.has(metric))
      fail("required threshold is missing", metric);
    if (!measurementById.has(metric))
      fail("required measurement is missing", metric);
  }
  if (thresholdById.size !== REQUIRED_METRICS.length)
    fail("threshold set contains an undeclared metric");
  if (measurementById.size !== REQUIRED_METRICS.length)
    fail("measurement set contains an undeclared metric");

  const measurementResults = [];
  for (const metric of REQUIRED_METRICS) {
    const threshold = thresholdById.get(metric);
    const measurement = measurementById.get(metric);
    const evaluated = compare(
      threshold.operator,
      measurement.value,
      threshold.target,
    );
    const expectedStatus = evaluated ? "pass" : "miss";
    if (measurement.status !== expectedStatus)
      fail(
        `status does not match threshold (${expectedStatus} required)`,
        metric,
      );
    for (const reference of measurement.evidenceRefs) {
      if (reference.startsWith("command:")) continue;
      containedPath(reference, `evidence reference for ${metric}`);
    }
    measurementResults.push({
      id: metric,
      value: measurement.value,
      target: threshold.target,
      operator: threshold.operator,
      status: measurement.status,
    });
  }
  const observedMisses = measurementResults
    .filter((measurement) => measurement.status === "miss")
    .map((measurement) => measurement.id)
    .sort();
  const declaredMisses = [...report.decision.failedGraduateCriteria].sort();
  if (stableStringify(observedMisses) !== stableStringify(declaredMisses))
    fail(
      `failed graduation criteria do not match observed misses: expected ${JSON.stringify(
        observedMisses,
      )}, found ${JSON.stringify(declaredMisses)}`,
    );

  const matrix = readJson(
    containedPath("schema/adapter-support-matrix.v0.1.json", "support matrix"),
  );
  const rust = matrix.entries.find((entry) => entry.id === "cartograph.rust");
  const language = matrix.entries.find((entry) => entry.id === "language.rust");
  if (rust?.status !== "implemented")
    fail("bounded Rust adapter must remain implemented in the support matrix");
  if (language?.status !== "deferred")
    fail("broad Rust language entry must remain deferred");

  const adrPath = containedPath(report.publicAdr.path, "public ADR");
  const adrText = readFileSync(adrPath, "utf8");
  const reportDigest = `sha256:${createHash("sha256")
    .update(stableStringify(report))
    .digest("hex")}`;
  if (!adrText.includes(report.gateId))
    fail("public ADR does not identify the gate report");
  if (!adrText.includes(reportDigest))
    fail("public ADR does not contain the report digest");
  if (!adrText.includes("retain as experimental"))
    fail("public ADR does not state the selected outcome");
  if (report.publicAdr.decision !== report.decision.outcome)
    fail("public ADR decision does not match the report decision");
  if (report.decision.outcome !== "retain-experimental")
    fail("this gate fixture must retain the bounded pilot as experimental");
  if (report.decision.failedGraduateCriteria.length === 0)
    fail("an experimental decision must name a failed graduation criterion");
  if (report.decision.implementationCommitments.length !== 0)
    fail("a rejected expansion cannot create implementation commitments");
  if (!report.decision.supportBoundary.includes("language.rust"))
    fail("decision must preserve the deferred broad-language boundary");

  const raw = stableStringify(report);
  if (
    /(?:\/Users\/|password=|BEGIN (?:RSA|OPENSSH) PRIVATE KEY|ghp_[A-Za-z0-9]+)/u.test(
      raw,
    )
  )
    fail("report contains a source or secret disclosure marker");
  if (!SHA256_PATTERN.test(reportDigest))
    fail("report digest format is invalid");
  return {
    ok: true,
    contract: report.contract,
    schemaVersion: report.schemaVersion,
    gateId: report.gateId,
    reportDigest,
    candidate: report.candidate.adapterId,
    decision: report.decision.outcome,
    failedGraduateCriteria: report.decision.failedGraduateCriteria,
    metrics: measurementResults,
    implementationCommitments: report.decision.implementationCommitments.length,
    externalSources: report.provenance.externalSources,
    sourceBodiesIncluded: report.provenance.sourceBodiesIncluded,
    secretsIncluded: report.provenance.secretsIncluded,
  };
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node --import tsx scripts/language-expansion-gate.mjs validate [--root path] [--report path]",
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
          `## CARTOGRAPH language-expansion gate\n\n- Candidate: ${result.candidate}\n- Decision: ${result.decision}\n- Failed graduation criteria: ${result.failedGraduateCriteria.join(", ")}\n- Implementation commitments: ${result.implementationCommitments}\n- Result: passed\n`,
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

export { validate as validateLanguageExpansionGate };
