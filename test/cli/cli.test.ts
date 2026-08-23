import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCli } from "../../src/cli.js";
import { parseGraphSnapshot } from "../../src/core/index.js";

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/typescript-express",
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI", () => {
  it("exposes the supported command surface", () => {
    expect(createCli().commands.map((command) => command.name())).toEqual([
      "scan",
      "diff",
      "diff-snapshots",
    ]);
  });

  it("scans a repository to canonical JSON on stdout", async () => {
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    await createCli().parseAsync(["scan", fixtureRoot], { from: "user" });

    expect(parseGraphSnapshot(JSON.parse(output) as unknown)).toMatchObject({
      schemaVersion: 1,
      revision: { commitSha: "working-tree" },
    });
  });

  it("rejects unknown report formats before diffing", async () => {
    const program = createCli();
    const diffCommand = program.commands.find(
      (command) => command.name() === "diff",
    );
    expect(diffCommand).toBeDefined();
    diffCommand?.exitOverride().configureOutput({ writeErr: () => undefined });

    await expect(
      program.parseAsync(
        ["diff", fixtureRoot, "--base", "HEAD", "--format", "yaml"],
        { from: "user" },
      ),
    ).rejects.toThrow("format must be one of");
  });
});
