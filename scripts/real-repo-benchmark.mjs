#!/usr/bin/env node
/* global console, process */
// Scheduled benchmark over pinned real repositories (see
// docs/BENCHMARK_PROTOCOL.md). `validate` checks the manifest offline;
// `run` fetches each repository at its pinned commit, scans it in a child
// process, and fails when a time, memory, noise, or coverage budget is missed.
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(import.meta.url), "../..");
const manifestPath = resolve(
  repositoryRoot,
  "benchmarks/real-repositories.v0.1.json",
);

const fail = (message) => {
  throw new Error(`cartograph.real-repository-benchmark: ${message}`);
};

const BUDGET_KEYS = [
  "maxMs",
  "maxRssBytes",
  "maxDiagnosticsPerNode",
  "minNodes",
  "minEdges",
];
const RESOURCE_KEYS = [
  "maxFiles",
  "maxFileBytes",
  "maxSourceBytes",
  "maxArchiveBytes",
  "maxMemoryBytes",
  "maxWallClockMs",
  "maxReportItems",
];

export const validateManifest = (manifest) => {
  if (manifest?.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (manifest.contract !== "cartograph.real-repository-benchmark")
    fail("unexpected contract");
  if (!Array.isArray(manifest.repositories) || manifest.repositories.length < 3)
    fail("at least three repositories are required");
  const ids = new Set();
  for (const repository of manifest.repositories) {
    if (!/^[a-z][a-z0-9-]{0,62}$/u.test(repository.id ?? ""))
      fail(`invalid repository id ${JSON.stringify(repository.id)}`);
    if (ids.has(repository.id))
      fail(`duplicate repository id ${repository.id}`);
    ids.add(repository.id);
    if (
      !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/u.test(repository.url ?? "")
    )
      fail(`${repository.id}: url must be an https GitHub repository`);
    if (!/^[0-9a-f]{40}$/u.test(repository.commit ?? ""))
      fail(`${repository.id}: commit must be a full 40-character SHA`);
    if (
      !["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"].includes(
        repository.license,
      )
    )
      fail(`${repository.id}: license must be permissive and recorded`);
    if (!["small", "medium", "large"].includes(repository.size))
      fail(`${repository.id}: size must be small, medium, or large`);
    for (const key of Object.keys(repository.resources ?? {}))
      if (!RESOURCE_KEYS.includes(key))
        fail(`${repository.id}: unknown resource ${key}`);
    for (const key of BUDGET_KEYS) {
      const value = repository.budgets?.[key];
      if (typeof value !== "number" || !(value > 0))
        fail(`${repository.id}: budget ${key} must be a positive number`);
    }
  }
  const sizes = new Set(
    manifest.repositories.map((repository) => repository.size),
  );
  for (const size of ["small", "medium", "large"])
    if (!sizes.has(size)) fail(`the corpus needs a ${size} repository`);
  return manifest;
};

/** Budget failures for one measurement, as human-readable strings. */
export const budgetFailures = (repository, measurement) => {
  const { budgets } = repository;
  const failures = [];
  const ratio =
    measurement.nodes === 0
      ? Number.POSITIVE_INFINITY
      : measurement.diagnostics / measurement.nodes;
  if (measurement.ms > budgets.maxMs)
    failures.push(`took ${measurement.ms} ms (budget ${budgets.maxMs} ms)`);
  if (measurement.maxRssBytes > budgets.maxRssBytes)
    failures.push(
      `peak RSS ${measurement.maxRssBytes} bytes (budget ${budgets.maxRssBytes})`,
    );
  if (ratio > budgets.maxDiagnosticsPerNode)
    failures.push(
      `${ratio.toFixed(3)} diagnostics per node (budget ${budgets.maxDiagnosticsPerNode})`,
    );
  if (measurement.nodes < budgets.minNodes)
    failures.push(
      `${measurement.nodes} nodes (expected at least ${budgets.minNodes})`,
    );
  if (measurement.edges < budgets.minEdges)
    failures.push(
      `${measurement.edges} edges (expected at least ${budgets.minEdges})`,
    );
  return failures;
};

const readManifest = () =>
  validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));

const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const fetchRepository = (repository, directory) => {
  rmSync(directory, { force: true, recursive: true });
  mkdirSync(directory, { recursive: true });
  git(directory, ["init", "-q"]);
  git(directory, [
    "fetch",
    "-q",
    "--depth",
    "1",
    repository.url,
    repository.commit,
  ]);
  git(directory, ["checkout", "-q", "--detach", "FETCH_HEAD"]);
  const head = git(directory, ["rev-parse", "HEAD"]);
  if (head !== repository.commit)
    fail(`${repository.id}: fetched ${head}, expected ${repository.commit}`);
};

