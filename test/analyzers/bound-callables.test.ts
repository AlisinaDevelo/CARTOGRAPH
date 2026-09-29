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

describe("functions bound to class fields and wrapped initializers", () => {
  it("registers them and resolves calls through them", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cartograph-bound-")));
    roots.push(root);
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
        },
        include: ["src"],
      }),
    );
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src/a.ts"),
      [
        "type Validate = (value: unknown) => boolean;",
        "export class Schema {",
        "  static create = (): Schema => new Schema();",
        "  handle = (value: unknown): unknown => value;",
        "}",
        "export const validate = ((value: unknown): boolean => value !== null) as Validate;",
        "const createSchema = Schema.create;",
        "export const make = () =>",
        "  class Inner {",
        "    run = (): number => 1;",
        "  };",
        "export const use = (): unknown => {",
        "  const schema = createSchema();",
        "  validate(1);",
        "  return schema.handle(2);",
        "};",
        "",
      ].join("\n"),
    );
    const snapshot = analyzeTypeScriptRepository({ rootDir: root });
    expect(
      snapshot.nodes
        .filter((node) => node.kind === "function")
        .map((node) => node.id),
    ).toEqual([
      "function:src/a.ts:Schema.create",
      "function:src/a.ts:Schema.handle",
      "function:src/a.ts:make",
      "function:src/a.ts:make.run",
      "function:src/a.ts:use",
      "function:src/a.ts:validate",
    ]);
    expect(
      snapshot.edges
        .filter((edge) => edge.kind === "calls")
        .map((edge) => `${edge.from} -> ${edge.to}`),
    ).toEqual([
      "function:src/a.ts:use -> function:src/a.ts:Schema.create",
      "function:src/a.ts:use -> function:src/a.ts:Schema.handle",
      "function:src/a.ts:use -> function:src/a.ts:validate",
    ]);
    expect(snapshot.diagnostics).toEqual([]);
  });
});
