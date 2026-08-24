import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/remediation-evaluation.mjs",
);

describe("remediation assistance evaluation gate", () => {
  it("documents the metrics, threat matrix, and rule-only decision", () => {
    const documentation = readFileSync(
      resolve(repositoryRoot, "docs/REMEDIATION_EVALUATION.md"),
      "utf8",
    );
    const adr = readFileSync(
      resolve(repositoryRoot, "docs/adr/0003-remediation-assistance-gate.md"),
      "utf8",
    );
    for (const metric of [
      "applicability precision",
      "unsafe suggestion rate",
      "validation success",
      "stale-evidence detection",
      "reviewer acceptance",
      "time saved or added",
      "reproducibility",
      "cost",
      "provider exposure",
    ])
      expect(documentation).toContain(metric);
    for (const threat of [
      "injection",
      "secret leakage",
      "destructive commands",
      "policy weakening",
      "broad waivers",
      "dependency confusion",
      "fabricated evidence",
      "compromised providers",
      "automation bias",
    ])
      expect(documentation).toMatch(new RegExp(threat.replaceAll(" ", "\\s+")));
    expect(adr).toContain("Decision: rule-only");
    expect(adr).toContain("no provider");
    expect(adr).toContain("automatic application");
  });

  it("runs the red-team evaluation offline and emits the declared gate", () => {
    const validator = readFileSync(scriptPath, "utf8");
    expect(validator).not.toMatch(/\bfetch\b/u);
    expect(validator).not.toContain("child_process");
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "validate"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      schemaVersion: 1,
      contract: "cartograph.remediation-evaluation",
      evaluationId: "s006-red-team-v0-1",
      cases: 13,
      redTeamCases: 9,
      emitted: 4,
      unsafeSuggestionRate: 0,
      reviewerAcceptanceRate: 0.5,
      timeSavedMs: -150,
      costMicrounits: 250,
      decision: "rule-only",
    });
  });
});
