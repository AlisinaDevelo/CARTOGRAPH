import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  GRAPH_QUERY_LANGUAGE_CONTRACT,
  createGraphSnapshot,
  diffGraphSnapshots,
  executeGraphQuery,
  GraphQueryLanguageParseError,
  GraphQueryResultSchema,
  parseGraphQuery,
  parseGraphQueryLanguage,
  serializeGraphQuery,
} from "../../src/core/index.js";

const root = resolve(import.meta.dirname, "../..");
const evidence = (id: string, path: string, line = 1) => ({
  id,
  kind: "source" as const,
  path,
  line,
  detector: "cartograph.query-language-test@1",
  contentHash: "c".repeat(64),
});

const before = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "base" },
  nodes: [
    {
      id: "a",
      stableKey: "function:a",
      kind: "function",
      name: "alpha",
      location: { path: "src/a.ts", line: 1 },
    },
    {
      id: "old",
      stableKey: "module:old",
      kind: "module",
      name: "old",
      location: { path: "legacy/old.ts", line: 1 },
    },
  ],
  edges: [
    {
      from: "a",
      to: "old",
      kind: "imports",
      confidence: "inferred",
      evidence: [evidence("a-old", "src/a.ts", 2)],
    },
  ],
});

const after = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "head" },
  nodes: [
    {
      id: "a",
      stableKey: "function:a",
      kind: "function",
      name: "alpha",
      location: { path: "src/a.ts", line: 1 },
    },
    {
      id: "new",
      stableKey: "module:new",
      kind: "module",
      name: "new",
      location: { path: "src/new.ts", line: 1 },
    },
    {
      id: "leaf",
      stableKey: "function:leaf",
      kind: "function",
      name: "leaf",
      location: { path: "src/leaf.ts", line: 1 },
    },
  ],
  edges: [
    {
      from: "a",
      to: "new",
      kind: "calls",
      confidence: "certain",
      evidence: [evidence("a-new", "src/a.ts", 2)],
    },
    {
      from: "new",
      to: "a",
      kind: "depends_on",
      confidence: "user_confirmed",
      evidence: [evidence("new-a", "src/new.ts", 4)],
    },
    {
      from: "new",
      to: "leaf",
      kind: "imports",
      confidence: "inferred",
      evidence: [evidence("new-leaf", "src/new.ts", 3)],
    },
  ],
});

