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
import {
  parseGraphInterchange,
  parseSarifLog,
  parseScipIndex,
} from "../../src/core/index.js";

const roots: string[] = [];

const repository = (): { root: string; snapshot: string } => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cartograph-export-")));
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
  writeFileSync(
    join(root, "src/ui.ts"),
    'import { query } from "./db.js";\nexport const page = (): number => query();\n',
  );
  writeFileSync(
    join(root, "src/db.ts"),
    "export const query = (): number => 1;\n",
  );
  writeFileSync(
    join(root, "policy.json"),
    JSON.stringify({
      policyId: "architecture",
      version: "1.0.0",
      mode: "enforce",
      rules: [
        {
          id: "ui-not-db",
          target: "edge",
          assertion: "absent",
          selector: { kind: "imports", to: "module:src/db.ts" },
        },
      ],
    }),
  );
  const snapshot = join(root, "graph.json");
  writeFileSync(snapshot, serializeScan(scanRepository({ root })));
  return { root, snapshot };
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
    await createCli().parseAsync(args, { from: "user" });
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

describe("export command", () => {
  it.each([
    ["graph-json", "json"],
    ["json-ld", "json-ld"],
    ["edge-list", "edge-list"],
  ] as const)("round-trips %s exports", async (cliFormat, format) => {
    const { snapshot } = repository();
    const { output } = await run([
      "export",
      "--snapshot",
      snapshot,
      "--format",
      cliFormat,
    ]);
    const parsed = parseGraphInterchange(
      format === "edge-list" ? output : (JSON.parse(output) as unknown),
      format,
    );
    expect(parsed.nodes.map((node) => node.id)).toContain("module:src/ui.ts");
  });

  it("exports a SCIP index", async () => {
    const { snapshot } = repository();
    const { output } = await run([
      "export",
      "--snapshot",
      snapshot,
      "--format",
      "scip",
    ]);
    const index = parseScipIndex(JSON.parse(output) as unknown);
    expect(index.documents.map((document) => document.relativePath)).toEqual([
      "src/db.ts",
      "src/ui.ts",
    ]);
  });

  it("rejects an unknown format", async () => {
    const { snapshot } = repository();
    const program = createCli();
    program.commands
      .find((command) => command.name() === "export")
      ?.exitOverride()
      .configureOutput({ writeErr: () => undefined });
    await expect(
      program.parseAsync(
        ["export", "--snapshot", snapshot, "--format", "dot"],
        { from: "user" },
      ),
    ).rejects.toThrow("format must be one of");
  });
});

describe("policy --format sarif", () => {
  it("emits line-local violations as SARIF and keeps the enforce exit code", async () => {
    const { root, snapshot } = repository();
    const { output, exitCode } = await run([
      "policy",
      root,
      "--policy",
      "policy.json",
      "--snapshot",
      snapshot,
      "--format",
      "sarif",
    ]);
    expect(exitCode).toBe(2);
    const log = parseSarifLog(JSON.parse(output) as unknown);
    expect(
      log.runs[0]?.results.map((result) => ({
        ruleId: result.ruleId,
        uri: result.locations[0]?.physicalLocation.artifactLocation.uri,
        line: result.locations[0]?.physicalLocation.region.startLine,
      })),
    ).toEqual([{ ruleId: "ui-not-db", uri: "src/ui.ts", line: 1 }]);
  });
});
