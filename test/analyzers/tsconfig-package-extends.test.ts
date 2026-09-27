import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeTypeScriptRepository } from "../../src/analyzers/typescript.js";

const roots: string[] = [];

const repository = (files: Record<string, string>): string => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cartograph-tsconfig-extends-")),
  );
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

const aliasBase = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    baseUrl: "../../..",
    paths: { "@lib/*": ["src/lib/*"] },
  },
});

const aliasSources = {
  "src/lib/util.ts": "export const util = (): number => 1;\n",
  "src/app.ts":
    'import { util } from "@lib/util.js";\nexport const app = (): number => util();\n',
};

const importsOf = (root: string): string[] =>
  analyzeTypeScriptRepository({ rootDir: root })
    .edges.filter((edge) => edge.kind === "imports")
    .map((edge) => `${edge.from} -> ${edge.to}`);

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("tsconfig extends of a package", () => {
  it("reads an installed base config named by the package's tsconfig field", () => {
    const root = repository({
      "tsconfig.json": JSON.stringify({
        extends: "@acme/tsconfig",
        include: ["src"],
      }),
      "node_modules/@acme/tsconfig/package.json": JSON.stringify({
        name: "@acme/tsconfig",
        tsconfig: "base.json",
      }),
      "node_modules/@acme/tsconfig/base.json": aliasBase,
      ...aliasSources,
    });
    expect(importsOf(root)).toContain(
      "module:src/app.ts -> module:src/lib/util.ts",
    );
  });

  it("reads an installed base config by its conventional file name", () => {
    const root = repository({
      "tsconfig.json": JSON.stringify({
        extends: "@acme/tsconfig/strict.json",
        include: ["src"],
      }),
      "node_modules/@acme/tsconfig/strict.json": aliasBase,
      ...aliasSources,
    });
    expect(importsOf(root)).toContain(
      "module:src/app.ts -> module:src/lib/util.ts",
    );
  });

  it("continues with a diagnostic when the package is not installed", () => {
    const root = repository({
      "tsconfig.json": `{\n  "extends": "@acme/tsconfig",\n  "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" },\n  "include": ["src"]\n}\n`,
      "src/a.ts": "export const a = (): number => 1;\n",
    });
    const snapshot = analyzeTypeScriptRepository({ rootDir: root });
    expect(snapshot.nodes.map((node) => node.id)).toContain("module:src/a.ts");
    const unresolved = snapshot.diagnostics.filter(
      (diagnostic) => diagnostic.code === "UNRESOLVED_TSCONFIG_EXTENDS",
    );
    expect(unresolved.map((diagnostic) => diagnostic.location)).toEqual([
      { path: "tsconfig.json", line: 2, column: 3 },
    ]);
    expect(unresolved[0]?.message).toContain("@acme/tsconfig");
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a symlinked install",
    () => {
      const outside = realpathSync(
        mkdtempSync(join(tmpdir(), "cartograph-tsconfig-outside-")),
      );
      roots.push(outside);
      writeFileSync(join(outside, "tsconfig.json"), aliasBase);
      const root = repository({
        "tsconfig.json": JSON.stringify({
          extends: "@acme/tsconfig",
          compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
          include: ["src"],
        }),
        ...aliasSources,
      });
      mkdirSync(join(root, "node_modules", "@acme"), { recursive: true });
      symlinkSync(outside, join(root, "node_modules", "@acme", "tsconfig"));
      const snapshot = analyzeTypeScriptRepository({ rootDir: root });
      expect(
        snapshot.diagnostics.map((diagnostic) => diagnostic.code),
      ).toContain("UNRESOLVED_TSCONFIG_EXTENDS");
    },
  );
});
