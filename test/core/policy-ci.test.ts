import { describe, expect, it } from "vitest";

import {
  parsePolicyCiMode,
  policyCiExitCode,
  POLICY_CI_EXIT_CODES,
} from "../../src/core/index.js";

describe("policy CI exit contract", () => {
  it("accepts only the documented modes", () => {
    expect(parsePolicyCiMode("informational")).toBe("informational");
    expect(parsePolicyCiMode("enforce")).toBe("enforce");
    expect(() => parsePolicyCiMode("blocking")).toThrow(
      "policy mode must be informational or enforce",
    );
  });

  it("keeps informational findings non-blocking and reserves code 2 for enforce", () => {
    const findings = {
      violations: [null] as never[],
      unsupported: [] as never[],
    };
    const clear = { violations: [], unsupported: [] };

    expect(policyCiExitCode("informational", findings)).toBe(
      POLICY_CI_EXIT_CODES.success,
    );
    expect(policyCiExitCode("enforce", findings)).toBe(
      POLICY_CI_EXIT_CODES.findings,
    );
    expect(policyCiExitCode("enforce", clear)).toBe(
      POLICY_CI_EXIT_CODES.success,
    );
    expect(
      policyCiExitCode("informational", {
        violations: [],
        unsupported: [null] as never[],
      }),
    ).toBe(POLICY_CI_EXIT_CODES.success);
  });
});
