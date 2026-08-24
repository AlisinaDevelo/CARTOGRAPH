import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createResourceBudget,
  CancellationError,
  ResourceLimitError,
} from "../resources.js";

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_REF_LENGTH = 512;
const DEFAULT_ARCHIVE_BYTES = 128 * 1024 * 1024;
const DEFAULT_EXTRACTED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MEMORY_BYTES = 1024 * 1024 * 1024;

export const revisionTemporaryPrefix = (repositoryRoot: string): string =>
  `cartograph-revision-${createHash("sha256")
    .update(repositoryRoot, "utf8")
    .digest("hex")
    .slice(0, 16)}-`;

export type MaterializationOptions = {
  resources?: {
    maxArchiveBytes?: number;
    maxExtractedBytes?: number;
    maxMemoryBytes?: number;
    maxWallClockMs?: number;
  };
  signal?: AbortSignal;
};

export type GitPathHistoryOptions = {
  maxWallClockMs?: number;
  signal?: AbortSignal;
};

export type GitPathHistoryEntry = {
  beforePath: string;
  afterPath: string;
};

type ProcessOptions = {
  maxWallClockMs?: number;
  signal?: AbortSignal;
};

export type MaterializedRevision = {
  readonly commit: string;
  readonly root: string;
  cleanup(): Promise<void>;
};

export class GitCommandError extends Error {
  readonly command: string;
  readonly exitCode: number | null;

  constructor(command: string, exitCode: number | null, detail: string) {
    super(
      `${command} failed${exitCode === null ? "" : ` with exit code ${exitCode}`}: ${detail}`,
    );
    this.name = "GitCommandError";
    this.command = command;
    this.exitCode = exitCode;
  }
}

function assertSafeRef(ref: string): void {
  if (
    ref.length === 0 ||
    ref.length > MAX_REF_LENGTH ||
    ref.startsWith("-") ||
    /[\0\r\n]/u.test(ref)
  ) {
    throw new Error(`unsafe Git ref: ${JSON.stringify(ref)}`);
  }
}

const portableGitPath = (value: string): string | undefined => {
  const path = value.replaceAll("\\", "/");
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.startsWith("~") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(path)
  ) {
    return undefined;
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "..")) return undefined;
  const normalized = parts
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
  return normalized.length > 0 ? normalized : undefined;
};

async function runProcess(
  command: string,
  args: readonly string[],
  cwd?: string,
  options: ProcessOptions = {},
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined = undefined;
    let abortHandler: (() => void) | undefined = undefined;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (abortHandler !== undefined)
        options.signal?.removeEventListener("abort", abortHandler);
      callback();
    };

    const collect =
      (target: Buffer[]) =>
      (chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          finish(() =>
            reject(new GitCommandError(command, null, "output exceeded 1 MiB")),
          );
          return;
        }
        target.push(chunk);
      };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve(Buffer.concat(stdout).toString("utf8"));
          return;
        }
        const detail =
          Buffer.concat(stderr).toString("utf8").trim() ||
          "no diagnostic output";
        reject(new GitCommandError(command, code, detail));
      });
    });

    abortHandler = (): void => {
      child.kill("SIGKILL");
      finish(() =>
        reject(new CancellationError("revision materialization cancelled")),
      );
    };
    if (options.signal?.aborted) {
      abortHandler();
      return;
    }
    options.signal?.addEventListener("abort", abortHandler, { once: true });
    timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new GitCommandError(
            command,
            null,
            `timed out after ${options.maxWallClockMs ?? COMMAND_TIMEOUT_MS} ms`,
          ),
        ),
      );
    }, options.maxWallClockMs ?? COMMAND_TIMEOUT_MS);
  });
}

const processOptions = (options: MaterializationOptions): ProcessOptions => ({
  maxWallClockMs: options.resources?.maxWallClockMs ?? COMMAND_TIMEOUT_MS,
  ...(options.signal === undefined ? {} : { signal: options.signal }),
});

export async function resolveRepositoryRoot(
  inputPath: string,
  options: ProcessOptions = {},
): Promise<string> {
  const candidate = await realpath(inputPath);
  const output = await runProcess(
    "git",
    ["-C", candidate, "rev-parse", "--show-toplevel"],
    undefined,
    options,
  );
  return await realpath(output.trim());
}

export async function resolveCommit(
  repositoryRoot: string,
  ref: string,
  options: ProcessOptions = {},
): Promise<string> {
  assertSafeRef(ref);
  const root = await resolveRepositoryRoot(repositoryRoot, options);
  const output = await runProcess(
    "git",
    [
      "-C",
      root,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ],
    undefined,
    options,
  );
  const commit = output.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
    throw new Error(
      `Git returned an invalid commit identifier for ${JSON.stringify(ref)}`,
    );
  }
  return commit;
}

