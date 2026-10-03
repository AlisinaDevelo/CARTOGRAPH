import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createGraphSnapshot,
  diffGraphSnapshots,
  serializeGraphSnapshot,
  stableStringify,
  type GraphSnapshot,
} from "../../src/core/index.js";
import {
  exportHistoryRecords,
  historyGc,
  historyTrends,
  importHistoryRecords,
  listHistoryRecords,
  repairHistory,
  verifyHistory,
} from "../../src/history-command.js";

const roots: string[] = [];
const temporary = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "cartograph-gc-")));
  roots.push(path);
  return path;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

const AS_OF = "2026-10-01T00:00:00Z";
// Assembled at runtime so no secret-shaped literal is committed.
const TOKEN = ["gh", "p_", "R".repeat(36)].join("");

const snapshot = (
  commitSha: string,
  authoredAt: string,
  names: string[],
): GraphSnapshot =>
  createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha, authoredAt },
    nodes: names.map((name) => ({
      id: `module:src/${name}.ts`,
      stableKey: `module:src/${name}.ts`,
      kind: "module",
      name,
      location: { path: `src/${name}.ts`, line: 1 },
    })),
    edges: [],
  });

const setup = async (options: { diff?: boolean } = {}) => {
  const directory = temporary();
  const store = join(directory, "store");
  const a = snapshot("aaaa", "2025-06-01T00:00:00Z", ["a"]);
  const b = snapshot("bbbb", "2026-09-01T00:00:00Z", ["a", "b"]);
  const c = snapshot("cccc", "2026-09-20T00:00:00Z", ["a", "b", "c"]);
  const write = (name: string, value: unknown): string => {
    const path = join(directory, name);
    writeFileSync(
      path,
      typeof value === "string" ? value : `${stableStringify(value)}\n`,
    );
    return path;
  };
  const inputs = [
    { kind: "snapshot", path: write("a.json", serializeGraphSnapshot(a)) },
    { kind: "snapshot", path: write("b.json", serializeGraphSnapshot(b)) },
    { kind: "snapshot", path: write("c.json", serializeGraphSnapshot(c)) },
  ];
  if (options.diff !== false)
    inputs.push({
      kind: "diff",
      path: write("ab.json", diffGraphSnapshots(a, b)),
    });
  await importHistoryRecords({ store, inputs, toolVersion: "0.1.1" });
  const policy = (value: object): string =>
    write(`policy-${Math.random().toString(16).slice(2)}.json`, {
      schemaVersion: 1,
      contract: "cartograph.history-retention",
      ...value,
    });
  return { directory, store, policy, write };
};

const idOf = async (store: string, revision: string) =>
  (await listHistoryRecords({ store, kind: "snapshot", revision })).find(
    (entry) => entry.revision === revision,
  )?.id as string;

