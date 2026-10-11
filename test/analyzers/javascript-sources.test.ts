import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeTypeScriptRepository } from "../../src/analyzers/typescript.js";

const roots: string[] = [];

const scan = (files: Record<string, string>) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cartograph-js-")));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return analyzeTypeScriptRepository({ rootDir: root });
};

const modules = (snapshot: ReturnType<typeof scan>): string[] =>
  snapshot.nodes
    .filter(
      (node) =>
        node.kind === "module" && !node.id.startsWith("module:external:"),
    )
    .map((node) => `${node.id} ${node.language ?? ""}`);

const imports = (snapshot: ReturnType<typeof scan>): string[] =>
  snapshot.edges
    .filter((edge) => edge.kind === "imports")
    .map((edge) => `${edge.from} -> ${edge.to}`);

const compilerOptions = {
  module: "NodeNext",
  moduleResolution: "NodeNext",
  target: "ES2022",
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("JavaScript sources", () => {
  it("keeps declaration files from suppressing JavaScript discovery", () => {
    const snapshot = scan({
      "types.d.ts": "export declare function plain(): void;\n",
      "types.d.mts": "export declare function esm(): void;\n",
      "types.d.cts": "export declare function cjs(): void;\n",
      "src/index.js": "export const run = () => 1;\n",
    });

    expect(modules(snapshot)).toEqual(["module:src/index.js javascript"]);
    expect(
      snapshot.nodes
        .filter((node) => node.kind === "function")
        .map((node) => node.id),
    ).toEqual(["function:src/index.js:run"]);
  });

  it("excludes every declaration extension selected by a tsconfig", () => {
    const snapshot = scan({
      "tsconfig.json": JSON.stringify({ compilerOptions, include: ["src"] }),
      "src/types.d.ts": "export declare function plain(): void;\n",
      "src/types.d.mts": "export declare function esm(): void;\n",
      "src/types.d.cts": "export declare function cjs(): void;\n",
      "src/esm.mts": "export const esm = () => 1;\n",
      "src/cjs.cts": "export const cjs = () => 1;\n",
    });

    expect(modules(snapshot)).toEqual([
      "module:src/cjs.cts typescript",
      "module:src/esm.mts typescript",
    ]);
  });

  it("scans a JavaScript project with no config, including CommonJS", () => {
    const snapshot = scan({
      "src/app.js":
        'import { total } from "./math.js";\nexport const run = () => total([1, 2]);\n',
      "src/math.js":
        "export const add = (a, b) => a + b;\nexport const total = (xs) => xs.reduce(add, 0);\n",
      "lib/helper.cjs":
        'const { add } = require("../src/math.js");\nmodule.exports = { twice: (x) => add(x, x) };\n',
    });
    expect(modules(snapshot)).toEqual([
      "module:lib/helper.cjs javascript",
      "module:src/app.js javascript",
      "module:src/math.js javascript",
    ]);
    expect(imports(snapshot)).toEqual([
      "module:lib/helper.cjs -> module:src/math.js",
      "module:src/app.js -> module:src/math.js",
    ]);
    expect(
      snapshot.edges.some(
        (edge) =>
          edge.kind === "calls" && edge.to === "function:src/math.js:total",
      ),
    ).toBe(true);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it("uses jsconfig.json when there is no tsconfig", () => {
    const snapshot = scan({
      "jsconfig.json": JSON.stringify({ compilerOptions, include: ["src"] }),
      "src/a.js": 'import { b } from "./b.js";\nexport const a = () => b();\n',
      "src/b.js": "export const b = () => 1;\n",
      "scripts/tool.js": "export const tool = () => 1;\n",
    });
    expect(modules(snapshot)).toEqual([
      "module:src/a.js javascript",
      "module:src/b.js javascript",
    ]);
  });

  it("follows allowJs in tsconfig and prefers .ts for a .js specifier", () => {
    const files = {
      "src/index.ts":
        'import { legacy } from "./legacy.js";\nimport { util } from "./util.js";\nexport const run = (): number => legacy() + util();\n',
      "src/legacy.js": "export const legacy = () => 1;\n",
      "src/util.ts": "export const util = (): number => 2;\n",
      "src/util.js": "export const util = () => 3;\n",
    };
    const withoutJs = scan({
      "tsconfig.json": JSON.stringify({ compilerOptions, include: ["src"] }),
      ...files,
    });
    expect(modules(withoutJs)).toEqual([
      "module:src/index.ts typescript",
      "module:src/util.ts typescript",
    ]);

    const withJs = scan({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { ...compilerOptions, allowJs: true },
        include: ["src"],
      }),
      ...files,
    });
    // TypeScript drops util.js from the program because util.ts shadows it.
    expect(modules(withJs)).toEqual([
      "module:src/index.ts typescript",
      "module:src/legacy.js javascript",
      "module:src/util.ts typescript",
    ]);
    expect(imports(withJs)).toEqual([
      "module:src/index.ts -> module:src/legacy.js",
      "module:src/index.ts -> module:src/util.ts",
    ]);
  });

  it("keeps a TypeScript project without config TypeScript-only", () => {
    const snapshot = scan({
      "src/a.ts": "export const a = (): number => 1;\n",
      "eslint.config.js": "export default [];\n",
    });
    expect(modules(snapshot)).toEqual(["module:src/a.ts typescript"]);
  });
});
