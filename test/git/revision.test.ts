import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  materializeRevision,
  resolveCommit,
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Git revision materialization", () => {
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
