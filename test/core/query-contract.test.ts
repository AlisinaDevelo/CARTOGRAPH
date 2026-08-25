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
  evaluatePolicyOnSnapshot,
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

const traversalGraph = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "query-traversal-test" },
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
      evidence: [evidence("traversal-edge-ab", "src/a.ts", 1)],
    },
    {
      from: "node-b",
      to: "node-c",
      kind: "imports",
      confidence: "inferred",
      evidence: [evidence("traversal-edge-bc", "src/b.ts", 2)],
    },
    {
      from: "node-c",
      to: "module-d",
      kind: "depends_on",
      confidence: "inferred",
      evidence: [evidence("traversal-edge-cd", "src/c.ts", 3)],
    },
    {
      from: "module-d",
      to: "node-a",
      kind: "calls",
      confidence: "observed",
      evidence: [evidence("traversal-edge-da", "src/d.ts", 4)],
    },
    {
      from: "node-a",
      to: "node-b",
      kind: "depends_on",
      confidence: "certain",
      evidence: [evidence("traversal-edge-ab-dependency", "src/a.ts", 5)],
    },
    {
      from: "node-b",
      to: "node-c",
      kind: "depends_on",
      confidence: "certain",
      evidence: [evidence("traversal-edge-bc-dependency", "src/b.ts", 6)],
    },
  ],
  diagnostics: [],
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
      queryId: "future-source-search",
      operation: "source-body-search",
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
      unsupportedOperation: "source-body-search",
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

  it("supports direct neighbors and bounded upstream/downstream reachability", () => {
    const neighbors = executeArchitectureQuery(traversalGraph, {
      schemaVersion: 1,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "neighbors",
      operation: "neighbors",
      selectors: { nodes: [{ id: "node-a" }] },
      traversal: { direction: "forward", edgeKinds: ["calls"] },
    });
    expect(neighbors.nodes.map((node) => node.id)).toEqual([
      "node-a",
      "node-b",
    ]);
    expect(neighbors.edges).toHaveLength(1);
    expect(neighbors.nodeDepths).toEqual([
      { nodeId: "node-a", depth: 0, root: true },
      { nodeId: "node-b", depth: 1, root: false },
    ]);

    const upstream = executeArchitectureQuery(traversalGraph, {
      schemaVersion: 1,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "upstream",
      operation: "reachability",
      selectors: { nodes: [{ id: "module-d" }] },
      traversal: {
        direction: "upstream",
        edgeKinds: ["calls", "imports", "depends_on"],
      },
    });
    expect(upstream.nodes.map((node) => node.id)).toEqual([
      "node-a",
      "node-b",
      "node-c",
      "module-d",
    ]);
    expect(upstream.truncated).toBe(false);
  });

  it("returns shortest dependency paths with complete evidence", () => {
    const result = executeArchitectureQuery(traversalGraph, {
      schemaVersion: 1,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "dependency-path",
      operation: "dependency-path",
      selectors: {},
      path: {
        from: { stableKey: "function:node-a" },
        to: "module-d",
        edgeKinds: ["depends_on"],
      },
    });
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toMatchObject({
      nodes: ["node-a", "node-b", "node-c", "module-d"],
      length: 3,
    });
    expect(result.paths[0]?.edges.map((edge) => edge.evidence[0]?.id)).toEqual([
      "traversal-edge-ab-dependency",
      "traversal-edge-bc-dependency",
      "traversal-edge-cd",
    ]);
  });

  it("reports boundaries, cycles, and explicit depth truncation", () => {
    const boundary = executeArchitectureQuery(traversalGraph, {
      schemaVersion: 1,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "boundary",
      operation: "boundary-crossing",
      selectors: { nodes: [{ kind: "function" }] },
      traversal: { direction: "both", edgeKinds: ["calls", "depends_on"] },
    });
    expect(boundary.boundaries).toHaveLength(2);
    expect(
      boundary.boundaries.map((item) => item.edge.evidence[0]?.id),
    ).toEqual(["traversal-edge-da", "traversal-edge-cd"]);

    const cycles = executeArchitectureQuery(traversalGraph, {
      schemaVersion: 1,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "cycles",
      operation: "cycles",
      selectors: { nodes: [{ id: "node-a" }] },
      traversal: {
        direction: "forward",
        edgeKinds: ["calls", "imports", "depends_on"],
      },
    });
    expect(cycles.cycles).toHaveLength(1);
    expect(
      cycles.cycles[0]?.edges.every((edge) => edge.evidence.length > 0),
    ).toBe(true);

    const truncated = executeArchitectureQuery(traversalGraph, {
      schemaVersion: 1,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "truncated",
      operation: "reachability",
      selectors: { nodes: [{ id: "node-a" }] },
      limits: { maxDepth: 1 },
      traversal: {
        direction: "forward",
        edgeKinds: ["calls", "imports", "depends_on"],
      },
    });
    expect(truncated.truncated).toBe(true);
    expect(
      truncated.diagnostics.some((item) => item.code === "QUERY_TRUNCATED"),
    ).toBe(true);
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

  it("projects applicable policy, ADR, ownership, and unsupported metadata without inference", () => {
    const policy = {
      schemaVersion: 1,
      policyId: "architecture-policy",
      version: "1.0.0",
      mode: "enforce",
      rules: [
        {
          id: "node-presence",
          target: "node",
          selector: { id: "node-a" },
          assertion: "exists",
          effect: "enforce",
        },
        {
          id: "edge-presence",
          target: "edge",
          selector: { kind: "calls" },
          assertion: "exists",
          effect: "informational",
        },
        {
          id: "diff-review",
          target: "diff",
          selector: { kind: "node-changed" },
          assertion: "exists",
        },
      ],
    };
    const evaluation = evaluatePolicyOnSnapshot(policy, graph);
    const before = JSON.stringify({ graph, policy, evaluation });
    const result = executeArchitectureQuery(
      graph,
      {
        schemaVersion: 1,
        contract: ARCHITECTURE_QUERY_CONTRACT,
        queryId: "metadata-projection",
        operation: "select-nodes",
        selectors: { nodes: [{ kind: "function" }] },
        projection: { metadata: "full" },
      },
      {
        schemaVersion: 1,
        contract: "cartograph.architecture-query-metadata",
        policies: [
          {
            source: ".cartograph/policy.json",
            config: policy,
            evaluation,
          },
        ],
        decisions: {
          source: ".cartograph/adr.json",
          document: {
            schemaVersion: 1,
            references: [
              {
                id: "adr-architecture",
                file: "docs/adr/0001-architecture.md",
                title: "Architecture boundary",
                status: "accepted",
                graphIds: ["node:node-a"],
              },
              {
                id: "adr-stale",
                file: "docs/adr/0002-stale.md",
                title: "Stale decision",
                status: "deprecated",
                graphIds: ["node:missing"],
              },
            ],
          },
          diagnostics: [
            {
              code: "ADR_REFERENCE_STALE_GRAPH_ID",
              severity: "error",
              referenceId: "adr-stale",
              file: "docs/adr/0002-stale.md",
              graphId: "node:missing",
              message: "ADR graph ID is stale",
            },
          ],
        },
        ownership: {
          source: ".cartograph/ownership.json",
          hints: [
            {
              id: "owner-a-primary",
              target: { kind: "node", graphId: "node:node-a" },
              owners: ["team-architecture"],
              source: ".cartograph/ownership.json",
              evidenceRefs: ["ownership:owner-a-primary"],
            },
            {
              id: "owner-a-conflict",
              target: { kind: "node", graphId: "node:node-a" },
              owners: ["team-runtime"],
              source: ".cartograph/ownership.json",
              evidenceRefs: ["ownership:owner-a-conflict"],
            },
          ],
        },
        unsupported: [
          {
            id: "remote-owner-catalog",
            category: "ownership",
            code: "REMOTE_METADATA_UNSUPPORTED",
            message:
              "remote ownership catalogs are outside the local query contract",
            evidenceRefs: ["metadata:remote-owner-catalog"],
          },
        ],
      },
    );

    expect(result.metadata?.policies[0]?.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "node-presence",
          applicableGraphIds: ["node:node-a"],
        }),
      ]),
    );
    expect(result.metadata?.policies[0]?.unsupported).toEqual([
      expect.objectContaining({ ruleId: "diff-review" }),
    ]);
    expect(
      result.metadata?.decisions.references.map((reference) => reference.id),
    ).toEqual(["adr-architecture", "adr-stale"]);
    expect(result.metadata?.decisions.references[1]?.diagnostics[0]?.code).toBe(
      "ADR_REFERENCE_STALE_GRAPH_ID",
    );
    expect(result.metadata?.ownership.hints.map((hint) => hint.id)).toEqual([
      "owner-a-conflict",
      "owner-a-primary",
    ]);
    expect(
      result.metadata?.diagnostics.map((diagnostic) => diagnostic.code),
    ).toEqual(
      expect.arrayContaining([
        "METADATA_OWNERSHIP_CONFLICT",
        "METADATA_OWNERSHIP_MISSING",
      ]),
    );
    expect(result.metadata?.unsupported[0]?.code).toBe(
      "REMOTE_METADATA_UNSUPPORTED",
    );
    expect(JSON.stringify({ graph, policy, evaluation })).toBe(before);
  });

  it("keeps metadata projection opt-in and reports absent ownership instead of guessing", () => {
    const result = executeArchitectureQuery(graph, {
      schemaVersion: 1,
      contract: ARCHITECTURE_QUERY_CONTRACT,
      queryId: "metadata-missing",
      operation: "select-nodes",
      selectors: { nodes: [{ id: "node-b" }] },
      projection: { metadata: "full" },
    });

    expect(result.metadata?.ownership.hints).toEqual([]);
    expect(result.metadata?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "METADATA_OWNERSHIP_MISSING",
          target: { kind: "node", graphId: "node:node-b" },
        }),
        expect.objectContaining({ code: "METADATA_DECISIONS_MISSING" }),
      ]),
    );
    expect(result.metadata?.policies).toEqual([]);
  });
});
