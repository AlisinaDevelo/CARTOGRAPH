import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  materializeRevision,
  readPathHistory,
  resolveCommit,
  resolveRevisionComparison,
  withMaterializedRevision,
} from "../../src/git/revision.js";
import { CancellationError, ResourceLimitError } from "../../src/resources.js";

const temporaryDirectories: string[] = [];

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
      } else {
        reject(new Error(Buffer.concat(stderr).toString("utf8")));
      }
    });
  });
}

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cartograph-git-test-"));
  temporaryDirectories.push(root);
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.name", "CARTOGRAPH Test"], root);
  await run("git", ["config", "user.email", "test@example.invalid"], root);
  await writeFile(
    join(root, "service.ts"),
    "export const value = 1;\n",
    "utf8",
  );
  await run("git", ["add", "service.ts"], root);
  await run("git", ["commit", "-m", "add service"], root);
  await writeFile(
    join(root, "service.ts"),
    "export const value = 2;\n",
    "utf8",
  );
  await run("git", ["add", "service.ts"], root);
  await run("git", ["commit", "-m", "change service"], root);
  return root;
}

async function createRenameRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cartograph-git-rename-test-"));
  temporaryDirectories.push(root);
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.name", "CARTOGRAPH Test"], root);
  await run("git", ["config", "user.email", "test@example.invalid"], root);
  await writeFile(
    join(root, "old.ts"),
    "export function load() { return 1; }\n",
    "utf8",
  );
  await run("git", ["add", "old.ts"], root);
  await run("git", ["commit", "-m", "add old path"], root);
  await run("git", ["mv", "old.ts", "new.ts"], root);
  await run("git", ["commit", "-m", "move path"], root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Git revision materialization", () => {
  it("resolves direct and merge-base modes to exact local commits", async () => {
    const root = await createRepository();

    const direct = await resolveRevisionComparison(
      root,
      "HEAD~1",
      "HEAD",
      "direct",
    );
    expect(direct.mode).toBe("direct");
    expect(direct.baseRef).toBe("HEAD~1");
    expect(direct.headRef).toBe("HEAD");
    expect(direct.fromCommitSha).toBe(direct.baseCommitSha);
    expect(direct.mergeBaseSha).toBeUndefined();
    expect(direct.baseCommitSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(direct.headCommitSha).toMatch(/^[0-9a-f]{40}$/u);

    const mergeBase = await resolveRevisionComparison(
      root,
      "HEAD~1",
      "HEAD",
      "merge-base",
    );
    expect(mergeBase.mode).toBe("merge-base");
    expect(mergeBase.fromCommitSha).toBe(mergeBase.mergeBaseSha);
    expect(mergeBase.baseCommitSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(mergeBase.headCommitSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(mergeBase.mergeBaseSha).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("fails merge-base mode for unrelated histories", async () => {
    const root = await createRepository();
    await run("git", ["checkout", "--orphan", "unrelated"], root);
    await run("git", ["rm", "-rf", "."], root);
    await writeFile(join(root, "unrelated.txt"), "unrelated\n", "utf8");
    await run("git", ["add", "unrelated.txt"], root);
    await run("git", ["commit", "-m", "unrelated history"], root);
    await run("git", ["checkout", "main"], root);

    await expect(
      resolveRevisionComparison(root, "main", "unrelated", "merge-base"),
    ).rejects.toThrow("unrelated histories");
  });

  it("records the new merge base after a local rebase", async () => {
    const root = await createRepository();
    await run("git", ["branch", "feature", "HEAD~1"], root);
    await run("git", ["checkout", "feature"], root);
    await writeFile(
      join(root, "feature.ts"),
      "export const feature = true;\n",
      "utf8",
    );
    await run("git", ["add", "feature.ts"], root);
    await run("git", ["commit", "-m", "feature work"], root);
    await run("git", ["checkout", "main"], root);
    await writeFile(
      join(root, "main.ts"),
      "export const main = true;\n",
      "utf8",
    );
    await run("git", ["add", "main.ts"], root);
    await run("git", ["commit", "-m", "main work"], root);
    await run("git", ["checkout", "feature"], root);
    await run("git", ["rebase", "main"], root);
    await run("git", ["checkout", "main"], root);

    const comparison = await resolveRevisionComparison(
      root,
      "main",
      "feature",
      "merge-base",
    );
    await expect(resolveCommit(root, "main")).resolves.toBe(
      comparison.mergeBaseSha,
    );
    expect(comparison.headCommitSha).not.toBe(comparison.mergeBaseSha);
  });

  it("fails merge-base mode in a shallow repository instead of fetching", async () => {
    const root = await createRepository();
    const shallowRoot = await mkdtemp(join(tmpdir(), "cartograph-shallow-"));
    temporaryDirectories.push(shallowRoot);
    await run(
      "git",
      ["clone", "--depth", "1", `file://${root}`, shallowRoot],
      root,
    );

    await expect(
      resolveRevisionComparison(shallowRoot, "HEAD", "HEAD", "merge-base"),
    ).rejects.toThrow("shallow repository");
    await expect(
      resolveRevisionComparison(shallowRoot, "HEAD", "HEAD", "direct"),
    ).resolves.toMatchObject({ mode: "direct" });
  });

  it("resolves a ref to an exact commit and extracts it without touching a dirty worktree", async () => {
    const root = await createRepository();
    await writeFile(join(root, "service.ts"), "dirty working tree\n", "utf8");
    const before = await run("git", ["status", "--porcelain=v1"], root);

    const revision = await materializeRevision(root, "HEAD~1");
    try {
      expect(revision.commit).toMatch(/^[0-9a-f]{40,64}$/u);
      await expect(
        readFile(join(revision.root, "service.ts"), "utf8"),
      ).resolves.toBe("export const value = 1;\n");
    } finally {
      await revision.cleanup();
    }

    await expect(run("git", ["status", "--porcelain=v1"], root)).resolves.toBe(
      before,
    );
  });

  it("cleans the extracted tree when analysis fails", async () => {
    const root = await createRepository();
    let extractedRoot = "";

    await expect(
      withMaterializedRevision(root, "HEAD", async (revision) => {
        extractedRoot = revision.root;
        await readFile(join(revision.root, "service.ts"), "utf8");
        throw new Error("analysis failed");
      }),
    ).rejects.toThrow("analysis failed");

    await expect(
      readFile(join(extractedRoot, "service.ts"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects option-shaped or control-character refs before invoking Git", async () => {
    const root = await createRepository();
    await expect(resolveCommit(root, "--upload-pack=evil")).rejects.toThrow(
      "unsafe Git ref",
    );
    await expect(resolveCommit(root, "HEAD\nmalicious")).rejects.toThrow(
      "unsafe Git ref",
    );
    await expect(
      readPathHistory(root, "HEAD\nmalicious", "HEAD"),
    ).rejects.toThrow("unsafe Git ref");
  });

  it("reads deterministic Git rename history as portable path pairs", async () => {
    const root = await createRenameRepository();

    await expect(readPathHistory(root, "HEAD~1", "HEAD")).resolves.toEqual([
      { beforePath: "old.ts", afterPath: "new.ts" },
    ]);
  });

  it("rejects archived symbolic links before analysis", async () => {
    const root = await createRepository();
    await symlink("/etc/passwd", join(root, "outside.ts"));
    await run("git", ["add", "outside.ts"], root);
    await run("git", ["commit", "-m", "add unsafe symlink"], root);

    await expect(materializeRevision(root, "HEAD")).rejects.toThrow(
      "symbolic link",
    );
  });

  it("fails closed when the revision archive exceeds its ceiling", async () => {
    const root = await createRepository();

    await expect(
      materializeRevision(root, "HEAD", {
        resources: { maxArchiveBytes: 1 },
      }),
    ).rejects.toThrowError(ResourceLimitError);
    await expect(
      materializeRevision(root, "HEAD", {
        resources: { maxArchiveBytes: 1 },
      }),
    ).rejects.toThrow("revision archive exceeds the 1 byte archive ceiling");
  });

  it("fails closed when extracted revision bytes exceed their ceiling", async () => {
    const root = await createRepository();

    await expect(
      materializeRevision(root, "HEAD", {
        resources: { maxExtractedBytes: 1 },
      }),
    ).rejects.toThrowError(ResourceLimitError);
    await expect(
      materializeRevision(root, "HEAD", {
        resources: { maxExtractedBytes: 1 },
      }),
    ).rejects.toThrow(
      "materialized revision exceeds the 1 byte extracted-source ceiling",
    );
  });

  it("cleans a materialized tree when cancellation aborts analysis", async () => {
    const root = await createRepository();
    const controller = new AbortController();
    let extractedRoot = "";

    await expect(
      withMaterializedRevision(
        root,
        "HEAD",
        (revision) => {
          extractedRoot = revision.root;
          controller.abort();
          throw new CancellationError("revision materialization cancelled");
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrowError(CancellationError);

    await expect(
      readFile(join(extractedRoot, "service.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
