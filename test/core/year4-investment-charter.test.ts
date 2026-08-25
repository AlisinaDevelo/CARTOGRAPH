import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/year4-investment-charter.mjs",
);
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/year4-charter/charter.v0.1.json",
);

type MutableFixture = {
  selectedTrack: { expansion: string };
  capacity: { verifiedBackups: number };
  gates: Array<{ id: string; digest: string | null }>;
  quarters: Array<{ status: string; objective: string }>;
};

const run = (path = fixturePath): Record<string, unknown> =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [scriptPath, "validate", "--fixture", path],
      { cwd: repositoryRoot, encoding: "utf8" },
    ),
  ) as Record<string, unknown>;

const withMutatedFixture = (
  mutate: (fixture: MutableFixture) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(join(tmpdir(), "cartograph-year4-charter-"));
  const path = join(directory, "charter.json");
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

describe("conditional Year 4 investment charter", () => {
  it("validates the maintenance-only, capacity-gated decision", () => {
    expect(run()).toMatchObject({
      ok: true,
      contract: "cartograph.year4-investment-charter",
      schemaVersion: 1,
      charterId: "year4-investment-charter-v0.1",
      selectedTrack: "conditional-maintenance-first",
      gates: 6,
      outcomes: 4,
      quarters: 4,
      risks: 5,
      nonGoals: 8,
      capacityStatus: "unmeasured",
      hostedExpansion: "deferred",
      network: false,
      sourceBodiesIncluded: false,
      privateDataIncluded: false,
      hiddenTelemetry: false,
    });
    expect(run().digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("keeps the public document explicit about its choice and limits", () => {
    const document = readFileSync(
      resolve(repositoryRoot, "docs/YEAR4_INVESTMENT_CHARTER.md"),
      "utf8",
    );
    expect(document).toContain("conditional-maintenance-first");
    expect(document).toContain("no verified independent backup");
    expect(document).toContain("does not auto-start Year 4 expansion");
    expect(document).toMatch(/not a funding\s+approval/u);
  });

  it("rejects an authorized expansion or invented backup capacity", () => {
    withMutatedFixture(
      (fixture) => {
        fixture.selectedTrack.expansion = "authorized";
      },
      (path) => expect(() => run(path)).toThrow(/schema validation failed/u),
    );
    withMutatedFixture(
      (fixture) => {
        fixture.capacity.verifiedBackups = 1;
      },
      (path) => expect(() => run(path)).toThrow(/schema validation failed/u),
    );
  });

  it("rejects a stale evidence digest or a feature quarter", () => {
    withMutatedFixture(
      (fixture) => {
        const gate = fixture.gates.find((entry) => entry.id === "claims-audit");
        if (!gate) throw new Error("charter gate test setup");
        gate.digest =
          "sha256:0000000000000000000000000000000000000000000000000000000000000000";
      },
      (path) => expect(() => run(path)).toThrow(/digest drifted/u),
    );
    withMutatedFixture(
      (fixture) => {
        fixture.quarters[0]!.status = "feature-authorized";
      },
      (path) => expect(() => run(path)).toThrow(/schema validation failed/u),
    );
  });

  it("rejects private markers and network-capable validator code", () => {
    withMutatedFixture(
      (fixture) => {
        fixture.quarters[0]!.objective = "/Users/example";
      },
      (path) =>
        expect(() => run(path)).toThrow(/private path or secret marker/u),
    );
    const validator = readFileSync(scriptPath, "utf8");
    expect(validator).not.toMatch(/node:(?:http|https|net|tls)/u);
    expect(validator).not.toMatch(/\bfetch\s*\(/u);
  });
});
