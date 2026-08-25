#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

const repositoryRoot = resolve(process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  process.argv.includes("--fixture")
    ? process.argv[process.argv.indexOf("--fixture") + 1]
    : "test/fixtures/architecture-query/scenarios.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/architecture-query-fixtures.v0.1.schema.json",
);
const querySchemaPath = resolve(
  repositoryRoot,
  "schema/architecture-query.v0.1.schema.json",
);
const resultSchemaPath = resolve(
  repositoryRoot,
  "schema/architecture-query-result.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(
    `cartograph.architecture-query validation failed: ${message}`,
  );
};

const evidence = (id, path, line) => ({
  id,
  kind: "source",
  path,
  line,
  detector: "cartograph.query-fixture@1",
  contentHash: "a".repeat(64),
});

const snapshot = (createGraphSnapshot) =>
  createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha: "architecture-query-fixture" },
    nodes: [
      {
        id: "node-a",
        stableKey: "function:node-a",
        kind: "function",
        name: "alpha",
        language: "typescript",
      },
      {
        id: "node-b",
        stableKey: "function:node-b",
        kind: "function",
        name: "beta",
        language: "typescript",
      },
      {
        id: "node-c",
        stableKey: "function:node-c",
        kind: "function",
        name: "gamma",
        language: "typescript",
      },
      {
        id: "module-d",
        stableKey: "module:module-d",
        kind: "module",
        name: "delta",
        language: "typescript",
      },
    ],
    edges: [
      {
        from: "node-a",
        to: "node-b",
        kind: "calls",
        confidence: "certain",
        evidence: [evidence("edge-ab", "src/a.ts", 1)],
      },
      {
        from: "node-b",
        to: "node-c",
        kind: "imports",
        confidence: "inferred",
        evidence: [evidence("edge-bc", "src/b.ts", 2)],
      },
      {
        from: "node-c",
        to: "module-d",
        kind: "depends_on",
        confidence: "inferred",
        evidence: [evidence("edge-cd", "src/c.ts", 3)],
      },
      {
        from: "module-d",
        to: "node-a",
        kind: "calls",
        confidence: "observed",
        evidence: [evidence("edge-da", "src/d.ts", 4)],
      },
      {
        from: "node-a",
        to: "node-b",
        kind: "depends_on",
        confidence: "certain",
        evidence: [evidence("edge-ab-dependency", "src/a.ts", 5)],
      },
      {
        from: "node-b",
        to: "node-c",
        kind: "depends_on",
        confidence: "certain",
        evidence: [evidence("edge-bc-dependency", "src/b.ts", 6)],
      },
    ],
    diagnostics: [],
  });

const validate = async () => {
  const fixture = readJson(fixturePath);
  const ajv = new Ajv({ allErrors: true });
  const validateFixture = ajv.compile(readJson(fixtureSchemaPath));
  const validateQuery = ajv.compile(readJson(querySchemaPath));
  const validateResult = ajv.compile(readJson(resultSchemaPath));
  if (!validateFixture(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validateFixture.errors)}`,
    );
  if (
    fixture.scope.network ||
    fixture.scope.filesystemWrites ||
    fixture.scope.sourceBodiesIncluded ||
    fixture.scope.execution ||
    !fixture.scope.deterministic
  )
    fail(
      "fixture scope must remain local, read-only, source-free, and deterministic",
    );

  const {
    createGraphSnapshot,
    executeArchitectureQuery,
    serializeArchitectureQueryResult,
  } = await import("../src/core/index.ts");
  const graph = snapshot(createGraphSnapshot);
  const before = JSON.stringify(graph);
  const caseIds = new Set();
  const statuses = new Set();

  for (const scenario of fixture.cases) {
    if (caseIds.has(scenario.id)) fail(`duplicate scenario ${scenario.id}`);
    caseIds.add(scenario.id);
    const validRequest = validateQuery(scenario.query);
    if (scenario.scenario === "malformed") {
      if (validRequest)
        fail(`${scenario.id} unexpectedly passes the request schema`);
      try {
        executeArchitectureQuery(graph, scenario.query);
        fail(`${scenario.id} unexpectedly executes`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes(scenario.expected.errorIncludes))
          fail(
            `${scenario.id} error did not include ${scenario.expected.errorIncludes}`,
          );
      }
      statuses.add("invalid");
      continue;
    }
    if (!validRequest)
      fail(
        `${scenario.id} request schema validation failed: ${JSON.stringify(validateQuery.errors)}`,
      );
    const result = executeArchitectureQuery(graph, scenario.query);
    if (!validateResult(result))
      fail(
        `${scenario.id} result schema validation failed: ${JSON.stringify(validateResult.errors)}`,
      );
    if (result.status !== scenario.expected.status)
      fail(
        `${scenario.id} expected ${scenario.expected.status}, found ${result.status}`,
      );
    if (
      scenario.expected.nodes !== undefined &&
      result.nodes.length !== scenario.expected.nodes
    )
      fail(
        `${scenario.id} expected ${scenario.expected.nodes} nodes, found ${result.nodes.length}`,
      );
    if (
      scenario.expected.edges !== undefined &&
      result.edges.length !== scenario.expected.edges
    )
      fail(
        `${scenario.id} expected ${scenario.expected.edges} edges, found ${result.edges.length}`,
      );
    if (
      scenario.expected.diagnosticCode !== undefined &&
      !result.diagnostics.some(
        (diagnostic) => diagnostic.code === scenario.expected.diagnosticCode,
      )
    )
      fail(`${scenario.id} is missing ${scenario.expected.diagnosticCode}`);
    if (
      scenario.expected.pathLength !== undefined &&
      result.paths[0]?.length !== scenario.expected.pathLength
    )
      fail(
        `${scenario.id} expected path length ${scenario.expected.pathLength}, found ${result.paths[0]?.length ?? "none"}`,
      );
    if (
      scenario.expected.cycles !== undefined &&
      result.cycles.length !== scenario.expected.cycles
    )
      fail(
        `${scenario.id} expected ${scenario.expected.cycles} cycles, found ${result.cycles.length}`,
      );
    if (
      scenario.expected.boundaries !== undefined &&
      result.boundaries.length !== scenario.expected.boundaries
    )
      fail(
        `${scenario.id} expected ${scenario.expected.boundaries} boundaries, found ${result.boundaries.length}`,
      );
    if (
      scenario.expected.truncated !== undefined &&
      result.truncated !== scenario.expected.truncated
    )
      fail(
        `${scenario.id} expected truncated=${scenario.expected.truncated}, found ${result.truncated}`,
      );
    statuses.add(result.status);

    const repeated = executeArchitectureQuery(graph, scenario.query);
    if (
      serializeArchitectureQueryResult(result) !==
      serializeArchitectureQueryResult(repeated)
    )
      fail(`${scenario.id} is not byte-stable across repeated runs`);
  }

  if (
    !statuses.has("ok") ||
    !statuses.has("unsupported") ||
    !statuses.has("resource-limit") ||
    !statuses.has("invalid")
  )
    fail(
      "fixture corpus must cover positive, unsupported, resource-limit, and malformed outcomes",
    );
  if (JSON.stringify(graph) !== before)
    fail("query execution mutated the input snapshot");

  return {
    ok: true,
    contract: "cartograph.architecture-query",
    fixtureId: fixture.fixtureId,
    cases: fixture.cases.length,
    statuses: [...statuses].sort(),
    network: false,
    readOnly: true,
    sourceBodiesIncluded: false,
    deterministic: true,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/query-contract.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(await validate()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
