import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("composes repository-local includes before evaluating the graph", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cartograph-policy-cli-composition-"),
    );
    temporaryDirectories.push(root);
    const policyPath = join(root, "policy.json");
    const includedPath = join(root, "included.json");
    const snapshotPath = join(root, "snapshot.json");
    const reportPath = join(root, "report.json");
    await writeFile(
      policyPath,
      JSON.stringify({
        schemaVersion: 1,
        policyId: "policy-cli-composition",
        version: "1.0.0",
        includes: [{ path: "included.json" }],
        rules: [
          {
            id: "endpoint-forbidden",
            target: "node",
            selector: { kind: "endpoint" },
            assertion: "absent",
          },
        ],
      }),
    );
    await writeFile(
      includedPath,
      JSON.stringify({
        schemaVersion: 1,
        policyId: "included-policy",
        version: "1.0.0",
        rules: [
          {
            id: "module-required",
            target: "node",
            selector: { kind: "module" },
            assertion: "exists",
          },
        ],
      }),
    );
    await writeFile(snapshotPath, JSON.stringify(snapshot));

    const result = await runEntrypoint([
      "policy",
      root,
      "--policy",
      "policy.json",
      "--snapshot",
      snapshotPath,
      "--output",
      reportPath,
    ]);

    expect(result).toMatchObject({ code: 0, stderr: "", stdout: "" });
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
      status: "passed",
      evaluatedRules: 2,
      passedRules: 2,
    });
  });

  it("uses an explicit as-of date for expiry-bound exceptions", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cartograph-policy-cli-exception-"),
    );
    temporaryDirectories.push(root);
    const policyPath = join(root, "policy.json");
    const snapshotPath = join(root, "snapshot.json");
    const activeReportPath = join(root, "active.json");
    const expiredReportPath = join(root, "expired.json");
    await writeFile(
      policyPath,
      JSON.stringify({
        schemaVersion: 1,
        policyId: "policy-cli-exception",
        version: "1.0.0",
        mode: "enforce",
        rules: [
          {
            id: "endpoint-required",
            target: "node",
            selector: { kind: "endpoint" },
            assertion: "exists",
          },
        ],
        exceptions: [
          {
            schemaVersion: 1,
            contract: "cartograph.policy-exception",
            id: "migration-window",
            ruleId: "endpoint-required",
            scope: { target: "node", selector: { kind: "endpoint" } },
            rationale: "bounded migration",
            owner: "architecture-team",
            createdAt: "2026-08-01T00:00:00.000Z",
            expiresAt: "2026-09-01T00:00:00.000Z",
            precedence: 5,
          },
        ],
      }),
    );
    await writeFile(snapshotPath, JSON.stringify(snapshot));

    const active = await runEntrypoint([
      "policy",
      root,
      "--policy",
      "policy.json",
      "--snapshot",
      snapshotPath,
      "--as-of",
      "2026-08-24T00:00:00.000Z",
      "--output",
      activeReportPath,
    ]);
    const expired = await runEntrypoint([
      "policy",
      root,
      "--policy",
      "policy.json",
      "--snapshot",
      snapshotPath,
      "--as-of",
      "2026-09-02T00:00:00.000Z",
      "--output",
      expiredReportPath,
    ]);

    expect(active).toMatchObject({ code: 0, stderr: "", stdout: "" });
    expect(expired).toMatchObject({ code: 2, stderr: "", stdout: "" });
    expect(JSON.parse(await readFile(activeReportPath, "utf8"))).toMatchObject({
      status: "passed",
      exceptions: [
        expect.objectContaining({ status: "active", suppresses: true }),
      ],
    });
    expect(JSON.parse(await readFile(expiredReportPath, "utf8"))).toMatchObject(
      {
        status: "violations",
        exceptions: [
          expect.objectContaining({ status: "expired", suppresses: false }),
        ],
      },
    );
  });

  it("loads a local ADR document for required policy bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartograph-policy-cli-adr-"));
    temporaryDirectories.push(root);
    const policyPath = join(root, "policy.json");
    const snapshotPath = join(root, "snapshot.json");
    const adrPath = join(root, "adr.json");
    const adrFile = join(root, "docs/adr/decision.md");
    await mkdir(dirname(adrFile), { recursive: true });
    await writeFile(
      adrFile,
      "# ADR 0001: Keep module a\n\n- Status: accepted\n",
    );
    await writeFile(
      adrPath,
      JSON.stringify({
        schemaVersion: 1,
        references: [
          {
            id: "ADR-0001",
            file: "docs/adr/decision.md",
            title: "Keep module a",
            status: "accepted",
            graphIds: ["module:a"],
          },
        ],
      }),
    );
    await writeFile(
      policyPath,
      JSON.stringify({
        schemaVersion: 1,
        policyId: "policy-cli-adr",
        version: "1.0.0",
        mode: "enforce",
        rules: [
          {
            id: "module-required",
            target: "node",
            selector: { id: "module:a" },
            assertion: "exists",
          },
        ],
        adrBindings: [
          {
            schemaVersion: 1,
            contract: "cartograph.policy-adr-binding",
            id: "module-adr",
            ruleId: "module-required",
            requirement: "boundary",
            scope: { target: "node", selector: { id: "module:a" } },
            referenceId: "ADR-0001",
          },
        ],
      }),
    );
    await writeFile(snapshotPath, JSON.stringify(snapshot));

    const missing = await runEntrypoint([
      "policy",
      root,
      "--policy",
      "policy.json",
      "--snapshot",
      snapshotPath,
    ]);
    const valid = await runEntrypoint([
      "policy",
      root,
      "--policy",
      "policy.json",
      "--snapshot",
      snapshotPath,
      "--adr",
      "adr.json",
    ]);

    expect(missing.code).toBe(2);
    expect(valid.code).toBe(0);
    expect(valid.stderr).toBe("");
    expect(JSON.parse(valid.stdout)).toMatchObject({
      status: "passed",
      violations: [],
    });
  });
});
