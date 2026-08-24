import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const entrypoint = resolve(repositoryRoot, "src/cli.ts");
const temporaryDirectories: string[] = [];

type ProcessResult = {
  code: number | null;
  stderr: string;
  stdout: string;
};

async function runEntrypoint(args: string[]): Promise<ProcessResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", entrypoint, ...args],
      {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolveResult({
        code,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      }),
    );
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CLI entrypoint", () => {
  it("uses a stable nonzero exit and diagnostic for invalid top-level input", async () => {
    const result = await runEntrypoint(["not-a-command"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error: unknown command 'not-a-command'");
  });

  it("runs a no-op scan without executing repository code", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartograph-cli-no-op-test-"));
    temporaryDirectories.push(root);
    const marker = join(root, "executed-by-cli");
    const output = join(root, "snapshot.json");

    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
        },
      }),
      "utf8",
    );
    await writeFile(
      join(root, "untrusted.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(marker)}, "executed");`,
        "export const value = 1;",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runEntrypoint(["scan", root, "--output", output]);
    const snapshot = JSON.parse(await readFile(output, "utf8")) as {
      revision?: { commitSha?: string };
      schemaVersion?: number;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(snapshot).toMatchObject({
      revision: { commitSha: "working-tree" },
      schemaVersion: 1,
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
