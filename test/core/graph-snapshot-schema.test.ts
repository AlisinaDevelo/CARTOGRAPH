import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GraphSnapshotSchema, parseGraphSnapshot } from "../../src/index.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/graph-snapshot.v0.1.schema.json",
);
const fixturePath = (name: string): string =>
  resolve(repositoryRoot, "test/fixtures/snapshots", name);
const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8")) as unknown;

const jsonSchema = readJson(schemaPath) as {
  definitions?: Record<string, unknown>;
  required?: string[];
};
const validateJsonSchema = new Ajv({ allErrors: true }).compile(jsonSchema);

describe("GraphSnapshot v0.1 JSON Schema", () => {
  it("declares the complete portable snapshot surface", () => {
    expect(jsonSchema.required).toEqual([
      "schemaVersion",
      "revision",
      "nodes",
      "edges",
      "diagnostics",
    ]);
    expect(Object.keys(jsonSchema.definitions ?? {})).toEqual(
      expect.arrayContaining([
        "revision",
        "node",
        "edge",
        "evidence",
        "diagnostic",
      ]),
    );
  });

  it("accepts a representative snapshot through JSON Schema and runtime validation", () => {
    const fixture = readJson(fixturePath("valid.graph.json"));

    expect(validateJsonSchema(fixture)).toBe(true);
    expect(validateJsonSchema.errors).toBeNull();
    expect(GraphSnapshotSchema.safeParse(fixture).success).toBe(true);
    expect(parseGraphSnapshot(fixture).schemaVersion).toBe(1);
  });

  it("rejects the malformed fixture through both validators", () => {
    const fixture = readJson(fixturePath("malformed.graph.json"));

    expect(validateJsonSchema(fixture)).toBe(false);
    expect(GraphSnapshotSchema.safeParse(fixture).success).toBe(false);
    expect(() => parseGraphSnapshot(fixture)).toThrow();
  });

  it("keeps cross-record reference checks in the runtime validator", () => {
    const fixture = readJson(fixturePath("valid.graph.json")) as {
      edges: Array<Record<string, unknown>>;
    };
    const dangling = {
      ...fixture,
      edges: fixture.edges.map((edge, index) =>
        index === 0 ? { ...edge, to: "missing-node" } : edge,
      ),
    };

    expect(validateJsonSchema(dangling)).toBe(true);
    expect(GraphSnapshotSchema.safeParse(dangling).success).toBe(false);
    expect(() => parseGraphSnapshot(dangling)).toThrow(/not declared/u);
  });
});
