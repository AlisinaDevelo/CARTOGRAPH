import { describe, expect, it } from "vitest";

import { runIdentityQuality } from "../../scripts/identity-quality.js";

describe("identity quality release gate", () => {
  it("reports curated and generated rates by refactor family", () => {
    const report = runIdentityQuality();

    expect(report).toMatchObject({
      ok: true,
      contract: "cartograph.identity-quality",
      corpusContract: "cartograph.identity-corpus",
      curated: {
        cases: 7,
        preservationRate: 1,
        falseMatchRate: 0,
        unmatchedRate: 0,
      },
      generated: {
        cases: 56,
        preservationRate: 1,
        falseMatchRate: 0,
        unmatchedRate: 0,
      },
    });
    expect(report.byCategory.curated["duplicate-names"]).toMatchObject({
      ambiguityRate: 1,
      preservationRate: null,
    });
    expect(report.byCategory.generated.overloads).toMatchObject({
      preservationRate: 1,
      falseMatchRate: 0,
    });
  });

  it("replays the baseline deterministically", () => {
    expect(runIdentityQuality()).toEqual(runIdentityQuality());
  });
});