describe("graph and diff query language", () => {
  it("normalizes equivalent text into one versioned AST", () => {
    const first = parseGraphQueryLanguage(
      "v1 nodes where kind=function and evidence.path ^= src/",
    );
    const second = parseGraphQueryLanguage(
      'query v1 select nodes where evidence.path^="src/" and node.kind = function',
    );
    expect(first.contract).toBe(GRAPH_QUERY_LANGUAGE_CONTRACT);
    expect(serializeGraphQuery(first)).toBe(serializeGraphQuery(second));
    expect(first.queryId).toMatch(/^query-[a-f0-9]{20}$/u);
  });

  it("reports stable parser codes and source locations", () => {
    expect(() =>
      parseGraphQueryLanguage("v2 nodes where kind=function"),
    ).toThrow(GraphQueryLanguageParseError);
    try {
      parseGraphQueryLanguage("v2 nodes where kind=function");
    } catch (error) {
      expect(error).toMatchObject({
        code: "QUERY_PARSE_UNSUPPORTED_VERSION",
        line: 1,
        column: 1,
      });
      expect((error as Error).message).toContain(
        "QUERY_PARSE_UNSUPPORTED_VERSION at 1:1",
      );
    }
  });

  it("selects evidence paths and confidence without executing source", () => {
    const result = executeGraphQuery(
      after,
      "v1 edges where kind=calls and confidence >= inferred and evidence.path ^= src/",
    );
    expect(result.status).toBe("ok");
    expect(result.edges.map((edge) => edge.kind)).toEqual(["calls"]);
    expect(result.edges[0]).toMatchObject({
      from: "a",
      to: "new",
      confidence: "certain",
    });
    expect(result.snapshotRevision).toBe("head");
    expect(GraphQueryResultSchema.parse(result)).toBeDefined();

    const confirmed = executeGraphQuery(
      after,
      "v1 edges where confidence >= certain",
    );
    expect(confirmed.edges.map((edge) => edge.confidence)).toEqual([
      "certain",
      "user_confirmed",
    ]);
  });

  it("returns deterministic bounded traversal and explicit truncation", () => {
    const result = executeGraphQuery(
      after,
      "v1 nodes where kind=function and name=alpha traverse forward depth=1 edges=[calls]",
    );
    expect(result.nodes.map((node) => node.id)).toEqual(["a", "new"]);
    expect(result.edges.map((edge) => edge.kind)).toEqual(["calls"]);
    expect(result.truncated).toBe(false);

    const truncated = executeGraphQuery(
      after,
      "v1 nodes where id=a traverse forward depth=1 edges=[calls,imports] limit depth=1",
    );
    expect(truncated.nodes.map((node) => node.id)).toEqual(["a", "new"]);
    expect(truncated.truncated).toBe(true);
    expect(truncated.diagnostics[0]?.code).toBe("QUERY_TRUNCATED");
  });

  it("fails closed when node or serialized-result budgets are exceeded", () => {
    const nodeLimit = executeGraphQuery(
      after,
      "v1 nodes where kind in [function,module] limit maxNodes=1",
    );
    expect(nodeLimit).toMatchObject({
      status: "resource-limit",
      nodes: [],
      diagnostics: [
        expect.objectContaining({
          code: "QUERY_RESOURCE_LIMIT",
          limit: "maxNodes",
        }),
      ],
    });

    const bytes = executeGraphQuery(
      after,
      "v1 nodes where kind in [function,module] limit maxResultBytes=1",
    );
    expect(bytes.status).toBe("resource-limit");
    expect(bytes.diagnostics[0]).toMatchObject({
      code: "QUERY_RESOURCE_LIMIT",
      limit: "maxResultBytes",
    });
  });

  it("selects revision changes by kind, path, confidence, and exact revisions", () => {
    const diff = diffGraphSnapshots(before, after);
    const result = executeGraphQuery(
      after,
      "v1 changes where change in [node-added,edge-added] and evidence.path ^= src/ revision from base to head",
      diff,
    );
    expect(result.status).toBe("ok");
    expect(result.revisions).toEqual({ from: "base", to: "head" });
    expect(result.changes.map((change) => change.kind)).toEqual([
      "edge-added",
      "edge-added",
      "edge-added",
      "node-added",
      "node-added",
    ]);
    expect(result.changes[0]?.evidencePaths[0]).toMatch(/^src\//u);

    const mismatch = executeGraphQuery(
      after,
      "v1 changes revision from wrong to head",
      diff,
    );
    expect(mismatch).toMatchObject({
      status: "invalid",
      diagnostics: [
        expect.objectContaining({ code: "QUERY_REVISION_MISMATCH" }),
      ],
    });
  });

  it("accepts normalized object input with defaults and preserves the graph", () => {
    const original = JSON.stringify(after);
    const query = parseGraphQuery({
      schemaVersion: 1,
      contract: GRAPH_QUERY_LANGUAGE_CONTRACT,
      target: "nodes",
      predicates: [{ field: "kind", operator: "=", values: ["function"] }],
    });
    const result = executeGraphQuery(after, query);
    expect(result.nodes.map((node) => node.id)).toEqual(["a", "leaf"]);
    expect(JSON.stringify(after)).toBe(original);
  });

  it("matches the published AST and fixture schemas", () => {
    const astSchema = JSON.parse(
      readFileSync(
        resolve(root, "schema/graph-query-language.v0.1.schema.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const fixtureSchema = JSON.parse(
      readFileSync(
        resolve(root, "schema/graph-query-language-fixtures.v0.1.schema.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const validateAst = new Ajv({ allErrors: true }).compile(astSchema);
    const validateFixture = new Ajv({ allErrors: true }).compile(fixtureSchema);
    const query = parseGraphQueryLanguage("v1 nodes where kind=function");
    const fixture = JSON.parse(
      readFileSync(
        resolve(root, "test/fixtures/query-language/scenarios.v0.1.json"),
        "utf8",
      ),
    ) as unknown;
    expect(validateAst(query), JSON.stringify(validateAst.errors)).toBe(true);
    expect(
      validateFixture(fixture),
      JSON.stringify(validateFixture.errors),
    ).toBe(true);
  });
});
