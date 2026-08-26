import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/review-workflow-evaluation.mjs",
);
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/review-workflow-evaluation/report.v0.1.json",
);

type MutableReport = {
  measurements: Array<{ id: string; value: number }>;
  observations: Array<{ kind: string }>;
  securityReview: {
    threats: Array<{ id: string; status: string }>;
    summary: {
      blockedCount: number;
      deferredCount: number;
      missCount: number;
    };
  };
};

const run = (path = fixturePath) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [scriptPath, "validate", "--fixture", path],
      { cwd: repositoryRoot, encoding: "utf8" },
    ),
  ) as {
    ok: boolean;
    contract: string;
    schemaVersion: number;
    evaluationId: string;
    observations: number;
    measurements: Array<{ id: string; value: number; status: string }>;
    failedMetrics: string[];
    securityThreats: number;
    securityBlocked: number;
    securityDeferred: number;
    securityMisses: number;
    decision: string;
    securityOutcome: string;
    digest: string;
  };

const withMutatedFixture = (
  mutate: (fixture: MutableReport) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(join(tmpdir(), "cartograph-review-workflow-"));
  const path = join(directory, "report.v0.1.json");
  const fixture = JSON.parse(
    readFileSync(fixturePath, "utf8"),
  ) as MutableReport;
  mutate(fixture);
  writeFileSync(path, JSON.stringify(fixture));
  try {
    callback(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("review workflow evaluation report", () => {
  it("derives all seven metrics and publishes the conservative gate", () => {
    const first = run();
    const second = run();

    expect(first).toMatchObject({
      ok: true,
      contract: "cartograph.review-workflow-evaluation",
      schemaVersion: 1,
      evaluationId: "g006-v0.1",
      observations: 23,
      failedMetrics: [],
      securityThreats: 6,
      securityBlocked: 6,
      securityDeferred: 0,
      securityMisses: 0,
      decision: "defer",
      securityOutcome: "pass",
      network: false,
      sourceBodiesIncluded: false,
      credentialsUsed: false,
      hiddenTelemetry: false,
    });
    expect(first.measurements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "triage-accuracy",
          value: 1,
          status: "pass",
        }),
        expect.objectContaining({
          id: "time-to-owner",
          value: 18000,
          status: "pass",
        }),
        expect.objectContaining({
          id: "waiver-review-time",
          value: 45000,
          status: "pass",
        }),
        expect.objectContaining({
          id: "stale-finding-rate",
          value: 0.5,
          status: "pass",
        }),
        expect.objectContaining({
          id: "reviewer-task-completion",
          value: 0.8,
          status: "pass",
        }),
        expect.objectContaining({
          id: "maintainer-load",
          value: 13.5,
          status: "pass",
        }),
        expect.objectContaining({
          id: "failure-recovery",
          value: 0.75,
          status: "pass",
        }),
      ]),
    );
    expect(second).toEqual(first);
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("fails closed when a derived metric is forged", () => {
    withMutatedFixture(
      (fixture) => {
        const measurement = fixture.measurements.find(
          (entry) => entry.id === "time-to-owner",
        );
        if (measurement === undefined) throw new Error("measurement missing");
        measurement.value = 1;
      },
      (path) =>
        expect(() => run(path)).toThrow(/measurement time-to-owner drifted/u),
    );
  });

  it("requires every representative workflow kind", () => {
    withMutatedFixture(
      (fixture) => {
        fixture.observations.splice(0, 3);
      },
      (path) =>
        expect(() => run(path)).toThrow(
          /representative study requires at least two failure-recovery observations/u,
        ),
    );
  });

  it("binds security counts and conclusions to threat outcomes", () => {
    withMutatedFixture(
      (fixture) => {
        const threat = fixture.securityReview.threats.find(
          (entry) => entry.id === "replay",
        );
        if (threat === undefined) throw new Error("threat missing");
        threat.status = "miss";
        fixture.securityReview.summary.missCount = 1;
        fixture.securityReview.summary.blockedCount = 5;
      },
      (path) =>
        expect(() => run(path)).toThrow(/security conclusion does not match/u),
    );
  });

  it("keeps the evaluator offline and mutation-free", () => {
    const validator = readFileSync(scriptPath, "utf8");
    expect(validator).not.toMatch(/node:(?:http|https|net|tls)/u);
    expect(validator).not.toMatch(/\bfetch\s*\(/u);
    expect(validator).not.toMatch(
      /(?:git\s+push|gh\s+(?:issue|pr)|npm\s+publish|writeFile|appendFile)/u,
    );
  });
});
