import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Ajv from "ajv";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/runtime-reconciliation-reproducibility.mjs",
);
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/runtime-reconciliation-reproducibility/study.v0.1.json",
);
const reportPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-reproducibility.v0.1.json",
);
const reportSchemaPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-reproducibility.v0.1.schema.json",
);

const run = (path = fixturePath) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "validate", "--fixture", path],
      { cwd: repositoryRoot, encoding: "utf8" },
    ),
  ) as {
    studyId: string;
    repetitions: number;
    summary: {
      perturbations: number;
      totalRuns: number;
      stableRuns: number;
      stabilityRate: number;
      classificationChanges: number;
      missingRuntimeSpanEdges: number;
      missingParentRecords: number;
      redactionInvariantCases: number;
      network: boolean;
      liveTraces: boolean;
      exporter: boolean;
    };
    corpusDigest: string;
    methodDigest: string;
    reportDigest: string;
  };

const withMutatedFixture = (
  mutate: (fixture: Record<string, unknown>) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(
    join(tmpdir(), "cartograph-runtime-reproducibility-"),
  );
  const path = join(directory, "study.json");
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

describe("runtime reconciliation reproducibility study", () => {
  it("validates the digest-only variance report and invariants", () => {
    const schema = JSON.parse(readFileSync(reportSchemaPath, "utf8")) as object;
    const sample = JSON.parse(readFileSync(reportPath, "utf8")) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(sample)).toBe(true);
    expect(validate.errors).toBeNull();

    expect(run()).toMatchObject({
      studyId: "runtime-reconciliation-reproducibility",
      repetitions: 5,
      summary: {
        perturbations: 4,
        totalRuns: 20,
        stableRuns: 20,
        stabilityRate: 1,
        classificationChanges: 5,
        missingRuntimeSpanEdges: 1,
        missingParentRecords: 1,
        redactionInvariantCases: 1,
        network: false,
        liveTraces: false,
        exporter: false,
      },
    });
  });

  it("is invariant to perturbation declaration order", () => {
    const baseline = run();
    withMutatedFixture(
      (fixture) => {
        const method = fixture.method as Record<string, unknown>;
        const perturbations = method.perturbations as Array<
          Record<string, unknown>
        >;
        method.perturbations = perturbations.reverse();
      },
      (path) => {
        expect(run(path)).toEqual(baseline);
      },
    );
  });

  it("fails closed when the study claims a live-trace boundary", () => {
    withMutatedFixture(
      (fixture) => {
        const method = fixture.method as Record<string, unknown>;
        const boundary = method.offlineBoundary as Record<string, unknown>;
        boundary.liveTraces = true;
      },
      (path) => {
        expect(() => run(path)).toThrow(
          /(?:must remain offline|fixture schema validation failed)/u,
        );
      },
    );
  });

  it("keeps the validator free of network and exporter access", () => {
    const validator = readFileSync(scriptPath, "utf8");
    expect(validator).not.toMatch(/node:(?:http|https|net|tls)/u);
    expect(validator).not.toMatch(/\bfetch\s*\(/u);
    expect(validator).not.toMatch(/live user traces/u);
  });
});
