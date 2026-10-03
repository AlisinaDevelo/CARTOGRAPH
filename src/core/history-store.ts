import { createHash } from "node:crypto";

import { z } from "zod";

import { parseAdrReferenceDocument } from "./adr.js";
import { parseArchitectureWaiver } from "./architecture-waivers.js";
import { canonicalizeGraphSnapshot, stableStringify } from "./canonical.js";
import { parseGraphDiff } from "./diff.js";
import { parseFindingLifecycleInput } from "./finding-lifecycle.js";
import { migrateGraphSnapshot } from "./migrations.js";
import { parseOwnershipReport } from "./ownership.js";
import { parsePolicyConfig } from "./policy.js";
import { parseWorkspaceCompositionManifest } from "./workspace-composition.js";

export const HISTORY_STORE_SCHEMA_VERSION = 1 as const;
export const HISTORY_STORE_CONTRACT = "cartograph.history-store" as const;
export const HISTORY_RECORD_CONTRACT = "cartograph.history-record" as const;
export const HISTORY_RECORD_MAX_BYTES = 64 * 1024 * 1024;

export const HISTORY_RECORD_KINDS = [
  "snapshot",
  "diff",
  "policy",
  "decisions",
  "finding-lifecycle",
  "workspace-composition",
  "provenance",
  "waiver",
  "ownership",
] as const;
export type HistoryRecordKind = (typeof HISTORY_RECORD_KINDS)[number];

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const ProvenanceSchema = z
  .object({
    toolName: z.literal("cartograph-cli"),
    toolVersion: z.string().min(1).max(64),
    analyzerFingerprint: DigestSchema,
  })
  .strict();

const ReferenceSchema = z
  .string()
  .regex(/^(?:revision:[0-9a-zA-Z._-]{1,128}|record:[0-9a-f]{64})$/u);

export const HistoryRecordSchema = z
  .object({
    schemaVersion: z.literal(HISTORY_STORE_SCHEMA_VERSION),
    contract: z.literal(HISTORY_RECORD_CONTRACT),
    kind: z.enum(HISTORY_RECORD_KINDS),
    recordSchemaVersion: z.number().int().nonnegative(),
    // Present only when the input was migrated from an older contract.
    migratedFrom: z.number().int().nonnegative().optional(),
    revision: z.string().min(1).max(128).optional(),
    references: z.array(ReferenceSchema).max(64),
    body: z.unknown(),
  })
  .strict();
export type HistoryRecord = z.infer<typeof HistoryRecordSchema>;

export const HistoryIndexEntrySchema = z
  .object({
    id: DigestSchema,
    kind: z.enum(HISTORY_RECORD_KINDS),
    recordSchemaVersion: z.number().int().nonnegative(),
    migratedFrom: z.number().int().nonnegative().optional(),
    revision: z.string().min(1).max(128).optional(),
    references: z.array(ReferenceSchema).max(64),
  })
  .strict();
export type HistoryIndexEntry = z.infer<typeof HistoryIndexEntrySchema>;

export const HistoryIndexSchema = z
  .object({
    schemaVersion: z.literal(HISTORY_STORE_SCHEMA_VERSION),
    contract: z.literal(HISTORY_STORE_CONTRACT),
    records: z.array(HistoryIndexEntrySchema),
  })
  .strict();
export type HistoryIndex = z.infer<typeof HistoryIndexSchema>;

export class HistoryStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryStoreError";
  }
}

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const schemaVersionOf = (value: unknown): number => {
  const version =
    value && typeof value === "object" && "schemaVersion" in value
      ? value.schemaVersion
      : undefined;
  return typeof version === "number" &&
    Number.isInteger(version) &&
    version >= 0
    ? version
    : 1;
};

const contractErrorText = (error: unknown): string => {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (issue !== undefined)
      return `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`;
  }
  const cause =
    error instanceof Error && "cause" in error ? error.cause : undefined;
  if (cause instanceof z.ZodError) return contractErrorText(cause);
  return error instanceof Error
    ? (error.message.split("\n")[0] ?? "invalid")
    : "invalid";
};

