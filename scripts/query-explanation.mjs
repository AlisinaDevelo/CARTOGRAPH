#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { stableStringify } from "../src/core/index.ts";

const repositoryRoot = resolve(process.cwd());
const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const fixturePath = resolve(
  repositoryRoot,
  argumentValue("--fixture") ??
    "test/fixtures/architecture-query-explanation/scenarios.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/architecture-query-explanation-fixtures.v0.1.schema.json",
);
const querySchemaPath = resolve(
  repositoryRoot,
  "schema/architecture-query.v0.1.schema.json",
);
const resultSchemaPath = resolve(
  repositoryRoot,
  "schema/architecture-query-result.v0.1.schema.json",
);
const explanationSchemaPath = resolve(
  repositoryRoot,
  "schema/architecture-query-explanation.v0.1.schema.json",
);
const evaluationSchemaPath = resolve(
  repositoryRoot,
  "schema/architecture-query-explanation-evaluation.v0.1.schema.json",
);
const baselinePath = resolve(
  repositoryRoot,
  "schema/architecture-query-explanation-evaluation.v0.1.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(
    `cartograph.architecture-query-explanation validation failed: ${message}`,
  );
};
const compareStrings = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;
const stable = (value) => stableStringify(value);
const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const fixtureDigest = (fixture) => digest(stable(fixture));
const codeCounts = (items) => {
  const counts = new Map();
  for (const item of items)
    counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => compareStrings(left.code, right.code));
};

const evidence = (id, path, line) => ({
  id,
  kind: "source",
  path,
  line,
  detector: "cartograph.query-explanation-fixture@1",
  contentHash: "a".repeat(64),
});

const createFixtureGraph = (createGraphSnapshot) =>
  createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha: "architecture-query-explanation-fixture" },
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
      {
        id: "queue-events",
        stableKey: "queue:events",
        kind: "queue",
        name: "events",
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
        to: "node-a",
        kind: "calls",
        confidence: "observed",
        evidence: [evidence("edge-ca", "src/c.ts", 3)],
      },
      {
        from: "node-c",
        to: "module-d",
        kind: "depends_on",
        confidence: "inferred",
        evidence: [evidence("edge-cd", "src/c.ts", 4)],
      },
      {
        from: "node-a",
        to: "queue-events",
        kind: "publishes",
        confidence: "inferred",
        evidence: [],
        unresolvedReason: "publisher binding is dynamic",
      },
    ],
    diagnostics: [],
  });

