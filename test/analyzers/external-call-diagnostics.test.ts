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

const repository = (files: Record<string, string>): string => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cartograph-external-calls-")),
  );
  roots.push(root);
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        baseUrl: ".",
        paths: { "@app/*": ["src/*"] },
      },
      include: ["src"],
    }),
  );
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};

const unresolvedCallLines = (root: string): number[] =>
  analyzeTypeScriptRepository({ rootDir: root })
    .diagnostics.filter((diagnostic) => diagnostic.code === "UNRESOLVED_CALL")
    .map((diagnostic) => diagnostic.location?.line ?? 0)
    .sort((left, right) => left - right);

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("UNRESOLVED_CALL for package-originated call targets", () => {
  it("does not report calls whose callee comes from an uninstalled package", () => {
    const root = repository({
      "src/app.ts": [
        'import { z } from "zod";',
        'import * as React from "react";',
        'import { useTranslation } from "react-i18next";',
        'import { Command } from "commander";',
        "export const schema = z.object({ id: z.string() });",
        "export const Component = () => {",
        "  const [count, setCount] = React.useState(0);",
        "  const { t } = useTranslation();",
        "  setCount(count + 1);",
        '  return t("title");',
        "};",
        "export const cli = (): void => {",
        "  const program = new Command();",
        '  program.name("tool");',
        "};",
        "",
      ].join("\n"),
    });
    expect(unresolvedCallLines(root)).toEqual([]);
  });

  it("does not report callees reached through parameters", () => {
    const root = repository({
      "src/view.ts": [
        "type Props = { onSelect: (id: string) => void };",
        "export const view = (props: Props, { onClose }: { onClose: () => void }): void => {",
        '  props.onSelect("a");',
        "  onClose();",
        "};",
        "",
      ].join("\n"),
    });
    expect(unresolvedCallLines(root)).toEqual([]);
  });

  it("does not report calls to members declared only by a type", () => {
    const root = repository({
      "src/schema.ts": [
        "export interface Schema {",
        "  parse(value: unknown): unknown;",
        "  check: (value: unknown) => boolean;",
        "}",
        "export const make = (): Schema => ({ parse: (value) => value, check: () => true });",
        "const schema = make();",
        "export const use = (): unknown => (schema.check(1) ? schema.parse(1) : undefined);",
        "",
      ].join("\n"),
    });
    expect(unresolvedCallLines(root)).toEqual([]);
  });

  it("still reports unresolved calls rooted in repository code", () => {
    const root = repository({
      "src/local.ts": ["export const make = () => () => 1;", ""].join("\n"),
      "src/use.ts": [
        'import { make } from "@app/local.js";',
        "const handler = make();",
        "export const run = (): number => handler();",
        "",
      ].join("\n"),
    });
    expect(unresolvedCallLines(root)).toEqual([3]);
  });
});
