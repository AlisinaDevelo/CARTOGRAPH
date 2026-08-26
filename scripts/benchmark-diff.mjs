#!/usr/bin/env node
/* global Buffer, console, process */

import { createHash } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import Ajv from "ajv";

import {
  createGraphSnapshot,
  diffGraphSnapshots,
  serializeGraphDiff,
  stableStringify,
} from "../src/core/index.ts";

const repositoryRoot = resolve(
  process.env.CARTOGRAPH_REPOSITORY_ROOT ?? process.cwd(),
);
const defaultManifestPath = resolve(
  repositoryRoot,
  "benchmarks/diff-workloads.v0.1.json",
);
const defaultArtifactPath = resolve(
  repositoryRoot,
  "benchmarks/diff-baseline.v0.1.json",
);
const workloadSchemaPath = resolve(
  repositoryRoot,
  "schema/diff-benchmark-workloads.v0.1.schema.json",
);
const resultSchemaPath = resolve(
  repositoryRoot,
  "schema/diff-benchmark-result.v0.1.schema.json",
);

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
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
};

const fail = (message) => {
  throw new Error(`cartograph.diff-benchmark validation failed: ${message}`);
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    fail(`could not read JSON ${path}: ${detail}`);
  }
};

const sha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const roundedMilliseconds = (value) => Number(value.toFixed(3));

const percentile = (values, quantile) => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
};

const timingSummary = (samples) => ({
  runs: samples.length,
  minMs: roundedMilliseconds(
    Math.min(...samples.map((sample) => sample.durationMs)),
  ),
  medianMs: roundedMilliseconds(
    percentile(
      samples.map((sample) => sample.durationMs),
      0.5,
    ),
  ),
  p95Ms: roundedMilliseconds(
    percentile(
      samples.map((sample) => sample.durationMs),
      0.95,
    ),
  ),
  maxMs: roundedMilliseconds(
    Math.max(...samples.map((sample) => sample.durationMs)),
  ),
  peakRssBytes: Math.max(...samples.map((sample) => sample.rssBytes)),
});

const edgeDensity = (nodes, edges) =>
  Number((edges / Math.max(1, nodes * Math.max(1, nodes - 1))).toFixed(6));

const schemaValidator = (path) =>
  new Ajv({ allErrors: true, strict: false }).compile(readJson(path));

const validateManifestSchema = schemaValidator(workloadSchemaPath);
const validateResultSchema = schemaValidator(resultSchemaPath);

const manifestDigest = (manifest) => sha256(stableStringify(manifest));

const tierMapFor = (manifest) =>
  new Map(manifest.tiers.map((tier) => [tier.id, tier]));

const validateCardinality = (cardinality, tier, label) => {
  if (cardinality.nodes > tier.maxNodes)
    fail(
      `${label} declares ${cardinality.nodes} nodes, exceeding supported ${tier.id} tier limit ${tier.maxNodes}`,
    );
  if (cardinality.edges > tier.maxEdges)
    fail(
      `${label} declares ${cardinality.edges} edges, exceeding supported ${tier.id} tier limit ${tier.maxEdges}`,
    );
  const density = edgeDensity(cardinality.nodes, cardinality.edges);
  if (density > tier.maxEdgeDensity)
    fail(
      `${label} edge density ${density} exceeds supported ${tier.id} tier limit ${tier.maxEdgeDensity}`,
    );
  if (cardinality.edges > cardinality.nodes * (cardinality.nodes - 1) * 2)
    fail(
      `${label} requests more unique directed edges than the generator can represent`,
    );
};

