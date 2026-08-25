import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  diffRepositoryRevisions,
  diffSnapshotFiles,
  loadSnapshot,
  scanRepository,
  writeOutputFile,
} from "../../src/commands.js";
import { parseGraphDiff } from "../../src/core/index.js";
import { parseCartographConfig } from "../../src/core/index.js";

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/typescript-express",
);
const temporaryDirectories: string[] = [];

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  return await new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveOutput(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf8")));
    });
  });
}

async function createDiffRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cartograph-cli-test-"));
  temporaryDirectories.push(root);
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.name", "CARTOGRAPH Test"], root);
  await run("git", ["config", "user.email", "test@example.invalid"], root);
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
    }),
    "utf8",
  );
  await writeFile(
    join(root, "app.ts"),
    "export const checkout = (): string => 'ok';\n",
    "utf8",
  );
  await run("git", ["add", "."], root);
  await run("git", ["commit", "-m", "add checkout"], root);
  await writeFile(
    join(root, "app.ts"),
    "export const checkout = async (): Promise<Response> => await fetch('https://payments.example/check');\n",
    "utf8",
  );
  await run("git", ["add", "app.ts"], root);
  await run("git", ["commit", "-m", "add payment request"], root);
  return root;
}

async function createAdrDiffRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cartograph-cli-adr-test-"));
  temporaryDirectories.push(root);
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.name", "CARTOGRAPH Test"], root);
  await run("git", ["config", "user.email", "test@example.invalid"], root);
  await mkdir(join(root, "docs/adr"), { recursive: true });
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
    }),
    "utf8",
  );
  await writeFile(
    join(root, "app.ts"),
    "export const checkout = (): string => 'ok';\n",
    "utf8",
  );
  await writeFile(
    join(root, "docs/adr/0001-checkout.md"),
    "# ADR 0001: Checkout\n\n- Status: proposed\n",
    "utf8",
  );
  await writeFile(
    join(root, "adr.json"),
    JSON.stringify({
      schemaVersion: 1,
      references: [
        {
          id: "ADR-0001",
          file: "docs/adr/0001-checkout.md",
          title: "Checkout",
          status: "proposed",
          graphIds: ["module:app.ts"],
        },
      ],
    }),
    "utf8",
  );
  await run("git", ["add", "."], root);
  await run("git", ["commit", "-m", "add checkout ADR"], root);
  await writeFile(
    join(root, "app.ts"),
    "export const checkout = async (): Promise<Response> => await fetch('https://payments.example/check');\n",
    "utf8",
  );
  await writeFile(
    join(root, "docs/adr/0001-checkout.md"),
    "# ADR 0001: Checkout\n\n- Status: accepted\n",
    "utf8",
  );
  await writeFile(
    join(root, "adr.json"),
    JSON.stringify({
      schemaVersion: 1,
      references: [
        {
          id: "ADR-0001",
          file: "docs/adr/0001-checkout.md",
          title: "Checkout",
          status: "accepted",
          graphIds: ["module:app.ts"],
        },
      ],
    }),
    "utf8",
  );
  await run("git", ["add", "."], root);
  await run("git", ["commit", "-m", "accept checkout ADR"], root);
  return root;
}

async function createRenameDiffRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cartograph-cli-rename-test-"));
  temporaryDirectories.push(root);
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.name", "CARTOGRAPH Test"], root);
  await run("git", ["config", "user.email", "test@example.invalid"], root);
  await writeFile(
    join(root, "old.ts"),
    "export const load = (): string => 'ok';\n",
    "utf8",
  );
  await run("git", ["add", "old.ts"], root);
  await run("git", ["commit", "-m", "add old module"], root);
  await run("git", ["mv", "old.ts", "new.ts"], root);
  await run("git", ["commit", "-m", "move module"], root);
  return root;
}

