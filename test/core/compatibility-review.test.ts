import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/compatibility-review.mjs");

const runCompatibilityReview = () =>
  JSON.parse(
    execFileSync(process.execPath, [scriptPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }),
  ) as {
    ok: boolean;
    contract: string;
    reviewId: string;
    repositories: number;
    analyzed: number;
    failed: number;
    supportedConstructs: number;
    unknownDiagnostics: number;
    failureCodes: string[];
    fixtureDigest: string;
  };

describe("representative compatibility review", () => {
  it("records three successful analyses and bounded failures", () => {
    expect(runCompatibilityReview()).toMatchObject({
      ok: true,
      contract: "cartograph.compatibility-review",
      reviewId: "r005-v0.1",
      repositories: 5,
      analyzed: 3,
      failed: 2,
      supportedConstructs: 1556,
      unknownDiagnostics: 3143,
      failureCodes: ["CONFIGURATION_ERROR", "RESOURCE_LIMIT"],
    });
  });

  it("replays the checked-in matrix deterministically", () => {
    expect(runCompatibilityReview()).toEqual(runCompatibilityReview());
  });
});
