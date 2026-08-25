import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/language-equivalence.mjs");

const runValidator = (root = repositoryRoot): string =>
  execFileSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "validate", "--root", root],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

const createTemporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(
    join(repositoryRoot, ".tmp-language-equivalence-"),
  );
  await cp(
    resolve(repositoryRoot, "test/fixtures/language-equivalence"),
    join(root, "test/fixtures/language-equivalence"),
    { recursive: true },
  );
  await cp(
    resolve(repositoryRoot, "schema/language-equivalence.v0.1.schema.json"),
    join(root, "schema/language-equivalence.v0.1.schema.json"),
  );
  return root;
};

describe("cross-language semantic equivalence corpus", () => {
  it("validates every declared category, identity case, and evidence requirement", () => {
    const report = JSON.parse(runValidator()) as {
      ok: boolean;
      corpusId: string;
      cases: Array<{
        id: string;
        category: string;
        relation: string;
        typescript: { evidenceComplete: boolean };
        rust: { evidenceComplete: boolean };
        identity?: {
          typescript?: { matches: number };
          rust?: { matches: number };
        };
      }>;
      summary: {
        cases: number;
        equivalent: number;
        intentionalDifference: number;
        disagreements: number;
        evidenceComplete: boolean;
        identityMatches: number;
      };
    };

    expect(report).toMatchObject({
      ok: true,
      corpusId: "language-equivalence.v0.1",
      summary: {
        cases: 6,
        equivalent: 5,
        intentionalDifference: 1,
        disagreements: 0,
        evidenceComplete: true,
        identityMatches: 2,
      },
    });
    expect(report.cases.map((current) => current.category)).toEqual([
      "modules",
      "calls",
      "boundary",
      "identity",
      "evidence",
      "unknown",
    ]);
    expect(
      report.cases.every(
        (current) =>
          current.typescript.evidenceComplete && current.rust.evidenceComplete,
      ),
    ).toBe(true);
    expect(
      report.cases.find((current) => current.id === "unknown")?.relation,
    ).toBe("intentional-difference");
    expect(
      report.cases.find((current) => current.id === "identity")?.identity,
    ).toMatchObject({
      typescript: { matches: 1 },
      rust: { matches: 1 },
    });
  });

  it("reports expected-output drift with its semantic category", async () => {
    const root = await createTemporaryRoot();
    try {
      const fixturePath = join(
        root,
        "test/fixtures/language-equivalence/scenarios.v0.1.json",
      );
      const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
        cases: Array<{
          id: string;
          typescriptExpected: { edgeCounts: Record<string, number> };
        }>;
      };
      const modules = fixture.cases.find((current) => current.id === "modules");
      if (modules === undefined) throw new Error("modules case missing");
      modules.typescriptExpected.edgeCounts.calls = 99;
      await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

      expect(() => runValidator(root)).toThrow(/category=modules/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
