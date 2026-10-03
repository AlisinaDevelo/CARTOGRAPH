import { constants, readdirSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  HISTORY_RECORD_KINDS,
  HISTORY_RECORD_MAX_BYTES,
  HistoryStoreError,
  buildHistoryIndex,
  checkHistoryObject,
  createHistoryRecord,
  historyIndexEntry,
  serializeHistoryRecord,
  stableStringify,
  verifyHistoryStore,
  HistoryIndexSchema,
  computeTrendMetrics,
  parseTrendExplanations,
  parseTrendMetricsReport,
  parseAdrReferenceDocument,
  parseGraphSnapshot,
  parsePolicyConfig,
  diffGraphSnapshots,
  parseGraphDiff,
  parseHistoryRetentionPolicy,
  planHistoryRetention,
  redactArtifactForSharing,
  SHARING_PROFILES,
  type RetentionPlan,
  type RetentionRecord,
  type HistoryIndexEntry,
  type HistoryRecord,
  type TrendMetricsReport,
  type TrendRevisionInput,
  type HistoryRecordKind,
  type HistoryVerification,
} from "./core/index.js";
import { analyzerFingerprint } from "./scan-cache.js";

export const DEFAULT_HISTORY_STORE = ".cartograph/history";
const OBJECT_NAME = /^[0-9a-f]{64}\.json$/u;

const kindOf = (value: string): HistoryRecordKind => {
  const kind = HISTORY_RECORD_KINDS.find((candidate) => candidate === value);
  if (kind === undefined)
    throw new HistoryStoreError(
      `unknown record kind ${JSON.stringify(value)}; expected one of ${HISTORY_RECORD_KINDS.join(", ")}`,
    );
  return kind;
};

const objectPath = (store: string, id: string): string =>
  join(store, "objects", id.slice(0, 2), `${id}.json`);

const tombstonePath = (store: string, id: string): string =>
  join(store, "tombstones", `${id}.json`);

const tombstoned = (store: string): Set<string> => {
  try {
    return new Set(
      readdirSync(join(store, "tombstones"))
        .filter((name) => OBJECT_NAME.test(name))
        .map((name) => name.slice(0, -".json".length)),
    );
  } catch {
    return new Set();
  }
};

