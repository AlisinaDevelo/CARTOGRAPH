import { describe, expect, it } from "vitest";

import {
  createGraphSnapshot,
  parseAdrReferenceDocument,
  stableStringify,
} from "../../src/core/index.js";
import { buildAdrCoverage } from "../../src/report/adr.js";

const hash = `sha256:${"a".repeat(64)}`;

const coverageSnapshot = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "1".repeat(40) },
  nodes: [
    {
      id: "node-a",
      stableKey: "stable:a",
      kind: "function",
      name: "A",
    },
    {
      id: "node-b",
      stableKey: "same",
      kind: "service",
      name: "B",
    },
    {
      id: "same",
      stableKey: "stable:c",
      kind: "module",
      name: "C",
    },
    {
      id: "unlinked",
      kind: "file",
      name: "Unlinked",
    },
  ],
  edges: [
    {
      from: "node-a",
      to: "node-b",
      kind: "calls",
      confidence: "certain",
      evidence: [
        {
          id: "edge-evidence",
          kind: "source",
          path: "src/a.ts",
          line: 1,
          detector: "test@1.0.0",
          contentHash: hash,
        },
      ],
    },
    {
      from: "node-b",
      to: "same",
      kind: "imports",
      confidence: "inferred",
      evidence: [
        {
          id: "unlinked-edge-evidence",
          kind: "source",
          path: "src/b.ts",
          line: 2,
          detector: "test@1.0.0",
          contentHash: hash,
        },
      ],
    },
  ],
  diagnostics: [],
});

const adrDocument = parseAdrReferenceDocument({
  schemaVersion: 1,
  references: [
    {
      id: "ADR-0001",
      file: "docs/adr/0001-a.md",
      title: "A",
      status: "accepted",
      graphIds: ["node-a", "edge:node-a|calls|node-b"],
    },
    {
      id: "ADR-0002",
      file: "docs/adr/0002-ambiguous.md",
      title: "Ambiguous",
      status: "proposed",
      graphIds: ["same"],
    },
    {
      id: "ADR-0003",
      file: "docs/adr/0003-deleted.md",
      title: "Deleted",
      status: "deprecated",
      graphIds: ["node-deleted"],
    },
    {
      id: "ADR-0004",
      file: "docs/adr/0004-shared.md",
      title: "Shared",
      status: "accepted",
      graphIds: ["node-a"],
    },
  ],
});

describe("ADR coverage indexes", () => {
  it("keeps deleted, ambiguous, and many-to-many references explicit", () => {
    const coverage = buildAdrCoverage(coverageSnapshot, adrDocument);

    expect(coverage.adrReferences).toEqual({
      total: 4,
      linked: 2,
      ambiguous: 1,
      unlinked: 1,
    });
    expect(coverage.graphLinks).toEqual({
      total: 5,
      resolved: 3,
      ambiguous: 1,
      unresolved: 1,
    });

    const ambiguous = coverage.adrToGraph.find(
      (entry) => entry.id === "ADR-0002",
    );
    expect(ambiguous?.links).toEqual([
      {
        graphId: "same",
        resolution: "ambiguous",
        targets: [
          { id: "node:node-b", type: "node", kind: "service" },
          { id: "node:same", type: "node", kind: "module" },
        ],
      },
    ]);
    expect(
      coverage.adrToGraph.find((entry) => entry.id === "ADR-0003")?.links[0],
    ).toEqual({
      graphId: "node-deleted",
      resolution: "unresolved",
      targets: [],
    });

    expect(
      coverage.graphToAdr.find((entry) => entry.id === "node:node-a"),
    ).toMatchObject({
      adrIds: ["ADR-0001", "ADR-0004"],
      ambiguousAdrIds: [],
    });
    expect(coverage.nodes).toMatchObject({
      total: 4,
      linked: 1,
      ambiguous: 2,
      unlinked: 1,
    });
    expect(coverage.edges).toMatchObject({
      total: 2,
      linked: 1,
      ambiguous: 0,
      unlinked: 1,
    });
    expect(
      coverage.nodes.byKind.find((entry) => entry.kind === "function"),
    ).toEqual({
      kind: "function",
      total: 1,
      linked: 1,
      ambiguous: 0,
      unlinked: 0,
    });
  });

  it("is byte-stable when snapshot and ADR input order changes", () => {
    const reorderedSnapshot = createGraphSnapshot({
      ...coverageSnapshot,
      nodes: [...coverageSnapshot.nodes].reverse(),
      edges: [...coverageSnapshot.edges].reverse(),
    });
    const reorderedDocument = parseAdrReferenceDocument({
      ...adrDocument,
      references: [...adrDocument.references].reverse(),
    });

    expect(
      stableStringify(buildAdrCoverage(coverageSnapshot, adrDocument)),
    ).toBe(
      stableStringify(buildAdrCoverage(reorderedSnapshot, reorderedDocument)),
    );
  });
});
