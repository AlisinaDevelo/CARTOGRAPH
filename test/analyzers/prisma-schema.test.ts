import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeTypeScriptRepository } from "../../src/analyzers/index.js";
import { parseGraphSnapshot } from "../../src/core/index.js";

const fixtureRoot = resolve(import.meta.dirname, "../fixtures/prisma-schema");

describe("Prisma schema analyzer", () => {
  it("maps datasources, models, relations, and generated clients", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: fixtureRoot }),
    );

    const nodeFor = (stableKey: string) =>
      snapshot.nodes.find((node) => node.stableKey === stableKey);
    expect(nodeFor("service:prisma:datasource:db")).toMatchObject({
      kind: "service",
      location: { path: "prisma/schema.prisma" },
    });
    expect(nodeFor("database_table:prisma:User")).toMatchObject({
      kind: "database_table",
      location: { path: "prisma/schema.prisma" },
    });
    expect(nodeFor("database_table:prisma:Post")).toMatchObject({
      kind: "database_table",
    });
    expect(nodeFor("module:prisma-generated:generated/prisma")).toMatchObject({
      kind: "module",
      location: { path: "prisma/schema.prisma" },
    });

    expect(snapshot.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "contains",
          from: "service:prisma:datasource:db",
          to: "database_table:prisma:User",
        }),
        expect.objectContaining({
          kind: "depends_on",
          from: "database_table:prisma:Post",
          to: "database_table:prisma:User",
        }),
        expect.objectContaining({
          kind: "depends_on",
          from: "database_table:prisma:User",
          to: "database_table:prisma:Post",
        }),
        expect.objectContaining({
          kind: "contains",
          from: "service:prisma:generator:client",
          to: "module:prisma-generated:generated/prisma",
        }),
        expect.objectContaining({
          kind: "imports",
          from: "module:src/app.ts",
          to: "module:prisma-generated:generated/prisma",
        }),
      ]),
    );

    const prismaEdges = snapshot.edges.filter((edge) =>
      [
        "service:prisma:datasource:db",
        "service:prisma:generator:client",
        "database_table:prisma:Post",
        "database_table:prisma:User",
      ].some((prefix) => edge.from === prefix || edge.to === prefix),
    );
    expect(
      prismaEdges.every((edge) =>
        edge.evidence.some((evidence) =>
          evidence.detector?.startsWith("cartograph.prisma-schema@1/"),
        ),
      ),
    ).toBe(true);
  });

  it("classifies multiple schemas and unsupported boundaries deterministically", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: fixtureRoot }),
    );
    const codes = snapshot.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("MULTIPLE_PRISMA_SCHEMA_FILES");
    expect(codes).toContain("UNSUPPORTED_PRISMA_PROVIDER");
    expect(codes).toContain("UNSUPPORTED_PRISMA_GENERATOR");
    expect(codes).toContain("UNSUPPORTED_PRISMA_GENERATED_OUTPUT");
    expect(
      snapshot.diagnostics.every((diagnostic) => {
        const hash = diagnostic.evidence[0]?.contentHash;
        return typeof hash === "string" && /^[0-9a-f]{64}$/u.test(hash);
      }),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).toBe(
      JSON.stringify(
        parseGraphSnapshot(
          analyzeTypeScriptRepository({ rootDir: fixtureRoot }),
        ),
      ),
    );
  });
});
