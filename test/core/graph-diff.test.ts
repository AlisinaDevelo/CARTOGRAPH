import { describe, expect, it } from "vitest";

import {
  diffGraphSnapshots,
  GraphEdgeSchema,
  GraphSnapshotSchema,
  parseGraphSnapshot,
  serializeGraphDiff,
  serializeGraphSnapshot,
} from "../../src/index.js";

const sourceEvidence = (id: string, path = "src/index.ts", line = 1) => ({
  id,
  kind: "source" as const,
  path,
  line,
  detector: "test-detector@1",
  contentHash:
    "0000000000000000000000000000000000000000000000000000000000000000",
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  revision: { commitSha: "commit-a", branch: "main" },
  nodes: [
    {
      id: "node-a",
      stableKey: "function:src/a.ts:a",
      kind: "function",
      name: "a",
      language: "typescript",
    },
    {
      id: "node-b",
      stableKey: "function:src/b.ts:b",
      kind: "function",
      name: "b",
      language: "typescript",
    },
  ],
  edges: [
    {
      from: "node-a",
      to: "node-b",
      kind: "calls",
      confidence: "certain",
      evidence: [sourceEvidence("evidence-a")],
    },
  ],
  diagnostics: [],
  ...overrides,
});

describe("graph snapshot contracts", () => {
  it("rejects whitespace-only identifiers", () => {
    const result = GraphSnapshotSchema.safeParse(
      snapshot({ revision: { commitSha: "   " } }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects absolute paths in portable evidence", () => {
    const result = GraphSnapshotSchema.safeParse(
      snapshot({
        edges: [
          {
            from: "node-a",
            to: "node-b",
            kind: "calls",
            confidence: "certain",
            evidence: [
              sourceEvidence("absolute", "/Users/alice/project/src/a.ts"),
            ],
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects source bodies and other non-portable evidence fields", () => {
    const result = GraphSnapshotSchema.safeParse(
      snapshot({
        edges: [
          {
            from: "node-a",
            to: "node-b",
            kind: "calls",
            confidence: "certain",
            evidence: [
              {
                ...sourceEvidence("body"),
                excerpt: "function a() { return b(); }",
              },
            ],
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
  });

  it("requires source evidence detector identity and content hash", () => {
    const result = GraphSnapshotSchema.safeParse(
      snapshot({
        edges: [
          {
            from: "node-a",
            to: "node-b",
            kind: "calls",
            confidence: "certain",
            evidence: [
              {
                id: "missing-integrity",
                kind: "source",
                path: "src/index.ts",
                line: 1,
              },
            ],
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
  });

  it("rejects edges and diagnostics that reference undeclared nodes", () => {
    const result = GraphSnapshotSchema.safeParse(
      snapshot({
        edges: [
          {
            from: "node-a",
            to: "missing-node",
            kind: "calls",
            confidence: "inferred",
            evidence: [sourceEvidence("dangling-edge")],
          },
        ],
        diagnostics: [
          {
            id: "dangling-diagnostic",
            code: "MISSING_NODE",
            severity: "warning",
            message: "the referenced node is missing",
            nodeId: "missing-node",
          },
        ],
      }),
    );

    expect(result.success).toBe(false);
  });

  it("requires edge evidence or an explicit unresolved reason", () => {
    const edge = {
      from: "node-a",
      to: "node-b",
      kind: "calls",
      confidence: "inferred",
      evidence: [],
    };

    expect(GraphEdgeSchema.safeParse(edge).success).toBe(false);
    expect(
      GraphEdgeSchema.safeParse({
        ...edge,
        unresolvedReason: "dynamic dispatch could not be resolved",
      }).success,
    ).toBe(true);
  });

  it("canonicalizes ordering and deduplicates identical records", () => {
    const first = parseGraphSnapshot(
      snapshot({
        nodes: [
          {
            id: "node-b",
            stableKey: "function:src/b.ts:b",
            kind: "function",
            name: "b",
            language: "typescript",
          },
          {
            id: "node-a",
            stableKey: "function:src/a.ts:a",
            kind: "function",
            name: "a",
            language: "typescript",
          },
          {
            id: "node-a",
            stableKey: "function:src/a.ts:a",
            kind: "function",
            name: "a",
            language: "typescript",
          },
        ],
        edges: [
          {
            from: "node-a",
            to: "node-b",
            kind: "calls",
            confidence: "certain",
            evidence: [
              sourceEvidence("evidence-a", "src/index.ts", 2),
              sourceEvidence("evidence-b"),
            ],
          },
          {
            from: "node-a",
            to: "node-b",
            kind: "calls",
            confidence: "certain",
            evidence: [
              sourceEvidence("evidence-b"),
              sourceEvidence("evidence-a", "src/index.ts", 2),
            ],
          },
        ],
      }),
    );

    const second = parseGraphSnapshot(
      snapshot({
        nodes: [
          {
            id: "node-a",
            stableKey: "function:src/a.ts:a",
            kind: "function",
            name: "a",
            language: "typescript",
          },
          {
            id: "node-b",
            stableKey: "function:src/b.ts:b",
            kind: "function",
            name: "b",
            language: "typescript",
          },
        ],
        edges: [
          {
            from: "node-a",
            to: "node-b",
            kind: "calls",
            confidence: "certain",
            evidence: [
              sourceEvidence("evidence-a", "src/index.ts", 2),
              sourceEvidence("evidence-b"),
            ],
          },
        ],
      }),
    );

    expect(first.nodes).toHaveLength(2);
    expect(first.edges).toHaveLength(1);
    expect(serializeGraphSnapshot(first)).toBe(serializeGraphSnapshot(second));
  });

  it("rejects conflicting duplicate nodes and edges", () => {
    expect(() =>
      parseGraphSnapshot(
        snapshot({
          nodes: [
            {
              id: "node-a",
              stableKey: "function:src/a.ts:a",
              kind: "function",
              name: "a",
            },
            {
              id: "node-a-2",
              stableKey: "function:src/a.ts:a",
              kind: "function",
              name: "renamed",
            },
          ],
          edges: [],
        }),
      ),
    ).toThrow(/conflicting duplicate node/i);

    expect(() =>
      parseGraphSnapshot(
        snapshot({
          edges: [
            {
              from: "node-a",
              to: "node-b",
              kind: "calls",
              confidence: "certain",
              evidence: [sourceEvidence("edge-1")],
            },
            {
              from: "node-a",
              to: "node-b",
              kind: "calls",
              confidence: "observed",
              evidence: [sourceEvidence("edge-1")],
            },
          ],
        }),
      ),
    ).toThrow(/conflicting duplicate edge/i);
  });
});

describe("graph diffs", () => {
  it("reports added, removed, and changed nodes, edges, and diagnostics", () => {
    const before = parseGraphSnapshot(
      snapshot({
        revision: { commitSha: "before", branch: "main" },
        nodes: [
          {
            id: "node-a",
            stableKey: "function:src/a.ts:a",
            kind: "function",
            name: "a",
            language: "typescript",
          },
          {
            id: "node-b",
            stableKey: "function:src/b.ts:b",
            kind: "function",
            name: "b",
            language: "typescript",
          },
          {
            id: "node-d",
            stableKey: "function:src/d.ts:d",
            kind: "function",
            name: "d",
            language: "typescript",
          },
        ],
        edges: [
          {
            from: "node-a",
            to: "node-d",
            kind: "calls",
            confidence: "certain",
            evidence: [sourceEvidence("evidence-a")],
          },
          {
            from: "node-b",
            to: "node-d",
            kind: "calls",
            confidence: "certain",
            evidence: [sourceEvidence("evidence-b")],
          },
        ],
        diagnostics: [
          {
            id: "diagnostic-changed",
            code: "UNRESOLVED_CALL",
            severity: "warning",
            message: "call target unresolved",
          },
          {
            id: "diagnostic-removed",
            code: "OLD",
            severity: "info",
            message: "old diagnostic",
          },
        ],
      }),
    );
    const after = parseGraphSnapshot(
      snapshot({
        revision: { commitSha: "after", branch: "main" },
        nodes: [
          {
            id: "node-a",
            stableKey: "function:src/a.ts:a",
            kind: "function",
            name: "a-renamed",
            language: "typescript",
          },
          {
            id: "node-c",
            stableKey: "function:src/c.ts:c",
            kind: "function",
            name: "c",
            language: "typescript",
          },
          {
            id: "node-d",
            stableKey: "function:src/d.ts:d",
            kind: "function",
            name: "d",
            language: "typescript",
          },
        ],
        edges: [
          {
            from: "node-a",
            to: "node-d",
            kind: "calls",
            confidence: "observed",
            evidence: [sourceEvidence("evidence-a")],
          },
          {
            from: "node-c",
            to: "node-a",
            kind: "calls",
            confidence: "certain",
            evidence: [sourceEvidence("evidence-c")],
          },
        ],
        diagnostics: [
          {
            id: "diagnostic-changed",
            code: "UNRESOLVED_CALL",
            severity: "error",
            message: "call target remains unresolved",
          },
          {
            id: "diagnostic-added",
            code: "NEW",
            severity: "info",
            message: "new diagnostic",
          },
        ],
      }),
    );

    const diff = diffGraphSnapshots(before, after);

    expect(diff.nodes.added.map((change) => change.stableKey)).toEqual([
      "function:src/c.ts:c",
    ]);
    expect(diff.nodes.removed.map((change) => change.stableKey)).toEqual([
      "function:src/b.ts:b",
    ]);
    expect(diff.nodes.changed).toHaveLength(1);
    expect(
      diff.nodes.changed[0]?.changes.map((change) => change.path),
    ).toContain("name");

    expect(diff.edges.added).toHaveLength(1);
    expect(diff.edges.removed).toHaveLength(1);
    expect(diff.edges.changed).toHaveLength(1);
    expect(
      diff.edges.changed[0]?.changes.map((change) => change.path),
    ).toContain("confidence");

    expect(diff.diagnostics.added.map((change) => change.id)).toEqual([
      "diagnostic-added",
    ]);
    expect(diff.diagnostics.removed.map((change) => change.id)).toEqual([
      "diagnostic-removed",
    ]);
    expect(diff.diagnostics.changed).toHaveLength(1);
  });

  it("serializes the same diff regardless of snapshot input ordering", () => {
    const first = parseGraphSnapshot(snapshot());
    const second = parseGraphSnapshot(
      snapshot({
        nodes: [...first.nodes].reverse(),
        edges: [...first.edges].reverse(),
      }),
    );

    expect(serializeGraphSnapshot(first)).toBe(serializeGraphSnapshot(second));
    expect(diffGraphSnapshots(first, second).nodes.changed).toEqual([]);
  });

  it("serializes diff arrays canonically", () => {
    const before = parseGraphSnapshot(snapshot());
    const after = parseGraphSnapshot(
      snapshot({
        revision: { commitSha: "after", branch: "main" },
        nodes: [
          ...before.nodes,
          {
            id: "node-c",
            stableKey: "function:src/c.ts:c",
            kind: "function",
            name: "c",
            language: "typescript",
          },
        ],
        edges: [
          ...before.edges,
          {
            from: "node-c",
            to: "node-a",
            kind: "calls",
            confidence: "certain",
            evidence: [sourceEvidence("evidence-c")],
          },
        ],
      }),
    );
    const diff = diffGraphSnapshots(before, after);
    const reordered = {
      ...diff,
      nodes: {
        ...diff.nodes,
        added: [...diff.nodes.added].reverse(),
        removed: [...diff.nodes.removed].reverse(),
        changed: [...diff.nodes.changed].reverse(),
      },
      edges: {
        ...diff.edges,
        added: [...diff.edges.added].reverse(),
        removed: [...diff.edges.removed].reverse(),
        changed: [...diff.edges.changed].reverse(),
      },
      diagnostics: {
        ...diff.diagnostics,
        added: [...diff.diagnostics.added].reverse(),
        removed: [...diff.diagnostics.removed].reverse(),
        changed: [...diff.diagnostics.changed].reverse(),
      },
    };

    expect(serializeGraphDiff(diff)).toBe(serializeGraphDiff(reordered));
  });
});
