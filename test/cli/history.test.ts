import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  exportHistoryRecords,
  historyTrends,
  importHistoryRecords,
  listHistoryRecords,
  repairHistory,
  verifyHistory,
} from "../../src/history-command.js";
import { scanRepository, serializeScan } from "../../src/commands.js";
import { createAjv } from "../../scripts/json-schema.mjs";

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

describe("history trends", () => {
  it("recomputes metrics from stored snapshots and reports missing revisions", async () => {
    const { store, snapshot, directory } = setup();
    const policyPath = join(directory, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        policyId: "trend",
        version: "1.0.0",
        mode: "enforce",
        rules: [
          {
            id: "imports-exist",
            target: "edge",
            assertion: "exists",
            selector: { kind: "imports" },
          },
        ],
      }),
    );
    const imported = await importHistoryRecords({
      store,
      inputs: [
        { kind: "snapshot", path: snapshot },
        { kind: "policy", path: policyPath },
      ],
      toolVersion: "0.1.1",
    });
    const [entry] = await listHistoryRecords({ store, kind: "snapshot" });
    const policyId = imported.imported.find(
      (item) => item.kind === "policy",
    )?.id;
    const revision = entry?.revision ?? "";
    const report = await historyTrends({
      store,
      revisions: [revision, "not-imported"],
      ...(policyId === undefined ? {} : { policyRecord: policyId }),
    });
    expect(report.revisions.map((item) => item.status)).toEqual([
      "measured",
      "missing",
    ]);
    expect(report.revisions[0]?.evidence?.recordId).toBe(entry?.id);
    expect(
      report.revisions[0]?.metrics.find(
        (item) => item.id === "policy-violation-rate",
      )?.status,
    ).toBe("measured");
    const again = await historyTrends({
      store,
      revisions: [revision, "not-imported"],
      ...(policyId === undefined ? {} : { policyRecord: policyId }),
    });
    expect(again).toEqual(report);
    const schema = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../schema/trend-metrics.v0.1.schema.json",
        ),
        "utf8",
      ),
    ) as object;
    const validate = createAjv({ allErrors: true }).compile(schema);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects a record ID of the wrong kind", async () => {
    const { store, snapshot } = setup();
    await importHistoryRecords({
      store,
      inputs: [{ kind: "snapshot", path: snapshot }],
      toolVersion: "0.1.1",
    });
    const [entry] = await listHistoryRecords({ store, kind: "snapshot" });
    await expect(
      historyTrends({
        store,
        revisions: [entry?.revision ?? ""],
        policyRecord: entry?.id ?? "",
      }),
    ).rejects.toThrow(/no policy record/u);
  });
});

describe("history import boundary", () => {
  it("refuses to deduplicate against an object whose bytes changed", async () => {
    const { store, snapshot } = setup();
    await importHistoryRecords({
      store,
      inputs: [{ kind: "snapshot", path: snapshot }],
      toolVersion: "0.1.1",
    });
    const [entry] = await listHistoryRecords({ store, kind: "snapshot" });
    const id = entry?.id ?? "";
    writeFileSync(join(store, "objects", id.slice(0, 2), `${id}.json`), "{}\n");
    await expect(
      importHistoryRecords({
        store,
        inputs: [{ kind: "snapshot", path: snapshot }],
        toolVersion: "0.1.1",
      }),
    ).rejects.toThrow(/does not match its content/u);
  });

  it("refuses a store that is a symbolic link", async () => {
    const { directory, snapshot } = setup();
    const real = join(directory, "real-store");
    mkdirSync(real);
    const link = join(directory, "linked-store");
    symlinkSync(real, link);
    await expect(
      importHistoryRecords({
        store: link,
        inputs: [{ kind: "snapshot", path: snapshot }],
        toolVersion: "0.1.1",
      }),
    ).rejects.toThrow(/symbolic links/u);
    expect(readdirSync(real)).toEqual([]);
  });

  it("reports two different snapshots of one revision as a conflict", async () => {
    const { store, snapshot, directory } = setup();
    const original = JSON.parse(readFileSync(snapshot, "utf8")) as {
      nodes: { name: string }[];
    };
    const node = original.nodes[0] as { name: string };
    node.name = `${node.name}-edited`;
    const edited = join(directory, "edited.json");
    writeFileSync(edited, JSON.stringify(original));
    const result = await importHistoryRecords({
      store,
      inputs: [
        { kind: "snapshot", path: snapshot },
        { kind: "snapshot", path: edited },
      ],
      toolVersion: "0.1.1",
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.ids).toHaveLength(2);
  });
});
