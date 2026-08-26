import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/workspace-federation-evaluation.mjs",
);
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/workspace-federation-evaluation/report.v0.1.json",
);

type MutableFixture = {
  method: { network: boolean };
  portfolios: Array<{
    scenarios: Array<{ kind: string }>;
    metrics: {
      resolution: { precision: number };
    };
  }>;
  summary: {
    incrementalPerformance: { speedup: number };
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
    portfolios: number;
    scenarioKinds: string[];
    precision: number;
    recall: number;
    unknownCoverage: number;
    identityStability: number;
    incrementalSpeedup: number;
    reviewerUsefulness: string;
    privacyFindings: number;
    decision: string;
    network: boolean;
    sourceBodiesIncluded: boolean;
    hiddenTelemetry: boolean;
    digest: string;
  };

const withMutatedFixture = (
  mutate: (fixture: MutableFixture) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(
    join(tmpdir(), "cartograph-federation-evaluation-"),
  );
  const path = join(directory, "report.json");
  const fixture = JSON.parse(
    readFileSync(fixturePath, "utf8"),
  ) as MutableFixture;
  mutate(fixture);
  writeFileSync(path, JSON.stringify(fixture));
  try {
    callback(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("workspace federation evaluation report", () => {
  it("validates three bounded portfolios and publishes the narrow decision", () => {
    expect(run()).toMatchObject({
      ok: true,
      contract: "cartograph.workspace-federation-evaluation",
      schemaVersion: 1,
      evaluationId: "w006-v0.1",
      portfolios: 3,
      scenarioKinds: [
        "package",
        "service",
        "schema",
        "missing-repository",
        "version-skew",
        "cross-boundary-change",
      ],
      precision: 0.92,
      recall: 0.92,
      reviewerUsefulness: "not-observed",
      privacyFindings: 7,
      decision: "narrow",
      network: false,
      sourceBodiesIncluded: false,
      hiddenTelemetry: false,
    });
    expect(run().digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("fails closed when network collection is enabled", () => {
    withMutatedFixture(
      (fixture) => {
        fixture.method.network = true;
      },
      (path) => expect(() => run(path)).toThrow(/schema validation failed/u),
    );
  });

  it("fails closed when a portfolio precision is forged", () => {
    withMutatedFixture(
      (fixture) => {
        const portfolio = fixture.portfolios.at(0);
        if (!portfolio) throw new Error("federation evaluation test setup");
        portfolio.metrics.resolution.precision = 1;
      },
      (path) => expect(() => run(path)).toThrow(/precision drifted/u),
    );
  });

  it("fails closed when a required scenario is omitted", () => {
    withMutatedFixture(
      (fixture) => {
        const portfolio = fixture.portfolios.at(1);
        const scenario = portfolio?.scenarios.at(2);
        if (!scenario) throw new Error("federation evaluation test setup");
        scenario.kind = "package";
      },
      (path) => expect(() => run(path)).toThrow(/scenario kinds/u),
    );
  });

  it("fails closed when the aggregate incremental metric is forged", () => {
    withMutatedFixture(
      (fixture) => {
        fixture.summary.incrementalPerformance.speedup = 99;
      },
      (path) =>
        expect(() => run(path)).toThrow(
          /summary incremental performance speedup drifted/u,
        ),
    );
  });

  it("keeps the validator offline and free of source or telemetry access", () => {
    const validator = readFileSync(scriptPath, "utf8");
    expect(validator).not.toMatch(/node:(?:http|https|net|tls)/u);
    expect(validator).not.toMatch(/\bfetch\s*\(/u);
    expect(validator).not.toMatch(/telemetry\.send|navigator\.sendBeacon/u);
  });
});
