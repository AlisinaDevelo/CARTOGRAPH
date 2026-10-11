import { z } from "zod";

import {
  HISTORY_RECORD_KINDS,
  type HistoryRecordKind,
} from "./history-store.js";

export const HISTORY_RETENTION_SCHEMA_VERSION = 1 as const;
export const HISTORY_RETENTION_CONTRACT =
  "cartograph.history-retention" as const;
export const HISTORY_CLASSIFICATIONS = [
  "public",
  "internal",
  "restricted",
] as const;
export type HistoryClassification = (typeof HISTORY_CLASSIFICATIONS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const RevisionSchema = z.string().min(1).max(128);
const TextSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !/[\0\r\n]/u.test(value), "must be a single line");
const DateTimeSchema = z.string().datetime({ offset: true });

const SelectorShape = {
  id: DigestSchema.optional(),
  revision: RevisionSchema.optional(),
};
const hasTarget = (value: {
  id?: string | undefined;
  revision?: string | undefined;
}): boolean => (value.id === undefined) !== (value.revision === undefined);

export const HistoryRetentionPolicySchema = z
  .object({
    schemaVersion: z.literal(HISTORY_RETENTION_SCHEMA_VERSION),
    contract: z.literal(HISTORY_RETENTION_CONTRACT),
    // Records without a classification are treated as `internal`.
    classifications: z
      .array(
        z
          .object({
            ...SelectorShape,
            classification: z.enum(HISTORY_CLASSIFICATIONS),
          })
          .strict()
          .refine(hasTarget, "give exactly one of id or revision"),
      )
      .max(10_000)
      .default([]),
    rules: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u, "must be a short slug"),
            kind: z.enum(HISTORY_RECORD_KINDS),
            classification: z.enum(HISTORY_CLASSIFICATIONS).optional(),
            maxAgeDays: z.number().int().positive().max(36_500).optional(),
            keepLast: z.number().int().nonnegative().max(100_000).optional(),
          })
          .strict()
          .refine(
            (rule) =>
              rule.maxAgeDays !== undefined || rule.keepLast !== undefined,
            "a rule needs maxAgeDays or keepLast",
          ),
      )
      .max(256),
    holds: z
      .array(
        z
          .object({
            ...SelectorShape,
            owner: TextSchema,
            reason: TextSchema,
            until: DateTimeSchema.optional(),
          })
          .strict()
          .refine(hasTarget, "give exactly one of id or revision"),
      )
      .max(10_000)
      .default([]),
    // Drop stored diffs that the retained snapshots reproduce byte for byte.
    compactDerivedDiffs: z.boolean().default(false),
  })
  .strict()
  .superRefine((policy, context) => {
    const ids = new Set<string>();
    policy.rules.forEach((rule, index) => {
      if (ids.has(rule.id))
        context.addIssue({
          code: "custom",
          path: ["rules", index, "id"],
          message: `duplicate rule id ${rule.id}`,
        });
      ids.add(rule.id);
    });
  });
export type HistoryRetentionPolicy = z.infer<
  typeof HistoryRetentionPolicySchema
>;

export const parseHistoryRetentionPolicy = (
  value: unknown,
): HistoryRetentionPolicy => HistoryRetentionPolicySchema.parse(value);

export type RetentionRecord = {
  id: string;
  kind: HistoryRecordKind;
  revision?: string;
  references: readonly string[];
  /** When the evidence was produced; only snapshots and diffs carry one. */
  date?: string;
};

export type RetentionKeepReason =
  | "no-rule"
  | "within-rule"
  | "undated"
  | "hold"
  | "referenced"
  | "not-reproducible";

export type RetentionPlan = {
  asOf: string;
  keep: {
    id: string;
    kind: HistoryRecordKind;
    reasons: RetentionKeepReason[];
  }[];
  remove: {
    id: string;
    kind: HistoryRecordKind;
    revision?: string;
    rule: string;
  }[];
};

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Decide which records a policy removes at `asOf`. Removal is only ever
 * proposed by a rule, and is withdrawn for anything held or still referenced
 * by a record that stays, so applying the plan never breaks retained
 * evidence. `reproducible` answers whether a diff can be regenerated from
 * the retained snapshots it references; diffs are compacted only when it can.
 */
