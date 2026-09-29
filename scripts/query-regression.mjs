#!/usr/bin/env node
/* global console, process, structuredClone, URL */
// Q-011 query regression and authorization-boundary corpus. Replays parser
// bug cases, path-containment rejections, stale snapshot and revision
// references, and adversarial selectors, and proves that running queries
// cannot grant, change, or stand in for a policy decision.

import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  GraphQueryLanguageParseError,
  createGraphSnapshot,
  diffGraphSnapshots,
  evaluatePolicyOnSnapshot,
  executeArchitectureQuery,
  executeGraphQuery,
  parseGraphQueryLanguage,
  serializePolicyEvaluation,
} from "../src/core/index.ts";

const repositoryRoot = resolve(process.cwd());
// Generous per-query ceiling: the corpus is tiny, so anything near this means
// an adversarial selector escaped its bounds.
const MAX_QUERY_MS = 2_000;

const fail = (message) => {
  throw new Error(`cartograph.query-regression validation failed: ${message}`);
};

const evidence = (id, path, line) => ({
  id,
  kind: "source",
  path,
  line,
  detector: "cartograph.query-regression@1",
  contentHash: "e".repeat(64),
});

const node = (id, kind, path) => ({
  id,
  stableKey: id,
  kind,
  name: id.split(":").at(-1),
  location: { path, line: 1 },
});

const before = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "base" },
  nodes: [
    node("module:src/a.ts", "module", "src/a.ts"),
    node("module:src/b.ts", "module", "src/b.ts"),
  ],
  edges: [
    {
      from: "module:src/a.ts",
      to: "module:src/b.ts",
      kind: "imports",
      confidence: "certain",
      evidence: [evidence("a-b", "src/a.ts", 1)],
    },
  ],
});

const snapshot = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "head" },
  nodes: [
    node("module:src/a.ts", "module", "src/a.ts"),
    node("module:src/b.ts", "module", "src/b.ts"),
    node("function:src/b.ts:run", "function", "src/b.ts"),
  ],
  edges: [
    {
      from: "module:src/a.ts",
      to: "module:src/b.ts",
      kind: "imports",
      confidence: "certain",
      evidence: [evidence("a-b", "src/a.ts", 1)],
    },
    {
      from: "function:src/b.ts:run",
      to: "module:src/a.ts",
      kind: "calls",
      confidence: "inferred",
      evidence: [evidence("run-a", "lib/b.ts", 3)],
    },
  ],
});

const diff = diffGraphSnapshots(before, snapshot);

const policy = {
  policyId: "query-boundary",
  version: "1.0.0",
  mode: "enforce",
  rules: [
    {
      id: "no-lib-calls",
      target: "edge",
      assertion: "absent",
      selector: { kind: "calls", fromPath: "src/**" },
    },
    {
      id: "imports-exist",
      target: "edge",
      assertion: "exists",
      selector: { kind: "imports" },
    },
  ],
};

const isContainedPath = (path) =>
  typeof path === "string" &&
  !path.startsWith("/") &&
  !path.startsWith("\\") &&
  !/^[A-Za-z][A-Za-z\d+.-]*:/u.test(path) &&
  !path.split(/[\\/]/u).includes("..");

const timed = (id, run) => {
  const started = performance.now();
  const result = run();
  const elapsed = performance.now() - started;
  if (elapsed > MAX_QUERY_MS)
    fail(`${id} took ${elapsed.toFixed(0)} ms (limit ${MAX_QUERY_MS} ms)`);
  return result;
};

export const runQueryRegressions = () => {
  const fixture = JSON.parse(
    readFileSync(
      resolve(repositoryRoot, "test/fixtures/query-regression/cases.v0.1.json"),
      "utf8",
    ),
  );
  if (fixture.contract !== "cartograph.query-regression-fixtures")
    fail("unexpected fixture contract");

  const snapshotBefore = structuredClone(snapshot);
  const decisionBefore = serializePolicyEvaluation(
    evaluatePolicyOnSnapshot(policy, snapshot),
  );

  for (const scenario of fixture.parse) {
    try {
      timed(scenario.id, () => parseGraphQueryLanguage(scenario.query));
      fail(`${scenario.id} unexpectedly parsed`);
    } catch (error) {
      if (!(error instanceof GraphQueryLanguageParseError)) throw error;
      if (error.code !== scenario.errorCode)
        fail(
          `${scenario.id} expected ${scenario.errorCode}, found ${error.code}`,
        );
    }
  }

  for (const scenario of fixture.execute) {
    const result = timed(scenario.id, () =>
      scenario.input === "diff"
        ? executeGraphQuery(undefined, scenario.query, diff)
        : executeGraphQuery(snapshot, scenario.query),
    );
    if (scenario.status !== undefined && result.status !== scenario.status)
      fail(
        `${scenario.id} expected status ${scenario.status}, found ${result.status}`,
      );
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    for (const code of scenario.diagnostics ?? [])
      if (!codes.includes(code))
        fail(`${scenario.id} is missing diagnostic ${code}`);
    if (scenario.nodes !== undefined && result.nodes.length !== scenario.nodes)
      fail(`${scenario.id} returned ${result.nodes.length} nodes`);
    if (scenario.edges !== undefined && result.edges.length !== scenario.edges)
      fail(`${scenario.id} returned ${result.edges.length} edges`);
    const paths = [
      ...result.nodes.map((item) => item.location?.path),
      ...result.edges.flatMap((edge) =>
        edge.evidence.map((item) => item.path ?? item.location?.path),
      ),
    ].filter((path) => path !== undefined);
    if (!paths.every(isContainedPath))
      fail(`${scenario.id} returned a path outside the repository`);
  }

  for (const scenario of fixture.architecture) {
    const result = timed(scenario.id, () =>
      executeArchitectureQuery(snapshot, scenario.query),
    );
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    for (const code of scenario.diagnostics ?? [])
      if (!codes.includes(code))
        fail(`${scenario.id} is missing diagnostic ${code}`);
  }

  // Queries read a snapshot; they must never mutate it or change a decision.
  if (!isDeepStrictEqual(snapshot, snapshotBefore))
    fail("a query mutated its input snapshot");
  const decisionAfter = serializePolicyEvaluation(
    evaluatePolicyOnSnapshot(policy, snapshot),
  );
  if (decisionAfter !== decisionBefore)
    fail("running queries changed the policy decision");

  // A query result is not a graph and cannot stand in for policy input.
  const selection = executeGraphQuery(snapshot, "v1 edges where kind = calls");
  try {
    evaluatePolicyOnSnapshot(policy, selection);
    fail("a query result was accepted as policy input");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("cartograph.query-regression")
    )
      throw error;
  }

  return {
    ok: true,
    contract: "cartograph.query-regression",
    fixture: fixture.fixtureId,
    parseCases: fixture.parse.length,
    executeCases: fixture.execute.length,
    architectureCases: fixture.architecture.length,
    policyDecisionUnchanged: true,
    inputUnmutated: true,
  };
};

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node --import tsx scripts/query-regression.mjs validate",
    );
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(runQueryRegressions()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
