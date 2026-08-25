import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  ARCHITECTURE_QUERY_CONTRACT,
  ARCHITECTURE_QUERY_SCHEMA_VERSION,
  ArchitectureQueryResultSchema,
  createGraphSnapshot,
  executeArchitectureQuery,
  GraphValidationError,
  parseArchitectureQuery,
  serializeArchitectureQuery,
  serializeArchitectureQueryResult,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const evidence = (id: string, path: string, line: number) => ({
  id,
  kind: "source" as const,
  path,
  line,
  detector: "cartograph.query-test@1",
  contentHash: "b".repeat(64),
});

const graph = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "query-test" },
  nodes: [
    {
      id: "node-b",
      stableKey: "function:node-b",
      kind: "function",
      name: "beta",
      language: "typescript",
    },
    {
      id: "node-a",
      stableKey: "function:node-a",
      kind: "function",
      name: "alpha",
      language: "typescript",
    },
    {
      id: "module-c",
      stableKey: "module:module-c",
      kind: "module",
      name: "gamma",
      language: "typescript",
    },
  ],
  edges: [
    {
      from: "node-b",
      to: "node-a",
      kind: "calls",
      confidence: "certain",
      evidence: [evidence("edge-ba", "src/b.ts", 2)],
    },
    {
      from: "node-a",
      to: "module-c",
      kind: "imports",
      confidence: "inferred",
      evidence: [evidence("edge-ac", "src/a.ts", 3)],
    },
  ],
  diagnostics: [
    {
      id: "diagnostic:node-a",
      code: "DYNAMIC_TEST",
      severity: "warning",
      message: "The test graph contains a dynamic construct.",
      nodeId: "node-a",
      evidence: [evidence("diagnostic-node-a", "src/a.ts", 4)],
    },
  ],
});

describe("architecture query contract", () => {
  it("normalizes defaults and preserves canonical request ordering", () => {
    const first = serializeArchitectureQuery({
      schemaVersion: 1,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "query-defaults",
      operation: "select-nodes",
      selectors: { nodes: [{ kind: "function" }] },
    });
    const second = serializeArchitectureQuery({
      selectors: { nodes: [{ kind: "function" }] },
      operation: "select-nodes",
      queryId: "query-defaults",
      contract: ARCHITECTURE_QUERY_CONTRACT,
      schemaVersion: ARCHITECTURE_QUERY_SCHEMA_VERSION,
    });

    expect(first).toBe(second);
    expect(parseArchitectureQuery(JSON.parse(first))).toMatchObject({
      limits: { maxDepth: 8, maxNodes: 10_000, maxEdges: 20_000 },
      projection: { evidence: "full", includeNodes: true },
      ordering: { nodes: "stableKey,id" },
    });
  });

  it("selects nodes and projects matching snapshot diagnostics", () => {
    const result = executeArchitectureQuery(graph, {
      schemaVersion: 1,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "select-functions",
      operation: "select-nodes",
      selectors: { nodes: [{ kind: "function" }] },
      projection: { includeEdges: false },
    });

    expect(result.status).toBe("ok");
    expect(result.nodes.map((node) => node.id)).toEqual(["node-a", "node-b"]);
    expect(result.edges).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "DYNAMIC_TEST",
    ]);
    expect(result.diagnostics[0]?.evidenceIds).toEqual(["diagnostic-node-a"]);
  });

  it("selects edges with deterministic endpoint ordering and evidence projection", () => {
    const result = executeArchitectureQuery(graph, {
      schemaVersion: 1,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "select-calls",
      operation: "select-edges",
      selectors: { edges: [{ kind: "calls" }] },
      projection: { evidence: "summary" },
    });

    expect(result.status).toBe("ok");
    expect(result.nodes.map((node) => node.id)).toEqual(["node-a", "node-b"]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.evidence[0]).toMatchObject({
      id: "edge-ba",
      path: "src/b.ts",
      line: 2,
      detector: "cartograph.query-test@1",
    });
    expect(result.edges[0]?.evidence[0]?.reference).toBeUndefined();
  });

  it("returns explicit unsupported and resource-limit diagnostics", () => {
    const unsupported = executeArchitectureQuery(graph, {
      schemaVersion: 1,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "future-reachability",
      operation: "reachability",
      selectors: { nodes: [{ id: "node-a" }] },
    });
    const limited = executeArchitectureQuery(graph, {
      schemaVersion: 1,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "one-node-only",
      operation: "select-nodes",
      selectors: { nodes: [{ kind: "function" }] },
      limits: { maxNodes: 1 },
    });

    expect(unsupported).toMatchObject({
      status: "unsupported",
      unsupportedOperation: "reachability",
    });
    expect(unsupported.diagnostics[0]?.code).toBe(
      "QUERY_OPERATION_UNSUPPORTED",
    );
    expect(limited).toMatchObject({
      status: "resource-limit",
      nodes: [],
      edges: [],
    });
    expect(limited.diagnostics[0]).toMatchObject({
      code: "QUERY_RESOURCE_LIMIT",
      limit: "maxNodes",
    });
  });

  it("rejects malformed requests and keeps execution read-only and byte-stable", () => {
    expect(() =>
      executeArchitectureQuery(graph, {
        schemaVersion: 1,
        contract: ARCHITECTURE_QUERY_CONTRACT,
        queryId: "malformed",
        operation: "select-nodes",
        selectors: { nodes: [{ kind: "function" }] },
        network: true,
      }),
    ).toThrow(GraphValidationError);
    expect(() =>
      executeArchitectureQuery(graph, {
        schemaVersion: 1,
        contract: ARCHITECTURE_QUERY_CONTRACT,
        queryId: "absolute-selector",
        operation: "select-nodes",
        selectors: { nodes: [{ pathPrefix: "/Users/example" }] },
      }),
    ).toThrow(GraphValidationError);

    const before = JSON.stringify(graph);
    const query = {
      schemaVersion: 1,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "stable-result",
      operation: "select-edges" as const,
      selectors: { edges: [{ kind: "imports" as const }] },
    };
    const first = executeArchitectureQuery(graph, query);
    const second = executeArchitectureQuery(graph, query);
    expect(serializeArchitectureQueryResult(first)).toBe(
      serializeArchitectureQueryResult(second),
    );
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("matches the published result schema", () => {
    const validate = new Ajv({ allErrors: true }).compile(
      JSON.parse(
        readFileSync(
          resolve(
            repositoryRoot,
            "schema/architecture-query-result.v0.1.schema.json",
          ),
          "utf8",
        ),
      ) as Record<string, unknown>,
    );
    const result = executeArchitectureQuery(graph, {
      schemaVersion: 1,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "schema-match",
      operation: "select-nodes",
      selectors: { nodes: [{ id: "node-a" }] },
    });
    expect(ArchitectureQueryResultSchema.parse(result)).toBeDefined();
    const isValid = validate as (input: unknown) => boolean;
    expect(isValid(result), JSON.stringify(validate.errors)).toBe(true);
  });
});
