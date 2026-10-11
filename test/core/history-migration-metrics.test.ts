import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  computeTrendMetrics,
  createGraphSnapshot,
  createHistoryRecord,
  migrateGraphSnapshot,
  parseGraphSnapshot,
  serializeGraphSnapshot,
  type TrendMetricValue,
} from "../../src/core/index.js";

type Scenario = {
  id: string;
  legacy: unknown;
  current: unknown;
  expected: { metrics: TrendMetricValue[]; partialDiagnostics: number };
};

const scenarios = (
  JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../fixtures/history-migration/scenarios.v0.1.json",
      ),
      "utf8",
    ),
  ) as { scenarios: Scenario[] }
).scenarios;

const metrics = (values: TrendMetricValue[]): TrendMetricValue[] =>
  values.filter((item) =>
    [
      "boundary-crossing-imports",
      "bidirectional-boundary-pairs",
      "modules-in-import-cycles",
      "import-cycle-groups",
      "unresolved-edges",
      "diagnostics-per-node",
    ].includes(item.id),
  );

describe("independent migration metric oracles", () => {
  it.each(scenarios)(
    "matches the hand-calculated current oracle: $id",
    (scenario) => {
      const snapshot = createGraphSnapshot(scenario.current);
      const revision = computeTrendMetrics([
        { revision: scenario.id, snapshot },
      ]).revisions[0];
      expect(metrics(revision?.metrics ?? [])).toEqual(
        scenario.expected.metrics,
      );
      expect(revision?.marks).toEqual(
        scenario.expected.partialDiagnostics === 0
          ? []
          : [
              {
                reason: "partial-snapshot",
                detail: `${scenario.expected.partialDiagnostics} error or partial-analysis diagnostic(s)`,
              },
            ],
      );
    },
  );

  it.each(scenarios)(
    "matches the independent topology after migration: $id",
    (scenario) => {
      const migrated = migrateGraphSnapshot(scenario.legacy);
      const record = createHistoryRecord("snapshot", scenario.legacy);
      const snapshot = parseGraphSnapshot(record.body);
      const revision = computeTrendMetrics([
        {
          revision: scenario.id,
          snapshot,
          ...(record.migratedFrom === undefined
            ? {}
            : { migratedFrom: record.migratedFrom }),
        },
      ]).revisions[0];
      expect(metrics(revision?.metrics ?? [])).toEqual(
        scenario.expected.metrics,
      );
      expect(serializeGraphSnapshot(migrated.snapshot)).toBe(
        serializeGraphSnapshot(createGraphSnapshot(scenario.current)),
      );
      expect(serializeGraphSnapshot(snapshot)).toBe(
        serializeGraphSnapshot(migrated.snapshot),
      );
      expect(migrated.report.evidenceLoss).toEqual([]);
      expect(record.migratedFrom).toBe(0);
      expect(revision?.evidence?.migratedFrom).toBe(0);
      expect(revision?.marks).toContainEqual({
        reason: "migration",
        detail: "snapshot migrated from contract v0",
      });
    },
  );
});
