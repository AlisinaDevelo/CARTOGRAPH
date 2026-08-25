#!/usr/bin/env node
/* global Buffer, console, process */

import { createHash } from "node:crypto";
import { cpus, totalmem } from "node:os";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(
  process.env.CARTOGRAPH_REPOSITORY_ROOT ?? process.cwd(),
);
const corpusPath = resolve(repositoryRoot, "benchmarks/corpus.v0.1.json");
const protocolPath = resolve(repositoryRoot, "benchmarks/protocol.v0.1.json");
const resultSchemaPath = resolve(
  repositoryRoot,
  "schema/benchmark-result.v0.1.schema.json",
);
const baselinePath = resolve(repositoryRoot, "benchmarks/baseline.v0.1.json");

const SOURCE_BODY_KEYS = new Set([
  "body",
  "content",
  "excerpt",
  "sourcebody",
  "sourcecode",
  "sourcetext",
  "snippet",
]);
const ARTIFACT_KEYS = new Set([
  "artifactVersion",
  "protocolVersion",
  "generatedAt",
  "tool",
  "corpus",
  "runs",
  "fixtures",
]);

const fail = (message) => {
  throw new Error(message);
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    fail(`could not read JSON ${path}: ${detail}`);
  }
};

const portablePath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.startsWith("/") &&
  !value.startsWith("\\") &&
  !value.startsWith("~") &&
  !/^[A-Za-z]:[\\/]/u.test(value) &&
  !value.includes("\0") &&
  !value.split("/").includes("..") &&
  !value.split("\\").includes("..");

const containedPath = (root, candidate, label) => {
  if (!portablePath(candidate))
    fail(`${label} must be a portable relative path`);
  const resolved = resolve(root, candidate);
  const relativePath = relative(root, resolved);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  ) {
    fail(`${label} escapes the repository: ${candidate}`);
  }
  return resolved;
};

const walkFiles = (root) => {
  const files = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isSymbolicLink())
        fail(
          `benchmark corpus contains an unreviewed symbolic link: ${entryPath}`,
        );
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      } else {
        fail(`benchmark corpus contains a non-regular entry: ${entryPath}`);
      }
    }
  };
  visit(root);
  return files.sort();
};

const relativeRepositoryPath = (path) =>
  relative(repositoryRoot, path).split(sep).join("/");

const digestEntries = (entries) => {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    hash.update(entry.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(entry.bytes);
  }
  return hash.digest("hex");
};

const corpusEntries = (manifest) => {
  const entries = [];
  for (const fixture of manifest.fixtures) {
    const root = containedPath(
      repositoryRoot,
      fixture.root,
      `fixture ${fixture.id}`,
    );
    if (!existsSync(root) || !lstatSync(root).isDirectory())
      fail(`fixture root is not a directory: ${fixture.root}`);
    for (const filePath of walkFiles(root)) {
      entries.push({
        path: relativeRepositoryPath(filePath),
        bytes: readFileSync(filePath),
      });
    }
  }
  return entries;
};

const fixtureEntries = (fixture) => {
  const root = containedPath(
    repositoryRoot,
    fixture.root,
    `fixture ${fixture.id}`,
  );
  return walkFiles(root).map((filePath) => ({
    path: relativeRepositoryPath(filePath),
    bytes: readFileSync(filePath),
  }));
};

const numberArgument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1)
    fail(`${name} must be a positive integer`);
  return value;
};

const outputArgument = () => {
  const index = process.argv.indexOf("--output");
  return index >= 0 ? process.argv[index + 1] : baselinePath;
};

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

const multisetMatches = (actual, expected) => {
  const counts = new Map();
  for (const value of actual) counts.set(value, (counts.get(value) ?? 0) + 1);
  let truePositives = 0;
  for (const value of expected) {
    const count = counts.get(value) ?? 0;
    if (count > 0) {
      truePositives += 1;
      counts.set(value, count - 1);
    }
  }
  return truePositives;
};

