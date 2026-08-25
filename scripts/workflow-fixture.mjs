#!/usr/bin/env node
/* global console, process */

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(repositoryRoot, "examples/sample-repository");
const legacySnapshot = resolve(
  repositoryRoot,
  "test/fixtures/snapshots/legacy-v0.graph.json",
);
const cliPath = resolve(repositoryRoot, "dist/cli.js");
const digest = `sha256:${"1".repeat(64)}`;

const run = async (binary, args, cwd) => {
  try {
    return await execFileAsync(binary, args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
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

const cartograph = async (args, cwd) =>
  await run(process.execPath, [cliPath, ...args], cwd);

const workflow = async () => {
  const root = await mkdtemp(join(tmpdir(), "cartograph-workflow-"));
  try {
    await cp(fixtureRoot, root, { recursive: true });
    await mkdir(join(root, "docs/adr"), { recursive: true });
    await mkdir(join(root, ".cartograph"), { recursive: true });
    await run("git", ["init", "--initial-branch=main"], root);
    await run("git", ["config", "user.name", "CARTOGRAPH fixture"], root);
    await run(
      "git",
      ["config", "user.email", "fixture@cartograph.invalid"],
      root,
    );

    await writeFile(
      join(root, "docs/adr/0001-greeting.md"),
      "# ADR 0001: Keep the greeting module local\n\n- Status: proposed\n",
      "utf8",
    );
    await writeFile(
      join(root, "adr.json"),
      JSON.stringify({
        schemaVersion: 1,
        references: [
          {
            id: "ADR-0001",
            file: "docs/adr/0001-greeting.md",
            title: "Keep the greeting module local",
            status: "proposed",
            graphIds: ["module:src/app.ts"],
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      join(root, "policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        policyId: "workflow-policy",
        version: "1.0.0",
        mode: "informational",
        rules: [
          {
            id: "greeting-module-present",
            target: "node",
            selector: { id: "module:src/app.ts" },
            assertion: "exists",
          },
        ],
      }),
      "utf8",
    );

    const baselinePath = join(root, ".cartograph/baseline.graph.json");
    await cartograph(["scan", root, "--output", baselinePath], root);
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    if (!baseline.nodes.some((node) => node.id === "module:src/app.ts"))
      throw new Error("workflow baseline did not contain the ADR graph node");

    await run(
      "git",
      [
        "add",
        ".gitignore",
        "tsconfig.json",
        "src",
        "README.md",
        "docs/adr",
        "adr.json",
        "policy.json",
      ],
      root,
    );
    await git(["commit", "--no-verify", "-m", "workflow baseline"], root);
    const baseSha = await git(["rev-parse", "HEAD"], root);

    await writeFile(
      join(root, "src/app.ts"),
      `${await readFile(join(root, "src/app.ts"), "utf8")}\nexport const workflowChange = true;\n`,
      "utf8",
    );
    await writeFile(
      join(root, "docs/adr/0001-greeting.md"),
      "# ADR 0001: Keep the greeting module local\n\n- Status: accepted\n",
      "utf8",
    );
    await writeFile(
      join(root, "adr.json"),
      JSON.stringify({
        schemaVersion: 1,
        references: [
          {
            id: "ADR-0001",
            file: "docs/adr/0001-greeting.md",
            title: "Keep the greeting module local",
            status: "accepted",
            graphIds: ["module:src/app.ts"],
          },
        ],
      }),
      "utf8",
    );
    await run("git", ["add", "src/app.ts", "adr.json", "docs/adr"], root);
    await git(["commit", "--no-verify", "-m", "workflow change"], root);
    const headSha = await git(["rev-parse", "HEAD"], root);

    const diffReportPath = join(root, ".cartograph/architecture-diff.md");
    await cartograph(
      [
        "diff",
        root,
        "--base",
        baseSha,
        "--head",
        headSha,
        "--format",
        "markdown",
        "--adr",
        "adr.json",
        "--output",
        diffReportPath,
      ],
      repositoryRoot,
    );
    const diffReport = await readFile(diffReportPath, "utf8");
    if (
      !diffReport.includes("## ADR references") ||
      !diffReport.includes("accepted") ||
      !diffReport.includes("src/app.ts")
    )
      throw new Error("workflow diff did not render ADR evidence");

    const policyReportPath = join(root, ".cartograph/policy-evaluation.json");
    await cartograph(
      [
        "policy",
        root,
        "--policy",
        "policy.json",
        "--snapshot",
        baselinePath,
        "--adr",
        "adr.json",
        "--mode",
        "informational",
        "--output",
        policyReportPath,
      ],
      repositoryRoot,
    );
    const policyReport = JSON.parse(await readFile(policyReportPath, "utf8"));
    if (policyReport.status !== "passed")
      throw new Error("workflow informational policy did not pass");

    const migratedPath = join(root, ".cartograph/migrated.graph.json");
    const migrationReportPath = join(root, ".cartograph/migration-report.json");
    await cartograph(
      [
        "migrate-snapshot",
        legacySnapshot,
        "--output",
        migratedPath,
        "--report",
        migrationReportPath,
      ],
      repositoryRoot,
    );
    const migrated = JSON.parse(await readFile(migratedPath, "utf8"));
    const migration = JSON.parse(await readFile(migrationReportPath, "utf8"));
    if (
      migrated.schemaVersion !== 1 ||
      migration.contract !== "GraphSnapshot" ||
      migration.toVersion !== 1
    )
      throw new Error("workflow migration did not emit reviewed v1 artifacts");

    const reviewInputPath = join(root, ".cartograph/review.json");
    const reviewReportPath = join(root, ".cartograph/review-report.json");
    await writeFile(
      reviewInputPath,
      JSON.stringify({
        schemaVersion: 1,
        contract: "cartograph.remediation-review",
        reviewId: "workflow-review",
        suggestionId: "workflow-suggestion",
        suggestionVersion: 1,
        suggestionDigest: digest,
        ownerId: "architecture-team",
        reviewerId: null,
        evidenceRevision: {
          sourceCommit: headSha,
          baselineDigest: digest,
          evidenceDigest: digest,
        },
        decision: "proposed",
        rationale: "The local report is awaiting a named reviewer.",
        validation: { status: "not-run", resultDigest: null, commands: [] },
        expiresAt: "2031-01-01T00:00:00.000Z",
        reviewedAt: null,
        finalDisposition: "unapplied",
        externalApplication: null,
      }),
      "utf8",
    );
    await cartograph(
      [
        "review-remediation",
        reviewInputPath,
        "--as-of",
        "2030-01-01T00:00:00.000Z",
        "--output",
        reviewReportPath,
      ],
      repositoryRoot,
    );
    const review = JSON.parse(await readFile(reviewReportPath, "utf8"));
    if (
      review.state !== "proposed" ||
      review.readOnly !== true ||
      review.mergeAutomation !== false
    )
      throw new Error("workflow review did not remain read-only and proposed");

    await rm(join(root, ".cartograph"), { recursive: true, force: true });
    const status = await git(["status", "--porcelain"], root);
    if (status !== "")
      throw new Error(
        `workflow commands modified source-controlled files: ${status}`,
      );

    console.log(
      JSON.stringify({
        ok: true,
        baseSha,
        headSha,
        diffAdr: true,
        policyStatus: policyReport.status,
        migrationVersion: migrated.schemaVersion,
        reviewState: review.state,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

await workflow();
