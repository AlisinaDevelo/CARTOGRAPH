import { describe, expect, it } from "vitest";

import {
  createGraphSnapshot,
  executeGraphQuery,
} from "../../src/core/index.js";

const hash = "d".repeat(64);
const snapshot = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "head" },
  nodes: [
    {
      id: "a",
      stableKey: "function:a",
      kind: "function",
      name: "alpha",
      location: { path: "src/a.ts", line: 10 },
    },
    {
      id: "b",
      stableKey: "function:b",
      kind: "function",
      name: "beta",
      location: { path: "src/b.ts", line: 40 },
    },
    {
      id: "c",
      stableKey: "module:c",
      kind: "module",
      name: "gamma",
    },
  ],
  edges: [
    {
      from: "a",
      to: "b",
      kind: "calls",
      confidence: "certain",
      evidence: [
        {
          id: "a-b",
          kind: "source",
          path: "src/a.ts",
          line: 12,
          endLine: 14,
          detector: "cartograph.typescript-express@1/call",
          contentHash: hash,
        },
      ],
    },
    {
      from: "b",
      to: "a",
      kind: "requests",
      confidence: "inferred",
      evidence: [
        {
          id: "b-a",
          kind: "source",
          path: "src/b.ts",
          line: 41,
          detector: "cartograph.typescript-express@1/http",
          contentHash: hash,
        },
      ],
    },
    {
      from: "a",
      to: "c",
      kind: "imports",
      confidence: "inferred",
      evidence: [],
      unresolvedReason: "dynamic import specifier",
    },
  ],
});

const edges = (query: string): string[] =>
  executeGraphQuery(snapshot, query).edges.map(
    (edge) => `${edge.from}-${edge.kind}-${edge.to}`,
  );
const nodes = (query: string): string[] =>
  executeGraphQuery(snapshot, query).nodes.map((node) => node.id);

describe("evidence span, detector, and unresolved predicates", () => {
  it("matches source spans including multi-line evidence", () => {
    expect(edges("v1 edges where evidence.line = 13")).toEqual(["a-calls-b"]);
    expect(edges("v1 edges where evidence.line in [2, 41]")).toEqual([
      "b-requests-a",
    ]);
    expect(edges("v1 edges where evidence.line > 13")).toEqual([
      "a-calls-b",
      "b-requests-a",
    ]);
    expect(edges("v1 edges where evidence.line < 12")).toEqual([]);
    expect(edges("v1 edges where evidence.line != 13")).toEqual([
      "a-imports-c",
      "b-requests-a",
    ]);
    expect(nodes("v1 nodes where line >= 20")).toEqual(["b"]);
  });

  it("matches extractor versions", () => {
    expect(
      edges(
        "v1 edges where evidence.detector = cartograph.typescript-express@1/http",
      ),
    ).toEqual(["b-requests-a"]);
    expect(
      edges("v1 edges where detector ^= cartograph.typescript-express@1"),
    ).toEqual(["a-calls-b", "b-requests-a"]);
  });

  it("matches unresolved edges and their reasons", () => {
    expect(edges("v1 edges where unresolved = true")).toEqual(["a-imports-c"]);
    expect(edges("v1 edges where unresolved != true")).toEqual([
      "a-calls-b",
      "b-requests-a",
    ]);
    expect(edges('v1 edges where unresolved.reason ^= "dynamic"')).toEqual([
      "a-imports-c",
    ]);
  });

  it("is deterministic across equivalent spellings", () => {
    expect(
      executeGraphQuery(
        snapshot,
        "v1 edges where line >= 12 and detector ^= cartograph",
      ).query,
    ).toEqual(
      executeGraphQuery(
        snapshot,
        "v1 edges where evidence.detector ^= cartograph and evidence.line >= 12",
      ).query,
    );
  });
});
