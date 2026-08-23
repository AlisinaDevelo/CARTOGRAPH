import { constants, realpathSync } from "node:fs";
import { lstat, open, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { analyzeTypeScriptRepository } from "./analyzers/index.js";
import {
  diffGraphSnapshots,
  parseGraphSnapshot,
  serializeGraphSnapshot,
  type GraphSnapshot,
} from "./core/index.js";
import { withMaterializedRevision } from "./git/revision.js";
import { renderDiff, type ReportFormat } from "./report/render.js";

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
// macOS exposes these root-owned aliases for /private/{tmp,var}; they are not
// user-controlled path components and must remain usable for normal temp paths.
const MACOS_ROOT_SYMLINKS = new Set(["/tmp", "/var"]);

export type ScanOptions = {
  root: string;
  tsconfigPath?: string;
};

export type RevisionDiffOptions = {
  base: string;
  format: ReportFormat;
  head: string;
  root: string;
  tsconfigPath?: string;
};

const containedPath = (
  root: string,
  candidate: string,
  label: string,
): string => {
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(resolve(realRoot, candidate));
  const relativePath = relative(realRoot, realCandidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  ) {
    throw new Error(`${label} must stay inside the analyzed repository`);
  }
  return realCandidate;
};

export function scanRepository(options: ScanOptions): GraphSnapshot {
  const root = realpathSync(resolve(options.root));
  return parseGraphSnapshot(
    analyzeTypeScriptRepository({
      rootDir: root,
      ...(options.tsconfigPath === undefined
        ? {}
        : {
            tsconfigPath: containedPath(root, options.tsconfigPath, "tsconfig"),
          }),
      revision: { branch: "working-tree", commitSha: "working-tree" },
    }),
  );
}

const scanMaterializedRevision = async (
  repositoryRoot: string,
  ref: string,
  tsconfigPath?: string,
): Promise<GraphSnapshot> =>
  await withMaterializedRevision(repositoryRoot, ref, (revision) =>
    parseGraphSnapshot(
      analyzeTypeScriptRepository({
        rootDir: revision.root,
        revision: { commitSha: revision.commit },
        ...(tsconfigPath === undefined
          ? {}
          : {
              tsconfigPath: containedPath(
                revision.root,
                tsconfigPath,
                "tsconfig",
              ),
            }),
      }),
    ),
  );

export async function diffRepositoryRevisions(
  options: RevisionDiffOptions,
): Promise<string> {
  const repositoryRoot = resolve(options.root);
  const before = await scanMaterializedRevision(
    repositoryRoot,
    options.base,
    options.tsconfigPath,
  );
  const after = await scanMaterializedRevision(
    repositoryRoot,
    options.head,
    options.tsconfigPath,
  );
  return renderDiff(diffGraphSnapshots(before, after), options.format);
}

export async function loadSnapshot(path: string): Promise<GraphSnapshot> {
  const inputPath = resolve(path);
  const metadata = await stat(inputPath);
  if (!metadata.isFile())
    throw new Error(`snapshot is not a regular file: ${path}`);
  if (metadata.size > MAX_SNAPSHOT_BYTES) {
    throw new Error(`snapshot exceeds the 64 MiB input limit: ${path}`);
  }

  const source = await readFile(inputPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error(`snapshot exceeds the 64 MiB input limit: ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`could not parse snapshot ${path}: ${detail}`, {
      cause: error,
    });
  }
  return parseGraphSnapshot(value);
}

export async function diffSnapshotFiles(
  beforePath: string,
  afterPath: string,
  format: ReportFormat,
): Promise<string> {
  const [before, after] = await Promise.all([
    loadSnapshot(beforePath),
    loadSnapshot(afterPath),
  ]);
  return renderDiff(diffGraphSnapshots(before, after), format);
}

export async function writeOutputFile(
  outputPath: string,
  content: string,
  force: boolean,
): Promise<void> {
  const path = resolve(outputPath);
  let parentPath = dirname(path);
  while (true) {
    try {
      const metadata = await lstat(parentPath);
      if (
        metadata.isSymbolicLink() &&
        !(process.platform === "darwin" && MACOS_ROOT_SYMLINKS.has(parentPath))
      )
        throw new Error("output path must not contain a symbolic link");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }

    const ancestorPath = dirname(parentPath);
    if (ancestorPath === parentPath) break;
    parentPath = ancestorPath;
  }

  if (force) {
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink())
        throw new Error("output path must not be a symbolic link");
      if (!metadata.isFile())
        throw new Error("output path must be a regular file");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
  }

  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    (force ? constants.O_TRUNC : constants.O_EXCL) |
    constants.O_NOFOLLOW;
  const handle = await open(path, flags, 0o600);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new Error("output path must be a regular file");
    await handle.writeFile(content, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

export function serializeScan(snapshot: GraphSnapshot): string {
  return `${serializeGraphSnapshot(snapshot)}\n`;
}
