import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/fixture-provenance.mjs");

const createTemporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(repositoryRoot, ".tmp-fixture-provenance-"));
  await cp(
    resolve(repositoryRoot, "test/fixtures"),
    join(root, "test/fixtures"),
    {
      recursive: true,
    },
  );
  await cp(resolve(repositoryRoot, "schema"), join(root, "schema"), {
    recursive: true,
  });
  return root;
};

describe("fixture provenance validator", () => {
  it("validates every checked-in fixture and generated-directory reason", () => {
    const output = execFileSync(process.execPath, [scriptPath, "validate"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      fixtures: 52,
      generatedDirectories: 8,
    });
  });

  it("fails when a fixture entry is missing", async () => {
    const root = await createTemporaryRoot();
    try {
      const manifestPath = join(root, "test/fixtures/provenance.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        fixtures: Array<{ id: string }>;
      };
      manifest.fixtures = manifest.fixtures.filter(
        (entry) => entry.id !== "secrets",
      );
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

      expect(() =>
        execFileSync(
          process.execPath,
          [scriptPath, "validate", "--root", root],
          { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" },
        ),
      ).toThrow(/fixtures missing provenance: secrets/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when generated output has no declared reason", async () => {
    const root = await createTemporaryRoot();
    try {
      const manifestPath = join(root, "test/fixtures/provenance.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        fixtures: Array<{
          id: string;
          generated?: Array<{ path: string; reason: string }>;
        }>;
      };
      const exclusions = manifest.fixtures.find(
        (entry) => entry.id === "exclusions",
      );
      if (!exclusions?.generated)
        throw new Error("fixture manifest test setup");
      exclusions.generated = exclusions.generated.filter(
        (entry) => entry.path !== "dist",
      );
      await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

      expect(() =>
        execFileSync(
          process.execPath,
          [scriptPath, "validate", "--root", root],
          { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" },
        ),
      ).toThrow(/generated output lacks a declared reason: exclusions\/dist/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
