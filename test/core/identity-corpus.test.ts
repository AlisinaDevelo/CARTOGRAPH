import { describe, expect, it } from "vitest";

import { runIdentityCorpus } from "../../scripts/identity-corpus.js";

describe("seeded identity regression corpus", () => {
  it("covers each bounded transformation category and reports quality", () => {
    const report = runIdentityCorpus();

    expect(report).toMatchObject({
      ok: true,
      contract: "cartograph.identity-corpus",
      seed: 12648430,
      regressionCases: 7,
      generatedCases: 56,
      minimizedFailures: 0,
    });
    expect(report.quality.categories).toEqual({
      "line-move": 9,
      "file-move": 9,
      "supported-rename": 9,
      "duplicate-names": 9,
      overloads: 9,
      "path-alias": 9,
      ambiguous: 9,
    });
    expect(report.quality.matchRate).toBeGreaterThan(0.5);
    expect(report.quality.ambiguityRate).toBeGreaterThan(0);
  });

  it("replays the same seed with the same quality result", () => {
    expect(runIdentityCorpus()).toEqual(runIdentityCorpus());
  });
});
