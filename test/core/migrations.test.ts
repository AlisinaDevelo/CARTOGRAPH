import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  migrateGraphSnapshot,
  serializeMigrationReport,
  serializeGraphSnapshot,
  SnapshotMigrationError,
  validateMigrationOutput,
} from "../../src/index.js";

const fixturePath = resolve(
  import.meta.dirname,
  "../fixtures/snapshots/legacy-v0.graph.json",
);

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;

describe("GraphSnapshot migrations", () => {
  it("migrates the historical v0 fixture deterministically", () => {
    const first = migrateGraphSnapshot(fixture);
    const second = migrateGraphSnapshot(fixture);

    validateMigrationOutput(first);
    expect(serializeGraphSnapshot(first.snapshot)).toBe(
      serializeGraphSnapshot(second.snapshot),
    );
    expect(serializeMigrationReport(first.report)).toBe(
      serializeMigrationReport(second.report),
    );
    expect(first.snapshot.schemaVersion).toBe(1);
    expect(first.snapshot.capabilityRegistryVersion).toBe(1);
    expect(first.snapshot.nodes).toContainEqual(
      expect.objectContaining({
        id: "function:src/entry.ts:main",
        stableKey: "function:src/entry.ts:main",
      }),
    );
    expect(first.snapshot.edges[0]?.to).toBe("function:src/entry.ts:main");
    expect(first.report.changedNodeIdentities).toContainEqual({
      before: "function:src/entry.ts#main",
      after: "function:src/entry.ts:main",
      changed: true,
    });
    expect(first.report.changedEdgeIdentities).toHaveLength(1);
    expect(first.report.nodeIdentities).toHaveLength(2);
    expect(first.report.edgeIdentities).toHaveLength(1);
    expect(first.report.evidenceLoss).toEqual([]);
  });

  it("rejects unsupported versions and dangling legacy identities", () => {
    expect(() => migrateGraphSnapshot({ schemaVersion: 1 })).toThrowError(
      SnapshotMigrationError,
    );
    expect(() =>
      migrateGraphSnapshot({
        ...(fixture as Record<string, unknown>),
        edges: [
          {
            source: "module:src/entry.ts",
            target: "function:missing#target",
            relation: "contains",
            confidence: "certain",
            evidence: [],
          },
        ],
      }),
    ).toThrowError(/unknown legacy node/u);
  });
});
