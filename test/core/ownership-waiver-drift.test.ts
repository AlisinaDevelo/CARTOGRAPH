import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  OwnershipWaiverDriftInputSchema,
  evaluateOwnershipWaiverDrift,
  parseOwnershipWaiverDriftInput,
  serializeOwnershipWaiverDriftReport,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/ownership-waiver-drift/scenarios.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/ownership-waiver-drift-fixtures.v0.1.schema.json",
);
const scriptPath = resolve(
  repositoryRoot,
  "scripts/ownership-waiver-drift.mjs",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  scenarios: Array<{
    id: string;
    input: Record<string, unknown>;
    expected: {
      status: string;
      diagnosticCodes: string[];
      summary: Record<string, number>;
      trailIncludes: string[];
    };
  }>;
};

describe("ownership and waiver drift evaluation", () => {
  it("replays repository, policy, evidence, key, expiry, and partial-workspace drift", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
    const validator = new Ajv({ allErrors: true }).compile(schema);
    expect(validator(JSON.parse(readFileSync(fixturePath, "utf8")))).toBe(true);

    const scenario = fixture.scenarios[0];
    if (!scenario) throw new Error("drift fixture setup");
    const report = evaluateOwnershipWaiverDrift(scenario.input);
    expect(report.status).toBe(scenario.expected.status);
    expect(
      [...new Set(report.diagnostics.map((entry) => entry.code))].sort(),
    ).toEqual(scenario.expected.diagnosticCodes.sort());
    expect(report.summary).toEqual(scenario.expected.summary);
    for (const required of scenario.expected.trailIncludes) {
      expect(report.decisionTrail.map((entry) => entry.id)).toContain(required);
    }
    expect(report.summary.repositoryMoves).toBeGreaterThan(0);
    expect(report.summary.keyRotations).toBeGreaterThan(0);
    expect(report.summary.partialWorkspaces).toBe(1);
    expect(report.provenance).toMatchObject({
      network: false,
      sourceBodiesIncluded: false,
      privateKeysIncluded: false,
      authorityGranted: false,
      autoExtended: false,
      deterministic: true,
    });
  });

  it("preserves prior decisions, never renews, and serializes deterministically", () => {
    const scenario = fixture.scenarios[0];
    if (!scenario) throw new Error("drift fixture setup");
    const input = parseOwnershipWaiverDriftInput(scenario.input);
    const report = evaluateOwnershipWaiverDrift(input);
    const prior = input.previous?.decisionTrail[0];
    if (!prior) throw new Error("prior decision fixture setup");
    const trailEntry = report.decisionTrail.find(
      (entry) => entry.id === prior.id,
    );
    expect(trailEntry).toEqual(prior);
    expect(
      report.decisionTrail.every((entry) => entry.authorityGranted === false),
    ).toBe(true);
    expect(
      report.decisionTrail.every((entry) => entry.autoExtended === false),
    ).toBe(true);
    expect(report.diagnostics.map((entry) => entry.code)).toContain(
      "DRIFT_WAIVER_EXPIRED",
    );
    const serialized = serializeOwnershipWaiverDriftReport(report);
    expect(serialized).toBe(
      serializeOwnershipWaiverDriftReport(JSON.parse(serialized)),
    );
    expect(serialized).not.toContain('"privateKey"');
    expect(serialized).not.toContain('"signature"');
  });

  it("rejects unsafe state extensions and keeps the validator offline", () => {
    const scenario = fixture.scenarios[0];
    if (!scenario) throw new Error("drift fixture setup");
    const unsafe = structuredClone(scenario.input) as {
      current: { waivers: Array<Record<string, unknown>> };
    };
    unsafe.current.waivers[0]!.privateKey = "never-store-this";
    expect(() => OwnershipWaiverDriftInputSchema.parse(unsafe)).toThrow();
    const source = readFileSync(scriptPath, "utf8");
    expect(source).not.toMatch(/node:(?:http|https|net|tls)/u);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "validate"],
        { cwd: repositoryRoot, encoding: "utf8" },
      ),
    ) as { ok: boolean; offline: boolean; authorityGranted: boolean };
    expect(output).toMatchObject({
      ok: true,
      offline: true,
      authorityGranted: false,
    });
  });
});