export const planHistoryRetention = (
  records: readonly RetentionRecord[],
  policy: HistoryRetentionPolicy,
  asOf: string,
  reproducible: (diff: RetentionRecord) => boolean = () => false,
): RetentionPlan => {
  const now = Date.parse(DateTimeSchema.parse(asOf));
  const classificationOf = (record: RetentionRecord): HistoryClassification =>
    policy.classifications.find(
      (item) =>
        item.id === record.id ||
        (item.revision !== undefined && item.revision === record.revision),
    )?.classification ?? "internal";
  const held = (record: RetentionRecord): boolean =>
    policy.holds.some(
      (hold) =>
        (hold.id === record.id ||
          (hold.revision !== undefined && hold.revision === record.revision)) &&
        (hold.until === undefined || now <= Date.parse(hold.until)),
    );

  const reasons = new Map<string, Set<RetentionKeepReason>>(
    records.map((record) => [record.id, new Set()]),
  );
  const removal = new Map<string, string>();
  for (const record of records) {
    const rules = policy.rules.filter(
      (rule) =>
        rule.kind === record.kind &&
        (rule.classification === undefined ||
          rule.classification === classificationOf(record)),
    );
    if (rules.length === 0) {
      reasons.get(record.id)?.add("no-rule");
      continue;
    }
    if (record.date === undefined) {
      reasons.get(record.id)?.add("undated");
      continue;
    }
    const date = record.date;
    for (const rule of rules) {
      const peers = records
        .filter(
          (other) =>
            other.kind === record.kind &&
            other.date !== undefined &&
            (rule.classification === undefined ||
              classificationOf(other) === rule.classification),
        )
        .sort(
          (left, right) =>
            Date.parse(right.date as string) -
              Date.parse(left.date as string) || compare(left.id, right.id),
        );
      const rank = peers.findIndex((other) => other.id === record.id);
      const tooOld =
        rule.maxAgeDays !== undefined &&
        now - Date.parse(date) > rule.maxAgeDays * DAY_MS;
      const beyondKeep = rule.keepLast !== undefined && rank >= rule.keepLast;
      if (tooOld || beyondKeep) {
        if (!removal.has(record.id)) removal.set(record.id, rule.id);
      } else reasons.get(record.id)?.add("within-rule");
    }
    // Any rule that keeps a record wins over one that removes it.
    if (reasons.get(record.id)?.has("within-rule")) removal.delete(record.id);
  }

  if (policy.compactDerivedDiffs)
    for (const record of records)
      if (record.kind === "diff" && !removal.has(record.id)) {
        if (reproducible(record))
          removal.set(record.id, "compact-derived-diff");
        else reasons.get(record.id)?.add("not-reproducible");
      }

  for (const record of records)
    if (removal.has(record.id) && held(record)) {
      removal.delete(record.id);
      reasons.get(record.id)?.add("hold");
    }

  // Withdraw removals until both retained references and compaction agree.
  for (let changed = true; changed;) {
    changed = false;
    const retained = records.filter((record) => !removal.has(record.id));
    const referenced = new Set(retained.flatMap((record) => record.references));
    for (const record of records) {
      if (!removal.has(record.id)) continue;
      const isReferenced =
        referenced.has(`record:${record.id}`) ||
        (record.kind === "snapshot" &&
          record.revision !== undefined &&
          referenced.has(`revision:${record.revision}`));
      if (isReferenced) {
        removal.delete(record.id);
        reasons.get(record.id)?.add("referenced");
        changed = true;
      }
    }

    // A reinstated diff pins its evidence on the next reference pass.
    for (const record of records)
      if (
        removal.get(record.id) === "compact-derived-diff" &&
        record.references.some((reference) => {
          const revision = reference.slice("revision:".length);
          return !records.some(
            (other) =>
              other.kind === "snapshot" &&
              other.revision === revision &&
              !removal.has(other.id),
          );
        })
      ) {
        removal.delete(record.id);
        reasons.get(record.id)?.add("not-reproducible");
        changed = true;
      }
  }

  const byId = new Map(records.map((record) => [record.id, record]));
  return {
    asOf,
    keep: records
      .filter((record) => !removal.has(record.id))
      .map((record) => ({
        id: record.id,
        kind: record.kind,
        reasons: [...(reasons.get(record.id) ?? [])].sort(compare),
      }))
      .sort((left, right) => compare(left.id, right.id)),
    remove: [...removal]
      .map(([id, rule]) => {
        const record = byId.get(id) as RetentionRecord;
        return {
          id,
          kind: record.kind,
          ...(record.revision === undefined
            ? {}
            : { revision: record.revision }),
          rule,
        };
      })
      .sort((left, right) => compare(left.id, right.id)),
  };
};
