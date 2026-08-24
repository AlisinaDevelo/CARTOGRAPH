#!/usr/bin/env node
/* global console, process */

import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

const expectFailure = async (label, callback, pattern) => {
  try {
    await callback();
  } catch (error) {
    const message = String(error?.message ?? error);
    if (pattern !== undefined && !pattern.test(message))
      throw new Error(
        `${label} failed with an unexpected diagnostic: ${message}`,
        { cause: error },
      );
    return message;
  }
  throw new Error(`${label} unexpectedly passed`);
};

const runFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "cartograph-action-fixture-"));
  const temporaryRoots = [root];
  const makeTemporaryRoot = async (prefix) => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), prefix));
    temporaryRoots.push(temporaryRoot);
    return temporaryRoot;
  };
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
    const privateSourceSnippet = "CARTOGRAPH_PRIVATE_SOURCE_SNIPPET_9f4e";
    const privateToken = "ghp_CartographFixtureToken_9f4e";
    await writeFile(
      entryPath,
      `${entry}\nconst privateSourceSnippet = ${JSON.stringify(privateSourceSnippet)};\nconst authorizationToken = ${JSON.stringify(privateToken)};\nexport const changed = true;\n`,
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
    const noUploadHtmlPath = join(
      outputDir,
      "architecture-diff-no-upload.html",
    );
    const noUploadSummaryPath = join(outputDir, "summary-no-upload.md");
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
    await run(
      process.execPath,
      [
        resolve(repositoryRoot, "scripts/action-report.mjs"),
        jsonPath,
        noUploadHtmlPath,
        noUploadSummaryPath,
        "cartograph-fixture-report",
        "false",
      ],
      repositoryRoot,
    );

    const diff = JSON.parse(await readFile(jsonPath, "utf8"));
    const html = await readFile(htmlPath, "utf8");
    const summary = await readFile(summaryPath, "utf8");
    const noUploadSummary = await readFile(noUploadSummaryPath, "utf8");
    const serializedDiff = JSON.stringify(diff);
    const reportBytes = Buffer.byteLength(serializedDiff, "utf8");
    const htmlBytes = Buffer.byteLength(html, "utf8");
    const forbiddenValues = [privateSourceSnippet, privateToken, root];
    const reportPayload = `${serializedDiff}\n${html}\n${summary}`;
    if (forbiddenValues.some((value) => reportPayload.includes(value)))
      throw new Error(
        "fixture report leaked an absolute path, source snippet, or token",
      );
    if (
      /(?:ghp_|github_pat_|xox[baprs]-|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY)/iu.test(
        reportPayload,
      )
    )
      throw new Error("fixture report contains a credential-shaped token");
    if (reportBytes > 16 * 1024 * 1024 || htmlBytes > 16 * 1024 * 1024)
      throw new Error("fixture report exceeded the 16 MiB artifact ceiling");
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
    if (
      !noUploadSummary.includes("Static report upload: disabled by policy") ||
      noUploadSummary.includes("Static report: artifact")
    )
      throw new Error("upload opt-out summary did not disable artifact claim");
    if ((await git(["status", "--porcelain"], root)) !== "")
      throw new Error("fixture analysis modified the repository");

    const maliciousPackageRoot = await makeTemporaryRoot(
      "cartograph-action-malicious-package-",
    );
    const maliciousMarker = join(
      maliciousPackageRoot,
      "CARTOGRAPH_MALICIOUS_SCRIPT_EXECUTED",
    );
    await writeFile(
      join(maliciousPackageRoot, "package.json"),
      JSON.stringify(
        {
          name: "cartograph-malicious-package-fixture",
          version: "1.0.0",
          scripts: {
            preinstall: `node -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(maliciousMarker)}, "executed")`)}`,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--offline",
      ],
      maliciousPackageRoot,
    );
    try {
      await access(maliciousMarker);
      throw new Error("malicious package script executed");
    } catch (error) {
      if (error?.message === "malicious package script executed") throw error;
    }

    const symlinkTarget = join(root, "symlink-target.json");
    const symlinkOutput = join(outputDir, "symlink-report.json");
    await writeFile(symlinkTarget, "do-not-overwrite\n", "utf8");
    await symlink(symlinkTarget, symlinkOutput);
    await expectFailure(
      "symlinked output",
      () =>
        run(
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
            symlinkOutput,
            "--force",
          ],
          repositoryRoot,
        ),
      /symlink|symbolic|output/u,
    );
    if ((await readFile(symlinkTarget, "utf8")) !== "do-not-overwrite\n")
      throw new Error("symlinked output target was modified");

    const oversizedRoot = await makeTemporaryRoot(
      "cartograph-action-oversized-input-",
    );
    await mkdir(join(oversizedRoot, "src"), { recursive: true });
    await writeFile(
      join(oversizedRoot, "src", "oversized.ts"),
      `export const oversized = "${"x".repeat(2 * 1024 * 1024)}";\n`,
      "utf8",
    );
    await expectFailure(
      "oversized input",
      () =>
        run(process.execPath, [cliPath, "scan", oversizedRoot], repositoryRoot),
      /exceed|ceiling|limit|size/u,
    );

    const { analyzeTypeScriptRepository } = await import(
      resolve(repositoryRoot, "dist", "analyzers", "index.js")
    );
    const { CancellationError } = await import(
      resolve(repositoryRoot, "dist", "resources.js")
    );
    const controller = new globalThis.AbortController();
    controller.abort();
    try {
      analyzeTypeScriptRepository({
        rootDir: fixtureRoot,
        signal: controller.signal,
      });
      throw new Error("cancelled analysis unexpectedly passed");
    } catch (error) {
      if (!(error instanceof CancellationError)) throw error;
    }

    await expectFailure(
      "missing revision ref",
      () =>
        run(
          process.execPath,
          [
            cliPath,
            "diff",
            root,
            "--base",
            "missing-cartograph-fixture-ref",
            "--head",
            headSha,
            "--comparison",
            "merge-base",
            "--format",
            "json",
          ],
          repositoryRoot,
        ),
      /failed|ref|revision|unknown/u,
    );

    console.log(
      JSON.stringify({
        ok: true,
        baseSha,
        headSha,
        mergeBaseSha: diff.comparison.mergeBaseSha,
        reportBytes: htmlBytes,
        jsonBytes: reportBytes,
        summaryBytes: Buffer.byteLength(summary, "utf8"),
        securityFixtures: [
          "fork-pull-request",
          "malicious-package-script",
          "symlinked-output",
          "oversized-input",
          "cancellation",
          "missing-ref",
        ],
      }),
    );
  } finally {
    await Promise.all(
      temporaryRoots.map((temporaryRoot) =>
        rm(temporaryRoot, { recursive: true, force: true }),
      ),
    );
  }
};

await runFixture();
