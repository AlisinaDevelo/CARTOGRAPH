import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ARCHITECTURE_QUERY_CONTRACT,
  buildArchitectureQueryExplanation,
  createGraphSnapshot,
  executeArchitectureQuery,
  GraphContractError,
  serializeArchitectureQueryExplanation,
} from "../../src/core/index.js";
import {
  renderArchitectureQueryExplanation,
  renderArchitectureQueryExplanationHtml,
} from "../../src/report/render.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const evidence = (id: string, path: string, line: number) => ({
  id,
  kind: "source" as const,
  path,
  line,
  detector: "cartograph.query-explanation-test@1",
  contentHash: "c".repeat(64),
});

const graph = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "query-explanation-test" },
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

const metadataFixture = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "test/fixtures/architecture-query-explanation/scenarios.v0.1.json",
    ),
    "utf8",
  ),
) as {
  cases: Array<{ id: string; metadata?: unknown }>;
};

describe("architecture query explanations", () => {
  it("retains cycles, missing evidence, and depth limits deterministically", () => {
    const query = {
      schemaVersion: 1 as const,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "explanation-cycle",
      operation: "reachability" as const,
      selectors: { nodes: [{ id: "node-a" }] },
      limits: { maxDepth: 1 },
      traversal: {
        direction: "downstream" as const,
        edgeKinds: ["calls", "imports", "publishes"] as const,
      },
    };
    const result = executeArchitectureQuery(graph, query);
    const explanation = buildArchitectureQueryExplanation(query, result);
    const codes = new Set(explanation.uncertainty.map((item) => item.code));

    expect(explanation.summary.truncated).toBe(true);
    expect(codes).toEqual(
      new Set(["diagnostic", "missing-evidence", "truncated"]),
    );
    expect(explanation.tool.formats).toEqual(["json", "markdown", "html"]);
    expect(serializeArchitectureQueryExplanation(explanation)).toBe(
      serializeArchitectureQueryExplanation(
        buildArchitectureQueryExplanation(
          query,
          executeArchitectureQuery(graph, query),
        ),
      ),
    );
  });

  it("makes empty results and HTML keyboard/accessibility boundaries explicit", () => {
    const query = {
      schemaVersion: 1 as const,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "explanation-empty",
      operation: "select-nodes" as const,
      selectors: { nodes: [{ name: "absent" }] },
    };
    const explanation = buildArchitectureQueryExplanation(
      query,
      executeArchitectureQuery(graph, query),
    );
    const html = renderArchitectureQueryExplanationHtml(explanation);

    expect(explanation.summary.empty).toBe(true);
    expect(explanation.uncertainty.map((item) => item.code)).toContain(
      "empty-result",
    );
    expect(html).toContain('href="#summary-heading"');
    expect(html).toContain('<main id="report" tabindex="-1">');
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("<details");
    expect(html).not.toMatch(/<(?:script|link|img)(?:\s|>)/u);
  });

  it("includes metadata context, reports format projections, and rejects mismatches", () => {
    const fixtureCase = metadataFixture.cases.find(
      (item) => item.id === "metadata-context",
    );
    if (fixtureCase?.metadata === undefined)
      throw new Error("metadata fixture missing");
    const query = {
      schemaVersion: 1 as const,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "explanation-metadata",
      operation: "select-nodes" as const,
      selectors: { nodes: [{ id: "node-a" }] },
      projection: { metadata: "full" as const },
    };
    const explanation = buildArchitectureQueryExplanation(
      query,
      executeArchitectureQuery(graph, query, fixtureCase.metadata),
    );

    expect(explanation.summary.metadataPolicies).toBe(1);
    expect(explanation.summary.metadataDecisions).toBe(1);
    expect(explanation.summary.metadataOwnershipHints).toBe(1);
    expect(explanation.uncertainty.map((item) => item.code)).toContain(
      "metadata",
    );
    expect(renderArchitectureQueryExplanation(explanation, "json")).toContain(
      "normalizedPlan",
    );
    expect(
      renderArchitectureQueryExplanation(explanation, "markdown"),
    ).toContain("Policy and ADR context");
    expect(() =>
      buildArchitectureQueryExplanation(
        { ...query, queryId: "different-query" },
        explanation.result,
      ),
    ).toThrow(GraphContractError);
  });
});