describe("history gc", () => {
  it("plans without deleting, keeps referenced snapshots, and applies with tombstones", async () => {
    const { store, policy } = await setup();
    const snapshots = policy({
      rules: [{ id: "year", kind: "snapshot", maxAgeDays: 365 }],
    });
    const plan = await historyGc({ store, policy: snapshots, asOf: AS_OF });
    expect(plan.applied).toBe(false);
    expect(plan.remove).toEqual([]);
    const aId = await idOf(store, "aaaa");
    expect(plan.keep.find((item) => item.id === aId)?.reasons).toEqual([
      "referenced",
    ]);

    const trendsBefore = await historyTrends({
      store,
      revisions: ["bbbb", "cccc"],
    });
    const withDiffs = policy({
      rules: [
        { id: "year", kind: "snapshot", maxAgeDays: 365 },
        { id: "diffs", kind: "diff", maxAgeDays: 7 },
      ],
    });
    const dry = await historyGc({ store, policy: withDiffs, asOf: AS_OF });
    expect(dry.remove.map((item) => item.kind).sort()).toEqual([
      "diff",
      "snapshot",
    ]);
    expect((await verifyHistory(store)).records).toBe(5);

    const applied = await historyGc({
      store,
      policy: withDiffs,
      asOf: AS_OF,
      apply: true,
    });
    expect(applied.deleted.sort()).toEqual(
      dry.remove.map((item) => item.id).sort(),
    );
    for (const id of applied.deleted) {
      expect(
        existsSync(join(store, "objects", id.slice(0, 2), `${id}.json`)),
      ).toBe(false);
      const tombstone = JSON.parse(
        readFileSync(join(store, "tombstones", `${id}.json`), "utf8"),
      ) as { removedAt: string; contract: string };
      expect(tombstone).toMatchObject({
        contract: "cartograph.history-tombstone",
        removedAt: AS_OF,
      });
    }
    expect(await verifyHistory(store)).toMatchObject({ ok: true, records: 3 });
    expect(await historyTrends({ store, revisions: ["bbbb", "cccc"] })).toEqual(
      trendsBefore,
    );
  });

  it("compacts a diff only when the stored snapshots reproduce it", async () => {
    const { store, policy, write } = await setup();
    const foreign = diffGraphSnapshots(
      snapshot("cccc", "2026-09-20T00:00:00Z", ["a", "b", "c"]),
      snapshot("dddd", "2026-09-25T00:00:00Z", ["z"]),
    );
    await importHistoryRecords({
      store,
      inputs: [{ kind: "diff", path: write("cd.json", foreign) }],
      toolVersion: "0.1.1",
    });
    const result = await historyGc({
      store,
      policy: policy({ rules: [], compactDerivedDiffs: true }),
      asOf: AS_OF,
      apply: true,
    });
    expect(result.remove.map((item) => item.rule)).toEqual([
      "compact-derived-diff",
    ]);
    expect(
      result.keep.filter((item) => item.reasons.includes("not-reproducible")),
    ).toHaveLength(1);
    expect((await verifyHistory(store)).ok).toBe(true);
  });

  it("refuses to run on a store whose index is corrupt", async () => {
    const { store, policy } = await setup();
    writeFileSync(join(store, "index.json"), "{");
    await expect(
      historyGc({
        store,
        policy: policy({ rules: [] }),
        asOf: AS_OF,
        apply: true,
      }),
    ).rejects.toThrow(/does not verify/u);
  });

  it("finishes an interrupted removal on repair, and re-import restores a record", async () => {
    const { store, policy, directory } = await setup({ diff: false });
    const aId = await idOf(store, "aaaa");
    const objectFile = join(store, "objects", aId.slice(0, 2), `${aId}.json`);
    const saved = readFileSync(objectFile);
    await historyGc({
      store,
      policy: policy({
        rules: [{ id: "year", kind: "snapshot", maxAgeDays: 365 }],
      }),
      asOf: AS_OF,
      apply: true,
    });
    // Simulate a crash after the index was rewritten but before deletion.
    writeFileSync(objectFile, saved);
    expect((await verifyHistory(store)).ok).toBe(false);
    await repairHistory(store);
    expect(existsSync(objectFile)).toBe(false);
    expect((await verifyHistory(store)).ok).toBe(true);

    await importHistoryRecords({
      store,
      inputs: [{ kind: "snapshot", path: join(directory, "a.json") }],
      toolVersion: "0.1.1",
    });
    expect(existsSync(join(store, "tombstones", `${aId}.json`))).toBe(false);
    expect(await idOf(store, "aaaa")).toBe(aId);
  });

  it("keeps held and undated (migrated legacy) records", async () => {
    const { store, policy } = await setup({ diff: false });
    await importHistoryRecords({
      store,
      inputs: [
        {
          kind: "snapshot",
          path: "test/fixtures/snapshots/legacy-v0.graph.json",
        },
      ],
      toolVersion: "0.1.1",
    });
    const result = await historyGc({
      store,
      policy: policy({
        rules: [{ id: "year", kind: "snapshot", maxAgeDays: 365 }],
        holds: [{ revision: "aaaa", owner: "legal", reason: "audit hold" }],
      }),
      asOf: AS_OF,
    });
    expect(result.remove).toEqual([]);
    const reasons = result.keep.flatMap((item) => item.reasons);
    expect(reasons).toContain("hold");
    expect(reasons).toContain("undated");
  });
});