export async function readPathHistory(
  repositoryRoot: string,
  baseRef: string,
  headRef: string,
  options: GitPathHistoryOptions = {},
): Promise<GitPathHistoryEntry[]> {
  assertSafeRef(baseRef);
  assertSafeRef(headRef);
  const root = await resolveRepositoryRoot(repositoryRoot, options);
  const output = await runProcess(
    "git",
    [
      "-C",
      root,
      "diff",
      "--name-status",
      "--find-renames",
      "--diff-filter=R",
      "--no-ext-diff",
      "--no-color",
      "-z",
      baseRef,
      headRef,
      "--",
    ],
    undefined,
    options,
  );
  const fields = output.split("\0");
  const history: GitPathHistoryEntry[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const status = fields[index];
    const beforePath = fields[index + 1];
    const afterPath = fields[index + 2];
    if (
      status === undefined ||
      beforePath === undefined ||
      afterPath === undefined ||
      !status.startsWith("R")
    ) {
      continue;
    }
    const normalizedBefore = portableGitPath(beforePath);
    const normalizedAfter = portableGitPath(afterPath);
    if (normalizedBefore === undefined || normalizedAfter === undefined) {
      throw new Error("Git returned a non-portable path history entry");
    }
    history.push({
      beforePath: normalizedBefore,
      afterPath: normalizedAfter,
    });
  }
  return history.sort((left, right) => {
    const beforeOrder =
      left.beforePath < right.beforePath
        ? -1
        : left.beforePath > right.beforePath
          ? 1
          : 0;
    return beforeOrder !== 0
      ? beforeOrder
      : left.afterPath < right.afterPath
        ? -1
        : left.afterPath > right.afterPath
          ? 1
          : 0;
  });
}

async function assertTreeContainsNoSymbolicLinks(
  root: string,
  checkBudget: () => void,
  maxExtractedBytes: number,
): Promise<void> {
  const directories = [root];
  let extractedBytes = 0;
  while (directories.length > 0) {
    checkBudget();
    const directory = directories.pop();
    if (directory === undefined) break;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      checkBudget();
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`archived symbolic link is not allowed: ${entry.name}`);
      }
      if (metadata.isDirectory()) directories.push(path);
      else if (metadata.isFile()) {
        extractedBytes += metadata.size;
        if (extractedBytes > maxExtractedBytes)
          throw new ResourceLimitError(
            `materialized revision exceeds the ${maxExtractedBytes} byte extracted-source ceiling`,
          );
      }
    }
  }
}

export async function materializeRevision(
  repositoryRoot: string,
  ref: string,
  options: MaterializationOptions = {},
): Promise<MaterializedRevision> {
  const maxArchiveBytes =
    options.resources?.maxArchiveBytes ?? DEFAULT_ARCHIVE_BYTES;
  const maxExtractedBytes =
    options.resources?.maxExtractedBytes ?? DEFAULT_EXTRACTED_BYTES;
  const maxMemoryBytes =
    options.resources?.maxMemoryBytes ?? DEFAULT_MEMORY_BYTES;
  const maxWallClockMs =
    options.resources?.maxWallClockMs ?? COMMAND_TIMEOUT_MS;
  const checkBudget = createResourceBudget({
    maxMemoryBytes,
    maxWallClockMs,
    subject: "revision materialization",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  checkBudget();
  const processConfig = processOptions(options);
  const root = await resolveRepositoryRoot(repositoryRoot, processConfig);
  checkBudget();
  const commit = await resolveCommit(root, ref, processConfig);
  checkBudget();
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), revisionTemporaryPrefix(root)),
  );
  const archivePath = join(temporaryRoot, "revision.tar");
  const treeRoot = join(temporaryRoot, "tree");
  let cleaned = false;

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rm(temporaryRoot, { force: true, recursive: true });
  };

  try {
    await mkdir(treeRoot, { mode: 0o700 });
    checkBudget();
    await runProcess(
      "git",
      [
        "-C",
        root,
        "archive",
        "--format=tar",
        `--output=${archivePath}`,
        commit,
      ],
      undefined,
      processConfig,
    );
    checkBudget();
    const archiveMetadata = await stat(archivePath);
    if (archiveMetadata.size > maxArchiveBytes)
      throw new ResourceLimitError(
        `revision archive exceeds the ${maxArchiveBytes} byte archive ceiling`,
      );
    await runProcess(
      "tar",
      ["-xf", archivePath, "-C", treeRoot],
      undefined,
      processConfig,
    );
    await assertTreeContainsNoSymbolicLinks(
      treeRoot,
      checkBudget,
      maxExtractedBytes,
    );
    checkBudget();
    return { cleanup, commit, root: treeRoot };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function withMaterializedRevision<T>(
  repositoryRoot: string,
  ref: string,
  operation: (revision: MaterializedRevision) => Promise<T> | T,
  options: MaterializationOptions = {},
): Promise<T> {
  const revision = await materializeRevision(repositoryRoot, ref, options);
  try {
    return await operation(revision);
  } finally {
    await revision.cleanup();
  }
}
