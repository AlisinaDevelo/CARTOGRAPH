import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createGraphSnapshot,
  type TrendMetricValue,
} from "../../src/core/index.js";
import {
  historyTrends,
  importHistoryRecords,
  listHistoryRecords,
  verifyHistory,
} from "../../src/history-command.js";

const scenarios = (
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../fixtures/history-migration/scenarios.v0.1.json",
      ),
      "utf8",
    ),
  ) as {
    scenarios: {
      id: string;
      legacy: unknown;
      current: unknown;
      expected: { metrics: TrendMetricValue[]; partialDiagnostics: number };
    }[];
  }
).scenarios;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("stored migration metric oracles", () => {
  it.each(scenarios)(
    "preserves the oracle and migration break after real import: $id",
    async (scenario) => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "cartograph-migration-metrics-")),
      );
      roots.push(root);
      const legacyPath = join(root, "legacy.json");
      const currentPath = join(root, "current.json");
      const current = createGraphSnapshot(scenario.current);
      const currentRevision = `${scenario.id}-current`;
      writeFileSync(legacyPath, JSON.stringify(scenario.legacy));
      writeFileSync(
        currentPath,
        JSON.stringify({
          ...current,
          revision: { commitSha: currentRevision },
        }),
      );
      const store = join(root, "store");
      const imported = await importHistoryRecords({
        store,
        inputs: [
          { kind: "snapshot", path: legacyPath },
          { kind: "snapshot", path: currentPath },
        ],
        toolVersion: "0.1.1",
      });
      expect(imported.conflicts).toEqual([]);
      expect(await verifyHistory(store)).toMatchObject({
        ok: true,
        records: 3,
      });
      const entries = await listHistoryRecords({ store, kind: "snapshot" });
      const legacyEntry = entries.find(
        (entry) => entry.revision === scenario.id,
      );
      const currentEntry = entries.find(
        (entry) => entry.revision === currentRevision,
      );
      expect(legacyEntry?.migratedFrom).toBe(0);
      expect(currentEntry).not.toHaveProperty("migratedFrom");
      const report = await historyTrends({
        store,
        revisions: [scenario.id, currentRevision],
      });
      expect(report.metricsVersion).toBe(1);
      for (const revision of report.revisions) {
        expect(
          revision.metrics.filter((item) =>
            scenario.expected.metrics.some(
              (expected) => expected.id === item.id,
            ),
          ),
        ).toEqual(scenario.expected.metrics);
      }
      expect(report.revisions[0]?.evidence).toMatchObject({
        recordId: legacyEntry?.id,
        migratedFrom: 0,
        snapshotSchemaVersion: 1,
        recordSchemaVersion: 1,
      });
      expect(report.revisions[1]?.evidence).not.toHaveProperty("migratedFrom");
      expect(report.revisions[0]?.marks).toContainEqual({
        reason: "migration",
        detail: "snapshot migrated from contract v0",
      });
      expect(report.intervals[0]?.breaks.map((item) => item.reason)).toContain(
        "migration",
      );
      for (const expected of scenario.expected.metrics) {
        const change = report.intervals[0]?.changes.find(
          (item) => item.id === expected.id,
        );
        expect(change).toEqual(
          expected.status === "unavailable"
            ? { id: expected.id, status: "unavailable" }
            : {
                id: expected.id,
                status: "incomparable",
                from: expected.value,
                to: expected.value,
                reasons:
                  scenario.expected.partialDiagnostics > 0
                    ? ["migration", "partial-snapshot"]
                    : ["migration"],
              },
        );
      }
      expect(
        await historyTrends({
          store,
          revisions: [scenario.id, currentRevision],
        }),
      ).toEqual(report);
    },
  );
});
