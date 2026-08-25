import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/policy-regression.mjs");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/policy-regression.v0.1.json",
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
    positiveCases: number;
    negativeCases: number;
    unsupportedCases: number;
    falsePositives: number;
    falseNegatives: number;
    explanationRegressions: number;
    evidenceRegressions: number;
    requiredRuleTypes: string[];
    observedRuleTypes: string[];
    baseline: Record<string, number>;
  };

const withMutatedFixture = (
  mutate: (fixture: Record<string, unknown>) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(
    join(tmpdir(), "cartograph-policy-regression-"),
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

describe("policy regression corpus", () => {
  it("passes every target/assertion pair and publishes zero baselines", () => {
    const report = run();
    expect(report).toMatchObject({
      cases: 25,
      positiveCases: 12,
      negativeCases: 12,
      unsupportedCases: 1,
      falsePositives: 0,
      falseNegatives: 0,
      explanationRegressions: 0,
      evidenceRegressions: 0,
      baseline: {
        falsePositives: 0,
        falseNegatives: 0,
        explanationRegressions: 0,
        evidenceRegressions: 0,
      },
    });
    expect(report.observedRuleTypes).toEqual(report.requiredRuleTypes);
  });

  it("fails when an expected explanation changes", () => {
    withMutatedFixture(
      (fixture) => {
        const cases = fixture.cases as Array<Record<string, unknown>>;
        const negative = cases.find(
          (definition) => definition.id === "node-exists-negative",
        );
        if (!negative) throw new Error("negative fixture missing");
        const expected = negative.expected as Record<string, unknown>;
        const checks = expected.checks as Array<Record<string, unknown>>;
        const check = checks[0];
        if (!check) throw new Error("expected explanation check missing");
        check.reasonIncludes = "deliberately changed explanation";
      },
      (path) => {
        expect(() => run(path)).toThrow(/explanationRegressions/);
      },
    );
  });

  it("fails when an expected evidence reference changes", () => {
    withMutatedFixture(
      (fixture) => {
        const cases = fixture.cases as Array<Record<string, unknown>>;
        const negative = cases.find(
          (definition) => definition.id === "edge-absent-negative",
        );
        if (!negative) throw new Error("negative fixture missing");
        const expected = negative.expected as Record<string, unknown>;
        const checks = expected.checks as Array<Record<string, unknown>>;
        const check = checks[0];
        if (!check) throw new Error("expected evidence check missing");
        check.evidenceIncludes = ["evidence:deliberately-missing"];
      },
      (path) => {
        expect(() => run(path)).toThrow(/evidenceRegressions/);
      },
    );
  });
});
