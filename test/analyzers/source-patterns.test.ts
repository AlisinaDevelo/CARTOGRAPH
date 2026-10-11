import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeTypeScriptRepository } from "../../src/analyzers/typescript.js";

const roots: string[] = [];
const repository = (withTsconfig: boolean): string => {
  const root = mkdtempSync(join(tmpdir(), "cartograph-source-patterns-"));
  roots.push(root);
  const files = {
    "root.ts": "export const root = () => 0;\n",
    "src/direct.ts": "export const direct = () => 1;\n",
    "src/deep/nested.ts": "export const nested = () => 2;\n",
    "src/generated.ts": "// @generated\nexport const generated = () => 3;\n",
  };
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  if (withTsconfig)
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ include: ["."] }),
    );
  return root;
};

const modules = (snapshot: ReturnType<typeof analyzeTypeScriptRepository>) =>
  snapshot.nodes
    .filter((node) => node.kind === "module")
    .map((node) => node.id);

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("source include and exclude patterns", () => {
  it.each([false, true])(
    "matches zero directories in **/ with tsconfig=%s",
    (withTsconfig) => {
      const snapshot = analyzeTypeScriptRepository({
        rootDir: repository(withTsconfig),
        include: ["src/**/*.ts"],
      });

      expect(modules(snapshot)).toEqual([
        "module:src/deep/nested.ts",
        "module:src/direct.ts",
        "module:src/generated.ts",
      ]);
      expect(
        snapshot.nodes.find((node) => node.id === "module:src/generated.ts")
          ?.language,
      ).toBe("typescript-generated");
      expect(snapshot.diagnostics).toEqual([]);
    },
  );

  it("matches repository-root source files with a leading **/", () => {
    const snapshot = analyzeTypeScriptRepository({
      rootDir: repository(false),
      include: ["**/*.ts"],
    });

    expect(modules(snapshot)).toEqual([
      "module:root.ts",
      "module:src/deep/nested.ts",
      "module:src/direct.ts",
      "module:src/generated.ts",
    ]);
  });

  it("applies the same zero-directory behavior to exclusion patterns", () => {
    const snapshot = analyzeTypeScriptRepository({
      rootDir: repository(true),
      exclude: ["src/**/direct.ts"],
    });

    expect(modules(snapshot)).toEqual([
      "module:root.ts",
      "module:src/deep/nested.ts",
      "module:src/generated.ts",
    ]);
  });

  it("keeps a single star within one directory", () => {
    const snapshot = analyzeTypeScriptRepository({
      rootDir: repository(false),
      include: ["src/*.ts"],
    });

    expect(modules(snapshot)).toEqual([
      "module:src/direct.ts",
      "module:src/generated.ts",
    ]);
  });
});
