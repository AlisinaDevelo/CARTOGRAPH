#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  argumentValue("--fixture") ??
    "test/fixtures/remediation-review/scenarios.v0.1.json",
);

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));
const fail = (message) => {
  throw new Error(message);
};

const validate = async () => {
  const fixture = readJson(fixturePath);
  const fixtureSchema = readJson(
    resolve(
      repositoryRoot,
      "schema/remediation-review-fixtures.v0.1.schema.json",
    ),
  );
  const reviewSchema = readJson(
    resolve(repositoryRoot, "schema/remediation-review.v0.1.schema.json"),
  );
  const ajv = new Ajv({ allErrors: true });
  const validateFixture = ajv.compile(fixtureSchema);
  const validateReview = ajv.compile(reviewSchema);
  if (!validateFixture(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validateFixture.errors)}`,
    );

  const {
    RemediationReviewError,
    createRemediationReview,
    serializeRemediationReview,
  } = await import("../src/core/index.ts");
  const digest =
    "sha256:3e2d9a1a2c5b4d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6";
  const asOf = "2030-01-01T00:00:00.000Z";
  const makeRequest = (scenario) => {
    const reviewed = scenario.decision !== "proposed";
    const invalidReviewer = scenario.id === "approved-without-reviewer";
    const external = scenario.id === "applied-externally";
    return {
      schemaVersion: 1,
      contract: "cartograph.remediation-review",
      reviewId: `review-${scenario.id}`,
      suggestionId: `suggestion-${scenario.id}`,
      suggestionVersion: 1,
      suggestionDigest: digest,
      ownerId: "team-architecture",
      reviewerId: reviewed && !invalidReviewer ? "reviewer-architecture" : null,
      evidenceRevision: {
        sourceCommit: "a".repeat(40),
        baselineDigest: digest,
        evidenceDigest: digest,
      },
      decision: scenario.decision,
      rationale: `Synthetic ${scenario.id} review rationale`,
      validation: {
        status: scenario.validation,
        resultDigest: scenario.validation === "not-run" ? null : digest,
        commands:
          scenario.validation === "not-run" ? [] : ["review-fixture-validator"],
      },
      expiresAt:
        scenario.expiry === "past"
          ? "2029-01-01T00:00:00.000Z"
          : "2031-01-01T00:00:00.000Z",
      reviewedAt: reviewed ? "2030-01-01T00:00:00.000Z" : null,
      finalDisposition:
        external || scenario.id === "applied-without-proof"
          ? "applied-externally"
          : "unapplied",
      externalApplication: external
        ? {
            externalReference: "pull-request-203",
            actorId: "reviewer-architecture",
            appliedAt: "2030-01-02T00:00:00.000Z",
            evidenceDigest: digest,
          }
        : null,
    };
  };

  const states = {};
  let valid = 0;
  let invalid = 0;
  for (const scenario of fixture.cases) {
    const request = makeRequest(scenario);
    try {
      const review = createRemediationReview(request, { now: asOf });
      if (!scenario.valid)
        fail(`fixture ${scenario.id} was expected to be invalid`);
      if (review.state !== scenario.expectedState)
        fail(
          `fixture ${scenario.id} expected ${scenario.expectedState}, found ${review.state}`,
        );
      if (!validateReview(review))
        fail(
          `review schema validation failed for ${scenario.id}: ${JSON.stringify(validateReview.errors)}`,
        );
      if (
        !review.readOnly ||
        review.autoApply ||
        review.policyMutation ||
        review.mergeAutomation ||
        Object.values(review.authority).some(Boolean)
      )
        fail(`review ${scenario.id} grants mutation authority`);
      if (JSON.parse(serializeRemediationReview(review)).state !== review.state)
        fail(`serialized review lost state for ${scenario.id}`);
      states[review.state] = (states[review.state] ?? 0) + 1;
      valid += 1;
    } catch (error) {
      if (scenario.valid) throw error;
      if (!(error instanceof RemediationReviewError)) throw error;
      if (error.code !== "invalid-input")
        fail(
          `invalid fixture ${scenario.id} used unexpected error ${error.code}`,
        );
      invalid += 1;
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      schemaVersion: fixture.schemaVersion,
      contract: "cartograph.remediation-review",
      cases: fixture.cases.length,
      valid,
      invalid,
      states,
    }),
  );
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/remediation-review.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  await validate();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`remediation review validation failed: ${message}`);
  process.exit(1);
}
