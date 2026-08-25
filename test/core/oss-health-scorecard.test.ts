import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/oss-health-scorecard.mjs");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/oss-health/scorecard.v0.1.json",
);

const run = (path = fixturePath) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [scriptPath, "validate", "--fixture", path],
      { cwd: repositoryRoot, encoding: "utf8" },
    ),
  ) as {
    ok: boolean;
    dimensions: number;
    observedDimensions: number;
    notObservedDimensions: number;
    externalRepositories: number;
    successfulExternalRepositories: number;
    boundedFailureExternalRepositories: number;
    records: number;
    tractionClaim: string;
    hostedInvestment: string;
    network: boolean;
    hiddenTelemetry: boolean;
    digest: string;
  };

const withMutatedFixture = (
  mutate: (fixture: Record<string, unknown>) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(join(tmpdir(), "cartograph-oss-health-"));
  const path = join(directory, "scorecard.json");
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

describe("OSS health and traction scorecard", () => {
  it("validates the aggregate compatibility evidence without traction claims", () => {
    expect(run()).toMatchObject({
      ok: true,
      dimensions: 8,
      observedDimensions: 1,
      notObservedDimensions: 7,
      externalRepositories: 5,
      successfulExternalRepositories: 3,
      boundedFailureExternalRepositories: 2,
      records: 5,
      tractionClaim: "deferred",
      hostedInvestment: "deferred",
      network: false,
      hiddenTelemetry: false,
    });
    expect(run().digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("fails closed when a successful run is changed without updating evidence", () => {
    withMutatedFixture(
      (fixture) => {
        const observations = fixture.observations as Array<
          Record<string, unknown>
        >;
        const external = observations.find(
          (observation) =>
            observation.dimensionId === "external-repository-runs",
        );
        if (!external) throw new Error("scorecard test setup");
        const records = external.records as Array<Record<string, unknown>>;
        const first = records.at(0);
        if (!first) throw new Error("scorecard run test setup");
        first.outcome = "bounded-failure";
      },
      (path) => {
        expect(() => run(path)).toThrow(
          /successful external repository count drifted/u,
        );
      },
    );
  });

  it("fails closed when an unobserved dimension receives a value", () => {
    withMutatedFixture(
      (fixture) => {
        const observations = fixture.observations as Array<
          Record<string, unknown>
        >;
        const release = observations.find(
          (observation) => observation.dimensionId === "release-stability",
        );
        if (!release) throw new Error("scorecard release test setup");
        release.value = 0;
      },
      (path) => {
        expect(() => run(path)).toThrow(/not-observed dimension/u);
      },
    );
  });

  it("fails closed if hidden telemetry is enabled", () => {
    withMutatedFixture(
      (fixture) => {
        const scope = fixture.scope as Record<string, unknown>;
        scope.hiddenTelemetry = true;
      },
      (path) => {
        expect(() => run(path)).toThrow(/schema validation failed/u);
      },
    );
  });

  it("rejects private markers and network or telemetry access", () => {
    withMutatedFixture(
      (fixture) => {
        const strategyGate = fixture.strategyGate as Record<string, unknown>;
        strategyGate.reason = "Evidence at /Users/example/private-project";
      },
      (path) => {
        expect(() => run(path)).toThrow(/private path or secret marker/u);
      },
    );
    const validator = readFileSync(scriptPath, "utf8");
    expect(validator).not.toMatch(/node:(?:http|https|net|tls)/u);
    expect(validator).not.toMatch(/\bfetch\s*\(/u);
    expect(validator).not.toMatch(/telemetry\.send|navigator\.sendBeacon/u);
  });
});