describe("history export scope and redaction", () => {
  it("exports one kind and redacts for a recipient profile", async () => {
    const { store, write, directory } = await setup();
    const leaky = createGraphSnapshot({
      schemaVersion: 1,
      revision: { commitSha: "eeee", authoredAt: "2026-09-30T00:00:00Z" },
      nodes: [
        {
          id: "module:src/x.ts",
          stableKey: "module:src/x.ts",
          kind: "module",
          name: `x ${TOKEN}`,
          location: { path: "src/x.ts", line: 1 },
        },
      ],
      edges: [],
    });
    await importHistoryRecords({
      store,
      inputs: [
        {
          kind: "snapshot",
          path: write("e.json", serializeGraphSnapshot(leaky)),
        },
      ],
      toolVersion: "0.1.1",
    });
    const output = join(directory, "export");
    const result = await exportHistoryRecords({
      store,
      output,
      kinds: ["snapshot"],
      revision: "eeee",
      profile: "team",
    });
    expect(result.exported).toHaveLength(1);
    expect(result.redactions).toBe(1);
    const text = readdirSync(output)
      .map((name) => readFileSync(join(output, name), "utf8"))
      .join("");
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("[REDACTED:access-token]");

    const diffsOnly = await exportHistoryRecords({
      store,
      output: join(directory, "diffs"),
      kinds: ["diff"],
    });
    expect(diffsOnly.exported.every((name) => name.startsWith("diff-"))).toBe(
      true,
    );
  });

  it("fails closed when redaction would break a record's contract", async () => {
    const { store, write, directory } = await setup({ diff: false });
    const leaky = createGraphSnapshot({
      schemaVersion: 1,
      revision: { commitSha: "ffff" },
      nodes: [0, 1].map((index) => ({
        id: `module:${TOKEN}${index}`,
        stableKey: `module:${TOKEN}${index}`,
        kind: "module" as const,
        name: "x",
      })),
      edges: [],
    });
    await importHistoryRecords({
      store,
      inputs: [
        {
          kind: "snapshot",
          path: write("f.json", serializeGraphSnapshot(leaky)),
        },
      ],
      toolVersion: "0.1.1",
    });
    const error = await exportHistoryRecords({
      store,
      output: join(directory, "out"),
      revision: "ffff",
      profile: "team",
    }).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toMatch(/no longer satisfies its contract/u);
    expect(error?.message).not.toContain(TOKEN);
  });
});

describe("history trends breaks on disk", () => {
  it("marks migrated and removed revisions, policy overrides, and reads notes and earlier reports", async () => {
    const { store, policy, write, directory } = await setup({ diff: false });
    await importHistoryRecords({
      store,
      inputs: [
        {
          kind: "snapshot",
          path: "test/fixtures/snapshots/legacy-v0.graph.json",
        },
      ],
      toolVersion: "0.1.1",
    });
    await historyGc({
      store,
      policy: policy({
        rules: [{ id: "year", kind: "snapshot", maxAgeDays: 365 }],
      }),
      asOf: AS_OF,
      apply: true,
    });
    const policyFile = (id: string) =>
      write(`p-${id}.json`, {
        policyId: id,
        version: "1.0.0",
        mode: "enforce",
        rules: [
          {
            id: "imports",
            target: "edge",
            assertion: "exists",
            selector: { kind: "imports" },
          },
        ],
      });
    const imported = await importHistoryRecords({
      store,
      inputs: [
        { kind: "policy", path: policyFile("one") },
        { kind: "policy", path: policyFile("two") },
      ],
      toolVersion: "0.1.1",
    });
    const [one, two] = imported.imported
      .filter((item) => item.kind === "policy")
      .map((item) => item.id) as [string, string];
    const notes = write("notes.json", {
      schemaVersion: 1,
      contract: "cartograph.trend-explanations",
      explanations: [
        {
          from: "bbbb",
          to: "cccc",
          reason: "policy-change",
          reviewer: "arch-review",
          note: "Policy two replaced policy one.",
        },
      ],
    });
    const options = {
      store,
      revisions: ["aaaa", "legacy-v0-fixture", "bbbb", "cccc"],
      policyRecord: one,
      policyAt: [{ revision: "cccc", id: two }],
      explanations: notes,
    };
    const report = await historyTrends(options);
    const marks = Object.fromEntries(
      report.revisions.map((item) => [
        item.revision,
        item.marks.map((mark) => mark.reason),
      ]),
    );
    expect(marks).toMatchObject({
      aaaa: ["removed-by-retention"],
      "legacy-v0-fixture": ["migration"],
      bbbb: [],
    });
    const last = report.intervals[2];
    expect(last?.breaks).toEqual([
      {
        reason: "policy-change",
        explanation: {
          reviewer: "arch-review",
          note: "Policy two replaced policy one.",
        },
      },
    ]);
    const previousPath = join(directory, "previous.json");
    writeFileSync(previousPath, JSON.stringify(report));
    expect(
      (await historyTrends({ ...options, previous: previousPath }))
        .restatements,
    ).toEqual([]);
  });
});