// Runs in a fresh child so peak RSS belongs to one scan.
const measure = async (directory, resourcesJson) => {
  const commands = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/commands.js")).href
  );
  const core = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/core/index.js")).href
  );
  const base = core.defaultCartographConfig();
  const config = {
    ...base,
    resources: { ...base.resources, ...JSON.parse(resourcesJson) },
  };
  const started = performance.now();
  const snapshot = commands.scanRepository({ root: directory, config });
  const ms = Math.round(performance.now() - started);
  const diagnosticCodes = {};
  for (const diagnostic of snapshot.diagnostics)
    diagnosticCodes[diagnostic.code] =
      (diagnosticCodes[diagnostic.code] ?? 0) + 1;
  process.stdout.write(
    `${JSON.stringify({
      ms,
      // resourceUsage().maxRSS is in kilobytes on every supported platform.
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      nodes: snapshot.nodes.length,
      edges: snapshot.edges.length,
      diagnostics: snapshot.diagnostics.length,
      diagnosticCodes,
    })}\n`,
  );
};

// The first error line a failed child printed, without its stack or the
// trailing Node.js version banner.
const childError = (child) => {
  const lines = `${child.stderr ?? ""}\n${child.stdout ?? ""}`
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("at ") &&
        !line.startsWith("Node.js v"),
    );
  return (
    lines.find((line) => /^(?:\w*Error|cartograph)\b.*:/u.test(line)) ??
    lines[0] ??
    `scan exited with status ${child.status}`
  );
};

const markdownReport = (results) => {
  const lines = [
    "## Real-repository benchmark",
    "",
    "| Repository | Commit | Time | Peak RSS | Nodes | Edges | Diagnostics | Result |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    const m = result.measurement;
    lines.push(
      m === undefined
        ? `| ${result.id} | \`${result.commit.slice(0, 12)}\` | – | – | – | – | – | ❌ ${result.failures.join("; ")} |`
        : `| ${result.id} | \`${result.commit.slice(0, 12)}\` | ${(m.ms / 1000).toFixed(1)} s | ${Math.round(m.maxRssBytes / 1048576)} MiB | ${m.nodes} | ${m.edges} | ${m.diagnostics} | ${result.failures.length === 0 ? "✅" : `❌ ${result.failures.join("; ")}`} |`,
    );
  }
  return `${lines.join("\n")}\n`;
};

const run = (outputPath) => {
  const manifest = readManifest();
  const workRoot = resolve(
    process.env.RUNNER_TEMP ?? tmpdir(),
    "cartograph-real-repositories",
  );
  const results = [];
  for (const repository of manifest.repositories) {
    const directory = join(workRoot, repository.id);
    const result = {
      id: repository.id,
      commit: repository.commit,
      failures: [],
    };
    try {
      fetchRepository(repository, directory);
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(import.meta.url),
          "measure",
          directory,
          JSON.stringify(repository.resources ?? {}),
        ],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      if (child.status !== 0) throw new Error(childError(child));
      result.measurement = JSON.parse(child.stdout.trim().split("\n").at(-1));
      result.failures = budgetFailures(repository, result.measurement);
    } catch (error) {
      result.failures.push(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
    results.push(result);
    console.error(
      `${repository.id}: ${result.failures.length === 0 ? "ok" : result.failures.join("; ")}`,
    );
  }
  const report = {
    schemaVersion: 1,
    contract: "cartograph.real-repository-benchmark-report",
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    results,
  };
  if (outputPath)
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = markdownReport(results);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  else console.log(markdown);
  if (results.some((result) => result.failures.length > 0))
    process.exitCode = 1;
};

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const [command, first, second] = process.argv.slice(2);
  if (command === "validate") {
    const manifest = readManifest();
    console.log(
      JSON.stringify({
        ok: true,
        repositories: manifest.repositories.map((repository) => repository.id),
      }),
    );
  } else if (command === "run") {
    const outputIndex = process.argv.indexOf("--output");
    run(outputIndex > 0 ? process.argv[outputIndex + 1] : undefined);
  } else if (command === "measure" && first !== undefined) {
    await measure(first, second ?? "{}");
  } else {
    console.error(
      "usage: node scripts/real-repo-benchmark.mjs validate | run [--output <path>]",
    );
    process.exitCode = 2;
  }
}
