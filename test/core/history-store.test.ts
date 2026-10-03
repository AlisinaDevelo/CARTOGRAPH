import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildHistoryIndex,
  checkHistoryObject,
  createGraphSnapshot,
  createHistoryRecord,
  diffGraphSnapshots,
  historyIndexEntry,
  HistoryStoreError,
  serializeHistoryRecord,
  verifyHistoryStore,
} from "../../src/core/index.js";

const root = resolve(import.meta.dirname, "../..");
const snapshot = (commitSha: string, names: string[]) =>
  createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha },
    nodes: names.map((name) => ({
      id: `module:src/${name}.ts`,
      stableKey: `module:src/${name}.ts`,
      kind: "module",
      name,
      location: { path: `src/${name}.ts`, line: 1 },
    })),
    edges: [],
  });
const base = snapshot("base", ["a"]);
const head = snapshot("head", ["a", "b"]);
const encode = (text: string) => new TextEncoder().encode(text);

const store = (records: ReturnType<typeof createHistoryRecord>[]) => {
  const objects = new Map<string, Uint8Array>();
  const entries = records.map((record) => {
    const { id, text } = serializeHistoryRecord(record);
    objects.set(id, encode(text));
    return historyIndexEntry(id, record);
  });
  return { objects, index: buildHistoryIndex(entries).text };
};

describe("history store records", () => {
  it("content-addresses canonical records, independent of input key order", () => {
    const first = serializeHistoryRecord(createHistoryRecord("snapshot", head));
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(head).reverse())),
    ) as unknown;
    const second = serializeHistoryRecord(
      createHistoryRecord("snapshot", reordered),
    );
    expect(second.id).toBe(first.id);
    expect(first.id).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("migrates legacy snapshots on import", () => {
    const legacy = JSON.parse(
      readFileSync(
        resolve(root, "test/fixtures/snapshots/legacy-v0.graph.json"),
        "utf8",
      ),
    ) as unknown;
    const record = createHistoryRecord("snapshot", legacy);
    expect(record.recordSchemaVersion).toBe(1);
  });

  it("references the revisions a diff connects", () => {
    const record = createHistoryRecord("diff", diffGraphSnapshots(base, head));
    expect(record.revision).toBe("head");
    expect(record.references).toEqual(["revision:base", "revision:head"]);
  });

  it("rejects inputs that do not match their contract", () => {
    expect(() => createHistoryRecord("diff", head)).toThrowError(
      HistoryStoreError,
    );
  });
});

describe("history store verification", () => {
  it("passes a consistent store and reports unresolved revisions without failing", () => {
    const { objects, index } = store([
      createHistoryRecord("diff", diffGraphSnapshots(base, head)),
      createHistoryRecord("snapshot", head),
    ]);
    const report = verifyHistoryStore(index, objects);
    expect(report.ok).toBe(true);
    expect(report.unresolvedReferences.map((item) => item.reference)).toEqual([
      "revision:base",
    ]);
  });

  it("detects corrupt, non-canonical, missing, and unindexed records", () => {
    const { objects, index } = store([
      createHistoryRecord("snapshot", base),
      createHistoryRecord("snapshot", head),
    ]);
    const [first, second] = [...objects.keys()];
    if (first === undefined || second === undefined) throw new Error("setup");
    const damaged = new Map(objects);
    damaged.set(
      first,
      encode(`${new TextDecoder().decode(objects.get(first))} `),
    );
    damaged.delete(second);
    const stray = serializeHistoryRecord(
      createHistoryRecord("snapshot", snapshot("other", ["c"])),
    );
    damaged.set(stray.id, encode(stray.text));
    const report = verifyHistoryStore(index, damaged);
    expect(report.ok).toBe(false);
    expect(report.corrupt.map((item) => item.id)).toEqual([first]);
    expect(report.missing).toEqual([second]);
    expect(report.unindexed).toEqual([stray.id]);

    const reformatted = JSON.stringify(
      JSON.parse(new TextDecoder().decode(objects.get(second))),
      null,
      2,
    );
    const renamed = new TextEncoder().encode(reformatted);
    const id = createHash("sha256").update(renamed).digest("hex");
    expect(checkHistoryObject(id, renamed)).toMatchObject({
      status: "corrupt",
      reason: "record is not in canonical form for its contract",
    });
  });
});

describe("history store schemas", () => {
  it("match the parser for records and indexes", async () => {
    const { createAjv } = await import("../../scripts/json-schema.mjs");
    const read = (path: string) =>
      JSON.parse(readFileSync(resolve(root, path), "utf8")) as object;
    const validateRecord = createAjv().compile(
      read("schema/history-record.v0.1.schema.json"),
    );
    const validateIndex = createAjv().compile(
      read("schema/history-index.v0.1.schema.json"),
    );
    const record = createHistoryRecord("diff", diffGraphSnapshots(base, head));
    const { id, text } = serializeHistoryRecord(record);
    expect(validateRecord(JSON.parse(text))).toBe(true);
    expect(
      validateIndex(
        JSON.parse(buildHistoryIndex([historyIndexEntry(id, record)]).text),
      ),
    ).toBe(true);
  });
});