/** Revisions whose snapshot a retention policy removed. */
const tombstonedRevisions = (store: string): Set<string> => {
  const revisions = new Set<string>();
  for (const id of tombstoned(store)) {
    try {
      const value = JSON.parse(
        readFileSync(tombstonePath(store, id), "utf8"),
      ) as { kind?: unknown; revision?: unknown };
      if (value.kind === "snapshot" && typeof value.revision === "string")
        revisions.add(value.revision);
    } catch {
      // An unreadable tombstone says nothing about a revision.
    }
  }
  return revisions;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

/** Write through a temporary file and rename, so readers never see a partial file. */
const writeAtomic = async (path: string, content: string): Promise<void> => {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

/** Exclusive store lock; a leftover lock means an interrupted writer. */
const withLock = async <T>(
  store: string,
  run: () => Promise<T>,
): Promise<T> => {
  await mkdir(store, { recursive: true, mode: 0o700 });
  const lockPath = join(store, "lock");
  let handle;
  try {
    handle = await open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
  } catch {
    throw new HistoryStoreError(
      "history store is locked by another import; if none is running, run `cartograph history repair` to clear the stale lock",
    );
  }
  await handle.close();
  try {
    return await run();
  } finally {
    await rm(lockPath, { force: true });
  }
};

const readObjects = async (
  store: string,
): Promise<{ objects: Map<string, Uint8Array>; leftovers: string[] }> => {
  const objects = new Map<string, Uint8Array>();
  const leftovers: string[] = [];
  const root = join(store, "objects");
  if (!(await exists(root))) return { objects, leftovers };
  for (const prefix of readdirSync(root, { withFileTypes: true })) {
    if (!prefix.isDirectory()) {
      leftovers.push(join("objects", prefix.name));
      continue;
    }
    for (const entry of readdirSync(join(root, prefix.name), {
      withFileTypes: true,
    })) {
      const relativePath = join("objects", prefix.name, entry.name);
      if (!entry.isFile() || !OBJECT_NAME.test(entry.name)) {
        leftovers.push(relativePath);
        continue;
      }
      const path = join(root, prefix.name, entry.name);
      const metadata = await lstat(path);
      if (metadata.size > HISTORY_RECORD_MAX_BYTES + 1024) {
        leftovers.push(relativePath);
        continue;
      }
      objects.set(entry.name.slice(0, -".json".length), await readFile(path));
    }
  }
  return { objects, leftovers: leftovers.sort() };
};

const readIndexEntries = async (
  store: string,
): Promise<HistoryIndexEntry[]> => {
  const path = join(store, "index.json");
  if (!(await exists(path))) return [];
  try {
    return HistoryIndexSchema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    ).records;
  } catch {
    throw new HistoryStoreError(
      "index.json is invalid; run `cartograph history repair` to rebuild it",
    );
  }
};

export type HistoryImportResult = {
  imported: { id: string; kind: HistoryRecordKind; existing: boolean }[];
  records: number;
  /** Revisions with more than one distinct stored snapshot after this import. */
  conflicts: { revision: string; ids: string[] }[];
};

/** Refuse a store whose root or object directories are symbolic links. */
const assertRealDirectories = async (store: string): Promise<void> => {
  for (const path of [store, join(store, "objects")]) {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch {
      continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      throw new HistoryStoreError(
        "history store paths must be real directories, not symbolic links",
      );
  }
};

/**
 * Validate, canonicalize, and store records. Existing records are
 * deduplicated by content address; a provenance record for the running
 * analyzer build is stored alongside each import.
 */
export async function importHistoryRecords(options: {
  store: string;
  inputs: readonly { kind: string; path: string }[];
  toolVersion: string;
}): Promise<HistoryImportResult> {
  const store = resolve(options.store);
  const records = await Promise.all(
    options.inputs.map(async (input) => {
      const kind = kindOf(input.kind);
      const metadata = await lstat(resolve(input.path));
      if (!metadata.isFile() || metadata.size > HISTORY_RECORD_MAX_BYTES)
        throw new HistoryStoreError(
          `history input is not a regular file under the size ceiling: ${input.path}`,
        );
      let value: unknown;
      try {
        value = JSON.parse(
          await readFile(resolve(input.path), "utf8"),
        ) as unknown;
      } catch {
        throw new HistoryStoreError(
          `history input is not valid JSON: ${input.path}`,
        );
      }
      return createHistoryRecord(kind, value);
    }),
  );
  records.push(
    createHistoryRecord("provenance", {
      toolName: "cartograph-cli",
      toolVersion: options.toolVersion,
      analyzerFingerprint: analyzerFingerprint(),
    }),
  );
  await assertRealDirectories(store);
  return await withLock(store, async () => {
    const entries = new Map(
      (await readIndexEntries(store)).map((entry) => [entry.id, entry]),
    );
    const imported: HistoryImportResult["imported"] = [];
    for (const record of records) {
      const { id, text } = serializeHistoryRecord(record);
      const path = objectPath(store, id);
      const existing = await exists(path);
      if (existing) {
        // Deduplication must not vouch for an object it has not read.
        const metadata = await lstat(path);
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          (await readFile(path, "utf8")) !== text
        )
          throw new HistoryStoreError(
            `stored object ${id} does not match its content; run \`cartograph history repair\``,
          );
      } else {
        await mkdir(join(store, "objects", id.slice(0, 2)), {
          recursive: true,
          mode: 0o700,
        });
        await writeAtomic(path, text);
        // An explicit re-import restores a record that retention removed.
        await rm(tombstonePath(store, id), { force: true });
      }
      entries.set(id, historyIndexEntry(id, record));
      imported.push({ id, kind: record.kind, existing });
    }
    const { index, text } = buildHistoryIndex([...entries.values()]);
    await writeAtomic(join(store, "index.json"), text);
    const snapshots = new Map<string, string[]>();
    for (const entry of index.records)
      if (entry.kind === "snapshot" && entry.revision !== undefined)
        snapshots.set(entry.revision, [
          ...(snapshots.get(entry.revision) ?? []),
          entry.id,
        ]);
    const conflicts = [...snapshots]
      .filter(([, ids]) => ids.length > 1)
      .map(([revision, ids]) => ({ revision, ids }))
      .sort((left, right) => (left.revision < right.revision ? -1 : 1));
    return { imported, records: index.records.length, conflicts };
  });
}

export async function listHistoryRecords(options: {
  store: string;
  kind?: string;
  revision?: string;
}): Promise<HistoryIndexEntry[]> {
  const kind = options.kind === undefined ? undefined : kindOf(options.kind);
  return (await readIndexEntries(resolve(options.store))).filter(
    (entry) =>
      (kind === undefined || entry.kind === kind) &&
      (options.revision === undefined ||
        entry.revision === options.revision ||
        entry.references.includes(`revision:${options.revision}`)),
  );
}

export async function verifyHistory(
  storePath: string,
): Promise<HistoryVerification & { leftovers: string[] }> {
  const store = resolve(storePath);
  const { objects, leftovers } = await readObjects(store);
  const indexPath = join(store, "index.json");
  const indexText = (await exists(indexPath))
    ? await readFile(indexPath, "utf8")
    : undefined;
  const report = verifyHistoryStore(indexText, objects);
  return { ...report, ok: report.ok && leftovers.length === 0, leftovers };
}

/**
 * Recover a damaged store: move corrupt objects to quarantine/, remove
 * leftover temporary files and a stale lock, and rebuild the index from the
 * valid objects. Nothing valid is deleted.
 */
export async function repairHistory(storePath: string): Promise<{
  records: number;
  quarantined: string[];
  removedLeftovers: string[];
}> {
  const store = resolve(storePath);
  await rm(join(store, "lock"), { force: true });
  return await withLock(store, async () => {
    const { objects, leftovers } = await readObjects(store);
    const quarantined: string[] = [];
    const entries: HistoryIndexEntry[] = [];
    const removed = tombstoned(store);
    for (const [id, content] of objects) {
      if (removed.has(id)) {
        // An interrupted gc: finish removing what it already tombstoned.
        await rm(objectPath(store, id), { force: true });
        continue;
      }
      const check = checkHistoryObject(id, content);
      if (check.status === "ok") {
        entries.push(historyIndexEntry(id, check.record));
        continue;
      }
      await mkdir(join(store, "quarantine"), { recursive: true, mode: 0o700 });
      await rename(
        objectPath(store, id),
        join(store, "quarantine", `${id}.json`),
      );
      quarantined.push(id);
    }
    for (const leftover of leftovers)
      await rm(join(store, leftover), { force: true, recursive: true });
    const { index, text } = buildHistoryIndex(entries);
    await writeAtomic(join(store, "index.json"), text);
    return {
      records: index.records.length,
      quarantined: quarantined.sort(),
      removedLeftovers: leftovers,
    };
  });
}

/** Write selected records' bodies as standalone contract documents. */
export async function exportHistoryRecords(options: {
  store: string;
  output: string;
  revision?: string;
  ids?: readonly string[];
  kinds?: readonly string[];
  /** Redact values unsafe for this recipient profile; fail if that breaks a contract. */
  profile?: string;
}): Promise<{ exported: string[]; redactions: number }> {
  const store = resolve(options.store);
  const kinds = options.kinds?.map(kindOf);
  const profile =
    options.profile === undefined
      ? undefined
      : SHARING_PROFILES.find((candidate) => candidate === options.profile);
  if (options.profile !== undefined && profile === undefined)
    throw new HistoryStoreError(
      `unknown sharing profile ${JSON.stringify(options.profile)}; expected one of ${SHARING_PROFILES.join(", ")}`,
    );
  const entries = (await readIndexEntries(store)).filter(
    (entry) =>
      (options.ids === undefined || options.ids.includes(entry.id)) &&
      (kinds === undefined || kinds.includes(entry.kind)) &&
      (options.revision === undefined ||
        entry.revision === options.revision ||
        entry.references.includes(`revision:${options.revision}`)),
  );
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });
  if (readdirSync(output).length > 0)
    throw new HistoryStoreError(
      `export directory is not empty: ${options.output}`,
    );
  const exported: string[] = [];
  let redactions = 0;
  for (const entry of entries) {
    const check = checkHistoryObject(
      entry.id,
      await readFile(objectPath(store, entry.id)),
    );
    if (check.status !== "ok")
      throw new HistoryStoreError(
        `record ${entry.id} is corrupt: ${check.reason}`,
      );
    let body = check.record.body;
    if (profile !== undefined) {
      const redacted = redactArtifactForSharing(
        {
          path: entry.id,
          role: "manifest",
          content: Buffer.from(stableStringify(body), "utf8"),
        },
        { profile },
      );
      redactions += redacted.redactions;
      body = JSON.parse(redacted.content) as unknown;
      try {
        // Canonicalization must not change the redacted body, or redaction
        // has merged or reordered evidence (for example two IDs that redact
        // to the same value).
        const canonical = createHistoryRecord(entry.kind, body).body;
        if (stableStringify(canonical) !== stableStringify(body))
          throw new HistoryStoreError("redaction changed the record's shape");
      } catch {
        throw new HistoryStoreError(
          `${entry.kind} record ${entry.id} no longer satisfies its contract after redaction; nothing was exported for it`,
        );
      }
    }
    const name = `${entry.kind}-${entry.id.slice(0, 12)}.json`;
    await writeAtomic(join(output, name), `${stableStringify(body)}\n`);
    exported.push(name);
  }
  return { exported: exported.sort(), redactions };
}