const validateManifest = (manifest) => {
  if (!validateManifestSchema(manifest))
    fail(
      `workload schema validation failed: ${JSON.stringify(validateManifestSchema.errors)}`,
    );
  const tiers = tierMapFor(manifest);
  if (
    tiers.size !== 3 ||
    !["small", "medium", "large"].every((id) => tiers.has(id))
  )
    fail(
      "workload manifest must declare exactly small, medium, and large tiers",
    );
  const ids = new Set();
  for (const workload of manifest.workloads) {
    if (ids.has(workload.id)) fail(`duplicate workload id: ${workload.id}`);
    ids.add(workload.id);
    const tier = tiers.get(workload.tier);
    if (tier === undefined)
      fail(`workload ${workload.id} references unknown tier ${workload.tier}`);
    validateCardinality(workload.before, tier, `${workload.id} before`);
    validateCardinality(workload.after, tier, `${workload.id} after`);
    if (workload.renamedNodes + workload.ambiguousNodes > workload.before.nodes)
      fail(
        `workload ${workload.id} identity declarations exceed before node count`,
      );
    if (workload.renamedNodes + workload.ambiguousNodes > workload.after.nodes)
      fail(
        `workload ${workload.id} identity declarations exceed after node count`,
      );
    const ambiguityPercent =
      (workload.ambiguousNodes / workload.before.nodes) * 100;
    if (ambiguityPercent > tier.maxIdentityAmbiguityPercent)
      fail(
        `workload ${workload.id} identity ambiguity ${ambiguityPercent.toFixed(3)}% exceeds supported ${tier.id} tier limit ${tier.maxIdentityAmbiguityPercent}%`,
      );
  }
  for (const tier of tiers.values())
    if (!manifest.workloads.some((workload) => workload.tier === tier.id))
      fail(`supported tier has no workload: ${tier.id}`);
  return { tiers, digest: manifestDigest(manifest) };
};

const makeNode = (id, stableKey, name, kind = "module") => ({
  id,
  stableKey,
  kind,
  name,
  language: "typescript",
});

const makeEvidence = (workload, phase, index) => ({
  id: `benchmark:${workload.id}:${phase}:${index}`,
  kind: "source",
  path: `benchmarks/generated/${workload.id}/${phase}.ts`,
  line: (index % 200) + 1,
  detector: "cartograph.benchmark@1",
  contentHash: `sha256:${sha256(`${workload.id}|${phase}|${index}`)}`,
});

