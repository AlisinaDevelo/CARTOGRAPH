#!/usr/bin/env node
/* global console, process */

import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(repositoryRoot, "examples/github-action-fixture");

const run = async (binary, args, cwd) => {
  try {
    return await execFileAsync(binary, args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  } catch (error) {
    const stderr = error?.stderr ?? "";
    throw new Error(
      `${binary} ${args.join(" ")} failed${stderr ? `: ${stderr.trim()}` : ""}`,
      { cause: error },
    );
  }
};

const git = async (args, cwd) => (await run("git", args, cwd)).stdout.trim();

const runFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "cartograph-action-fixture-"));
  try {
    await cp(fixtureRoot, root, { recursive: true });
    await git(["init", "--initial-branch=main"], root);
    await git(["config", "user.name", "CARTOGRAPH fixture"], root);
    await git(["config", "user.email", "fixture@cartograph.invalid"], root);
    await git(["add", "."], root);
    await git(["commit", "-m", "fixture base"], root);
    await git(["switch", "-c", "fixture-pr"], root);

    const entryPath = join(root, "src/entry.ts");
    const entry = await readFile(entryPath, "utf8");
    await writeFile(
      entryPath,
      `${entry}\nexport const changed = true;\n`,
      "utf8",
    );
    await git(["add", "src/entry.ts"], root);
    await git(["commit", "-m", "fixture change"], root);

    const baseSha = await git(["rev-parse", "main"], root);
    const headSha = await git(["rev-parse", "HEAD"], root);
    const outputDir = join(root, ".cartograph");
    await mkdir(outputDir, { recursive: true });
    const jsonPath = join(outputDir, "architecture-diff.json");
    const htmlPath = join(outputDir, "architecture-diff.html");
    const summaryPath = join(outputDir, "summary.md");
    const cliPath = resolve(repositoryRoot, "dist/cli.js");

    await run(
      process.execPath,
      [
        cliPath,
        "diff",
        root,
        "--base",
        baseSha,
        "--head",
        headSha,
        "--comparison",
        "merge-base",
        "--format",
        "json",
        "--output",
        jsonPath,
        "--force",
      ],
      repositoryRoot,
    );
    await run(
      process.execPath,
      [
        resolve(repositoryRoot, "scripts/action-report.mjs"),
        jsonPath,
        htmlPath,
        summaryPath,
        "cartograph-fixture-report",
      ],
      repositoryRoot,
    );

    const diff = JSON.parse(await readFile(jsonPath, "utf8"));
    const html = await readFile(htmlPath, "utf8");
    const summary = await readFile(summaryPath, "utf8");
    if (
      diff.comparison?.mode !== "merge-base" ||
      diff.comparison.baseCommitSha !== baseSha ||
      diff.comparison.headCommitSha !== headSha ||
      diff.comparison.mergeBaseSha !== baseSha
    )
      throw new Error(
        "fixture report did not preserve exact comparison metadata",
      );
    if (!html.includes("<title>CARTOGRAPH architecture diff</title>"))
      throw new Error("fixture report is not a CARTOGRAPH static HTML report");
    if (!summary.includes("### CARTOGRAPH architecture diff"))
      throw new Error("fixture summary was not emitted");
    if ((await git(["status", "--porcelain"], root)) !== "")
      throw new Error("fixture analysis modified the repository");

    console.log(
      JSON.stringify({
        ok: true,
        baseSha,
        headSha,
        mergeBaseSha: diff.comparison.mergeBaseSha,
        reportBytes: Buffer.byteLength(html, "utf8"),
        summaryBytes: Buffer.byteLength(summary, "utf8"),
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

await runFixture();
