import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Ajv from "ajv";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/runtime-reconciliation-uncertainty.mjs",
);
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/runtime-reconciliation-uncertainty/scenarios.v0.1.json",
);
const reportPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-uncertainty.v0.1.json",
);
const reportSchemaPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-uncertainty.v0.1.schema.json",
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
    samplingVariants: number;
    clockVariants: number;
    aliasCases: number;
    missingParentCases: number;
    classificationChanges: number;
    confidenceChanges: number;
    fixtureDigest: string;
  };

const withMutatedFixture = (
  mutate: (fixture: Record<string, unknown>) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(
    join(tmpdir(), "cartograph-runtime-reconciliation-uncertainty-"),
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

describe("uncertainty-aware runtime reconciliation", () => {
  it("validates the published contract and covers all uncertainty dimensions", () => {
    const schema = JSON.parse(readFileSync(reportSchemaPath, "utf8")) as object;
    const sample = JSON.parse(readFileSync(reportPath, "utf8")) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(sample)).toBe(true);
    expect(validate.errors).toBeNull();

    expect(run()).toMatchObject({
      cases: 3,
      samplingVariants: 2,
      clockVariants: 2,
      aliasCases: 3,
      missingParentCases: 1,
      classificationChanges: 4,
      confidenceChanges: 2,
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

  it("fails closed when a fixture claims that missing observations are absence", () => {
    withMutatedFixture(
      (fixture) => {
        const cases = fixture.cases as Array<Record<string, unknown>>;
        const first = cases[0];
        if (!first) throw new Error("baseline case missing");
        const uncertainty = first.uncertainty as Record<string, unknown>;
        const sampling = uncertainty.sampling as Record<string, unknown>;
        sampling.missingIsNotAbsence = false;
      },
      (path) => {
        expect(() => run(path)).toThrow(/fixture schema validation failed/u);
      },
    );
  });
});
