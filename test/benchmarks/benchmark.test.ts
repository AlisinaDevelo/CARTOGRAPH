import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/benchmark.mjs");

describe("benchmark corpus and artifact governance", () => {
  it("validates the checked-in corpus and sanitized baseline", () => {
    const output = execFileSync(process.execPath, [scriptPath, "validate"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      corpusVersion: "0.1",
      fixtures: 5,
      artifact: "benchmarks/baseline.v0.1.json",
    });
  });

  it("evaluates expected records by construct family", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "cartograph-benchmark-"));
    const resultFile = join(temporaryRoot, "result.json");
    try {
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          scriptPath,
          "run",
          "--cold-runs",
          "1",
          "--warm-runs",
          "1",
          "--output",
          resultFile,
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      const artifact = JSON.parse(readFileSync(resultFile, "utf8")) as {
        corpus: { fixtures: number };
        fixtures: Array<{
          id: string;
          accuracy: {
            edge: { precision: number; recall: number };
            diagnostic: { precision: number; recall: number };
            families?: Record<
              string,
              {
                edge: { precision: number; recall: number };
                diagnostic: { precision: number; recall: number };
              }
            >;
          } | null;
        }>;
      };
      expect(artifact.corpus.fixtures).toBeGreaterThanOrEqual(5);
      const scoredFixtures = artifact.fixtures.filter(
        (fixture) => fixture.accuracy !== null,
      );
      expect(scoredFixtures.length).toBeGreaterThanOrEqual(2);
      for (const fixture of scoredFixtures) {
        expect(fixture.accuracy?.edge.precision).toBe(1);
        expect(fixture.accuracy?.edge.recall).toBe(1);
        expect(fixture.accuracy?.diagnostic.precision).toBe(1);
        expect(fixture.accuracy?.diagnostic.recall).toBe(1);
        expect(
          Object.keys(fixture.accuracy?.families ?? {}).length,
        ).toBeGreaterThan(0);
        for (const family of Object.values(fixture.accuracy?.families ?? {})) {
          expect(family.edge.precision).toBe(1);
          expect(family.edge.recall).toBe(1);
          expect(family.diagnostic.precision).toBe(1);
          expect(family.diagnostic.recall).toBe(1);
        }
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("keeps source bodies out of the checked-in artifact", () => {
    const artifact = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "benchmarks/baseline.v0.1.json"),
        "utf8",
      ),
    ) as unknown;
    const serialized = JSON.stringify(artifact).toLowerCase();
    expect(serialized).not.toMatch(
      /"(?:sourcebody|sourcecode|sourcetext|snippet|excerpt)"/u,
    );
    expect(serialized).not.toMatch(/"(?:telemetry|network)"/u);
    expect(serialized).not.toMatch(/(?:\/users\/|\/private\/|[a-z]:\\)/u);
  });

  it("matches the published benchmark result schema", () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "schema/benchmark-result.v0.1.schema.json"),
        "utf8",
      ),
    ) as object;
    const artifact = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "benchmarks/baseline.v0.1.json"),
        "utf8",
      ),
    ) as unknown;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(artifact)).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
