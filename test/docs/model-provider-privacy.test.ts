import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/model-provider-privacy.mjs",
);

describe("model-provider privacy boundary", () => {
  it("keeps the RFC explicit, opt-in, and provider-free by default", () => {
    const rfc = readFileSync(
      resolve(repositoryRoot, "docs/MODEL_PROVIDER_PRIVACY.md"),
      "utf8",
    );

    expect(rfc).toContain("The default is **no provider**");
    expect(rfc).toContain("exact and bounded");
    expect(rfc).toContain("Local redaction and consent");
    expect(rfc).toContain("## Retention and training policy");
    expect(rfc).toContain("Provenance and reproducibility");
    expect(rfc).toContain("Budgets and availability");
    expect(rfc).toContain("source-prompt-injection");
    expect(rfc).toContain("misleading-confidence");
    expect(rfc).toContain("Deferral is a valid and expected result");
  });

  it("validates every adversarial scenario without network access", () => {
    const validator = readFileSync(scriptPath, "utf8");
    expect(validator).not.toMatch(/\bfetch\b/u);
    expect(validator).not.toContain("child_process");

    const output = execFileSync(process.execPath, [scriptPath, "validate"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(JSON.parse(output)).toEqual({
      ok: true,
      schemaVersion: 1,
      contract: "cartograph.model-provider-privacy-fixtures",
      cases: 12,
      deferrals: 10,
      redacted: 1,
      networkCases: 1,
    });
  });
});