const score = (actual, expected) => {
  const truePositives = multisetMatches(actual, expected);
  const emitted = actual.length;
  const expectedCount = expected.length;
  return {
    truePositives,
    emitted,
    expected: expectedCount,
    precision:
      emitted === 0 ? (expectedCount === 0 ? 1 : 0) : truePositives / emitted,
    recall:
      expectedCount === 0
        ? emitted === 0
          ? 1
          : 0
        : truePositives / expectedCount,
  };
};

const edgeIdentity = (edge) => `${edge.kind}\u0000${edge.from}\u0000${edge.to}`;

const familySelectorKeys = new Set([
  "edgeKinds",
  "edgeFromPrefixes",
  "edgeToPrefixes",
  "diagnosticCodes",
]);

const validateFamilySelector = (selector, label) => {
  exactObject(selector, familySelectorKeys, label);
  const selectorFields = [...familySelectorKeys].filter((key) =>
    Object.hasOwn(selector, key),
  );
  if (selectorFields.length === 0)
    fail(`${label} must select edges or diagnostics`);
  for (const key of selectorFields) {
    if (
      !Array.isArray(selector[key]) ||
      selector[key].some(
        (value) => typeof value !== "string" || value.length === 0,
      )
    )
      fail(`${label}.${key} must contain non-empty strings`);
  }
};

const validateExpected = (expected, expectedPath) => {
  if (!expected || typeof expected !== "object" || Array.isArray(expected))
    fail(`expected artifact must be an object: ${expectedPath}`);
  if (!Array.isArray(expected.edges) || !Array.isArray(expected.diagnostics))
    fail(
      `expected artifact must contain edge and diagnostic arrays: ${expectedPath}`,
    );
  if (expected.families !== undefined) {
    if (
      !expected.families ||
      typeof expected.families !== "object" ||
      Array.isArray(expected.families)
    )
      fail(`expected families must be an object: ${expectedPath}`);
    if (Object.keys(expected.families).length === 0)
      fail(`expected artifact has no construct families: ${expectedPath}`);
    for (const [family, selector] of Object.entries(expected.families))
      validateFamilySelector(selector, `expected family ${family}`);
  }
};

const matchesFamilyPrefix = (value, prefixes) =>
  prefixes === undefined || prefixes.some((prefix) => value.startsWith(prefix));

const hasEdgeFamilySelector = (selector) =>
  selector.edgeKinds !== undefined ||
  selector.edgeFromPrefixes !== undefined ||
  selector.edgeToPrefixes !== undefined;

const matchesEdgeFamily = (edge, selector) =>
  hasEdgeFamilySelector(selector) &&
  (selector.edgeKinds === undefined ||
    selector.edgeKinds.includes(edge.kind)) &&
  matchesFamilyPrefix(edge.from, selector.edgeFromPrefixes) &&
  matchesFamilyPrefix(edge.to, selector.edgeToPrefixes);

const matchesDiagnosticFamily = (diagnostic, selector) =>
  selector.diagnosticCodes !== undefined &&
  selector.diagnosticCodes.includes(diagnostic.code ?? diagnostic);

const accuracyFor = (snapshot, expectedPath) => {
  if (!expectedPath) return null;
  const expected = readJson(expectedPath);
  validateExpected(expected, expectedPath);
  const actualEdges = snapshot.edges.map(edgeIdentity);
  const expectedEdges = expected.edges.map((edge) => {
    if (!Array.isArray(edge) || edge.length !== 3)
      fail(`expected edge identity is malformed: ${expectedPath}`);
    return edge.join("\u0000");
  });
  const actualDiagnostics = snapshot.diagnostics.map(
    (diagnostic) => diagnostic.code,
  );
  const expectedDiagnostics = expected.diagnostics.map((diagnostic) => {
    if (typeof diagnostic !== "string")
      fail(`expected diagnostic identity is malformed: ${expectedPath}`);
    return diagnostic;
  });
  const accuracy = {
    edge: score(actualEdges, expectedEdges),
    diagnostic: score(actualDiagnostics, expectedDiagnostics),
  };
  if (expected.families !== undefined) {
    const familyAccuracy = {};
    for (const [family, selector] of Object.entries(expected.families)) {
      const actualFamilyEdges = snapshot.edges
        .filter((edge) => matchesEdgeFamily(edge, selector))
        .map(edgeIdentity);
      const expectedFamilyEdges = expected.edges
        .map((edge) => ({ kind: edge[0], from: edge[1], to: edge[2] }))
        .filter((edge) => matchesEdgeFamily(edge, selector))
        .map(edgeIdentity);
      const actualFamilyDiagnostics = snapshot.diagnostics
        .filter((diagnostic) => matchesDiagnosticFamily(diagnostic, selector))
        .map((diagnostic) => diagnostic.code);
      const expectedFamilyDiagnostics = expectedDiagnostics.filter(
        (diagnostic) => matchesDiagnosticFamily(diagnostic, selector),
      );
      familyAccuracy[family] = {
        edge: score(actualFamilyEdges, expectedFamilyEdges),
        diagnostic: score(actualFamilyDiagnostics, expectedFamilyDiagnostics),
      };
    }
    accuracy.families = familyAccuracy;
  }
  return accuracy;
};

