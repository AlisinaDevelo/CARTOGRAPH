import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  GraphDiffSchema,
  parseGraphDiff,
  serializeGraphDiff,
} from "../../src/index.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fixtureRoot = resolve(repositoryRoot, "test/fixtures/snapshots");
const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8")) as unknown;

const diffSchema = readJson(
  resolve(repositoryRoot, "schema/graph-diff.v0.1.schema.json"),
) as {
  required?: string[];
  properties?: { schemaVersion?: { const?: number } };
};
const validateJsonSchema = new Ajv({ allErrors: true }).compile(diffSchema);

describe("GraphDiff v0.1 JSON Schema", () => {
  it("publishes summary, revision, changes, evidence, and diagnostics", () => {
    expect(diffSchema.required).toEqual(
      expect.arrayContaining([
        "schemaVersion",
        "summary",
        "fromRevision",
        "toRevision",
        "nodes",
        "edges",
        "diagnostics",
      ]),
    );
    expect(diffSchema.properties?.schemaVersion?.const).toBe(1);
  });

  it("accepts the valid fixture through JSON Schema and runtime validation", () => {
    const fixture = readJson(resolve(fixtureRoot, "valid.graph-diff.json"));

    expect(validateJsonSchema(fixture)).toBe(true);
    expect(validateJsonSchema.errors).toBeNull();
    expect(GraphDiffSchema.safeParse(fixture).success).toBe(true);
    expect(parseGraphDiff(fixture).summary).toEqual({
      nodesAdded: 0,
      nodesRemoved: 0,
      nodesChanged: 0,
      edgesAdded: 1,
      edgesRemoved: 0,
      edgesChanged: 0,
      diagnosticsAdded: 0,
      diagnosticsRemoved: 0,
      diagnosticsChanged: 0,
    });
  });

  it("rejects malformed and internally inconsistent diffs", () => {
    const malformed = readJson(
      resolve(fixtureRoot, "malformed.graph-diff.json"),
    );
    expect(validateJsonSchema(malformed)).toBe(false);
    expect(GraphDiffSchema.safeParse(malformed).success).toBe(false);

    const valid = readJson(resolve(fixtureRoot, "valid.graph-diff.json")) as {
      summary: Record<string, number>;
    };
    const inconsistent = {
      ...valid,
      summary: { ...valid.summary, edgesAdded: 0 },
    };
    expect(validateJsonSchema(inconsistent)).toBe(true);
    expect(() => parseGraphDiff(inconsistent)).toThrow(
      /summary does not match/u,
    );
  });

  it("serializes canonical output identically across repeated runs", () => {
    const fixture = readJson(resolve(fixtureRoot, "valid.graph-diff.json"));
    const first = serializeGraphDiff(fixture);
    expect(serializeGraphDiff(parseGraphDiff(fixture))).toBe(first);
    expect(serializeGraphDiff(fixture)).toBe(first);
  });
});
