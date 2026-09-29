import { createHash } from "node:crypto";
import { constants, readdirSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_REGISTRY_VERSION,
  DIAGNOSTIC_REGISTRY_VERSION,
  GRAPH_SNAPSHOT_SCHEMA_VERSION,
  parseGraphSnapshot,
  serializeGraphSnapshot,
  stableStringify,
  type CartographConfig,
  type GraphSnapshot,
} from "./core/index.js";

export const SCAN_CACHE_KEY_VERSION = 1 as const;
const MAX_CACHED_SNAPSHOT_BYTES = 64 * 1024 * 1024;

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

let fingerprint: string | undefined;

/**
 * A digest of the analyzer that is running: every source or build file of
 * this package plus the TypeScript and ts-morph versions it resolved. Output
 * can change between commits that share a package version, so the version
 * alone is not a safe cache key.
 */
export const analyzerFingerprint = (): string => {
  if (fingerprint !== undefined) return fingerprint;
  const packageRoot = dirname(fileURLToPath(import.meta.url));
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => (left.name < right.name ? -1 : 1),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:js|ts|json)$/u.test(entry.name)) {
        hash.update(relative(packageRoot, path));
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  visit(packageRoot);
  const require = createRequire(import.meta.url);
  for (const dependency of ["typescript", "ts-morph"]) {
    const manifest = require(`${dependency}/package.json`) as {
      version: string;
    };
    hash.update(`${dependency}@${manifest.version}\0`);
  }
  fingerprint = hash.digest("hex");
  return fingerprint;
};

export type ScanCacheKeyInput = {
  analyzer: string;
  commitSha: string;
  treeSha: string;
  config: CartographConfig;
  tsconfigPath?: string | undefined;
};

/**
 * Content-addressed key for one revision scan. It binds the analyzer build,
 * the graph contracts, the scan-relevant configuration (resource ceilings
 * included, so a cached result never bypasses a stricter limit), the tsconfig
 * selection, and the commit and tree being analyzed. Lockfiles and every other
 * source input are covered by the tree digest.
 */
export const scanCacheKey = (input: ScanCacheKeyInput): string =>
  `cartograph-scan-v${SCAN_CACHE_KEY_VERSION}-${sha256(
    stableStringify({
      analyzer: input.analyzer,
      contracts: {
        snapshot: GRAPH_SNAPSHOT_SCHEMA_VERSION,
        capabilities: CAPABILITY_REGISTRY_VERSION,
        diagnostics: DIAGNOSTIC_REGISTRY_VERSION,
      },
      config: {
        include: input.config.include,
        exclude: input.config.exclude,
        extractors: input.config.extractors,
        resources: input.config.resources,
        tsconfigPath: input.tsconfigPath ?? input.config.tsconfigPath ?? null,
      },
      commitSha: input.commitSha,
      treeSha: input.treeSha,
    }),
  )}`;

const cachePath = (cacheDir: string, key: string): string =>
  join(cacheDir, `${key}.graph.json`);

/**
 * A cached snapshot for this key and commit, or undefined when there is none
 * or it is not a valid snapshot of exactly that commit. Anything unexpected
 * is treated as a miss, never as a reason to trust the file.
 */
export async function readCachedSnapshot(
  cacheDir: string,
  key: string,
  commitSha: string,
): Promise<GraphSnapshot | undefined> {
  const path = cachePath(cacheDir, key);
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_CACHED_SNAPSHOT_BYTES
    )
      return undefined;
    const snapshot = parseGraphSnapshot(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
    return snapshot.revision.commitSha === commitSha ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

export async function writeCachedSnapshot(
  cacheDir: string,
  key: string,
  snapshot: GraphSnapshot,
): Promise<void> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const target = cachePath(cacheDir, key);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${serializeGraphSnapshot(snapshot)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
