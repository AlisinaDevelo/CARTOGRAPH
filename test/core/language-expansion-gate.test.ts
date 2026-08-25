import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/language-expansion-gate.mjs",
);
const reportPath = resolve(
  repositoryRoot,
  "test/fixtures/language-expansion-gate/report.v0.1.json",
);

const runValidator = (report = reportPath): string =>
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      scriptPath,
      "validate",
      "--root",
      repositoryRoot,
      "--report",
      report,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

describe("language-expansion gate report", () => {
  it("validates the Rust pilot metrics and conservative public decision", () => {
    const first = JSON.parse(runValidator()) as Record<string, unknown>;
    const second = JSON.parse(runValidator()) as Record<string, unknown>;

    expect(first).toMatchObject({
      ok: true,
      contract: "cartograph.language-expansion-gate",
      schemaVersion: 1,
      gateId: "language-expansion-gate-v0.1",
      candidate: "cartograph.rust",
      decision: "retain-experimental",
      failedGraduateCriteria: ["demand"],
      implementationCommitments: 0,
      externalSources: false,
      sourceBodiesIncluded: false,
      secretsIncluded: false,
    });
    expect(second).toEqual(first);
  });

  it("fails closed with the affected metric when a measurement drifts", async () => {
    const directory = await mkdtemp(
      join(repositoryRoot, ".tmp-language-gate-"),
    );
    const mutatedPath = join(directory, "report.v0.1.json");
    try {
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        measurements: Array<{ id: string; value: number; status: string }>;
      };
      const demand = report.measurements.find(
        (measurement) => measurement.id === "demand",
      );
      if (demand === undefined) throw new Error("demand measurement missing");
      demand.value = 1;
      await writeFile(mutatedPath, JSON.stringify(report), "utf8");

      expect(() => runValidator(mutatedPath)).toThrow(
        /metric=demand.*status does not match threshold/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
