import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/strategy-privacy-security-review.mjs",
);
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/strategy-security/review.v0.1.json",
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
    selectedBranch: string;
    decision: string;
    assets: number;
    actors: number;
    dataFlows: number;
    reviewGaps: number;
    abuseCases: number;
    blockingMitigations: number;
    rejectedDataCollection: number;
    hostedExpansion: string;
    network: boolean;
    sourceUpload: boolean;
    hiddenTelemetry: boolean;
    digest: string;
  };

const withMutatedFixture = (
  mutate: (fixture: Record<string, unknown>) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(
    join(tmpdir(), "cartograph-strategy-security-"),
  );
  const path = join(directory, "review.json");
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

describe("strategy privacy and security review", () => {
  it("validates the accepted OSS-only local-first branch", () => {
    expect(run()).toMatchObject({
      ok: true,
      selectedBranch: "oss-local-first",
      decision: "oss-only-no-new-boundary",
      assets: 7,
      actors: 6,
      dataFlows: 7,
      reviewGaps: 7,
      abuseCases: 9,
      blockingMitigations: 7,
      rejectedDataCollection: 5,
      hostedExpansion: "deferred",
      network: false,
      sourceUpload: false,
      hiddenTelemetry: false,
    });
    expect(run().digest).toBe(
      "sha256:6d64721736a7fad5eea4f940e366ec7723dd66522b23800ed514366ecec5fb1e",
    );
  });

  it("fails closed when a data flow or scope widens", () => {
    withMutatedFixture(
      (fixture) => {
        const scope = fixture.scope as Record<string, unknown>;
        scope.sourceUpload = true;
      },
      (path) => {
        expect(() => run(path)).toThrow(/schema validation failed/u);
      },
    );
    withMutatedFixture(
      (fixture) => {
        const flows = fixture.dataFlows as Array<Record<string, unknown>>;
        const first = flows.at(0);
        if (!first) throw new Error("strategy flow test setup");
        first.network = true;
      },
      (path) => {
        expect(() => run(path)).toThrow(/local data flow/u);
      },
    );
  });

  it("requires the ADR to retain the exact review digest", () => {
    withMutatedFixture(
      (fixture) => {
        const decision = fixture.decision as Record<string, unknown>;
        decision.rationale = `${String(decision.rationale)} Revised evidence.`;
      },
      (path) => {
        expect(() => run(path)).toThrow(/ADR 0007 is not bound/u);
      },
    );
  });

  it("rejects private markers and network-capable validator code", () => {
    withMutatedFixture(
      (fixture) => {
        const residualRisks = fixture.residualRisks as Array<
          Record<string, unknown>
        >;
        const first = residualRisks.at(0);
        if (!first) throw new Error("strategy residual test setup");
        first.risk = "Private /Users/example source path";
      },
      (path) => {
        expect(() => run(path)).toThrow(/private path or secret marker/u);
      },
    );
    const validator = readFileSync(scriptPath, "utf8");
    expect(validator).not.toMatch(/node:(?:http|https|net|tls)/u);
    expect(validator).not.toMatch(/\bfetch\s*\(/u);
  });
});