/**
 * Validate and canonicalize one input as a history record. Legacy (v0)
 * snapshots are migrated to the current contract on import, so the store
 * only ever holds current-version bodies.
 */
export const createHistoryRecord = (
  kind: HistoryRecordKind,
  value: unknown,
  /** Keep the migration marker of a stored record whose body is already migrated. */
  stored?: { migratedFrom?: number | undefined },
): HistoryRecord => {
  const invalid = (error: unknown): never => {
    throw new HistoryStoreError(
      `${kind} input does not match its contract: ${contractErrorText(error)}`,
    );
  };
  let body: unknown;
  let revision: string | undefined;
  let references: string[] = [];
  let migratedFrom = stored?.migratedFrom;
  try {
    switch (kind) {
      case "snapshot": {
        const legacy = schemaVersionOf(value) === 0;
        if (legacy) migratedFrom = 0;
        const snapshot = legacy
          ? migrateGraphSnapshot(value).snapshot
          : canonicalizeGraphSnapshot(value);
        body = snapshot;
        revision = snapshot.revision.commitSha;
        break;
      }
      case "diff": {
        const diff = parseGraphDiff(value);
        body = diff;
        revision = diff.toRevision.commitSha;
        references = [
          `revision:${diff.fromRevision.commitSha}`,
          `revision:${diff.toRevision.commitSha}`,
        ];
        break;
      }
      case "policy":
        body = parsePolicyConfig(value);
        break;
      case "decisions":
        body = parseAdrReferenceDocument(value);
        break;
      case "finding-lifecycle":
        body = parseFindingLifecycleInput(value);
        break;
      case "workspace-composition":
        body = parseWorkspaceCompositionManifest(value);
        break;
      case "provenance":
        body = ProvenanceSchema.parse(value);
        break;
      case "waiver":
        body = parseArchitectureWaiver(value);
        break;
      case "ownership":
        body = parseOwnershipReport(value);
        break;
    }
  } catch (error) {
    if (error instanceof HistoryStoreError) throw error;
    invalid(error);
  }
  return HistoryRecordSchema.parse({
    schemaVersion: HISTORY_STORE_SCHEMA_VERSION,
    contract: HISTORY_RECORD_CONTRACT,
    kind,
    recordSchemaVersion: schemaVersionOf(body),
    ...(migratedFrom === undefined ? {} : { migratedFrom }),
    ...(revision === undefined ? {} : { revision }),
    references: [...new Set(references)].sort(compare),
    body,
  });
};

/** Canonical bytes and content address of a record. */
export const serializeHistoryRecord = (
  record: HistoryRecord,
): { id: string; text: string } => {
  const text = `${stableStringify(record)}\n`;
  if (Buffer.byteLength(text, "utf8") > HISTORY_RECORD_MAX_BYTES)
    throw new HistoryStoreError(
      `${record.kind} record exceeds the ${HISTORY_RECORD_MAX_BYTES} byte ceiling`,
    );
  return { id: sha256(text), text };
};

export const historyIndexEntry = (
  id: string,
  record: HistoryRecord,
): HistoryIndexEntry => ({
  id,
  kind: record.kind,
  recordSchemaVersion: record.recordSchemaVersion,
  ...(record.migratedFrom === undefined
    ? {}
    : { migratedFrom: record.migratedFrom }),
  ...(record.revision === undefined ? {} : { revision: record.revision }),
  references: record.references,
});

/** The index is derived: it can always be rebuilt from the objects. */
export const buildHistoryIndex = (
  entries: readonly HistoryIndexEntry[],
): { index: HistoryIndex; text: string } => {
  const index = HistoryIndexSchema.parse({
    schemaVersion: HISTORY_STORE_SCHEMA_VERSION,
    contract: HISTORY_STORE_CONTRACT,
    records: [...entries].sort((left, right) => compare(left.id, right.id)),
  });
  return { index, text: `${stableStringify(index)}\n` };
};

export type HistoryObjectCheck =
  | { id: string; status: "ok"; record: HistoryRecord }
  | { id: string; status: "corrupt"; reason: string };