const validate = async () => {
  const fixture = readJson(fixturePath);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const querySchema = readJson(querySchemaPath);
  const resultSchema = readJson(resultSchemaPath);
  const explanationSchema = readJson(explanationSchemaPath);
  ajv.addSchema(querySchema);
  ajv.addSchema(resultSchema);
  const validateFixture = ajv.compile(readJson(fixtureSchemaPath));
  const validateExplanation = ajv.compile(explanationSchema);
  const validateReport = ajv.compile(readJson(evaluationSchemaPath));
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
  if (/(?:fetch|child_process|https?:\/\/)/iu.test(stable(fixture)))
    fail("fixture contains a remote or process-execution reference");

  const {
    buildArchitectureQueryExplanation,
    createGraphSnapshot,
    executeArchitectureQuery,
  } = await import("../src/core/index.ts");
  const { renderArchitectureQueryExplanation } =
    await import("../src/report/render.ts");
  const graph = createFixtureGraph(createGraphSnapshot);
  const graphBefore = stable(graph);
  const caseIds = new Set();
  const statuses = new Set();
  const caseResults = [];

  for (const scenario of fixture.cases) {
    if (caseIds.has(scenario.id)) fail(`duplicate scenario ${scenario.id}`);
    caseIds.add(scenario.id);
    const result = executeArchitectureQuery(
      graph,
      scenario.query,
      scenario.metadata,
    );
    const explanation = buildArchitectureQueryExplanation(
      scenario.query,
      result,
    );
    if (!validateExplanation(explanation))
      fail(
        `${scenario.id} explanation schema validation failed: ${JSON.stringify(validateExplanation.errors)}`,
      );
    const json = renderArchitectureQueryExplanation(explanation, "json");
    const markdown = renderArchitectureQueryExplanation(
      explanation,
      "markdown",
    );
    const html = renderArchitectureQueryExplanation(explanation, "html");
    const repeated = buildArchitectureQueryExplanation(scenario.query, result);
    if (
      stable(explanation) !== stable(repeated) ||
      json !== renderArchitectureQueryExplanation(repeated, "json") ||
      markdown !== renderArchitectureQueryExplanation(repeated, "markdown") ||
      html !== renderArchitectureQueryExplanation(repeated, "html")
    )
      fail(
        `${scenario.id} explanation is not byte-stable across repeated runs`,
      );
    if (
      JSON.parse(json).contract !== "cartograph.architecture-query-explanation"
    )
      fail(`${scenario.id} JSON output is not self-identifying`);
    if (
      !markdown.includes("## Query plan") ||
      !markdown.includes("## Uncertainty") ||
      !markdown.includes(scenario.query.queryId)
    )
      fail(`${scenario.id} Markdown output omits inspectable query details`);
    if (
      !html.includes('meta http-equiv="Content-Security-Policy"') ||
      !html.includes('href="#summary-heading"') ||
      !html.includes('<main id="report"') ||
      !html.includes("<details") ||
      /<(?:script|link|img)(?:\s|>)/iu.test(html) ||
      /(?:https?:|file:)/iu.test(html)
    )
      fail(`${scenario.id} HTML output is not self-contained and accessible`);
    if (
      /(?:"(?:body|sourceBody|sourceCode|sourceText|snippet|excerpt)")/iu.test(
        json,
      )
    )
      fail(`${scenario.id} explanation contains a source-body field`);

    const expected = scenario.expected;
    const summary = explanation.summary;
    for (const key of [
      "resultNodes",
      "resultEdges",
      "pathCount",
      "cycleCount",
      "boundaryCount",
      "truncated",
      "empty",
      "metadataPolicies",
      "metadataDecisions",
      "metadataOwnershipHints",
      "metadataDiagnostics",
    ]) {
      if (expected[key] !== undefined && summary[key] !== expected[key])
        fail(
          `${scenario.id} expected ${key}=${expected[key]}, found ${summary[key]}`,
        );
    }
    if (result.status !== expected.status)
      fail(
        `${scenario.id} expected status ${expected.status}, found ${result.status}`,
      );
    const uncertaintyCodes = [
      ...new Set(explanation.uncertainty.map((item) => item.code)),
    ].sort(compareStrings);
    if (
      stable(uncertaintyCodes) !==
      stable([...expected.uncertaintyCodes].sort(compareStrings))
    )
      fail(
        `${scenario.id} uncertainty drifted: ${JSON.stringify(uncertaintyCodes)}`,
      );
    statuses.add(result.status);
    caseResults.push({
      id: scenario.id,
      operation: scenario.query.operation,
      status: result.status,
      resultNodes: summary.resultNodes,
      resultEdges: summary.resultEdges,
      pathCount: summary.pathCount,
      cycleCount: summary.cycleCount,
      boundaryCount: summary.boundaryCount,
      truncated: summary.truncated,
      empty: summary.empty,
      uncertaintyCodes: codeCounts(explanation.uncertainty),
      formats: {
        json: digest(json),
        markdown: digest(markdown),
        html: digest(html),
      },
      htmlAccessible: true,
      pass: true,
    });
  }
  if (stable(graph) !== graphBefore)
    fail("query explanation mutated the input snapshot");
  if (!statuses.has("ok"))
    fail("fixture corpus must include a successful query");

  const reportWithoutDigest = {
    schemaVersion: 1,
    contract: "cartograph.architecture-query-explanation-evaluation",
    fixtureId: fixture.fixtureId,
    fixtureDigest: fixtureDigest(fixture),
    cases: caseResults.sort((left, right) => compareStrings(left.id, right.id)),
    overall: {
      cases: caseResults.length,
      statuses: [...statuses].sort(compareStrings),
      uncertaintyCodes: codeCounts(
        caseResults.flatMap((item) =>
          item.uncertaintyCodes.flatMap((entry) =>
            Array.from({ length: entry.count }, () => ({ code: entry.code })),
          ),
        ),
      ),
      formatCount: 3,
    },
    deterministic: true,
    readOnly: true,
  };
  const report = {
    ...reportWithoutDigest,
    reportDigest: digest(stable(reportWithoutDigest)),
  };
  if (!validateReport(report))
    fail(
      `evaluation report schema validation failed: ${JSON.stringify(validateReport.errors)}`,
    );
  if (process.argv.includes("--write")) {
    writeFileSync(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } else {
    if (!existsSync(baselinePath))
      fail("published evaluation report is missing");
    if (stable(report) !== stable(readJson(baselinePath)))
      fail(
        "published architecture query explanation evaluation report drifted",
      );
  }
  return {
    ok: true,
    contract: report.contract,
    fixtureId: report.fixtureId,
    cases: report.cases.length,
    statuses: report.overall.statuses,
    uncertaintyCodes: report.overall.uncertaintyCodes,
    formats: report.overall.formatCount,
    network: false,
    readOnly: true,
    sourceBodiesIncluded: false,
    deterministic: true,
    reportDigest: report.reportDigest,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/query-explanation.mjs validate [--write] [--fixture path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(await validate()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
