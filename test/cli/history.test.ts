import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  exportHistoryRecords,
  importHistoryRecords,
  listHistoryRecords,
  repairHistory,
  verifyHistory,
} from "../../src/history-command.js";
import { scanRepository, serializeScan } from "../../src/commands.js";

const roots: string[] = [];
const temporary = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "cartograph-history-")));
  roots.push(path);
  return path;
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

const setup = () => {
  const directory = temporary();
  const snapshot = join(directory, "graph.json");
  writeFileSync(
    snapshot,
    serializeScan(scanRepository({ root: "test/fixtures/typescript-express" })),
  );
  return { store: join(directory, "store"), snapshot, directory };
};

const objectFiles = (store: string): string[] =>
  readdirSync(join(store, "objects"), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".json"));

describe("history store on disk", () => {
  it("imports once, deduplicates, and verifies", async () => {
    const { store, snapshot } = setup();
    const first = await importHistoryRecords({
      store,
      inputs: [{ kind: "snapshot", path: snapshot }],
      toolVersion: "0.1.1",
    });
    expect(first.imported.map((item) => [item.kind, item.existing])).toEqual([
      ["snapshot", false],
      ["provenance", false],
    ]);
    const second = await importHistoryRecords({
      store,
      inputs: [{ kind: "snapshot", path: snapshot }],
      toolVersion: "0.1.1",
    });
    expect(second.imported.every((item) => item.existing)).toBe(true);
    expect(objectFiles(store)).toHaveLength(2);
    expect(await listHistoryRecords({ store, kind: "snapshot" })).toHaveLength(
      1,
    );
    expect(await verifyHistory(store)).toMatchObject({ ok: true, records: 2 });
  });

  it("refuses to import while a lock is held", async () => {
    const { store, snapshot } = setup();
    await importHistoryRecords({
      store,
      inputs: [{ kind: "snapshot", path: snapshot }],
      toolVersion: "0.1.1",
    });
    writeFileSync(join(store, "lock"), "");
    await expect(
      importHistoryRecords({
        store,
        inputs: [{ kind: "snapshot", path: snapshot }],
        toolVersion: "0.1.1",
      }),
    ).rejects.toThrow("history store is locked");
  });

  it("detects corruption, repairs by quarantine, and exports", async () => {
    const { store, snapshot, directory } = setup();
    await importHistoryRecords({
      store,
      inputs: [{ kind: "snapshot", path: snapshot }],
      toolVersion: "0.1.1",
    });
    const [victim] = objectFiles(store);
    if (victim === undefined) throw new Error("no objects");
    appendFileSync(join(store, "objects", victim), " ");
    writeFileSync(join(store, "objects", "partial.tmp"), "");
    writeFileSync(join(store, "lock"), "");
    const damaged = await verifyHistory(store);
    expect(damaged.ok).toBe(false);
    expect(damaged.corrupt).toHaveLength(1);
    expect(damaged.leftovers).toEqual(["objects/partial.tmp"]);

    const repaired = await repairHistory(store);
    expect(repaired.quarantined).toHaveLength(1);
    expect(existsSync(join(store, "lock"))).toBe(false);
    expect(await verifyHistory(store)).toMatchObject({ ok: true });

    await importHistoryRecords({
      store,
      inputs: [{ kind: "snapshot", path: snapshot }],
      toolVersion: "0.1.1",
    });
    const exported = await exportHistoryRecords({
      store,
      output: join(directory, "export"),
      revision: "working-tree",
    });
    expect(exported.exported).toHaveLength(1);
    expect(exported.exported[0]).toMatch(/^snapshot-[0-9a-f]{12}\.json$/u);
  });
});
