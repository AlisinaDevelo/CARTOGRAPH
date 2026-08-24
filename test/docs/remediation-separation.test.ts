import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/remediation-separation.mjs",
);

describe("remediation suggestion separation audit", () => {
  it("documents the proposal-only and stale-evidence boundary", () => {
    const documentation = readFileSync(
      resolve(repositoryRoot, "docs/REMEDIATION_SUGGESTIONS.md"),
      "utf8",
    );
    expect(documentation).toContain("without changing graph, policy, history");
    expect(documentation).toContain("explicitly `unverified`");
    expect(documentation).toContain("`stale-baseline`");
    expect(documentation).toContain("S-007 separation audit");
  });

  it("proves no mutation and explicit stale skips offline", () => {
    const validator = readFileSync(scriptPath, "utf8");
    expect(validator).not.toMatch(/\bfetch\b/u);
    expect(validator).not.toContain("child_process");
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "validate"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({
      ok: true,
      contract: "cartograph.remediation-suggestion-separation",
      cases: [
        { id: "supported", outcome: "suggestion" },
        { id: "stale-baseline", outcome: "stale-baseline" },
        { id: "stale-evidence", outcome: "stale-evidence" },
      ],
      mutation: "none",
      staleDigests: "rejected",
      status: "unverified",
    });
  });
});
