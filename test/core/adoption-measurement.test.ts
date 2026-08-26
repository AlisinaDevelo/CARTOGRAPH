import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/adoption-measurement.mjs");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/adoption-measurement/protocol.v0.1.json",
);

type MutableFixture = {
  scope: { hiddenTelemetry: boolean };
  summary: { adoptionClaim: string };
  observations: Array<{
    sourceKinds: string[];
    records: Array<{ rawInputRetained: boolean }>;
  }>;
  decision: { rationale: string };
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
    metrics: number;
    observedMetrics: number;
    notObservedMetrics: number;
    records: number;
    publicRecords: number;
    consentedRecords: number;
    adoptionClaim: string;
    hiddenTelemetry: boolean;
    network: boolean;
    sourceUpload: boolean;
    digest: string;
  };

const withMutatedFixture = (
  mutate: (fixture: MutableFixture) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(
    join(tmpdir(), "cartograph-adoption-measurement-"),
  );
  const path = join(directory, "protocol.json");
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

describe("telemetry-free adoption measurement protocol", () => {
  it("validates the bounded metrics and deferred adoption decision", () => {
    expect(run()).toMatchObject({
      ok: true,
      contract: "cartograph.adoption-measurement",
      schemaVersion: 1,
      protocolId: "adoption-measurement-v0.1",
      metrics: 6,
      observedMetrics: 1,
      notObservedMetrics: 5,
      records: 5,
      publicRecords: 5,
      consentedRecords: 0,
      adoptionClaim: "deferred",
      hiddenTelemetry: false,
      network: false,
      sourceUpload: false,
    });
    expect(run().digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("fails closed when hidden telemetry is enabled", () => {
    withMutatedFixture(
      (fixture) => {
        fixture.scope.hiddenTelemetry = true;
      },
      (path) => expect(() => run(path)).toThrow(/schema validation failed/u),
    );
  });

  it("fails closed when a technical sample becomes an adoption claim", () => {
    withMutatedFixture(
      (fixture) => {
        fixture.summary.adoptionClaim = "observed";
      },
      (path) => expect(() => run(path)).toThrow(/schema validation failed/u),
    );
  });

  it("fails closed when a metric publishes an unapproved source", () => {
    withMutatedFixture(
      (fixture) => {
        const observation = fixture.observations.at(3);
        if (!observation) throw new Error("adoption measurement test setup");
        observation.sourceKinds = ["release-metadata"];
      },
      (path) => expect(() => run(path)).toThrow(/outside its metric rule/u),
    );
  });

  it("fails closed when a withdrawn record is still retained", () => {
    withMutatedFixture(
      (fixture) => {
        const observation = fixture.observations.at(3);
        const record = observation?.records.at(0);
        if (!record) throw new Error("adoption measurement test setup");
        record.rawInputRetained = true;
      },
      (path) => expect(() => run(path)).toThrow(/schema validation failed/u),
    );
  });

  it("rejects private markers and network-capable validator code", () => {
    withMutatedFixture(
      (fixture) => {
        fixture.decision.rationale =
          "Evidence at /Users/example/private-project";
      },
      (path) =>
        expect(() => run(path)).toThrow(/private path or secret marker/u),
    );
    const validator = readFileSync(scriptPath, "utf8");
    expect(validator).not.toMatch(/node:(?:http|https|net|tls)/u);
    expect(validator).not.toMatch(/\bfetch\s*\(/u);
    expect(validator).not.toMatch(/telemetry\.send|navigator\.sendBeacon/u);
  });
});
