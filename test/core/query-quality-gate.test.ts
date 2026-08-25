import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/query-quality-gate.mjs");
const reportPath = resolve(
  repositoryRoot,
  "test/fixtures/architecture-query-quality-gate/report.v0.1.json",
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

describe("architecture-query quality gate", () => {
  it("validates the conservative single-repository decision deterministically", () => {
    const first = JSON.parse(runValidator()) as Record<string, unknown>;
    const second = JSON.parse(runValidator()) as Record<string, unknown>;

    expect(first).toMatchObject({
      ok: true,
      contract: "cartograph.architecture-query-quality-gate",
      schemaVersion: 1,
      gateId: "architecture-query-quality-gate-v0.1",
      decision: "narrow",
      multiRepositoryDecision: "defer",
      reviewerTasks: 4,
      reviewerTaskCompletion: 0.75,
      failedThresholds: [
        "impact-precision",
        "multi-repository-readiness",
        "reviewer-task-completion",
      ],
      externalSources: false,
      sourceBodiesIncluded: false,
      secretsIncluded: false,
    });
    expect(second).toEqual(first);
  });

  it("fails closed when an observed metric status drifts", async () => {
    const directory = await mkdtemp(join(repositoryRoot, ".tmp-query-gate-"));
    const mutatedPath = join(directory, "report.v0.1.json");
    try {
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        measurements: Array<{ id: string; value: number; status: string }>;
      };
      const precision = report.measurements.find(
        (measurement) => measurement.id === "impact-precision",
      );
      if (precision === undefined)
        throw new Error("precision measurement missing");
      precision.value = 0.95;
      await writeFile(mutatedPath, JSON.stringify(report), "utf8");

      expect(() => runValidator(mutatedPath)).toThrow(
        /metric=impact-precision.*status does not match threshold/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects absolute evidence references", async () => {
    const directory = await mkdtemp(join(repositoryRoot, ".tmp-query-gate-"));
    const mutatedPath = join(directory, "report.v0.1.json");
    try {
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        measurements: Array<{ id: string; evidenceRefs: string[] }>;
      };
      const measurement = report.measurements.find(
        (entry) => entry.id === "path-leakage-safety",
      );
      if (measurement === undefined)
        throw new Error("path-safety measurement missing");
      measurement.evidenceRefs.push("/Users/example/private.ts");
      await writeFile(mutatedPath, JSON.stringify(report), "utf8");

      expect(() => runValidator(mutatedPath)).toThrow(
        /contains a remote or absolute reference/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("binds reviewer completion to the task denominator", async () => {
    const directory = await mkdtemp(join(repositoryRoot, ".tmp-query-gate-"));
    const mutatedPath = join(directory, "report.v0.1.json");
    try {
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        measurements: Array<{ id: string; value: number; status: string }>;
        reviewerTasks: Array<{ completed: boolean; outcome?: string }>;
      };
      const task = report.reviewerTasks[1];
      if (task === undefined) throw new Error("reviewer task missing");
      task.completed = true;
      task.outcome = "complete";
      const measurement = report.measurements.find(
        (entry) => entry.id === "reviewer-task-completion",
      );
      if (measurement === undefined)
        throw new Error("reviewer measurement missing");
      await writeFile(mutatedPath, JSON.stringify(report), "utf8");

      expect(() => runValidator(mutatedPath)).toThrow(
        /reviewer completion value 0\.75 does not match 1/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
