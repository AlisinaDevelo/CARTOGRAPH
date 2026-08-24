#!/usr/bin/env node
/* global console, process */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateArtifact, validateManifest } from "./benchmark.mjs";

const repositoryRoot = resolve(
  process.env.CARTOGRAPH_REPOSITORY_ROOT ?? process.cwd(),
);
const benchmarkScript = resolve(repositoryRoot, "scripts/benchmark.mjs");
const manifestPath = resolve(repositoryRoot, "benchmarks/corpus.v0.1.json");
const protocolPath = resolve(repositoryRoot, "benchmarks/protocol.v0.1.json");
const schemaPath = resolve(
  repositoryRoot,
  "schema/benchmark-result.v0.1.schema.json",
);
const defaultBaselinePath = resolve(
  repositoryRoot,
  "benchmarks/baseline.v0.1.json",
);
const environmentKeys = [
  "packageVersion",
  "nodeVersion",
  "platform",
  "arch",
  "cpuCount",
  "totalMemoryBytes",
];
const performanceModes = ["cold", "warm"];
const performanceMetrics = ["medianMs"];
const MAX_REGRESSION = 0.2;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
};

const positiveIntegerArgument = (name, fallback) => {
  const value = argumentValue(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
};

const hasFlag = (name) => process.argv.includes(name);

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
};

const sameJson = (left, right) =>
  JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

const environmentDifferences = (candidate, baseline) =>
  environmentKeys.filter(
    (key) => candidate.tool?.[key] !== baseline.tool?.[key],
  );

const compareArtifacts = (
  candidate,
  baseline,
  { explanation = "", requireCompatibleEnvironment = false } = {},
) => {
  const errors = [];
  const warnings = [];
  const candidateById = new Map(
    candidate.fixtures.map((fixture) => [fixture.id, fixture]),
  );

  if (!sameJson(candidate.corpus, baseline.corpus))
    errors.push(
      "benchmark correctness regression: corpus metadata or digest changed",
    );

  for (const baselineFixture of baseline.fixtures) {
    const candidateFixture = candidateById.get(baselineFixture.id);
    if (candidateFixture === undefined) {
      errors.push(
        `benchmark correctness regression: fixture disappeared: ${baselineFixture.id}`,
      );
      continue;
    }
    if (
      candidateFixture.digest !== baselineFixture.digest ||
      candidateFixture.fileCount !== baselineFixture.fileCount
    )
      errors.push(
        `benchmark correctness regression: fixture corpus changed: ${baselineFixture.id}`,
      );
    if (!sameJson(candidateFixture.graph, baselineFixture.graph))
      errors.push(
        `benchmark evidence regression: graph counts changed: ${baselineFixture.id}`,
      );
    if (!sameJson(candidateFixture.accuracy, baselineFixture.accuracy))
      errors.push(
        `benchmark correctness regression: accuracy changed: ${baselineFixture.id}`,
      );
  }

  const baselineIds = new Set(baseline.fixtures.map((fixture) => fixture.id));
  for (const candidateFixture of candidate.fixtures) {
    if (!baselineIds.has(candidateFixture.id))
      errors.push(
        `benchmark correctness regression: unexpected fixture: ${candidateFixture.id}`,
      );
  }

  const environmentDiffs = environmentDifferences(candidate, baseline);
  if (environmentDiffs.length > 0) {
    const detail = environmentDiffs
      .map(
        (key) =>
          `${key}=${String(baseline.tool[key])}->${String(candidate.tool[key])}`,
      )
      .join(", ");
    if (requireCompatibleEnvironment)
      errors.push(`benchmark environment mismatch: ${detail}`);
    else
      warnings.push(
        `performance comparison skipped because the benchmark environment differs: ${detail}`,
      );
  } else {
    for (const baselineFixture of baseline.fixtures) {
      const candidateFixture = candidateById.get(baselineFixture.id);
      if (candidateFixture === undefined) continue;
      for (const mode of performanceModes) {
        for (const metric of performanceMetrics) {
          const baselineValue = baselineFixture[mode][metric];
          const candidateValue = candidateFixture[mode][metric];
          if (baselineValue <= 0 || candidateValue <= 0) continue;
          const regression = candidateValue / baselineValue - 1;
          if (regression <= MAX_REGRESSION) continue;
          const detail = `${baselineFixture.id} ${mode}.${metric} ${baselineValue} -> ${candidateValue} (${(regression * 100).toFixed(1)}%)`;
          if (explanation.trim().length > 0)
            warnings.push(
              `explained benchmark performance regression: ${detail}`,
            );
          else errors.push(`benchmark performance regression: ${detail}`);
        }
      }
    }
  }

  return { errors, warnings };
};

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
    throw new Error(`benchmark candidate failed: ${detail.trim()}`, {
      cause: error,
    });
  }
};

const runGate = () => {
  const manifest = readJson(manifestPath);
  const protocol = readJson(protocolPath);
  const schema = readJson(schemaPath);
  const baselinePath = resolve(
    repositoryRoot,
    argumentValue("--baseline") ?? defaultBaselinePath,
  );
  const suppliedCandidate = argumentValue("--candidate");
  const temporaryRoot = suppliedCandidate
    ? undefined
    : mkdtempSync(join(tmpdir(), "cartograph-benchmark-gate-"));
  const candidatePath =
    suppliedCandidate ?? resolve(temporaryRoot, "candidate.json");
  const coldRuns = positiveIntegerArgument("--cold-runs", 3);
  const warmRuns = positiveIntegerArgument("--warm-runs", 5);
  try {
    if (suppliedCandidate === undefined)
      runCandidate(coldRuns, warmRuns, candidatePath);
    const baseline = readJson(baselinePath);
    const candidate = readJson(candidatePath);
    validateManifest(manifest, protocol, schema);
    validateArtifact(baseline, manifest, protocol, { checkCorpus: true });
    validateArtifact(candidate, manifest, protocol, { checkCorpus: true });
    const comparison = compareArtifacts(candidate, baseline, {
      explanation: argumentValue("--explain") ?? "",
      requireCompatibleEnvironment: hasFlag("--require-compatible-environment"),
    });
    for (const warning of comparison.warnings)
      console.error(`benchmark gate warning: ${warning}`);
    if (comparison.errors.length > 0)
      throw new Error(comparison.errors.join("\n"));
    console.log(
      JSON.stringify({
        ok: true,
        baseline: "benchmarks/baseline.v0.1.json",
        candidate:
          suppliedCandidate === undefined ? "temporary" : candidatePath,
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

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  try {
    runGate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`benchmark gate failed: ${message}`);
    process.exit(1);
  }
}

export { compareArtifacts };
