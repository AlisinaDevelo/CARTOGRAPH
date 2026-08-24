import { describe, expect, it } from "vitest";

import {
  GraphSnapshotSchema,
  parseGraphSnapshot,
  serializeGraphSnapshot,
} from "../../src/index.js";

const contentHash =
  "0000000000000000000000000000000000000000000000000000000000000000";

const sourceEvidence = (overrides: Record<string, unknown> = {}) => ({
  id: "source:entry:1:1",
  kind: "source" as const,
  path: "src/entry.ts",
  line: 1,
  detector: "cartograph.fixture@0.1/edge",
  contentHash,
  ...overrides,
});

const snapshot = (evidence: unknown = sourceEvidence()) => ({
  schemaVersion: 1,
  revision: { commitSha: "fixture-commit" },
  nodes: [
    {
      id: "module:src/entry.ts",
      stableKey: "module:src/entry.ts",
      kind: "module",
      name: "src/entry.ts",
    },
    {
      id: "function:src/entry.ts:main",
      stableKey: "function:src/entry.ts:main",
      kind: "function",
      name: "main",
    },
  ],
  edges: [
    {
      from: "module:src/entry.ts",
      to: "function:src/entry.ts:main",
      kind: "contains",
      confidence: "certain",
      evidence: [evidence],
    },
  ],
  diagnostics: [],
});

describe("evidence and provenance invariants", () => {
  it("requires a source span and a versioned detector identity", () => {
    expect(
      GraphSnapshotSchema.safeParse(
        snapshot(sourceEvidence({ line: undefined })),
      ).success,
    ).toBe(false);
    expect(
      GraphSnapshotSchema.safeParse(
        snapshot(sourceEvidence({ detector: "fixture" })),
      ).success,
    ).toBe(false);
  });

  it("normalizes repository-relative paths before retaining evidence", () => {
    const parsed = parseGraphSnapshot(
      snapshot(sourceEvidence({ path: "  src/./entry.ts  " })),
    );

    expect(parsed.edges[0]?.evidence[0]?.path).toBe("src/entry.ts");
  });

  it("rejects raw source snippets and absolute evidence paths", () => {
    expect(
      GraphSnapshotSchema.safeParse(
        snapshot(sourceEvidence({ excerpt: "const secret = true;" })),
      ).success,
    ).toBe(false);
    expect(
      GraphSnapshotSchema.safeParse(
        snapshot(sourceEvidence({ path: "/Users/alice/project/src/entry.ts" })),
      ).success,
    ).toBe(false);
  });

  it("keeps relationship confidence explicit and requires evidence or a reason", () => {
    const observed = parseGraphSnapshot({
      ...snapshot(),
      edges: [
        {
          ...snapshot().edges[0],
          confidence: "observed",
        },
        {
          from: "module:src/entry.ts",
          to: "function:src/entry.ts:main",
          kind: "depends_on",
          confidence: "inferred",
          evidence: [],
          unresolvedReason: "dependency is selected by runtime configuration",
        },
      ],
    });

    expect(observed.edges.map((edge) => edge.confidence)).toEqual([
      "observed",
      "inferred",
    ]);
    expect(() =>
      parseGraphSnapshot({
        ...snapshot(),
        edges: [{ ...snapshot().edges[0], evidence: [] }],
      }),
    ).toThrow(/evidence or an explicit unresolved reason/u);
  });

  it("does not serialize source bodies from a valid evidence record", () => {
    const serialized = serializeGraphSnapshot(snapshot());

    expect(serialized).not.toContain("excerpt");
    expect(serialized).not.toContain("sourceBody");
  });
});