async function createBranchComparisonRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cartograph-cli-branch-test-"));
  temporaryDirectories.push(root);
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.name", "CARTOGRAPH Test"], root);
  await run("git", ["config", "user.email", "test@example.invalid"], root);
  await writeFile(
    join(root, "app.ts"),
    "export const value = 'base';\n",
    "utf8",
  );
  await run("git", ["add", "app.ts"], root);
  await run("git", ["commit", "-m", "base"], root);
  await run("git", ["branch", "feature"], root);
  await run("git", ["checkout", "feature"], root);
  await writeFile(
    join(root, "app.ts"),
    "export const value = 'feature';\n",
    "utf8",
  );
  await run("git", ["add", "app.ts"], root);
  await run("git", ["commit", "-m", "feature change"], root);
  await run("git", ["checkout", "main"], root);
  await writeFile(
    join(root, "app.ts"),
    "export const value = 'main';\n",
    "utf8",
  );
  await run("git", ["add", "app.ts"], root);
  await run("git", ["commit", "-m", "main change"], root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("command orchestration", () => {
  it("scans a working tree into a canonical snapshot", () => {
    const snapshot = scanRepository({ root: fixtureRoot });

    expect(snapshot.revision.commitSha).toBe("working-tree");
    expect(snapshot.nodes.some((node) => node.kind === "endpoint")).toBe(true);
    expect(snapshot.edges.every((edge) => edge.evidence.length > 0)).toBe(true);
  });

  it("rejects a TypeScript configuration outside the analyzed root", () => {
    expect(() =>
      scanRepository({ root: fixtureRoot, tsconfigPath: "/etc/passwd" }),
    ).toThrow("must stay inside the analyzed repository");
  });

  it("diffs two Git revisions without a checkout", async () => {
    const root = await createDiffRepository();
    const report = await diffRepositoryRevisions({
      base: "HEAD~1",
      format: "json",
      head: "HEAD",
      root,
    });
    const diff = parseGraphDiff(JSON.parse(report) as unknown);

    expect(diff.fromRevision.commitSha).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(diff.toRevision.commitSha).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(diff.comparison).toMatchObject({
      mode: "direct",
      baseRef: "HEAD~1",
      headRef: "HEAD",
      baseCommitSha: diff.fromRevision.commitSha,
      headCommitSha: diff.toRevision.commitSha,
    });
    const request = diff.edges.added.find((edge) => edge.kind === "requests");
    expect(request).toMatchObject({
      confidence: "certain",
      from: "function:app.ts:checkout",
      kind: "requests",
      to: "external_service:https://payments.example",
    });
    expect(request?.evidence.length).toBeGreaterThan(0);
  });

  it("adds local ADR titles, states, and graph evidence to revision reports", async () => {
    const root = await createAdrDiffRepository();
    const report = await diffRepositoryRevisions({
      adr: "adr.json",
      base: "HEAD~1",
      format: "markdown",
      head: "HEAD",
      root,
    });

    expect(report).toContain("## ADR references");
    expect(report).toContain("ADR-0001");
    expect(report).toContain("accepted");
    expect(report).toContain("docs/adr/0001-checkout.md");
    expect(report).toContain("module:app.ts");
    expect(report).toContain("changed");
  });

  it("records merge-base pull-request semantics and exact revisions", async () => {
    const root = await createBranchComparisonRepository();
    const report = await diffRepositoryRevisions({
      base: "main",
      comparison: "merge-base",
      format: "json",
      head: "feature",
      root,
    });
    const diff = parseGraphDiff(JSON.parse(report) as unknown);

    expect(diff.comparison).toMatchObject({
      mode: "merge-base",
      baseRef: "main",
      headRef: "feature",
      mergeBaseSha: diff.fromRevision.commitSha,
      headCommitSha: diff.toRevision.commitSha,
    });
    expect(diff.comparison?.baseCommitSha).not.toBe(
      diff.comparison?.mergeBaseSha,
    );
    expect(diff.fromRevision.commitSha).not.toBe(diff.toRevision.commitSha);
  });

  it("uses local Git rename history to explain moved snapshot identities", async () => {
    const root = await createRenameDiffRepository();
    const report = await diffRepositoryRevisions({
      base: "HEAD~1",
      format: "json",
      head: "HEAD",
      root,
    });
    const diff = parseGraphDiff(JSON.parse(report) as unknown);

    expect(diff.nodes.added).toEqual([]);
    expect(diff.nodes.removed).toEqual([]);
    expect(diff.identity.matches.length).toBeGreaterThan(0);
    expect(
      diff.identity.matches.some((match) =>
        match.signals.includes("path-history"),
      ),
    ).toBe(true);
  });

  it("diffs two snapshot paths without invoking Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartograph-snapshot-diff-"));
    temporaryDirectories.push(root);
    const beforePath = join(root, "before.json");
    const afterPath = join(root, "after.json");
    const snapshot = scanRepository({ root: fixtureRoot });
    await writeFile(beforePath, JSON.stringify(snapshot), "utf8");
    await writeFile(afterPath, JSON.stringify(snapshot), "utf8");

    const report = await diffSnapshotFiles(beforePath, afterPath, "json");
    const diff = parseGraphDiff(JSON.parse(report) as unknown);
    expect(diff.fromRevision.commitSha).toBe("working-tree");
    expect(diff.toRevision.commitSha).toBe("working-tree");
    expect(diff.nodes.added).toHaveLength(0);
    expect(diff.edges.added).toHaveLength(0);
  });

  it("fails closed when a local base ref is missing", async () => {
    const root = await createDiffRepository();

    await expect(
      diffRepositoryRevisions({
        base: "missing-local-ref",
        format: "json",
        head: "HEAD",
        root,
      }),
    ).rejects.toThrow(/failed/u);
  });

  it("loads canonical snapshots and refuses to overwrite output by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartograph-output-test-"));
    temporaryDirectories.push(root);
    const snapshotPath = join(root, "snapshot.json");
    const snapshot = scanRepository({ root: fixtureRoot });
    await writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");

    await expect(loadSnapshot(snapshotPath)).resolves.toMatchObject({
      schemaVersion: 1,
    });
    await expect(
      writeOutputFile(snapshotPath, "replacement", false),
    ).rejects.toMatchObject({
      code: "EEXIST",
    });
    await writeOutputFile(snapshotPath, "replacement", true);
    await expect(readFile(snapshotPath, "utf8")).resolves.toBe("replacement");
  });

  it("rejects snapshots larger than the input resource limit", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cartograph-snapshot-limit-test-"),
    );
    temporaryDirectories.push(root);
    const snapshotPath = join(root, "oversized.json");

    await writeFile(snapshotPath, "{}", "utf8");
    await truncate(snapshotPath, 64 * 1024 * 1024 + 1);

    await expect(loadSnapshot(snapshotPath)).rejects.toThrow(
      "snapshot exceeds the 64 MiB input limit",
    );
  });

  it("fails closed when the report cardinality ceiling is exceeded", () => {
    expect(() =>
      scanRepository({
        root: fixtureRoot,
        config: parseCartographConfig({
          schemaVersion: 1,
          resources: { maxReportItems: 1 },
        }).config,
      }),
    ).toThrowError("report exceeds the 1 item report-cardinality ceiling");
  });

  it("never follows an output symlink when force is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartograph-output-link-test-"));
    temporaryDirectories.push(root);
    const targetPath = join(root, "target.txt");
    const outputPath = join(root, "report.txt");
    await writeFile(targetPath, "keep me", "utf8");
    await symlink(targetPath, outputPath);

    await expect(
      writeOutputFile(outputPath, "replacement", true),
    ).rejects.toThrow("must not be a symbolic link");
    await expect(readFile(targetPath, "utf8")).resolves.toBe("keep me");
  });

  it("rejects an output path with a symlinked parent component", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cartograph-output-parent-link-test-"),
    );
    const targetRoot = await mkdtemp(
      join(tmpdir(), "cartograph-output-parent-target-test-"),
    );
    temporaryDirectories.push(root, targetRoot);
    const targetPath = join(targetRoot, "report.txt");
    const parentPath = join(root, "reports");
    const outputPath = join(parentPath, "report.txt");
    await writeFile(targetPath, "keep me", "utf8");
    await symlink(targetRoot, parentPath, "dir");

    await expect(
      writeOutputFile(outputPath, "replacement", true),
    ).rejects.toThrow("must not contain a symbolic link");
    await expect(readFile(targetPath, "utf8")).resolves.toBe("keep me");
  });
});
