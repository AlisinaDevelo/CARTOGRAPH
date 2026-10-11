import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createAjv } from "../../scripts/json-schema.mjs";

import {
  parseHistoryRetentionPolicy,
  planHistoryRetention,
  type RetentionRecord,
} from "../../src/core/index.js";

const id = (n: number): string => n.toString(16).padStart(64, "0");
const snapshot = (
  n: number,
  revision: string,
  date?: string,
): RetentionRecord => ({
  id: id(n),
  kind: "snapshot",
  revision,
  references: [],
  ...(date === undefined ? {} : { date }),
});
const policy = (value: object) =>
  parseHistoryRetentionPolicy({
    schemaVersion: 1,
    contract: "cartograph.history-retention",
    ...value,
  });
const AS_OF = "2026-10-01T00:00:00Z";
const removed = (plan: ReturnType<typeof planHistoryRetention>) =>
  plan.remove.map((item) => item.id);

describe("history retention planning", () => {
  it("keeps a record exactly at the age boundary and removes one past it", () => {
    const records = [
      snapshot(1, "a", "2026-09-01T00:00:00Z"), // 30 days
      snapshot(2, "b", "2026-08-31T23:59:59Z"), // just over 30 days
    ];
    const plan = planHistoryRetention(
      records,
      policy({ rules: [{ id: "month", kind: "snapshot", maxAgeDays: 30 }] }),
      AS_OF,
    );
    expect(removed(plan)).toEqual([id(2)]);
    expect(plan.remove[0]).toMatchObject({ rule: "month", revision: "b" });
  });

  it("keeps the newest N and lets any keeping rule win", () => {
    const records = [
      snapshot(1, "a", "2026-01-01T00:00:00Z"),
      snapshot(2, "b", "2026-02-01T00:00:00Z"),
      snapshot(3, "c", "2026-03-01T00:00:00Z"),
    ];
    expect(
      removed(
        planHistoryRetention(
          records,
          policy({ rules: [{ id: "last2", kind: "snapshot", keepLast: 2 }] }),
          AS_OF,
        ),
      ),
    ).toEqual([id(1)]);
    expect(
      removed(
        planHistoryRetention(
          records,
          policy({
            rules: [
              { id: "last1", kind: "snapshot", keepLast: 1 },
              { id: "year", kind: "snapshot", maxAgeDays: 365 },
            ],
          }),
          AS_OF,
        ),
      ),
    ).toEqual([]);
  });

  it("applies rules by classification and keeps undated and unruled records", () => {
    const records = [
      snapshot(1, "secret", "2026-01-01T00:00:00Z"),
      snapshot(2, "normal", "2026-01-01T00:00:00Z"),
      snapshot(3, "legacy"),
      { id: id(4), kind: "policy" as const, references: [] },
    ];
    const plan = planHistoryRetention(
      records,
      policy({
        classifications: [{ revision: "secret", classification: "restricted" }],
        rules: [
          {
            id: "restricted-90",
            kind: "snapshot",
            classification: "restricted",
            maxAgeDays: 90,
          },
        ],
      }),
      AS_OF,
    );
    expect(removed(plan)).toEqual([id(1)]);
    const reasons = Object.fromEntries(
      plan.keep.map((item) => [item.id, item.reasons]),
    );
    expect(reasons[id(2)]).toEqual(["no-rule"]);
    expect(reasons[id(3)]).toEqual(["no-rule"]);
    expect(reasons[id(4)]).toEqual(["no-rule"]);
  });

  it("honours holds through their end date and not after", () => {
    const records = [snapshot(1, "a", "2025-01-01T00:00:00Z")];
    const withHold = (until: string) =>
      policy({
        rules: [{ id: "year", kind: "snapshot", maxAgeDays: 365 }],
        holds: [{ revision: "a", owner: "legal", reason: "audit", until }],
      });
    expect(
      removed(planHistoryRetention(records, withHold(AS_OF), AS_OF)),
    ).toEqual([]);
    expect(
      removed(
        planHistoryRetention(records, withHold("2026-09-30T23:59:59Z"), AS_OF),
      ),
    ).toEqual([id(1)]);
  });

  it("never removes a snapshot or record a retained record references", () => {
    const records: RetentionRecord[] = [
      snapshot(1, "a", "2025-01-01T00:00:00Z"),
      snapshot(2, "b", "2026-09-01T00:00:00Z"),
      {
        id: id(3),
        kind: "diff",
        revision: "b",
        references: ["revision:a", "revision:b"],
        date: "2026-09-01T00:00:00Z",
      },
    ];
    const rules = [{ id: "year", kind: "snapshot", maxAgeDays: 365 }];
    const plan = planHistoryRetention(records, policy({ rules }), AS_OF);
    expect(removed(plan)).toEqual([]);
    expect(plan.keep.find((item) => item.id === id(1))?.reasons).toEqual([
      "referenced",
    ]);
    // Once the diff itself expires, the snapshot it pinned goes too.
    const both = planHistoryRetention(
      records,
      policy({
        rules: [...rules, { id: "diffs", kind: "diff", maxAgeDays: 10 }],
      }),
      AS_OF,
    );
    expect(removed(both)).toEqual([id(1), id(3)]);
  });

  it("compacts only reproducible diffs whose snapshots stay", () => {
    const records: RetentionRecord[] = [
      snapshot(1, "a", "2026-09-01T00:00:00Z"),
      snapshot(2, "b", "2026-09-02T00:00:00Z"),
      {
        id: id(3),
        kind: "diff",
        revision: "b",
        references: ["revision:a", "revision:b"],
        date: "2026-09-02T00:00:00Z",
      },
      {
        id: id(4),
        kind: "diff",
        revision: "b",
        references: ["revision:a", "revision:b"],
        date: "2026-09-02T00:00:00Z",
      },
    ];
    const plan = planHistoryRetention(
      records,
      policy({ rules: [], compactDerivedDiffs: true }),
      AS_OF,
      (diff) => diff.id === id(3),
    );
    expect(removed(plan)).toEqual([id(3)]);
    expect(plan.keep.find((item) => item.id === id(4))?.reasons).toContain(
      "not-reproducible",
    );
  });

  it("keeps referenced snapshots when their diff cannot be compacted after retention", () => {
    const records: RetentionRecord[] = [
      snapshot(1, "a", "2026-09-01T00:00:00Z"),
      snapshot(2, "b", "2026-09-02T00:00:00Z"),
      {
        id: id(3),
        kind: "diff",
        revision: "b",
        references: ["revision:a", "revision:b"],
        date: "2026-09-02T00:00:00Z",
      },
    ];
    const plan = planHistoryRetention(
      records,
      policy({
        rules: [{ id: "last1", kind: "snapshot", keepLast: 1 }],
        compactDerivedDiffs: true,
      }),
      AS_OF,
      () => true,
    );

    expect(plan.remove).toEqual([]);
    expect(plan.keep.find((item) => item.id === id(1))?.reasons).toEqual([
      "referenced",
    ]);
    expect(plan.keep.find((item) => item.id === id(3))?.reasons).toContain(
      "not-reproducible",
    );
  });

  it("combines age and count rules with holds, shared references, and compaction", () => {
    const records: RetentionRecord[] = [
      snapshot(1, "a", "2026-09-01T00:00:00Z"),
      snapshot(2, "b", "2026-09-02T00:00:00Z"),
      snapshot(3, "c", "2026-09-20T00:00:00Z"),
      {
        id: id(4),
        kind: "diff",
        revision: "b",
        references: ["revision:a", "revision:b"],
        date: "2026-09-02T00:00:00Z",
      },
      {
        id: id(5),
        kind: "diff",
        revision: "c",
        references: ["revision:b", "revision:c"],
        date: "2026-09-20T00:00:00Z",
      },
    ];
    const retention = policy({
      rules: [{ id: "recent", kind: "snapshot", keepLast: 1, maxAgeDays: 20 }],
      holds: [{ revision: "b", owner: "legal", reason: "audit", until: AS_OF }],
      compactDerivedDiffs: true,
    });
    const plan = planHistoryRetention(records, retention, AS_OF, () => true);
    expect(plan.remove).toMatchObject([
      { id: id(5), rule: "compact-derived-diff" },
    ]);
    expect(plan.keep.map((item) => item.id)).toEqual([
      id(1),
      id(2),
      id(3),
      id(4),
    ]);
    expect(plan.keep.find((item) => item.id === id(2))?.reasons).toContain(
      "hold",
    );
    expect(plan).toEqual(
      planHistoryRetention(
        [...records].reverse(),
        retention,
        AS_OF,
        () => true,
      ),
    );
  });

  it("rejects malformed policies", () => {
    expect(() => policy({ rules: [{ id: "x", kind: "snapshot" }] })).toThrow();
    expect(() =>
      policy({
        rules: [],
        holds: [{ id: id(1), revision: "a", owner: "o", reason: "r" }],
      }),
    ).toThrow();
    expect(() =>
      policy({
        rules: [
          { id: "x", kind: "snapshot", keepLast: 1 },
          { id: "x", kind: "diff", keepLast: 1 },
        ],
      }),
    ).toThrow();
  });
});

describe("history retention policy schema", () => {
  it("accepts what the parser accepts and rejects a hold with two targets", () => {
    const validate = createAjv({ allErrors: true }).compile(
      JSON.parse(
        readFileSync(
          resolve(
            import.meta.dirname,
            "../../schema/history-retention.v0.1.schema.json",
          ),
          "utf8",
        ),
      ) as object,
    );
    const valid = {
      schemaVersion: 1,
      contract: "cartograph.history-retention",
      classifications: [{ revision: "a", classification: "restricted" }],
      rules: [{ id: "year", kind: "snapshot", maxAgeDays: 365 }],
      holds: [{ id: id(1), owner: "legal", reason: "audit", until: AS_OF }],
      compactDerivedDiffs: true,
    };
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    expect(() => parseHistoryRetentionPolicy(valid)).not.toThrow();
    const invalid = {
      ...valid,
      holds: [{ id: id(1), revision: "a", owner: "o", reason: "r" }],
    };
    expect(validate(invalid)).toBe(false);
    expect(() => parseHistoryRetentionPolicy(invalid)).toThrow();
  });
});
