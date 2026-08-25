import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  diffGraphSnapshots,
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
  properties?: {
    schemaVersion?: { const?: number };
    identity?: unknown;
    topology?: unknown;
  };
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
    expect(diffSchema.properties?.identity).toBeDefined();
    expect(diffSchema.properties?.topology).toBeDefined();
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

  it("validates direct and merge-base comparison metadata", () => {
    const fixture = readJson(resolve(fixtureRoot, "valid.graph-diff.json")) as {
      fromRevision: { commitSha: string };
      toRevision: { commitSha: string };
    } & Record<string, unknown>;
    const comparison = {
      mode: "merge-base",
      baseRef: "origin/main",
      headRef: "refs/pull/7/head",
      baseCommitSha: fixture.fromRevision.commitSha,
      headCommitSha: fixture.toRevision.commitSha,
      mergeBaseSha: fixture.fromRevision.commitSha,
    };
    const withComparison = { ...fixture, comparison };
    expect(validateJsonSchema(withComparison)).toBe(true);
    expect(parseGraphDiff(withComparison).comparison).toEqual(comparison);

    const missingMergeBase = {
      ...withComparison,
      comparison: { ...comparison, mergeBaseSha: undefined },
    };
    expect(validateJsonSchema(missingMergeBase)).toBe(false);
    expect(GraphDiffSchema.safeParse(missingMergeBase).success).toBe(false);

    const absoluteRef = {
      ...withComparison,
      comparison: { ...comparison, baseRef: "/tmp/repository" },
    };
    expect(validateJsonSchema(absoluteRef)).toBe(false);
    expect(GraphDiffSchema.safeParse(absoluteRef).success).toBe(false);

    const mismatchedRevision = {
      ...withComparison,
      comparison: { ...comparison, headCommitSha: "d".repeat(40) },
    };
    expect(() => parseGraphDiff(mismatchedRevision)).toThrow(
      /head commit does not match/u,
    );
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

  it("publishes endpoint and field-change classifications in canonical output", () => {
    const before = readJson(
      resolve(fixtureRoot, "graph-diff/before.graph.json"),
    );
    const after = readJson(resolve(fixtureRoot, "graph-diff/after.graph.json"));
    const serialized = JSON.parse(
      serializeGraphDiff(diffGraphSnapshots(before, after)),
    ) as {
      edges: {
        changed: Array<{ classification: string }>;
        rewired: Array<{ classification: string }>;
      };
      identity: {
        matches: Array<{ method: string }>;
        ambiguous: unknown[];
        unsupported: unknown[];
      };
    };

    expect(validateJsonSchema(serialized)).toBe(true);
    expect(validateJsonSchema.errors).toBeNull();
    expect(serialized.edges.changed.map((edge) => edge.classification)).toEqual(
      ["evidence-only", "confidence-changed"],
    );
    expect(serialized.edges.rewired.map((edge) => edge.classification)).toEqual(
      ["endpoint-rewired"],
    );
    expect(serialized.identity.matches.length).toBeGreaterThan(0);
    expect(serialized.identity.ambiguous).toEqual([]);
    expect(serialized.identity.unsupported).toHaveLength(1);
    expect(serialized.identity.unsupported[0]).toMatchObject({
      reason: "unsupported-rename",
      before: { stableKey: "function:src/b.ts:b" },
      after: { stableKey: "function:src/d.ts:d" },
    });
  });
});
