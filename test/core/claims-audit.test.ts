import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/claims-audit.mjs");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/claims-audit/audit.v0.1.json",
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
    claims: number;
    verifiedClaims: number;
    nonVerifiedClaims: number;
    statusCounts: Record<string, number>;
    year4Entries: number;
    hostedExpansion: string;
    network: boolean;
    sourceBodiesIncluded: boolean;
    privateDataIncluded: boolean;
    digest: string;
  };

const withMutatedFixture = (
  mutate: (fixture: Record<string, unknown>) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(join(tmpdir(), "cartograph-claims-audit-"));
  const path = join(directory, "audit.json");
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

describe("Year 1–3 claims audit", () => {
  it("validates the complete local claim register and Year 4 feed", () => {
    expect(run()).toMatchObject({
      ok: true,
      claims: 32,
      verifiedClaims: 15,
      nonVerifiedClaims: 17,
      statusCounts: {
        verified: 15,
        partial: 9,
        unsupported: 1,
        negative: 1,
        notObserved: 4,
        deferred: 2,
      },
      year4Entries: 4,
      hostedExpansion: "deferred",
      network: false,
      sourceBodiesIncluded: false,
      privateDataIncluded: false,
    });
    expect(run().digest).toBe(
      "sha256:9816d6bdc618f4c34113f44f02e080ca3e764bdf27df24f5cfa206406560e71f",
    );
  });

  it("fails closed when status counts are changed without evidence", () => {
    withMutatedFixture(
      (fixture) => {
        const claims = fixture.claims as Array<Record<string, unknown>>;
        const claim = claims.find(
          (entry) => entry.id === "y1-capability-action",
        );
        if (!claim) throw new Error("claims test setup");
        claim.status = "verified";
      },
      (path) => {
        expect(() => run(path)).toThrow(/status counts drifted/u);
      },
    );
  });

  it("requires every non-verified claim to bind to a charter entry", () => {
    withMutatedFixture(
      (fixture) => {
        const claims = fixture.claims as Array<Record<string, unknown>>;
        const claim = claims.find(
          (entry) => entry.id === "y3-quality-broad-rust-accuracy",
        );
        if (!claim) throw new Error("claims feed test setup");
        claim.feedsYear4 = ["missing-year4-entry"];
      },
      (path) => {
        expect(() => run(path)).toThrow(/unbound Year 4 feed/u);
      },
    );
  });

  it("rejects network, source-body, and private-data scope changes", () => {
    withMutatedFixture(
      (fixture) => {
        const scope = fixture.scope as Record<string, unknown>;
        scope.network = true;
      },
      (path) => {
        expect(() => run(path)).toThrow(/schema validation failed/u);
      },
    );
    const validator = readFileSync(scriptPath, "utf8");
    expect(validator).not.toMatch(/\bfetch\s*\(/u);
    expect(validator).not.toMatch(/telemetry\.send|navigator\.sendBeacon/u);
  });

  it("requires digest bindings in the public report and strategy ADR", () => {
    expect(
      readFileSync(resolve(repositoryRoot, "docs/CLAIMS_AUDIT.md"), "utf8"),
    ).toContain("claims-audit-year1-3-v0.1");
    expect(
      readFileSync(
        resolve(
          repositoryRoot,
          "docs/adr/0007-local-first-investment-boundary.md",
        ),
        "utf8",
      ),
    ).toContain("claims-audit-year1-3-v0.1");
  });
});
