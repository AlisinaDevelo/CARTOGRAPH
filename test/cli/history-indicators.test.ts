import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  serializeGraphSnapshot,
  stableStringify,
} from "../../src/core/index.js";
import {
  historyIndicators,
  importHistoryRecords,
  listHistoryRecords,
  verifyHistory,
} from "../../src/history-command.js";
import {
  findings,
  policy,
  snapshot,
  waiver,
} from "../core/control-evidence.fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("history indicators", () => {
  it("imports waivers and computes indicators from stored evidence", async () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "cartograph-indicators-")),
    );
    roots.push(directory);
    const store = join(directory, "store");
    const write = (name: string, value: string): string => {
      const path = join(directory, name);
      writeFileSync(path, value);
      return path;
    };
    const imported = await importHistoryRecords({
      store,
      inputs: [
        {
          kind: "snapshot",
          path: write("s.json", serializeGraphSnapshot(snapshot)),
        },
        { kind: "policy", path: write("p.json", stableStringify(policy)) },
        { kind: "waiver", path: write("w.json", stableStringify(waiver)) },
        {
          kind: "finding-lifecycle",
          path: write("f.json", stableStringify(findings)),
        },
      ],
      toolVersion: "0.1.1",
    });
    expect(await listHistoryRecords({ store, kind: "waiver" })).toHaveLength(1);
    expect((await verifyHistory(store)).ok).toBe(true);
    const policyId = imported.imported.find((item) => item.kind === "policy")
      ?.id as string;
    const report = await historyIndicators({
      store,
      asOf: "2030-06-01T00:00:00Z",
      revisions: ["control-fixture"],
      policyRecord: policyId,
    });
    const status = Object.fromEntries(
      report.indicators.map((item) => [item.id, item.status]),
    );
    expect(status).toEqual({
      "finding-age": "above-threshold",
      "finding-recurrence": "above-threshold",
      "waiver-history": "within-threshold",
      "ownership-gaps": "unavailable",
      "policy-severity": "above-threshold",
      "boundary-erosion": "unavailable",
      "unknown-coverage": "within-threshold",
      "remediation-evidence": "within-threshold",
    });
  });
});
