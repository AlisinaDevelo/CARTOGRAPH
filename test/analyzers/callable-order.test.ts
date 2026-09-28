import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeTypeScriptRepository } from "../../src/analyzers/typescript.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("callable registration order", () => {
  it("keeps stable keys for nested and same-named callables", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "cartograph-callables-")),
    );
    roots.push(root);
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
        include: ["src"],
      }),
    );
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src/a.ts"),
      [
        "export class Service {",
        "  run(): number {",
        "    const step = (): number => 1;",
        "    return step();",
        "  }",
        "}",
        "export function outer(): number {",
        "  function inner(): number { return 1; }",
        "  const again = function inner(): number { return 2; };",
        "  return inner() + again();",
        "}",
        "export const curried = (a: number) => (b: number): number => a + b;",
        "",
      ].join("\n"),
    );
    const functions = analyzeTypeScriptRepository({ rootDir: root })
      .nodes.filter((node) => node.kind === "function")
      .map((node) => node.id);
    expect(functions).toEqual([
      "function:src/a.ts:Service.run",
      "function:src/a.ts:Service.run.step",
      "function:src/a.ts:curried",
      "function:src/a.ts:outer",
      "function:src/a.ts:outer.again",
      "function:src/a.ts:outer.inner",
    ]);
  });
});
