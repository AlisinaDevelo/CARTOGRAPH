#!/usr/bin/env node
/* global console, process */

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(repositoryRoot, "examples/sample-repository");
const cliPath = resolve(repositoryRoot, "dist/cli.js");

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

const runQuickstart = async () => {
  const root = await mkdtemp(join(tmpdir(), "cartograph-quickstart-"));
  try {
    await cp(fixtureRoot, root, { recursive: true });
    await git(["init", "--initial-branch=main"], root);
    await git(["config", "user.name", "CARTOGRAPH fixture"], root);
    await git(["config", "user.email", "fixture@cartograph.invalid"], root);

    const outputDir = join(root, ".cartograph");
    await mkdir(outputDir, { recursive: true });
    const scanPath = join(outputDir, "sample.graph.json");
    const diffPath = join(outputDir, "sample-diff.json");

    await run(
      process.execPath,
      [cliPath, "scan", root, "--output", scanPath],
      root,
    );
    const scan = JSON.parse(await readFile(scanPath, "utf8"));
    if (
      scan.schemaVersion !== 1 ||
      scan.nodes.length < 2 ||
      scan.edges.length < 1
    )
      throw new Error("sample scan did not produce a schema-valid graph");

    await git(["add", "."], root);
    await git(["commit", "-m", "sample baseline"], root);
    const baseSha = await git(["rev-parse", "HEAD"], root);
    const appPath = join(root, "src/app.ts");
    await writeFile(
      appPath,
      `${await readFile(appPath, "utf8")}\nexport const changed = true;\n`,
      "utf8",
    );
    await git(["add", "src/app.ts"], root);
    await git(["commit", "-m", "sample change"], root);
    const headSha = await git(["rev-parse", "HEAD"], root);

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
        "direct",
        "--format",
        "json",
        "--output",
        diffPath,
      ],
      repositoryRoot,
    );
    const diff = JSON.parse(await readFile(diffPath, "utf8"));
    const changedCount =
      diff.summary.nodesAdded +
      diff.summary.nodesRemoved +
      diff.summary.nodesChanged +
      diff.summary.edgesAdded +
      diff.summary.edgesRemoved +
      diff.summary.edgesChanged +
      diff.summary.diagnosticsAdded +
      diff.summary.diagnosticsRemoved +
      diff.summary.diagnosticsChanged;
    if (
      diff.comparison?.mode !== "direct" ||
      diff.comparison.baseCommitSha !== baseSha ||
      diff.comparison.headCommitSha !== headSha ||
      changedCount < 1
    )
      throw new Error("sample diff did not preserve exact revision metadata");
    if ((await git(["status", "--porcelain"], root)) !== "")
      throw new Error("quickstart analysis modified the sample repository");

    console.log(
      JSON.stringify({
        ok: true,
        baseSha,
        headSha,
        scanNodes: scan.nodes.length,
        scanEdges: scan.edges.length,
        changedCount,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

await runQuickstart();
