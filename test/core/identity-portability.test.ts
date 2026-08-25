import { describe, expect, it } from "vitest";

import { runIdentityPortability } from "../../scripts/identity-portability.js";

describe("identity portability corpus", () => {
  it("covers platform paths, relocation, symlinks, and collision policy", () => {
    const report = runIdentityPortability();

    expect(report).toMatchObject({
      ok: true,
      contract: "cartograph.identity-portability",
      normalization: "NFC",
      scenarios: 7,
      equivalentProjects: 3,
      caseSensitiveDistinct: true,
      symlinkPolicy: "ignored",
    });
    expect(report.diagnostics.map(({ code }) => code).sort()).toEqual([
      "IDENTITY_CASE_COLLISION",
      "IDENTITY_UNICODE_COLLISION",
    ]);
  });

  it("replays deterministically", () => {
    expect(runIdentityPortability()).toEqual(runIdentityPortability());
  });
});
