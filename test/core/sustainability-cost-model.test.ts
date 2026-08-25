import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/sustainability-cost-model.mjs",
);
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/sustainability-cost/report.v0.1.json",
);

type MutableFixture = {
  scenarios: Array<{
    laborRateUsdPerHour: { min: number; max: number };
    totalCostUsd: { kind: string; min?: number; max?: number };
  }>;
};

const runValidator = (path = fixturePath): Record<string, unknown> =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [scriptPath, "validate", "--fixture", path],
      { cwd: repositoryRoot, encoding: "utf8" },
    ),
  ) as Record<string, unknown>;

const withMutatedFixture = async (
  mutate: (fixture: MutableFixture) => void,
): Promise<void> => {
  const directory = await mkdtemp(
    join(repositoryRoot, ".tmp-sustainability-cost-"),
  );
  const path = join(directory, "report.json");
  try {
    const fixture = JSON.parse(
      await readFile(fixturePath, "utf8"),
    ) as MutableFixture;
    mutate(fixture);
    await writeFile(path, JSON.stringify(fixture), "utf8");
    expect(() => runValidator(path)).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("sustainability and cost model contract", () => {
  it("validates the three local, funded, and deferred scenarios", () => {
    expect(runValidator()).toMatchObject({
      ok: true,
      contract: "cartograph.sustainability-cost-model",
      schemaVersion: 1,
      inputs: 8,
      scenarios: 3,
      estimatedScenarios: 2,
      deferredScenarios: 1,
      categories: 9,
      volunteerLaborPriced: true,
      hostedExpansion: "deferred",
      network: false,
      sourceBodiesIncluded: false,
    });
  });

  it("keeps the public report explicit about planning limits", async () => {
    const report = await readFile(
      resolve(repositoryRoot, "docs/SUSTAINABILITY_COST_MODEL.md"),
      "utf8",
    );
    expect(report).toContain("not an invoice");
    expect(report).toContain("Volunteer labor is priced");
    expect(report).toContain("$37,230");
    expect(report).toContain("Deferred costs are unknown, not free");
  });

  it("rejects free or inverted labor pricing", async () => {
    await withMutatedFixture((fixture) => {
      fixture.scenarios[0]!.laborRateUsdPerHour.min = 0;
    });
    await withMutatedFixture((fixture) => {
      fixture.scenarios[1]!.laborRateUsdPerHour.min = 300;
      fixture.scenarios[1]!.laborRateUsdPerHour.max = 200;
    });
  });

  it("rejects a total that does not include priced labor", async () => {
    await withMutatedFixture((fixture) => {
      fixture.scenarios[0]!.totalCostUsd.max = 100;
    });
  });

  it("rejects numeric estimates for the deferred hosted option", async () => {
    await withMutatedFixture((fixture) => {
      fixture.scenarios[2]!.totalCostUsd = {
        kind: "estimated",
        min: 1,
        max: 2,
      };
    });
  });
});
