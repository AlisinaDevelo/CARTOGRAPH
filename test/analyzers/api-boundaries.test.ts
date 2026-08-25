import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseGraphSnapshot } from "../../src/core/index.js";
import { analyzeTypeScriptRepository } from "../../src/analyzers/index.js";

const fixtureRoot = resolve(import.meta.dirname, "../fixtures/api-boundaries");

describe("API boundary analyzer", () => {
  it("extracts GraphQL resolvers and OpenAPI handler boundaries", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: fixtureRoot }),
    );

    expect(
      snapshot.nodes.some(
        (node) =>
          node.stableKey === "endpoint:graphql:Query.user" &&
          node.kind === "endpoint" &&
          node.location?.path === "schema.graphql",
      ),
    ).toBe(true);
    expect(
      snapshot.nodes.some(
        (node) =>
          node.stableKey === "endpoint:openapi:GET:/users" &&
          node.kind === "endpoint" &&
          node.location?.path === "openapi.yaml",
      ),
    ).toBe(true);

    expect(snapshot.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "routes_to",
          from: "endpoint:graphql:Query.user",
          to: "function:src/resolvers.ts:resolveUser",
        }),
        expect.objectContaining({
          kind: "routes_to",
          from: "endpoint:graphql:Mutation.createUser",
          to: "function:src/resolvers.ts:createUser",
        }),
        expect.objectContaining({
          kind: "routes_to",
          from: "endpoint:openapi:GET:/users",
          to: "function:src/server.ts:listUsers",
        }),
        expect.objectContaining({
          kind: "routes_to",
          from: "endpoint:openapi:GET:/users/{id}",
          to: "function:src/server.ts:getUser",
        }),
        expect.objectContaining({
          kind: "routes_to",
          from: "endpoint:openapi:POST:/json-users",
          to: "function:src/resolvers.ts:createUser",
        }),
      ]),
    );

    const apiEdges = snapshot.edges.filter((edge) => edge.kind === "routes_to");
    expect(apiEdges.length).toBeGreaterThanOrEqual(6);
    expect(
      apiEdges.every((edge) =>
        edge.evidence.every((evidence) =>
          evidence.detector?.startsWith("cartograph.typescript-api@1/"),
        ),
      ),
    ).toBe(true);
  });

  it("keeps generated, aliased, and runtime-composed coverage explicit", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: fixtureRoot }),
    );
    const codes = snapshot.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("PARTIAL_API_SCHEMA_GENERATION");
    expect(codes).toContain("PARTIAL_API_SCHEMA_ALIAS");
    expect(codes).toContain("PARTIAL_RUNTIME_COMPOSED_ROUTE");
    for (const diagnostic of snapshot.diagnostics.filter((diagnostic) =>
      diagnostic.code.startsWith("PARTIAL_"),
    )) {
      expect(diagnostic.evidence[0]?.path).toBeTruthy();
      expect(diagnostic.evidence[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(snapshot.nodes.map((node) => node.stableKey)).toContain(
      "endpoint:graphql:Query.generatedStatic",
    );
    expect(JSON.stringify(snapshot)).toBe(
      JSON.stringify(
        parseGraphSnapshot(
          analyzeTypeScriptRepository({ rootDir: fixtureRoot }),
        ),
      ),
    );
  });
});
