import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/benchmark-budgets.mjs");
const budgetsPath = resolve(repositoryRoot, "benchmarks/budgets.v0.1.json");

const run = (path = budgetsPath) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [scriptPath, "validate", "--budgets", path],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    ),
  ) as {
    ok: boolean;
    contract: string;
    budgetId: string;
    tiers: Array<{ id: string }>;
    fixtures: number;
  };

const withMutatedBudgets = (
  mutate: (budgets: Record<string, unknown>) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(
    join(tmpdir(), "cartograph-benchmark-budgets-"),
  );
  const path = join(directory, "budgets.json");
  const budgets = JSON.parse(readFileSync(budgetsPath, "utf8")) as Record<
    string,
    unknown
  >;
  mutate(budgets);
  writeFileSync(path, JSON.stringify(budgets));
  try {
    callback(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("benchmark budgets", () => {
  it("validates small, medium, and large tiers against the baseline", () => {
    expect(run()).toMatchObject({
      ok: true,
      contract: "cartograph.benchmark-budgets",
      budgetId: "cartograph-benchmark-budgets-v0.1",
      fixtures: 5,
    });
    expect(run().tiers.map((tier) => tier.id)).toEqual([
      "small",
      "medium",
      "large",
    ]);
  });

  it("fails when a tier budget is below the recorded p95", () => {
    withMutatedBudgets(
      (budgets) => {
        const tiers = budgets.tiers as Array<Record<string, unknown>>;
        const small = tiers[0];
        if (small === undefined) throw new Error("small tier is missing");
        small.maxP95Ms = 1;
      },
      (path) => {
        expect(() => run(path)).toThrow(/small tier/u);
      },
    );
  });

  it("fails when the reviewed regression threshold drifts", () => {
    withMutatedBudgets(
      (budgets) => {
        const regression = budgets.regression as Record<string, unknown>;
        regression.maxPercent = 10;
      },
      (path) => {
        expect(() => run(path)).toThrow(/threshold/u);
      },
    );
  });

  it("fails when a corpus fixture is assigned to more than one tier", () => {
    withMutatedBudgets(
      (budgets) => {
        const tiers = budgets.tiers as Array<Record<string, unknown>>;
        const large = tiers[2];
        if (large === undefined) throw new Error("large tier is missing");
        large.fixtureIds = ["review-regressions"];
      },
      (path) => {
        expect(() => run(path)).toThrow(/assigned to more than one tier/u);
      },
    );
  });
});
