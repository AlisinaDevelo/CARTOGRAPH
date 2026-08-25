import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Ajv from "ajv";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/runtime-reconciliation-evaluation.mjs",
);
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/runtime-reconciliation-evaluation/scenarios.v0.1.json",
);
const reportPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-evaluation.v0.1.json",
);
const reportSchemaPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-evaluation.v0.1.schema.json",
);

const run = (path = fixturePath) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "validate", "--fixture", path],
      { cwd: repositoryRoot, encoding: "utf8" },
    ),
  ) as {
    cases: number;
    expectedRecords: number;
    actualRecords: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number;
    recall: number;
    coverage: number;
    ambiguousRecords: number;
    ambiguityRate: number;
    releaseGating: boolean;
    fixtureDigest: string;
    reportDigest: string;
  };

const withMutatedFixture = (
  mutate: (fixture: Record<string, unknown>) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(
    join(tmpdir(), "cartograph-runtime-reconciliation-evaluation-"),
  );
  const path = join(directory, "fixture.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<
    string,
    unknown
  >;
  mutate(fixture);
  writeFileSync(path, JSON.stringify(fixture));
  try {
    callback(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("runtime reconciliation synthetic evaluation", () => {
  it("validates the published report and exposes the sampling baseline", () => {
    const schema = JSON.parse(readFileSync(reportSchemaPath, "utf8")) as object;
    const sample = JSON.parse(readFileSync(reportPath, "utf8")) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(sample)).toBe(true);
    expect(validate.errors).toBeNull();

    expect(run()).toMatchObject({
      cases: 2,
      expectedRecords: 8,
      actualRecords: 8,
      truePositives: 7,
      falsePositives: 1,
      falseNegatives: 1,
      precision: 0.875,
      recall: 0.875,
      coverage: 5 / 6,
      ambiguousRecords: 2,
      ambiguityRate: 0.25,
      releaseGating: false,
    });
  });

  it("is invariant to scenario ordering", () => {
    const baseline = run();
    withMutatedFixture(
      (fixture) => {
        const cases = fixture.cases as Array<Record<string, unknown>>;
        fixture.cases = cases.reverse();
      },
      (path) => {
        expect(run(path)).toEqual(baseline);
      },
    );
  });

  it("fails when a known expected classification drifts", () => {
    withMutatedFixture(
      (fixture) => {
        const cases = fixture.cases as Array<Record<string, unknown>>;
        const firstCase = cases[0];
        if (!firstCase) throw new Error("complete trace case missing");
        const expectedRecords = firstCase.expectedRecords as Array<
          Record<string, unknown>
        >;
        const ambiguous = expectedRecords.find(
          (record) => record.classification === "ambiguous",
        );
        if (!ambiguous) throw new Error("ambiguous expected record missing");
        ambiguous.classification = "observed-and-modeled";
      },
      (path) => {
        expect(() => run(path)).toThrow(
          /published runtime reconciliation evaluation report drifted/u,
        );
      },
    );
  });
});
