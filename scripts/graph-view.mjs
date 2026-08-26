#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  createGraphViewReport,
  renderGraphViewHtml,
  renderGraphViewMarkdown,
  serializeGraphViewReport,
} from "../src/report/graph-view.ts";
import { parseGraphSnapshot } from "../src/core/index.ts";

const repositoryRoot = resolve(process.cwd());
const fixtureRoot = resolve(repositoryRoot, "test/fixtures/graph-view");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(`cartograph.graph-view validation failed: ${message}`);
};

const expectEqual = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(
      `${label} drifted: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
    );
};

const validate = () => {
  const fixture = readJson(resolve(fixtureRoot, "scenarios.v0.1.json"));
  const fixtureSchema = readJson(
    resolve(repositoryRoot, "schema/graph-view-fixtures.v0.1.schema.json"),
  );
  const fixtureValidator = new Ajv({ allErrors: true, strict: false }).compile(
    fixtureSchema,
  );
  if (!fixtureValidator(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(fixtureValidator.errors)}`,
    );

  const reportSchema = readJson(
    resolve(repositoryRoot, "schema/graph-view.v0.1.schema.json"),
  );
  const reportValidator = new Ajv({ allErrors: true, strict: false }).compile(
    reportSchema,
  );
  const results = [];
  for (const scenario of fixture.scenarios) {
    const snapshotInput = readJson(resolve(fixtureRoot, scenario.snapshotFile));
    const snapshot = parseGraphSnapshot(snapshotInput);
    const report = createGraphViewReport({
      snapshot,
      query: scenario.query,
      viewId: `fixture-${scenario.id}`,
    });
    if (!reportValidator(report))
      fail(
        `${scenario.id} report schema validation failed: ${JSON.stringify(reportValidator.errors)}`,
      );
    const repeated = createGraphViewReport({
      snapshot,
      query: scenario.query,
      viewId: `fixture-${scenario.id}`,
    });
    expectEqual(
      serializeGraphViewReport(report),
      serializeGraphViewReport(repeated),
      `${scenario.id} repeated serialization`,
    );

    const reordered = {
      ...snapshotInput,
      nodes: [...snapshotInput.nodes].reverse(),
      edges: [...snapshotInput.edges].reverse(),
      diagnostics: [...snapshotInput.diagnostics].reverse(),
    };
    const reorderedReport = createGraphViewReport({
      snapshot: reordered,
      query: scenario.query,
      viewId: `fixture-${scenario.id}`,
    });
    expectEqual(
      serializeGraphViewReport(report),
      serializeGraphViewReport(reorderedReport),
      `${scenario.id} reordered serialization`,
    );
    expectEqual(
      report.selectionDigest,
      reorderedReport.selectionDigest,
      `${scenario.id} semantic selection digest`,
    );
    expectEqual(
      report.edges.map((edge) => `${edge.from}|${edge.kind}|${edge.to}`),
      reorderedReport.edges.map(
        (edge) => `${edge.from}|${edge.kind}|${edge.to}`,
      ),
      `${scenario.id} typed edge identities`,
    );

    const expected = scenario.expected;
    expectEqual(
      report.nodes.length,
      expected.nodes,
      `${scenario.id} node count`,
    );
    expectEqual(
      report.edges.length,
      expected.edges,
      `${scenario.id} edge count`,
    );
    expectEqual(
      report.legend.omittedContext.nodes.count,
      expected.omittedNodes,
      `${scenario.id} omitted node count`,
    );
    expectEqual(
      report.legend.omittedContext.edges.count,
      expected.omittedEdges,
      `${scenario.id} omitted edge count`,
    );
    expectEqual(
      report.legend.omittedContext.diagnostics.count,
      expected.omittedDiagnostics,
      `${scenario.id} omitted diagnostic count`,
    );
    expectEqual(
      report.legend.unresolvedEdges.count,
      expected.unresolvedEdges,
      `${scenario.id} unresolved edge count`,
    );

    const markdown = renderGraphViewMarkdown(report);
    const html = renderGraphViewHtml(report);
    if (
      !markdown.includes("## Legend") ||
      !markdown.includes("Omitted context")
    )
      fail(`${scenario.id} markdown legend is incomplete`);
    if (
      !html.includes("Content-Security-Policy") ||
      /<\/?(?:script|img|link)\b/iu.test(html)
    )
      fail(`${scenario.id} HTML rendering is not self-contained`);
    results.push({
      id: scenario.id,
      nodes: report.nodes.length,
      edges: report.edges.length,
      omittedNodes: report.legend.omittedContext.nodes.count,
      omittedEdges: report.legend.omittedContext.edges.count,
      omittedDiagnostics: report.legend.omittedContext.diagnostics.count,
      unresolvedEdges: report.legend.unresolvedEdges.count,
      selectionDigest: report.selectionDigest,
      reportDigest: report.reportDigest,
    });
  }
  return {
    ok: true,
    contract: "cartograph.graph-view",
    schemaVersion: 1,
    scenarios: results,
  };
};

if (process.argv[2] !== "validate") {
  console.error("usage: node scripts/graph-view.mjs validate");
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