const runBenchmark = async () => {
  const manifest = readJson(corpusPath);
  const protocol = readJson(protocolPath);
  const packageJson = readJson(resolve(repositoryRoot, "package.json"));
  const coldRuns = numberArgument("--cold-runs", 1);
  const warmRuns = numberArgument("--warm-runs", 3);
  const { analyzeTypeScriptRepository } =
    await import("../src/analyzers/index.ts");
  const allEntries = corpusEntries(manifest);
  const fixtures = [];

  for (const fixture of manifest.fixtures) {
    const entries = fixtureEntries(fixture);
    const root = containedPath(
      repositoryRoot,
      fixture.root,
      `fixture ${fixture.id}`,
    );
    const tsconfigPath = fixture.tsconfig
      ? containedPath(root, fixture.tsconfig, `fixture ${fixture.id} tsconfig`)
      : undefined;
    const samples = { cold: [], warm: [] };
    let snapshot;
    let serializedSnapshot;
    const invoke = () => {
      const started = performance.now();
      snapshot = analyzeTypeScriptRepository({
        rootDir: root,
        ...(tsconfigPath ? { tsconfigPath: tsconfigPath } : {}),
      });
      const serialized = JSON.stringify(snapshot);
      if (serializedSnapshot === undefined) serializedSnapshot = serialized;
      else if (serialized !== serializedSnapshot)
        fail(`benchmark fixture is nondeterministic: ${fixture.id}`);
      const durationMs = performance.now() - started;
      return { durationMs, rssBytes: process.memoryUsage().rss };
    };
    for (let index = 0; index < coldRuns; index += 1)
      samples.cold.push(invoke());
    for (let index = 0; index < warmRuns; index += 1)
      samples.warm.push(invoke());
    if (!snapshot) fail(`benchmark produced no snapshot: ${fixture.id}`);
    fixtures.push({
      id: fixture.id,
      digest: digestEntries(entries),
      fileCount: entries.length,
      reportBytes: Buffer.byteLength(serializedSnapshot ?? "", "utf8"),
      cold: timingSummary(samples.cold),
      warm: timingSummary(samples.warm),
      graph: {
        nodes: snapshot.nodes.length,
        edges: snapshot.edges.length,
        diagnostics: snapshot.diagnostics.length,
      },
      accuracy: accuracyFor(
        snapshot,
        fixture.expected
          ? containedPath(
              repositoryRoot,
              fixture.expected,
              `fixture ${fixture.id} expected`,
            )
          : undefined,
      ),
    });
  }

  const result = {
    artifactVersion: 1,
    protocolVersion: protocol.protocolVersion,
    generatedAt: new Date().toISOString(),
    tool: {
      packageVersion: packageJson.version,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    corpus: {
      version: manifest.corpusVersion,
      digest: digestEntries(allEntries),
      fileCount: allEntries.length,
      fixtures: fixtures.length,
    },
    runs: { cold: coldRuns, warm: warmRuns },
    fixtures,
  };
  validateArtifact(result, manifest, protocol, { checkCorpus: true });
  const outputPath = resolve(repositoryRoot, outputArgument() ?? baselinePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify({
      ok: true,
      output: relativeRepositoryPath(outputPath),
      corpusDigest: result.corpus.digest,
      fixtures: result.fixtures.length,
      coldRuns,
      warmRuns,
    }),
  );
};

const rejectSensitiveArtifactFields = (value, path = "artifact") => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectSensitiveArtifactFields(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      if (
        value.startsWith("/") ||
        value.startsWith("~") ||
        value.startsWith("\\") ||
        /^[A-Za-z]:[\\/]/u.test(value) ||
        /^file:/iu.test(value)
      )
        fail(`benchmark artifact contains an absolute path at ${path}`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SOURCE_BODY_KEYS.has(key.toLowerCase()))
      fail(`benchmark artifact contains source-body field ${path}.${key}`);
    if (key === "telemetry" || key === "network")
      fail(
        `benchmark artifact contains disallowed metadata field ${path}.${key}`,
      );
    rejectSensitiveArtifactFields(child, `${path}.${key}`);
  }
};

