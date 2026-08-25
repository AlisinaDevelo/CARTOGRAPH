import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const runnerPath = resolve(repositoryRoot, "scripts/property-regressions.mjs");
const scenarioPath = resolve(
  repositoryRoot,
  "test/fixtures/property-regressions/scenarios.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/property-regression.v0.1.schema.json",
);

describe("bounded property and security regressions", () => {
  it("publishes the reviewed four-domain corpus and budget", () => {
    const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as {
      contract: string;
      seed: number;
      budgets: { maxTotalMs: number; maxCaseMs: number };
      suites: Array<{ id: string; cases: number; expectedRejections: number }>;
      regressions: Array<{ id: string }>;
    };
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(scenario)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(scenario).toMatchObject({
      contract: "cartograph.property-regression",
      seed: 1597463007,
      budgets: { maxTotalMs: 15000, maxCaseMs: 3000 },
    });
    expect(scenario.suites.map((suite) => suite.id)).toEqual([
      "typescript-input",
      "snapshot-json",
      "policy-config",
      "adapter-output",
    ]);
    expect(
      scenario.suites.reduce((total, suite) => total + suite.cases, 0),
    ).toBe(112);
    expect(
      scenario.regressions.map((regression) => regression.id),
    ).toHaveLength(8);
  });

  it("replays every bounded property and security case", () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", runnerPath, "validate"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      totalCases: 112,
      expectedRejections: 24,
      runtimeBudgetMs: 15000,
      security: {
        sourceExecution: false,
        prototypePollution: false,
        executablePolicy: false,
        adapterAuthorityEscalation: false,
      },
      releaseGating: true,
    });
  });
});
