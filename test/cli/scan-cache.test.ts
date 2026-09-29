import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diffRepositoryRevisions } from "../../src/commands.js";
import { defaultCartographConfig } from "../../src/core/index.js";
import { analyzerFingerprint, scanCacheKey } from "../../src/scan-cache.js";

const roots: string[] = [];
const temporary = (prefix: string): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(path);
  return path;
};

const git = (root: string, args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();

const repository = (): string => {
  const root = temporary("cartograph-cache-repo-");
  git(root, ["init", "-q"]);
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["src"],
    }),
  );
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "export const a = (): number => 1;\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  writeFileSync(
    join(root, "src/b.ts"),
    'import { a } from "./a.js";\nexport const b = (): number => a();\n',
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "head"]);
  return root;
};

const diff = (root: string, cacheDir: string, exclude: string[] = []) =>
  diffRepositoryRevisions({
    root,
    base: "HEAD~1",
    head: "HEAD",
    format: "json",
    cacheDir,
    config: { ...defaultCartographConfig(), exclude },
  });

const cachedFiles = (cacheDir: string): string[] =>
  readdirSync(cacheDir)
    .filter((name) => name.endsWith(".graph.json"))
    .sort();

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("revision snapshot cache", () => {
  it("stores one snapshot per revision and reuses it", async () => {
    const root = repository();
    const cacheDir = join(temporary("cartograph-cache-"), "snapshots");
    const first = await diff(root, cacheDir);
    const files = cachedFiles(cacheDir);
    expect(files).toHaveLength(2);

    // Plant a marker in the head snapshot: a second run must read it back.
    const headCommit = git(root, ["rev-parse", "HEAD"]);
    const headFile = files
      .map((name) => join(cacheDir, name))
      .find((path) => readFileSync(path, "utf8").includes(headCommit));
    if (headFile === undefined) throw new Error("head snapshot not cached");
    const planted = readFileSync(headFile, "utf8").replace(
      '"name":"b"',
      '"name":"b-from-cache"',
    );
    expect(planted).toContain("b-from-cache");
    writeFileSync(headFile, planted);
    expect(await diff(root, cacheDir)).toContain("b-from-cache");
    expect(first).not.toContain("b-from-cache");
  });

  it("rescans when the configuration changes", async () => {
    const root = repository();
    const cacheDir = join(temporary("cartograph-cache-"), "snapshots");
    await diff(root, cacheDir);
    await diff(root, cacheDir, ["src/b.ts"]);
    expect(cachedFiles(cacheDir)).toHaveLength(4);
  });

  it("ignores cached files that are corrupt or belong to another commit", async () => {
    const root = repository();
    const cacheDir = join(temporary("cartograph-cache-"), "snapshots");
    const clean = await diff(root, cacheDir);
    const [firstFile, secondFile] = cachedFiles(cacheDir).map((name) =>
      join(cacheDir, name),
    );
    if (firstFile === undefined || secondFile === undefined)
      throw new Error("expected two cached snapshots");
    const other = readFileSync(secondFile, "utf8");
    writeFileSync(firstFile, other);
    writeFileSync(secondFile, "{not json");
    expect(await diff(root, cacheDir)).toBe(clean);
  });

  it("keys on every scan input", () => {
    const base = {
      analyzer: analyzerFingerprint(),
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      config: defaultCartographConfig(),
    };
    const key = scanCacheKey(base);
    expect(key).toMatch(/^cartograph-scan-v1-[0-9a-f]{64}$/u);
    expect(scanCacheKey({ ...base })).toBe(key);
    for (const changed of [
      { ...base, analyzer: "other" },
      { ...base, commitSha: "c".repeat(40) },
      { ...base, treeSha: "d".repeat(40) },
      { ...base, tsconfigPath: "tsconfig.build.json" },
      {
        ...base,
        config: {
          ...base.config,
          resources: { ...base.config.resources, maxFiles: 10 },
        },
      },
      { ...base, config: { ...base.config, exclude: ["dist/**"] } },
    ])
      expect(scanCacheKey(changed)).not.toBe(key);
  });
});
