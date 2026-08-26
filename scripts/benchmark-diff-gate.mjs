#!/usr/bin/env node
/* global console, process */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { validateArtifact, manifestDigest } from "./benchmark-diff.mjs";

const repositoryRoot = resolve(
  process.env.CARTOGRAPH_REPOSITORY_ROOT ?? process.cwd(),
);
const benchmarkScript = resolve(repositoryRoot, "scripts/benchmark-diff.mjs");
const manifestPath = resolve(
  repositoryRoot,
  "benchmarks/diff-workloads.v0.1.json",
);
const defaultBaselinePath = resolve(
  repositoryRoot,
  "benchmarks/diff-baseline.v0.1.json",
);
const environmentKeys = [
  "packageVersion",
  "nodeVersion",
  "platform",
  "arch",
  "cpuCount",
  "totalMemoryBytes",
];
const modes = ["cold", "warm"];
const MAX_REGRESSION = 0.2;

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  return value;
};

const sameJson = (left, right) =>
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

const environmentDifferences = (candidate, baseline) =>
  environmentKeys.filter(
    (key) => candidate.tool?.[key] !== baseline.tool?.[key],
  );

const runCandidate = (coldRuns, warmRuns, outputPath) => {
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        benchmarkScript,
        "run",
        "--cold-runs",
        String(coldRuns),
        "--warm-runs",
        String(warmRuns),
        "--output",
        outputPath,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error);
    throw new Error(`diff benchmark candidate failed: ${detail.trim()}`, {
      cause: error,
    });
  }
};

const compare = (
  candidate,
  baseline,
  explanation,
  requireCompatibleEnvironment,
) => {
  const errors = [];
  const warnings = [];
  if (candidate.manifest.digest !== baseline.manifest.digest)
    errors.push("diff benchmark workload manifest digest changed");
  if (candidate.manifest.workloads !== baseline.manifest.workloads)
    errors.push("diff benchmark workload count changed");
  const baselineById = new Map(
    baseline.workloads.map((workload) => [workload.id, workload]),
  );
  for (const baselineWorkload of baseline.workloads) {
    const candidateWorkload = candidate.workloads.find(
      (workload) => workload.id === baselineWorkload.id,
    );
    if (candidateWorkload === undefined) {
      errors.push(
        `diff benchmark workload disappeared: ${baselineWorkload.id}`,
      );
      continue;
    }
    for (const key of [
      "tier",
      "inputDigest",
      "before",
      "after",
      "identity",
      "diff",
      "reportBytes",
    ])
      if (!sameJson(candidateWorkload[key], baselineWorkload[key]))
        errors.push(
          `diff benchmark correctness drift: ${baselineWorkload.id}.${key}`,
        );
  }
  for (const candidateWorkload of candidate.workloads)
    if (!baselineById.has(candidateWorkload.id))
      errors.push(
        `unexpected diff benchmark workload: ${candidateWorkload.id}`,
      );

  const environmentDiffs = environmentDifferences(candidate, baseline);
  if (environmentDiffs.length > 0) {
    const detail = environmentDiffs
      .map(
        (key) =>
          `${key}=${String(baseline.tool[key])}->${String(candidate.tool[key])}`,
      )
      .join(", ");
    if (requireCompatibleEnvironment)
      errors.push(`diff benchmark environment mismatch: ${detail}`);
    else
      warnings.push(
        `diff benchmark performance comparison skipped because environment differs: ${detail}`,
      );
  } else {
    for (const baselineWorkload of baseline.workloads) {
      const candidateWorkload = candidate.workloads.find(
        (workload) => workload.id === baselineWorkload.id,
      );
      if (candidateWorkload === undefined) continue;
      for (const mode of modes) {
        const baselineMedian = baselineWorkload[mode].medianMs;
        const candidateMedian = candidateWorkload[mode].medianMs;
        if (baselineMedian <= 0 || candidateMedian <= 0) continue;
        const regression = candidateMedian / baselineMedian - 1;
        if (regression <= MAX_REGRESSION) continue;
        const detail = `${baselineWorkload.id} ${mode}.medianMs ${baselineMedian} -> ${candidateMedian} (${(regression * 100).toFixed(1)}%)`;
        if (explanation.trim().length > 0)
          warnings.push(
            `explained diff benchmark performance regression: ${detail}`,
          );
        else errors.push(`diff benchmark performance regression: ${detail}`);
      }
    }
  }
  return { errors, warnings };
};

const main = () => {
  const baselinePath = resolve(
    repositoryRoot,
    argumentValue("--baseline") ?? defaultBaselinePath,
  );
  const suppliedCandidate = argumentValue("--candidate");
  const temporaryRoot = suppliedCandidate
    ? undefined
    : mkdtempSync(join(tmpdir(), "cartograph-diff-benchmark-gate-"));
  const candidatePath =
    suppliedCandidate ?? resolve(temporaryRoot, "candidate.json");
  const coldRuns = Number(argumentValue("--cold-runs") ?? 3);
  const warmRuns = Number(argumentValue("--warm-runs") ?? 5);
  const explanation = argumentValue("--explain") ?? "";
  const requireCompatibleEnvironment = process.argv.includes(
    "--require-compatible-environment",
  );
  try {
    if (suppliedCandidate === undefined)
      runCandidate(coldRuns, warmRuns, candidatePath);
    const manifest = readJson(manifestPath);
    const baseline = readJson(baselinePath);
    const candidate = readJson(candidatePath);
    validateArtifact(baseline, manifest);
    validateArtifact(candidate, manifest);
    const comparison = compare(
      candidate,
      baseline,
      explanation,
      requireCompatibleEnvironment,
    );
    for (const warning of comparison.warnings)
      console.error(`diff benchmark gate warning: ${warning}`);
    if (comparison.errors.length > 0)
      throw new Error(comparison.errors.join("\n"));
    console.log(
      JSON.stringify({
        ok: true,
        baseline: "benchmarks/diff-baseline.v0.1.json",
        candidate:
          suppliedCandidate === undefined ? "temporary" : candidatePath,
        manifestDigest: manifestDigest(manifest),
        coldRuns: candidate.runs.cold,
        warmRuns: candidate.runs.warm,
        warnings: comparison.warnings.length,
      }),
    );
  } finally {
    if (temporaryRoot !== undefined)
      rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`diff benchmark gate failed: ${message}`);
  process.exit(1);
}
