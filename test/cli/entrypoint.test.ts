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
const fixtureRoot = resolve(repositoryRoot, "test/fixtures/typescript-express");
const migrationFixture = resolve(
  repositoryRoot,
  "test/fixtures/snapshots/legacy-v0.graph.json",
);
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

  it("keeps help and version as successful stdout-only controls", async () => {
    const help = await runEntrypoint(["--help"]);
    const version = await runEntrypoint(["--version"]);

    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage: cartograph");
    expect(version.code).toBe(0);
    expect(version.stderr).toBe("");
    expect(version.stdout.trim()).toBe("0.1.0");
  });

  it("keeps JSON reports on stdout and diagnostics on stderr", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartograph-cli-json-mode-"));
    temporaryDirectories.push(root);
    const before = join(root, "before.json");
    const after = join(root, "after.json");

    const first = await runEntrypoint([
      "scan",
      fixtureRoot,
      "--output",
      before,
    ]);
    const second = await runEntrypoint([
      "scan",
      fixtureRoot,
      "--output",
      after,
    ]);
    const result = await runEntrypoint([
      "diff-snapshots",
      before,
      after,
      "--format",
      "json",
    ]);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"schemaVersion":1');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      fromRevision: { commitSha: "working-tree" },
    });
  });

  it("redacts a configuration-path failure without leaking the supplied secret", async () => {
    const secret = "TOP-SECRET-TOKEN";
    const root = await mkdtemp(join(tmpdir(), "cartograph-cli-redaction-"));
    temporaryDirectories.push(root);
    const outsideConfig = join(root, `token=${secret}`, "config.json");
    const result = await runEntrypoint([
      "scan",
      fixtureRoot,
      "--config",
      outsideConfig,
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cartograph [output-error]");
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain(outsideConfig);
  });

  it("reports an invalid configuration with a stable boundary and no secret value", async () => {
    const secret = "TOP-SECRET-CREDENTIAL";
    const root = await mkdtemp(join(tmpdir(), "cartograph-cli-config-error-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "cartograph.json"),
      JSON.stringify({ schemaVersion: 1, credential: secret }),
      "utf8",
    );
    const result = await runEntrypoint([
      "scan",
      root,
      "--config",
      "cartograph.json",
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cartograph [configuration-error]");
    expect(result.stderr).not.toContain(secret);
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

  it("migrates a historical snapshot and writes its identity report", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cartograph-cli-migration-test-"),
    );
    temporaryDirectories.push(root);
    const output = join(root, "migrated.json");
    const report = join(root, "migration-report.json");

    const result = await runEntrypoint([
      "migrate-snapshot",
      migrationFixture,
      "--output",
      output,
      "--report",
      report,
    ]);
    const snapshot = JSON.parse(await readFile(output, "utf8")) as {
      schemaVersion?: number;
      nodes?: { stableKey?: string }[];
    };
    const migration = JSON.parse(await readFile(report, "utf8")) as {
      changedNodeIdentities?: { before?: string; after?: string }[];
      changedEdgeIdentities?: unknown[];
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stableKey: "function:src/entry.ts:main" }),
      ]),
    );
    expect(migration.changedNodeIdentities).toContainEqual({
      before: "function:src/entry.ts#main",
      after: "function:src/entry.ts:main",
      changed: true,
    });
    expect(migration.changedEdgeIdentities).toHaveLength(1);
  });

  it("emits a read-only remediation review state without applying changes", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cartograph-cli-remediation-review-test-"),
    );
    temporaryDirectories.push(root);
    const input = join(root, "review.json");
    const digest =
      "sha256:3e2d9a1a2c5b4d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6";
    await writeFile(
      input,
      JSON.stringify({
        schemaVersion: 1,
        contract: "cartograph.remediation-review",
        reviewId: "review-cli",
        suggestionId: "suggestion-cli",
        suggestionVersion: 1,
        suggestionDigest: digest,
        ownerId: "team-architecture",
        reviewerId: "reviewer-architecture",
        evidenceRevision: {
          sourceCommit: "a".repeat(40),
          baselineDigest: digest,
          evidenceDigest: digest,
        },
        decision: "approved",
        rationale: "The bounded preview was reviewed by the owner.",
        validation: {
          status: "passed",
          resultDigest: digest,
          commands: ["review-fixture-validator"],
        },
        expiresAt: "2031-01-01T00:00:00.000Z",
        reviewedAt: "2030-01-01T00:00:00.000Z",
        finalDisposition: "unapplied",
        externalApplication: null,
      }),
      "utf8",
    );

    const result = await runEntrypoint([
      "review-remediation",
      input,
      "--as-of",
      "2030-01-01T00:00:00.000Z",
    ]);
    const report = JSON.parse(result.stdout) as {
      state?: string;
      readOnly?: boolean;
      autoApply?: boolean;
      mergeAutomation?: boolean;
    };

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(report).toMatchObject({
      state: "approved",
      readOnly: true,
      autoApply: false,
      mergeAutomation: false,
    });
  });
});
