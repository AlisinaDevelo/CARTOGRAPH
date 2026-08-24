import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const read = (relativePath: string): string =>
  readFileSync(resolve(repositoryRoot, relativePath), "utf8");

describe("remediation review workflow documentation", () => {
  it("documents lifecycle states and the no-apply boundary", () => {
    const documentation = read("docs/REMEDIATION_REVIEW.md");

    for (const state of [
      "proposed",
      "approved",
      "rejected",
      "stale",
      "failed-validation",
      "applied-externally",
    ])
      expect(documentation).toContain(`\`${state}\``);
    expect(documentation).toContain("autoApply: false");
    expect(documentation).toContain("never merges a pull request");
    expect(documentation).toContain("--as-of");
  });

  it("keeps optional CI fork-safe and read-only", () => {
    for (const workflow of [
      ".github/workflows/ci.yml",
      ".github/workflows/codeql.yml",
    ]) {
      const source = read(workflow);
      expect(source).toContain("pull_request:");
      expect(source).toContain("contents: read");
      expect(source).not.toContain("pull_request_target");
    }
  });
});