const readRecord = async (
  store: string,
  entry: HistoryIndexEntry,
): Promise<HistoryRecord> => {
  const check = checkHistoryObject(
    entry.id,
    await readFile(objectPath(store, entry.id)),
  );
  if (check.status !== "ok")
    throw new HistoryStoreError(
      `record ${entry.id} is corrupt: ${check.reason}`,
    );
  return check.record;
};

/**
 * Trend metrics over an ordered list of revisions, recomputed from the
 * stored snapshots. One policy and one decisions record, when given, are
 * applied to every revision so the trend measures the code, not a changing
 * rule set. A revision with no stored snapshot is reported as missing.
 */
export async function historyTrends(options: {
  store: string;
  revisions: readonly string[];
  policyRecord?: string;
  decisionsRecord?: string;
  /** Per-revision overrides: a different policy or decisions record from that revision on. */
  policyAt?: readonly { revision: string; id: string }[];
  decisionsAt?: readonly { revision: string; id: string }[];
  previous?: string;
  explanations?: string;
}): Promise<TrendMetricsReport> {
  const store = resolve(options.store);
  const entries = await readIndexEntries(store);
  const removed = tombstonedRevisions(store);
  const byId = (id: string, kind: HistoryRecordKind): HistoryIndexEntry => {
    const entry = entries.find(
      (candidate) => candidate.id === id && candidate.kind === kind,
    );
    if (entry === undefined)
      throw new HistoryStoreError(`no ${kind} record ${id} in the store`);
    return entry;
  };
  const loadPolicy = async (id: string) =>
    parsePolicyConfig((await readRecord(store, byId(id, "policy"))).body);
  const loadDecisions = async (id: string) =>
    parseAdrReferenceDocument(
      (await readRecord(store, byId(id, "decisions"))).body,
    );
  for (const item of [
    ...(options.policyAt ?? []),
    ...(options.decisionsAt ?? []),
  ])
    if (!options.revisions.includes(item.revision))
      throw new HistoryStoreError(
        `override names revision ${item.revision}, which is not in --revision`,
      );
  const readJson = async (path: string, label: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
    } catch {
      throw new HistoryStoreError(`${label} is not readable JSON: ${path}`);
    }
  };
  const previous =
    options.previous === undefined
      ? undefined
      : parseTrendMetricsReport(
          await readJson(options.previous, "previous trends report"),
        );
  const explanations =
    options.explanations === undefined
      ? undefined
      : parseTrendExplanations(
          await readJson(options.explanations, "explanations"),
        );

  let policyId = options.policyRecord;
  let decisionsId = options.decisionsRecord;
  const inputs: TrendRevisionInput[] = [];
  for (const revision of options.revisions) {
    policyId =
      options.policyAt?.find((item) => item.revision === revision)?.id ??
      policyId;
    decisionsId =
      options.decisionsAt?.find((item) => item.revision === revision)?.id ??
      decisionsId;
    const matches = entries.filter(
      (entry) => entry.kind === "snapshot" && entry.revision === revision,
    );
    if (matches.length > 1)
      throw new HistoryStoreError(
        `revision ${revision} has ${matches.length} stored snapshots; trends need exactly one`,
      );
    const entry = matches[0];
    if (entry === undefined) {
      inputs.push({
        revision,
        ...(removed.has(revision) ? { removed: true } : {}),
      });
      continue;
    }
    const record = await readRecord(store, entry);
    inputs.push({
      revision,
      snapshot: parseGraphSnapshot(record.body),
      recordId: entry.id,
      recordSchemaVersion: record.recordSchemaVersion,
      ...(record.migratedFrom === undefined
        ? {}
        : { migratedFrom: record.migratedFrom }),
      ...(policyId === undefined
        ? {}
        : { policy: await loadPolicy(policyId), policyRecordId: policyId }),
      ...(decisionsId === undefined
        ? {}
        : {
            decisions: await loadDecisions(decisionsId),
            decisionsRecordId: decisionsId,
          }),
    });
  }
  return computeTrendMetrics(inputs, {
    ...(previous === undefined ? {} : { previous }),
    ...(explanations === undefined ? {} : { explanations }),
  });
}

