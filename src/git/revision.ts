import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, opendir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_REF_LENGTH = 512;

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

async function runProcess(
  command: string,
  args: readonly string[],
  cwd?: string,
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

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
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

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new GitCommandError(command, null, "timed out after 30 seconds"),
        ),
      );
    }, COMMAND_TIMEOUT_MS);
  });
}

export async function resolveRepositoryRoot(
  inputPath: string,
): Promise<string> {
  const candidate = await realpath(inputPath);
  const output = await runProcess("git", [
    "-C",
    candidate,
    "rev-parse",
    "--show-toplevel",
  ]);
  return await realpath(output.trim());
}

export async function resolveCommit(
  repositoryRoot: string,
  ref: string,
): Promise<string> {
  assertSafeRef(ref);
  const root = await resolveRepositoryRoot(repositoryRoot);
  const output = await runProcess("git", [
    "-C",
    root,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  const commit = output.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
    throw new Error(
      `Git returned an invalid commit identifier for ${JSON.stringify(ref)}`,
    );
  }
  return commit;
}

async function assertTreeContainsNoSymbolicLinks(root: string): Promise<void> {
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) break;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`archived symbolic link is not allowed: ${entry.name}`);
      }
      if (metadata.isDirectory()) directories.push(path);
    }
  }
}

export async function materializeRevision(
  repositoryRoot: string,
  ref: string,
): Promise<MaterializedRevision> {
  const root = await resolveRepositoryRoot(repositoryRoot);
  const commit = await resolveCommit(root, ref);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cartograph-revision-"));
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
    await runProcess("git", [
      "-C",
      root,
      "archive",
      "--format=tar",
      `--output=${archivePath}`,
      commit,
    ]);
    await runProcess("tar", ["-xf", archivePath, "-C", treeRoot]);
    await assertTreeContainsNoSymbolicLinks(treeRoot);
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
): Promise<T> {
  const revision = await materializeRevision(repositoryRoot, ref);
  try {
    return await operation(revision);
  } finally {
    await revision.cleanup();
  }
}
