import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
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

const snapshot = {
  schemaVersion: 1,
  revision: { commitSha: "policy-cli-fixture" },
  nodes: [{ id: "module:a", kind: "module", name: "a" }],
  edges: [],
  diagnostics: [],
};

const policy = (mode: "informational" | "enforce", assertion = "exists") => ({
  schemaVersion: 1,
  policyId: "policy-cli-fixture",
  version: "1.0.0",
  mode,
  rules: [
    {
      id: "endpoint-required",
      target: "node",
      selector: { kind: "endpoint" },
      assertion,
    },
  ],
});

describe("policy CLI mode contract", () => {
  it("reports informational findings with exit 0 and enforce findings with exit 2", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartograph-policy-cli-"));
    temporaryDirectories.push(root);
    const policyPath = join(root, "policy.json");
    const snapshotPath = join(root, "snapshot.json");
    const informationalReport = join(root, "informational.json");
    const enforcingReport = join(root, "enforcing.json");
    await writeFile(policyPath, JSON.stringify(policy("informational")));
    await writeFile(snapshotPath, JSON.stringify(snapshot));

    const informational = await runEntrypoint([
      "policy",
      root,
      "--policy",
      "policy.json",
      "--snapshot",
      snapshotPath,
      "--output",
      informationalReport,
    ]);
    const enforce = await runEntrypoint([
      "policy",
      root,
      "--policy",
      "policy.json",
      "--snapshot",
      snapshotPath,
      "--mode",
      "enforce",
      "--output",
      enforcingReport,
    ]);

    expect(informational).toMatchObject({ code: 0, stderr: "", stdout: "" });
    expect(enforce).toMatchObject({ code: 2, stderr: "", stdout: "" });
    expect(
      JSON.parse(await readFile(informationalReport, "utf8")),
    ).toMatchObject({
      mode: "informational",
      status: "violations",
    });
    expect(JSON.parse(await readFile(enforcingReport, "utf8"))).toMatchObject({
      mode: "enforce",
      status: "violations",
    });
  });

  it("allows an enforcing pass and reserves code 1 for tool errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartograph-policy-cli-errors-"));
    temporaryDirectories.push(root);
    const policyPath = join(root, "policy.json");
    const snapshotPath = join(root, "snapshot.json");
    await writeFile(policyPath, JSON.stringify(policy("enforce", "absent")));
    await writeFile(snapshotPath, JSON.stringify(snapshot));

    const pass = await runEntrypoint([
      "policy",
      root,
      "--policy",
      "policy.json",
      "--snapshot",
      snapshotPath,
    ]);
    const invalid = await runEntrypoint([
      "policy",
      root,
      "--policy",
      "missing.json",
      "--snapshot",
      snapshotPath,
    ]);
    const missingInput = await runEntrypoint([
      "policy",
      root,
      "--policy",
      "policy.json",
    ]);

    expect(pass.code).toBe(0);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("cartograph [configuration-error]");
    expect(missingInput.code).toBe(1);
    expect(missingInput.stderr).toContain("cartograph [cli-input]");
  });
});