const makeEdges = (nodes, count, workload, phase) => {
  const rawCandidates = nodes.filter(
    (node) => !node.stableKey.startsWith("ambiguous:"),
  );
  const rotation =
    rawCandidates.length === 0 ? 0 : workload.seed % rawCandidates.length;
  const candidates = [
    ...rawCandidates.slice(rotation),
    ...rawCandidates.slice(0, rotation),
  ];
  const edges = [];
  const seen = new Set();
  const kinds = ["calls", "imports"];
  for (const kind of kinds) {
    for (let fromIndex = 0; fromIndex < candidates.length; fromIndex += 1) {
      for (let toIndex = 0; toIndex < candidates.length; toIndex += 1) {
        if (fromIndex === toIndex) continue;
        const from = candidates[fromIndex];
        const to = candidates[toIndex];
        const key = `${from.id}\u0000${to.id}\u0000${kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          from: from.id,
          to: to.id,
          kind,
          confidence: "inferred",
          evidence: [makeEvidence(workload, phase, edges.length)],
        });
        if (edges.length === count) return edges;
      }
    }
  }
  fail(
    `workload ${workload.id} ${phase} cannot generate ${count} unique directed edges within its declared node count`,
  );
};

const nodesFor = (workload, phase) => {
  const cardinality = workload[phase];
  const sharedCount =
    Math.min(workload.before.nodes, workload.after.nodes) -
    workload.renamedNodes -
    workload.ambiguousNodes;
  if (sharedCount < 1)
    fail(`workload ${workload.id} does not leave a shared node set`);
  const nodes = [];
  for (let index = 0; index < sharedCount; index += 1)
    nodes.push(
      makeNode(`module:shared/${index}`, `shared:${index}`, `shared-${index}`),
    );
  for (let index = 0; index < workload.renamedNodes; index += 1) {
    const prefix = phase === "before" ? "legacy" : "current";
    nodes.push(
      makeNode(
        `module:${prefix}/${index}`,
        `${prefix}:stable:${index}`,
        `renamed-${index}`,
      ),
    );
  }
  for (let index = 0; index < workload.ambiguousNodes; index += 1)
    nodes.push(
      makeNode(
        `function:ambiguous/${phase}/${index}`,
        `ambiguous:${phase}:${index}`,
        "ambiguous-group",
        "function",
      ),
    );
  const extraCount =
    cardinality.nodes -
    sharedCount -
    workload.renamedNodes -
    workload.ambiguousNodes;
  for (let index = 0; index < extraCount; index += 1)
    nodes.push(
      makeNode(
        `module:${phase}/extra/${index}`,
        `extra:${phase}:${index}`,
        `${phase}-extra-${index}`,
      ),
    );
  return nodes;
};

export const buildSnapshots = (workload) => {
  const beforeNodes = nodesFor(workload, "before");
  const afterNodes = nodesFor(workload, "after");
  const before = createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha: `benchmark:${workload.id}:before` },
    nodes: beforeNodes,
    edges: makeEdges(beforeNodes, workload.before.edges, workload, "before"),
    diagnostics: [],
  });
  const after = createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha: `benchmark:${workload.id}:after` },
    nodes: afterNodes,
    edges: makeEdges(afterNodes, workload.after.edges, workload, "after"),
    diagnostics: [],
  });
  return {
    before,
    after,
    inputDigest: sha256(
      stableStringify({
        workload,
        before: { nodes: before.nodes.length, edges: before.edges.length },
        after: { nodes: after.nodes.length, edges: after.edges.length },
      }),
    ),
  };
};

const cardinalityFor = (snapshot) => ({
  nodes: snapshot.nodes.length,
  edges: snapshot.edges.length,
  edgeDensity: edgeDensity(snapshot.nodes.length, snapshot.edges.length),
});

const evaluateWorkload = (workload, coldRuns, warmRuns) => {
  const { before, after, inputDigest } = buildSnapshots(workload);
  const samples = { cold: [], warm: [] };
  let stableReport;
  let stableDiff;
  const invoke = () => {
    const started = performance.now();
    const diff = diffGraphSnapshots(before, after);
    const report = serializeGraphDiff(diff);
    if (stableReport === undefined) {
      stableReport = report;
      stableDiff = diff;
    } else if (report !== stableReport) {
      fail(`workload is nondeterministic: ${workload.id}`);
    }
    return {
      durationMs: performance.now() - started,
      rssBytes: process.memoryUsage().rss,
    };
  };
  for (let index = 0; index < coldRuns; index += 1) samples.cold.push(invoke());
  for (let index = 0; index < warmRuns; index += 1) samples.warm.push(invoke());
  if (stableDiff === undefined || stableReport === undefined)
    fail(`workload produced no diff: ${workload.id}`);
  return {
    id: workload.id,
    tier: workload.tier,
    inputDigest,
    before: cardinalityFor(before),
    after: cardinalityFor(after),
    identity: {
      matches: stableDiff.identity.matches.length,
      ambiguous: stableDiff.identity.ambiguous.length,
      unsupported: stableDiff.identity.unsupported.length,
      ambiguityPercent: Number(
        (
          (stableDiff.identity.ambiguous.length / before.nodes.length) *
          100
        ).toFixed(3),
      ),
    },
    diff: stableDiff.summary,
    reportBytes: Buffer.byteLength(stableReport, "utf8"),
    cold: timingSummary(samples.cold),
    warm: timingSummary(samples.warm),
  };
};

const rejectSensitiveArtifactFields = (value, path = "artifact") => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectSensitiveArtifactFields(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") {
    if (
      typeof value === "string" &&
      (value.startsWith("/") ||
        value.startsWith("~") ||
        /^[A-Za-z]:[\\/]/u.test(value) ||
        /^file:/iu.test(value))
    )
      fail(`artifact contains an absolute path at ${path}`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      [
        "body",
        "content",
        "excerpt",
        "snippet",
        "sourcebody",
        "sourcecode",
        "sourcetext",
        "telemetry",
        "network",
      ].includes(key.toLowerCase())
    )
      fail(`artifact contains disallowed field ${path}.${key}`);
    rejectSensitiveArtifactFields(child, `${path}.${key}`);
  }
};

const sameJson = (left, right) =>
  stableStringify(left) === stableStringify(right);

export const validateArtifact = (artifact, manifest) => {
  if (!validateResultSchema(artifact))
    fail(
      `result schema validation failed: ${JSON.stringify(validateResultSchema.errors)}`,
    );
  const { tiers, digest } = validateManifest(manifest);
  if (artifact.manifest.digest !== digest)
    fail(
      "result manifest digest does not match the declared workload manifest",
    );
  if (artifact.manifest.workloads !== manifest.workloads.length)
    fail("result workload count does not match the declared workload manifest");
  if (artifact.runs.cold < 1 || artifact.runs.warm < 1)
    fail("result run counts must be positive");
  const byId = new Map(
    manifest.workloads.map((workload) => [workload.id, workload]),
  );
  const seen = new Set();
  for (const result of artifact.workloads) {
    if (seen.has(result.id)) fail(`duplicate result workload: ${result.id}`);
    seen.add(result.id);
    const workload = byId.get(result.id);
    if (workload === undefined)
      fail(`result contains unknown workload: ${result.id}`);
    if (result.tier !== workload.tier)
      fail(`result tier drift for workload ${result.id}`);
    const generated = buildSnapshots(workload);
    if (result.inputDigest !== generated.inputDigest)
      fail(`input digest drift for workload ${result.id}`);
    if (!sameJson(result.before, cardinalityFor(generated.before)))
      fail(`before graph cardinality drift for workload ${result.id}`);
    if (!sameJson(result.after, cardinalityFor(generated.after)))
      fail(`after graph cardinality drift for workload ${result.id}`);
    const diff = diffGraphSnapshots(generated.before, generated.after);
    const identity = {
      matches: diff.identity.matches.length,
      ambiguous: diff.identity.ambiguous.length,
      unsupported: diff.identity.unsupported.length,
      ambiguityPercent: Number(
        (
          (diff.identity.ambiguous.length / generated.before.nodes.length) *
          100
        ).toFixed(3),
      ),
    };
    if (!sameJson(result.identity, identity))
      fail(`identity metrics drift for workload ${result.id}`);
    if (!sameJson(result.diff, diff.summary))
      fail(`diff summary drift for workload ${result.id}`);
    const reportBytes = Buffer.byteLength(serializeGraphDiff(diff), "utf8");
    if (result.reportBytes !== reportBytes)
      fail(`diff report size drift for workload ${result.id}`);
    const tier = tiers.get(workload.tier);
    if (tier === undefined)
      fail(`workload ${result.id} has unsupported tier ${workload.tier}`);
    for (const mode of ["cold", "warm"]) {
      if (result[mode].p95Ms > tier.maxP95Ms)
        fail(
          `${workload.tier} workload ${result.id} ${mode} p95 ${result[mode].p95Ms}ms exceeds ${tier.maxP95Ms}ms`,
        );
      if (result[mode].peakRssBytes > tier.maxPeakRssBytes)
        fail(
          `${workload.tier} workload ${result.id} ${mode} peak RSS ${result[mode].peakRssBytes} exceeds ${tier.maxPeakRssBytes}`,
        );
    }
    if (result.reportBytes > tier.maxReportBytes)
      fail(
        `${workload.tier} workload ${result.id} report size ${result.reportBytes} exceeds ${tier.maxReportBytes}`,
      );
  }
  if (seen.size !== manifest.workloads.length)
    fail(
      `result coverage is incomplete: ${seen.size} of ${manifest.workloads.length}`,
    );
  rejectSensitiveArtifactFields(artifact);
  return { ok: true, workloads: seen.size, digest };
};

const run = () => {
  const manifestPath = resolve(
    repositoryRoot,
    argumentValue("--manifest") ?? defaultManifestPath,
  );
  const outputPath = resolve(
    repositoryRoot,
    argumentValue("--output") ?? defaultArtifactPath,
  );
  const manifest = readJson(manifestPath);
  const { digest } = validateManifest(manifest);
  const coldRuns = positiveIntegerArgument("--cold-runs", 1);
  const warmRuns = positiveIntegerArgument("--warm-runs", 3);
  const workloads = manifest.workloads.map((workload) =>
    evaluateWorkload(workload, coldRuns, warmRuns),
  );
  const artifact = {
    artifactVersion: 1,
    protocolVersion: 1,
    generatedAt: new Date().toISOString(),
    tool: {
      packageVersion: readJson(resolve(repositoryRoot, "package.json")).version,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    manifest: { digest, workloads: workloads.length },
    runs: { cold: coldRuns, warm: warmRuns },
    workloads,
  };
  validateArtifact(artifact, manifest);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify({
      ok: true,
      output: outputPath,
      manifestDigest: digest,
      workloads: workloads.length,
      coldRuns,
      warmRuns,
    }),
  );
};

const validate = () => {
  const manifestPath = resolve(
    repositoryRoot,
    argumentValue("--manifest") ?? defaultManifestPath,
  );
  const artifactPath = resolve(
    repositoryRoot,
    argumentValue("--artifact") ?? defaultArtifactPath,
  );
  const manifest = readJson(manifestPath);
  const artifact = readJson(artifactPath);
  console.log(JSON.stringify(validateArtifact(artifact, manifest)));
};

export { validateManifest, manifestDigest, edgeDensity };

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  try {
    const command = process.argv[2];
    if (command === "run") run();
    else if (command === "validate") validate();
    else {
      console.error(
        "usage: benchmark-diff.mjs <run|validate> [--manifest path] [--artifact path] [--output path]",
      );
      process.exit(2);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
