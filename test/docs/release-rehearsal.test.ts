import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const record = readFileSync(
  resolve(repositoryRoot, "docs/RELEASE_REHEARSAL.md"),
  "utf8",
);

describe("release rehearsal record", () => {
  it("keeps a versioned acceptance checklist for every release boundary", () => {
    expect(record).toContain("release-rehearsal.v0.1");
    expect(record).toMatch(
      /package\/tag under review: `0\.1\.0` \/\s+`v0\.1\.0`/u,
    );
    for (const gate of [
      "Clean checkout and source state",
      "Runtime support window",
      "Clean installation",
      "Representative scans and diffs",
      "Read-only Action behavior",
      "Package contents",
      "Signature and provenance",
      "Documentation and limitations",
      "Security and dependency review",
    ]) {
      expect(record).toContain(gate);
    }
  });

  it("records a dry-run rollback with owners, timing, communication, and follow-up", () => {
    expect(record).toContain("## Dry-run rollback rehearsal");
    expect(record).toContain("does not edit a GitHub release");
    expect(record).toContain("not executed during this dry run");
    for (const term of [
      "Release owner",
      "Security owner",
      "Communications owner",
      "30 minutes",
      "60 minutes",
      "4 hours",
      "Communication and follow-up",
      "root cause",
      "recovery time",
    ]) {
      expect(record).toMatch(new RegExp(term.replaceAll(" ", "\\s+"), "u"));
    }
  });
});