const recordDate = (record: HistoryRecord): string | undefined => {
  const body = record.body as {
    revision?: { authoredAt?: string };
    toRevision?: { authoredAt?: string };
  };
  return record.kind === "snapshot"
    ? body.revision?.authoredAt
    : record.kind === "diff"
      ? body.toRevision?.authoredAt
      : undefined;
};

export type HistoryGcResult = RetentionPlan & {
  applied: boolean;
  /** Removed records whose object files were confirmed gone. */
  deleted: string[];
  records: number;
};

/**
 * Apply a retention policy. Without `apply` it only reports the plan. With
 * it, each removal is tombstoned first (ID, kind, revision, rule, time), then
 * dropped from the index, then its object is deleted and the deletion
 * checked. Deleted evidence cannot be recovered from the store.
 */
export async function historyGc(options: {
  store: string;
  policy: string;
  asOf: string;
  apply?: boolean;
}): Promise<HistoryGcResult> {
  const store = resolve(options.store);
  await assertRealDirectories(store);
  let policyValue: unknown;
  try {
    policyValue = JSON.parse(await readFile(resolve(options.policy), "utf8"));
  } catch {
    throw new HistoryStoreError(
      `retention policy is not readable JSON: ${options.policy}`,
    );
  }
  const policy = parseHistoryRetentionPolicy(policyValue);
  return await withLock(store, async () => {
    const verification = await verifyHistory(store);
    if (!verification.ok)
      throw new HistoryStoreError(
        "history store does not verify; run `cartograph history repair` before applying retention",
      );
    const entries = await readIndexEntries(store);
    const loaded = new Map<string, HistoryRecord>();
    for (const entry of entries) {
      const check = checkHistoryObject(
        entry.id,
        await readFile(objectPath(store, entry.id)),
      );
      if (check.status !== "ok")
        throw new HistoryStoreError(`record ${entry.id} is corrupt`);
      loaded.set(entry.id, check.record);
    }
    const records: RetentionRecord[] = entries.map((entry) => {
      const date = recordDate(loaded.get(entry.id) as HistoryRecord);
      return {
        id: entry.id,
        kind: entry.kind,
        ...(entry.revision === undefined ? {} : { revision: entry.revision }),
        references: entry.references,
        ...(date === undefined ? {} : { date }),
      };
    });
    const snapshotFor = (revision: string): HistoryRecord | undefined => {
      const matches = entries.filter(
        (entry) => entry.kind === "snapshot" && entry.revision === revision,
      );
      return matches.length === 1
        ? loaded.get((matches[0] as HistoryIndexEntry).id)
        : undefined;
    };
    const reproducible = (diff: RetentionRecord): boolean => {
      const body = parseGraphDiff(loaded.get(diff.id)?.body);
      const before = snapshotFor(body.fromRevision.commitSha);
      const after = snapshotFor(body.toRevision.commitSha);
      if (before === undefined || after === undefined) return false;
      try {
        const regenerated = createHistoryRecord(
          "diff",
          diffGraphSnapshots(
            parseGraphSnapshot(before.body),
            parseGraphSnapshot(after.body),
          ),
        );
        return serializeHistoryRecord(regenerated).id === diff.id;
      } catch {
        return false;
      }
    };
    const plan = planHistoryRetention(
      records,
      policy,
      options.asOf,
      reproducible,
    );
    if (options.apply !== true)
      return { ...plan, applied: false, deleted: [], records: entries.length };

    await mkdir(join(store, "tombstones"), { recursive: true, mode: 0o700 });
    for (const item of plan.remove)
      await writeAtomic(
        tombstonePath(store, item.id),
        `${stableStringify({
          schemaVersion: 1,
          contract: "cartograph.history-tombstone",
          id: item.id,
          kind: item.kind,
          ...(item.revision === undefined ? {} : { revision: item.revision }),
          rule: item.rule,
          removedAt: options.asOf,
        })}\n`,
      );
    const removing = new Set(plan.remove.map((item) => item.id));
    const kept = entries.filter((entry) => !removing.has(entry.id));
    const { text } = buildHistoryIndex(kept);
    await writeAtomic(join(store, "index.json"), text);
    const deleted: string[] = [];
    for (const item of plan.remove) {
      await rm(objectPath(store, item.id), { force: true });
      if (await exists(objectPath(store, item.id)))
        throw new HistoryStoreError(
          `record ${item.id} could not be deleted; it is tombstoned and \`history repair\` will finish removing it`,
        );
      deleted.push(item.id);
    }
    return { ...plan, applied: true, deleted, records: kept.length };
  });
}