const validDigest = (value) =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);

const exactObject = (value, allowedKeys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${label} has unknown field: ${key}`);
  }
  return value;
};

const validateTiming = (timing, label, expectedRuns) => {
  if (!timing || typeof timing !== "object") fail(`${label} timing is missing`);
  if (timing.runs !== expectedRuns) fail(`${label} timing run count drift`);
  for (const key of ["minMs", "medianMs", "p95Ms", "maxMs"]) {
    if (typeof timing[key] !== "number" || timing[key] < 0)
      fail(`${label} timing field is invalid: ${key}`);
  }
  if (!Number.isInteger(timing.peakRssBytes) || timing.peakRssBytes < 0)
    fail(`${label} peak RSS is invalid`);
  exactObject(
    timing,
    new Set(["runs", "minMs", "medianMs", "p95Ms", "maxMs", "peakRssBytes"]),
    `${label} timing`,
  );
};

const validateScore = (scoreValue, label) => {
  if (!scoreValue || typeof scoreValue !== "object")
    fail(`${label} score is missing`);
  for (const key of ["truePositives", "emitted", "expected"]) {
    if (!Number.isInteger(scoreValue[key]) || scoreValue[key] < 0)
      fail(`${label} count is invalid: ${key}`);
  }
  for (const key of ["precision", "recall"]) {
    if (
      typeof scoreValue[key] !== "number" ||
      scoreValue[key] < 0 ||
      scoreValue[key] > 1
    )
      fail(`${label} ratio is invalid: ${key}`);
  }
  if (
    scoreValue.truePositives > scoreValue.emitted ||
    scoreValue.truePositives > scoreValue.expected
  )
    fail(`${label} true-positive count exceeds a denominator`);
  exactObject(
    scoreValue,
    new Set(["truePositives", "emitted", "expected", "precision", "recall"]),
    `${label} score`,
  );
};

const validateArtifact = (artifact, manifest, protocol, options = {}) => {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact))
    fail("benchmark artifact must be an object");
  const keys = Object.keys(artifact);
  for (const key of keys)
    if (!ARTIFACT_KEYS.has(key))
      fail(`benchmark artifact has unknown field: ${key}`);
  if (
    artifact.artifactVersion !== 1 ||
    artifact.protocolVersion !== protocol.protocolVersion
  )
    fail("benchmark artifact version drift");
  if (
    typeof artifact.generatedAt !== "string" ||
    Number.isNaN(Date.parse(artifact.generatedAt))
  )
    fail("benchmark artifact generatedAt is invalid");
  const tool = artifact.tool;
  exactObject(
    tool,
    new Set([
      "packageVersion",
      "nodeVersion",
      "platform",
      "arch",
      "cpuCount",
      "totalMemoryBytes",
    ]),
    "benchmark tool disclosure",
  );
  for (const key of ["packageVersion", "nodeVersion", "platform", "arch"])
    if (typeof tool?.[key] !== "string" || tool[key].length === 0)
      fail(`benchmark tool disclosure is missing: ${key}`);
  for (const key of ["cpuCount", "totalMemoryBytes"])
    if (!Number.isInteger(tool?.[key]) || tool[key] < 1)
      fail(`benchmark tool disclosure is invalid: ${key}`);
  const corpus = artifact.corpus;
  exactObject(
    corpus,
    new Set(["version", "digest", "fileCount", "fixtures"]),
    "benchmark corpus",
  );
  if (
    corpus?.version !== manifest.corpusVersion ||
    !validDigest(corpus?.digest)
  )
    fail("benchmark corpus version or digest is invalid");
  if (
    !Number.isInteger(corpus.fileCount) ||
    corpus.fileCount < 0 ||
    corpus.fixtures !== manifest.fixtures.length
  )
    fail("benchmark corpus counts are invalid");
  const runs = artifact.runs;
  exactObject(runs, new Set(["cold", "warm"]), "benchmark runs");
  if (
    !Number.isInteger(runs?.cold) ||
    runs.cold < 1 ||
    !Number.isInteger(runs?.warm) ||
    runs.warm < 1
  )
    fail("benchmark run counts are invalid");
  if (
    !Array.isArray(artifact.fixtures) ||
    artifact.fixtures.length !== manifest.fixtures.length
  )
    fail("benchmark fixture results do not match the corpus");
  const expectedIds = new Set(manifest.fixtures.map((fixture) => fixture.id));
  const seenIds = new Set();
  for (const fixture of artifact.fixtures) {
    if (
      typeof fixture?.id !== "string" ||
      !expectedIds.has(fixture.id) ||
      seenIds.has(fixture.id)
    )
      fail(
        `benchmark fixture result has an unknown or duplicate id: ${fixture?.id}`,
      );
    seenIds.add(fixture.id);
    exactObject(
      fixture,
      new Set([
        "id",
        "digest",
        "fileCount",
        "reportBytes",
        "cold",
        "warm",
        "graph",
        "accuracy",
      ]),
      `benchmark fixture ${fixture.id}`,
    );
    if (
      !validDigest(fixture.digest) ||
      !Number.isInteger(fixture.fileCount) ||
      fixture.fileCount < 0 ||
      !Number.isInteger(fixture.reportBytes) ||
      fixture.reportBytes < 0
    )
      fail(
        `benchmark fixture digest, file count, or report size is invalid: ${fixture.id}`,
      );
    validateTiming(fixture.cold, `${fixture.id} cold`, runs.cold);
    validateTiming(fixture.warm, `${fixture.id} warm`, runs.warm);
    exactObject(
      fixture.graph,
      new Set(["nodes", "edges", "diagnostics"]),
      `benchmark graph ${fixture.id}`,
    );
    for (const key of ["nodes", "edges", "diagnostics"])
      if (!Number.isInteger(fixture.graph?.[key]) || fixture.graph[key] < 0)
        fail(`benchmark graph count is invalid: ${fixture.id}.${key}`);
    if (fixture.accuracy !== null) {
      exactObject(
        fixture.accuracy,
        new Set(["edge", "diagnostic", "families"]),
        `benchmark accuracy ${fixture.id}`,
      );
      validateScore(fixture.accuracy?.edge, `${fixture.id} edge`);
      validateScore(fixture.accuracy?.diagnostic, `${fixture.id} diagnostic`);
      if (fixture.accuracy.families !== undefined) {
        exactObject(
          fixture.accuracy.families,
          new Set(Object.keys(fixture.accuracy.families)),
          `benchmark accuracy families ${fixture.id}`,
        );
        if (Object.keys(fixture.accuracy.families).length === 0)
          fail(`benchmark accuracy families are empty: ${fixture.id}`);
        for (const [family, familyAccuracy] of Object.entries(
          fixture.accuracy.families,
        )) {
          exactObject(
            familyAccuracy,
            new Set(["edge", "diagnostic"]),
            `benchmark accuracy ${fixture.id}.${family}`,
          );
          validateScore(familyAccuracy.edge, `${fixture.id}.${family} edge`);
          validateScore(
            familyAccuracy.diagnostic,
            `${fixture.id}.${family} diagnostic`,
          );
        }
      }
    }
  }
  rejectSensitiveArtifactFields(artifact);
  if (options.checkCorpus) {
    const entries = corpusEntries(manifest);
    if (
      digestEntries(entries) !== corpus.digest ||
      entries.length !== corpus.fileCount
    )
      fail("benchmark corpus digest does not match the selected files");
    for (const fixture of manifest.fixtures) {
      const result = artifact.fixtures.find((entry) => entry.id === fixture.id);
      const entriesForFixture = fixtureEntries(fixture);
      if (
        result?.digest !== digestEntries(entriesForFixture) ||
        result.fileCount !== entriesForFixture.length
      )
        fail(
          `benchmark fixture digest does not match selected files: ${fixture.id}`,
        );
    }
  }
};

const validateManifest = (manifest, protocol, schema) => {
  if (
    manifest?.protocolVersion !== protocol.protocolVersion ||
    manifest.corpusVersion !== "0.1"
  )
    fail("benchmark corpus manifest version drift");
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0)
    fail("benchmark corpus must declare fixtures");
  const ids = new Set();
  for (const fixture of manifest.fixtures) {
    if (!fixture || typeof fixture.id !== "string" || ids.has(fixture.id))
      fail(
        `benchmark corpus has a missing or duplicate fixture id: ${fixture?.id}`,
      );
    ids.add(fixture.id);
    const root = containedPath(
      repositoryRoot,
      fixture.root,
      `fixture ${fixture.id}`,
    );
    if (!existsSync(root) || !lstatSync(root).isDirectory())
      fail(`benchmark fixture root is missing: ${fixture.root}`);
    if (fixture.tsconfig)
      containedPath(root, fixture.tsconfig, `fixture ${fixture.id} tsconfig`);
    if (fixture.expected) {
      const expected = containedPath(
        repositoryRoot,
        fixture.expected,
        `fixture ${fixture.id} expected`,
      );
      if (!existsSync(expected) || !lstatSync(expected).isFile())
        fail(`benchmark expected artifact is missing: ${fixture.expected}`);
      validateExpected(readJson(expected), fixture.expected);
    }
    if (!Array.isArray(fixture.families) || fixture.families.length === 0)
      fail(`benchmark fixture has no construct families: ${fixture.id}`);
  }
  if (schema?.properties?.artifactVersion?.const !== 1)
    fail("benchmark result schema version drift");
  if (protocol.fixtureSelection?.sourceBodiesInArtifacts !== false)
    fail("benchmark protocol must prohibit source bodies in artifacts");
  if (
    protocol.disclosure?.network !== "none" ||
    protocol.disclosure?.telemetry !== "none"
  )
    fail("benchmark protocol must prohibit network and telemetry");
  if (
    typeof protocol.runModes?.cold !== "string" ||
    typeof protocol.runModes?.warm !== "string" ||
    protocol.accuracy?.denominator !==
      "expected records in the fixture's checked-in expected artifact" ||
    protocol.variance?.acceptableRegression !==
      "A result over 20% slower than the recorded baseline requires an explanation before release."
  )
    fail("benchmark protocol measurement rules are incomplete");
};

const validate = () => {
  const manifest = readJson(corpusPath);
  const protocol = readJson(protocolPath);
  const schema = readJson(resultSchemaPath);
  const baseline = readJson(baselinePath);
  validateManifest(manifest, protocol, schema);
  validateArtifact(baseline, manifest, protocol, { checkCorpus: true });
  console.log(
    JSON.stringify({
      ok: true,
      corpusVersion: manifest.corpusVersion,
      corpusDigest: baseline.corpus.digest,
      fixtures: manifest.fixtures.length,
      artifact: "benchmarks/baseline.v0.1.json",
    }),
  );
};

export { validateArtifact, validateManifest };

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const command = process.argv[2];
  if (command !== "run" && command !== "validate") {
    console.error("usage: node scripts/benchmark.mjs <run|validate> [options]");
    process.exit(2);
  }

  try {
    if (command === "run") await runBenchmark();
    else validate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`benchmark ${command} failed: ${message}`);
    process.exit(1);
  }
}
