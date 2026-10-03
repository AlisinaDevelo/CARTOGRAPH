import { constants, readdirSync } from "node:fs";
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
  type HistoryIndexEntry,
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
  return await withLock(store, async () => {
    const entries = new Map(
      (await readIndexEntries(store)).map((entry) => [entry.id, entry]),
    );
    const imported: HistoryImportResult["imported"] = [];
    for (const record of records) {
      const { id, text } = serializeHistoryRecord(record);
      const path = objectPath(store, id);
      const existing = await exists(path);
      if (!existing) {
        await mkdir(join(store, "objects", id.slice(0, 2)), {
          recursive: true,
          mode: 0o700,
        });
        await writeAtomic(path, text);
      }
      entries.set(id, historyIndexEntry(id, record));
      imported.push({ id, kind: record.kind, existing });
    }
    const { index, text } = buildHistoryIndex([...entries.values()]);
    await writeAtomic(join(store, "index.json"), text);
    return { imported, records: index.records.length };
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
    for (const [id, content] of objects) {
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
}): Promise<{ exported: string[] }> {
  const store = resolve(options.store);
  const entries = (await readIndexEntries(store)).filter(
    (entry) =>
      (options.ids === undefined || options.ids.includes(entry.id)) &&
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
  for (const entry of entries) {
    const check = checkHistoryObject(
      entry.id,
      await readFile(objectPath(store, entry.id)),
    );
    if (check.status !== "ok")
      throw new HistoryStoreError(
        `record ${entry.id} is corrupt: ${check.reason}`,
      );
    const name = `${entry.kind}-${entry.id.slice(0, 12)}.json`;
    await writeAtomic(
      join(output, name),
      `${stableStringify(check.record.body)}\n`,
    );
    exported.push(name);
  }
  return { exported: exported.sort() };
}
