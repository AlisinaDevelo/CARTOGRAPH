import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCli } from "../../src/cli.js";
import { scanRepository, serializeScan } from "../../src/commands.js";
import { nodeReference } from "../../src/query-command.js";

const roots: string[] = [];

const snapshotOf = (files: Record<string, string>): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cartograph-query-")));
  roots.push(root);
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include: ["src"],
    }),
  );
  mkdirSync(join(root, "src"));
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(root, "src", name), content);
  const snapshotPath = join(root, "graph.json");
  writeFileSync(snapshotPath, serializeScan(scanRepository({ root })));
  return snapshotPath;
};

const cyclic = {
  "a.ts": 'import { b } from "./b.js";\nexport const a = (): number => b();\n',
  "b.ts": 'import { c } from "./c.js";\nexport const b = (): number => c();\n',
  "c.ts":
    'import { a } from "./a.js";\nexport const c = (): number => (Date.now() < 0 ? a() : 0);\n',
};

const run = async (
  args: string[],
): Promise<{ output: string; exitCode: number | undefined }> => {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await createCli().parseAsync(["query", ...args], { from: "user" });
    return { output, exitCode: process.exitCode };
  } finally {
    process.exitCode = previous;
  }
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("query command", () => {
  it.each([
    ["src/missing.ts", "src/b.ts"],
    ["src/a.ts", "src/missing.ts"],
  ])("fails when a path endpoint is missing: %s to %s", async (from, to) => {
    const snapshot = snapshotOf(cyclic);
    const result = await run([
      "--snapshot",
      snapshot,
      "--from",
      from,
      "--to",
      to,
      "--format",
      "json",
      "--fail-on-match",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      status: "error",
      paths: [],
      diagnostics: [expect.objectContaining({ code: "QUERY_NODE_NOT_FOUND" })],
    });
  });

  it("passes the gate when existing endpoints have no dependency path", async () => {
    const snapshot = snapshotOf({
      "a.ts": "export const a = 1;\n",
      "b.ts": "export const b = 2;\n",
    });
    const result = await run([
      "--snapshot",
      snapshot,
      "--from",
      "src/a.ts",
      "--to",
      "src/b.ts",
      "--format",
      "json",
      "--fail-on-match",
    ]);
    expect(result.exitCode).toBeUndefined();
    expect(JSON.parse(result.output)).toMatchObject({
      status: "ok",
      paths: [],
      diagnostics: [expect.objectContaining({ code: "QUERY_PATH_NOT_FOUND" })],
    });
  });

  it("reports module import cycles and gates on them", async () => {
    const snapshot = snapshotOf(cyclic);

    const markdown = await run(["--snapshot", snapshot, "--cycles"]);
    expect(markdown.exitCode).toBeUndefined();
    expect(markdown.output).toContain("## Cycles (1)");
    expect(markdown.output).toContain("module:src/a.ts");

    const json = await run([
      "--snapshot",
      snapshot,
      "--cycles",
      "--format",
      "json",
      "--fail-on-match",
    ]);
    expect(json.exitCode).toBe(2);
    const result = JSON.parse(json.output) as {
      status: string;
      cycles: { nodes: string[] }[];
    };
    expect(result.status).toBe("ok");
    expect(result.cycles.map((cycle) => cycle.nodes)).toEqual([
      [
        "module:src/a.ts",
        "module:src/b.ts",
        "module:src/c.ts",
        "module:src/a.ts",
      ],
    ]);
  });

  it("passes the cycle gate for an acyclic graph", async () => {
    const snapshot = snapshotOf({
      "a.ts":
        'import { b } from "./b.js";\nexport const a = (): number => b();\n',
      "b.ts": "export const b = (): number => 1;\n",
    });
    const result = await run([
      "--snapshot",
      snapshot,
      "--cycles",
      "--fail-on-match",
    ]);
    expect(result.exitCode).toBeUndefined();
    expect(result.output).toContain("No cycles found.");
  });

  it("finds a dependency path from module paths", async () => {
    const snapshot = snapshotOf(cyclic);
    const result = await run([
      "--snapshot",
      snapshot,
      "--from",
      "src/a.ts",
      "--to",
      "./src/c.ts",
      "--format",
      "json",
    ]);
    const parsed = JSON.parse(result.output) as {
      paths: { nodes: string[]; length: number }[];
    };
    expect(parsed.paths).toEqual([
      expect.objectContaining({
        length: 2,
        nodes: ["module:src/a.ts", "module:src/b.ts", "module:src/c.ts"],
      }),
    ]);
  });

  it("runs graph query language expressions", async () => {
    const snapshot = snapshotOf(cyclic);
    const result = await run([
      "--snapshot",
      snapshot,
      "--expr",
      "v1 nodes where kind = function",
      "--format",
      "json",
    ]);
    const parsed = JSON.parse(result.output) as { nodes: { id: string }[] };
    expect(parsed.nodes.map((node) => node.id)).toEqual([
      "function:src/a.ts:a",
      "function:src/b.ts:b",
      "function:src/c.ts:c",
    ]);
  });

  it("requires exactly one input and one query", async () => {
    const snapshot = snapshotOf(cyclic);
    const program = createCli();
    const query = program.commands.find(
      (command) => command.name() === "query",
    );
    query?.exitOverride().configureOutput({ writeErr: () => undefined });
    await expect(
      program.parseAsync(["query", "--snapshot", snapshot], { from: "user" }),
    ).rejects.toThrow("choose exactly one of");
    await expect(
      program.parseAsync(["query", "--cycles"], { from: "user" }),
    ).rejects.toThrow("exactly one of --snapshot or --diff");
  });

  it("maps bare module paths to module node references", () => {
    expect(nodeReference("src/a.ts")).toBe("module:src/a.ts");
    expect(nodeReference("./src/a.ts")).toBe("module:src/a.ts");
    expect(nodeReference("function:src/a.ts:a")).toBe("function:src/a.ts:a");
  });
});
