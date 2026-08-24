import { describe, expect, it } from "vitest";

import {
  GraphValidationError,
  parseGraphSnapshot,
  serializeGraphSnapshot,
} from "../../src/index.js";

const contentHash =
  "0000000000000000000000000000000000000000000000000000000000000000";

const snapshot = (windows: boolean, reverse: boolean) => {
  const entryPath = windows ? "src\\entry.ts" : "src/entry.ts";
  const moduleId = `module:${entryPath}`;
  const functionId = `function:${entryPath}:main`;
  const evidenceId = `source:${entryPath}:1`;
  const evidencePath = windows ? "src\\./entry.ts" : "src/./entry.ts";
  const evidence = [
    {
      id: evidenceId,
      kind: "source" as const,
      path: evidencePath,
      line: 1,
      detector: "cartograph.test@1",
      contentHash,
      observedAt: windows
        ? "2026-01-02T03:04:05+00:00"
        : "2026-01-02T03:04:05.000Z",
    },
    {
      id: `source:${windows ? "src/entry.ts" : "src\\entry.ts"}:1`,
      kind: "source" as const,
      path: "src/entry.ts",
      line: 1,
      detector: "cartograph.test@1",
      contentHash,
      observedAt: "2026-01-02T03:04:05Z",
    },
  ];
  const nodes = [
    {
      id: moduleId,
      stableKey: moduleId,
      kind: "module" as const,
      name: "entry module",
    },
    {
      id: functionId,
      stableKey: functionId,
      kind: "function" as const,
      name: "main",
    },
  ];
  const edges = [
    {
      from: moduleId,
      to: functionId,
      kind: "contains" as const,
      confidence: "certain" as const,
      evidence,
    },
  ];
  const diagnostics = [
    {
      id: `diagnostic:${entryPath}`,
      code: "PATH_NORMALIZED",
      severity: "info" as const,
      message: "repository path was normalized",
      location: { path: entryPath, line: 1 },
    },
  ];

  return {
    schemaVersion: 1,
    revision: {
      commitSha: "snapshot-commit",
      branch: "main",
      authoredAt: windows
        ? "2026-01-02T03:04:05+00:00"
        : "2026-01-02T03:04:05.000Z",
    },
    nodes: reverse ? nodes.reverse() : nodes,
    edges: reverse ? edges.reverse() : edges,
    diagnostics: reverse ? diagnostics.reverse() : diagnostics,
  };
};

describe("canonical graph snapshots", () => {
  it("serializes equivalent POSIX and Windows-shaped snapshots identically", () => {
    const posix = parseGraphSnapshot(snapshot(false, false));
    const windows = parseGraphSnapshot(snapshot(true, true));

    expect(serializeGraphSnapshot(posix)).toBe(serializeGraphSnapshot(windows));
    expect(posix.revision.authoredAt).toBe("2026-01-02T03:04:05.000Z");
    expect(windows.revision.authoredAt).toBe("2026-01-02T03:04:05.000Z");
    expect(windows.nodes.map((node) => node.id)).toEqual([
      "function:src/entry.ts:main",
      "module:src/entry.ts",
    ]);
    expect(windows.edges[0]?.evidence).toHaveLength(1);
    expect(windows.edges[0]?.evidence[0]?.path).toBe("src/entry.ts");
    expect(windows.diagnostics[0]?.id).toBe("diagnostic:src/entry.ts");
  });

  it("is idempotent when a normalized snapshot is parsed again", () => {
    const first = parseGraphSnapshot(snapshot(true, true));
    const second = parseGraphSnapshot(first);

    expect(serializeGraphSnapshot(first)).toBe(serializeGraphSnapshot(second));
  });

  it("reports invalid snapshots with actionable contract paths", () => {
    const invalid = snapshot(false, false);
    invalid.edges[0]!.to = "missing:function";

    try {
      parseGraphSnapshot(invalid);
      throw new Error("expected snapshot validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphValidationError);
      const validation = error as GraphValidationError;
      expect(validation.contract).toBe("GraphSnapshot");
      expect(validation.code).toBe("invalid");
      expect(validation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["edges", 0, "to"],
            message: "edge target node is not declared: missing:function",
          }),
        ]),
      );
      expect(validation.message).toContain("edges.0.to:");
    }
  });
});
