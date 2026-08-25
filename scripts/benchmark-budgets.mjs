#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import { validateArtifact, validateManifest } from "./benchmark.mjs";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const budgetsPath = resolve(
  repositoryRoot,
  argumentValue("--budgets") ?? "benchmarks/budgets.v0.1.json",
);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readText = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");
const fail = (message) => {
  throw new Error(`cartograph.benchmark-budgets validation failed: ${message}`);
};

const validate = () => {
  const budgets = readJson(budgetsPath);
  const schema = readJson(
    resolve(repositoryRoot, "schema/benchmark-budgets.v0.1.schema.json"),
  );
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(
    schema,
  );
  if (!validateSchema(budgets))
    fail(
      `budget schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );

  const baseline = readJson(resolve(repositoryRoot, budgets.baseline.artifact));
  const protocol = readJson(
    resolve(repositoryRoot, "benchmarks/protocol.v0.1.json"),
  );
  const resultSchema = readJson(
    resolve(repositoryRoot, "schema/benchmark-result.v0.1.schema.json"),
  );
  const manifest = readJson(
    resolve(repositoryRoot, "benchmarks/corpus.v0.1.json"),
  );
  validateManifest(manifest, protocol, resultSchema);
  validateArtifact(baseline, manifest, protocol, { checkCorpus: true });
  if (protocol.protocolVersion !== budgets.baseline.protocolVersion)
    fail(
      `protocol version drift: expected ${budgets.baseline.protocolVersion}, found ${protocol.protocolVersion}`,
    );
  if (
    protocol.variance?.acceptableRegression !==
    "A result over 20% slower than the recorded baseline requires an explanation before release."
  )
    fail("protocol regression rule is not the reviewed 20% explanation gate");
  if (budgets.regression.maxPercent !== 20)
    fail("budget regression threshold must remain 20 percent");

  const gate = readText("scripts/benchmark-gate.mjs");
  if (!gate.includes("const MAX_REGRESSION = 0.2"))
    fail("benchmark gate does not enforce the reviewed 20% threshold");
  if (!gate.includes('argumentValue("--explain")'))
    fail("benchmark gate does not expose an explanation path");

  const docs = readText("docs/BENCHMARK_PROTOCOL.md");
  for (const phrase of [
    "benchmarks/budgets.v0.1.json",
    "Small tier",
    "Medium tier",
    "Large tier",
    "p95 runtime",
    "peak RSS",
    "report size",
  ]) {
    if (!docs.includes(phrase))
      fail(`benchmark documentation is missing ${phrase}`);
  }

  const fixtureIds = new Set(manifest.fixtures.map((fixture) => fixture.id));
  const assigned = new Set();
  const tierReports = [];
  for (const tier of budgets.tiers) {
    for (const fixtureId of tier.fixtureIds) {
      if (!fixtureIds.has(fixtureId))
        fail(`${tier.id} tier references unknown fixture ${fixtureId}`);
      if (assigned.has(fixtureId))
        fail(`fixture is assigned to more than one tier: ${fixtureId}`);
      assigned.add(fixtureId);
      const fixture = baseline.fixtures.find((entry) => entry.id === fixtureId);
      if (fixture === undefined)
        fail(`baseline is missing fixture ${fixtureId}`);
      for (const mode of budgets.baseline.metricModes) {
        if (fixture[mode].p95Ms > tier.maxP95Ms)
          fail(
            `${tier.id} tier ${fixtureId} ${mode} p95 runtime ${fixture[mode].p95Ms}ms exceeds ${tier.maxP95Ms}ms`,
          );
        if (fixture[mode].peakRssBytes > tier.maxPeakRssBytes)
          fail(
            `${tier.id} tier ${fixtureId} ${mode} peak RSS ${fixture[mode].peakRssBytes} exceeds ${tier.maxPeakRssBytes}`,
          );
      }
      if (fixture.reportBytes > tier.maxReportBytes)
        fail(
          `${tier.id} tier ${fixtureId} report size ${fixture.reportBytes} exceeds ${tier.maxReportBytes}`,
        );
    }
    tierReports.push({
      id: tier.id,
      fixtures: tier.fixtureIds.length,
      maxP95Ms: tier.maxP95Ms,
      maxPeakRssBytes: tier.maxPeakRssBytes,
      maxReportBytes: tier.maxReportBytes,
    });
  }
  if (assigned.size !== fixtureIds.size)
    fail(
      `fixture coverage is incomplete: assigned ${assigned.size} of ${fixtureIds.size}`,
    );

  return {
    ok: true,
    contract: budgets.contract,
    schemaVersion: budgets.schemaVersion,
    budgetId: budgets.budgetId,
    tiers: tierReports,
    fixtures: assigned.size,
    regression: budgets.regression,
    releaseGating: true,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node scripts/benchmark-budgets.mjs validate [--root path] [--budgets path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