/**
 * Check one stored object: its name must be the digest of its bytes, its
 * bytes must be the canonical form of a valid record, and its body must still
 * satisfy its contract.
 */
export const checkHistoryObject = (
  id: string,
  content: Uint8Array,
): HistoryObjectCheck => {
  if (sha256(content) !== id)
    return {
      id,
      status: "corrupt",
      reason: "content digest does not match its name",
    };
  let record: HistoryRecord;
  try {
    record = HistoryRecordSchema.parse(
      JSON.parse(Buffer.from(content).toString("utf8")) as unknown,
    );
  } catch {
    return { id, status: "corrupt", reason: "not a valid history record" };
  }
  try {
    const canonical = serializeHistoryRecord(
      createHistoryRecord(record.kind, record.body, record),
    );
    if (canonical.id !== id)
      return {
        id,
        status: "corrupt",
        reason: "record is not in canonical form for its contract",
      };
  } catch (error) {
    return {
      id,
      status: "corrupt",
      reason: error instanceof Error ? error.message : "invalid record body",
    };
  }
  return { id, status: "ok", record };
};

export type HistoryVerification = {
  ok: boolean;
  records: number;
  corrupt: { id: string; reason: string }[];
  missing: string[];
  unindexed: string[];
  unresolvedReferences: { id: string; reference: string }[];
  problems: string[];
};

/**
 * Compare the objects on disk with the index. Corrupt, missing, and unindexed
 * records fail verification; references to revisions whose snapshot was never
 * imported are reported but are not failures (a store may hold only diffs).
 */
export const verifyHistoryStore = (
  indexText: string | undefined,
  objects: ReadonlyMap<string, Uint8Array>,
): HistoryVerification => {
  const problems: string[] = [];
  let index: HistoryIndex | undefined;
  if (indexText === undefined) problems.push("index.json is missing");
  else
    try {
      index = HistoryIndexSchema.parse(JSON.parse(indexText) as unknown);
    } catch {
      problems.push("index.json is not a valid history index");
    }
  const checks = [...objects].map(([id, content]) =>
    checkHistoryObject(id, content),
  );
  const corrupt = checks.flatMap((check) =>
    check.status === "corrupt" ? [{ id: check.id, reason: check.reason }] : [],
  );
  const indexed = new Set(index?.records.map((entry) => entry.id) ?? []);
  const missing = [...indexed].filter((id) => !objects.has(id)).sort(compare);
  const unindexed = index
    ? [...objects.keys()].filter((id) => !indexed.has(id)).sort(compare)
    : [];
  const valid = checks.flatMap((check) =>
    check.status === "ok" ? [check] : [],
  );
  if (index !== undefined) {
    const rebuilt = buildHistoryIndex(
      valid
        .filter((check) => indexed.has(check.id))
        .map((check) => historyIndexEntry(check.id, check.record)),
    );
    const listed = index.records.filter((entry) => objects.has(entry.id));
    for (const entry of listed) {
      const expected = rebuilt.index.records.find(
        (item) => item.id === entry.id,
      );
      if (
        expected !== undefined &&
        stableStringify(expected) !== stableStringify(entry)
      )
        problems.push(`index entry ${entry.id} does not describe its record`);
    }
  }
  const revisions = new Set(
    valid.flatMap((check) =>
      check.record.kind === "snapshot" && check.record.revision !== undefined
        ? [check.record.revision]
        : [],
    ),
  );
  const ids = new Set(valid.map((check) => check.id));
  const unresolvedReferences = valid
    .flatMap((check) =>
      check.record.references
        .filter((reference) =>
          reference.startsWith("revision:")
            ? !revisions.has(reference.slice("revision:".length))
            : !ids.has(reference.slice("record:".length)),
        )
        .map((reference) => ({ id: check.id, reference })),
    )
    .sort((left, right) =>
      compare(left.id + left.reference, right.id + right.reference),
    );
  return {
    ok:
      problems.length === 0 &&
      corrupt.length === 0 &&
      missing.length === 0 &&
      unindexed.length === 0,
    records: objects.size,
    corrupt,
    missing,
    unindexed,
    unresolvedReferences,
    problems,
  };
};
