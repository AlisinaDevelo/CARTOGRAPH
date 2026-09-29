import { describe, expect, it } from "vitest";

import { runQueryRegressions } from "../../scripts/query-regression.mjs";

describe("query regression and authorization-boundary corpus", () => {
  it("replays every case and leaves policy decisions untouched", () => {
    expect(runQueryRegressions()).toMatchObject({
      ok: true,
      parseCases: 13,
      executeCases: 5,
      architectureCases: 1,
      policyDecisionUnchanged: true,
      inputUnmutated: true,
    });
  });
});
