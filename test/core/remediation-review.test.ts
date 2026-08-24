import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  createRemediationReview,
  RemediationReviewError,
  RemediationReviewSchema,
  serializeRemediationReview,
} from "../../src/core/index.js";

const digest =
  "sha256:3e2d9a1a2c5b4d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6";
const now = "2030-01-01T00:00:00.000Z";

const request = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  contract: "cartograph.remediation-review",
  reviewId: "review-test",
  suggestionId: "suggestion-test",
  suggestionVersion: 1,
  suggestionDigest: digest,
  ownerId: "team-architecture",
  reviewerId: null,
  evidenceRevision: {
    sourceCommit: "a".repeat(40),
    baselineDigest: digest,
    evidenceDigest: digest,
  },
  decision: "proposed",
  rationale: "Awaiting an accountable review decision.",
  validation: { status: "not-run", resultDigest: null, commands: [] },
  expiresAt: "2031-01-01T00:00:00.000Z",
  reviewedAt: null,
  finalDisposition: "unapplied",
  externalApplication: null,
  ...overrides,
});

describe("human remediation review workflow", () => {
  it("derives every lifecycle state without granting authority", () => {
    const approved = {
      reviewerId: "reviewer-architecture",
      reviewedAt: now,
      decision: "approved",
      validation: {
        status: "passed",
        resultDigest: digest,
        commands: ["review-fixture-validator"],
      },
    };
    const cases = [
      [request(), "proposed"],
      [request(approved), "approved"],
      [
        request({
          reviewerId: "reviewer-architecture",
          reviewedAt: now,
          decision: "rejected",
          rationale: "Evidence is not sufficient for this proposal.",
        }),
        "rejected",
      ],
      [request({ expiresAt: "2029-01-01T00:00:00.000Z" }), "stale"],
      [
        request({
          validation: {
            status: "failed",
            resultDigest: digest,
            commands: ["review-fixture-validator"],
          },
        }),
        "failed-validation",
      ],
      [
        request({
          ...approved,
          validation: {
            status: "failed",
            resultDigest: digest,
            commands: ["review-fixture-validator"],
          },
        }),
        "failed-validation",
      ],
      [
        request({
          ...approved,
          finalDisposition: "applied-externally",
          externalApplication: {
            externalReference: "pull-request-203",
            actorId: "reviewer-architecture",
            appliedAt: "2030-01-02T00:00:00.000Z",
            evidenceDigest: digest,
          },
        }),
        "applied-externally",
      ],
    ] as const;

    for (const [input, expectedState] of cases) {
      const review = createRemediationReview(input, { now });
      expect(review.state).toBe(expectedState);
      expect(review.readOnly).toBe(true);
      expect(review.autoApply).toBe(false);
      expect(review.policyMutation).toBe(false);
      expect(review.mergeAutomation).toBe(false);
      expect(review.authority).toEqual({
        network: false,
        filesystem: false,
        execution: false,
      });
    }
  });

  it("fails closed on missing reviewer and external provenance", () => {
    expect(() =>
      createRemediationReview(
        request({
          decision: "approved",
          validation: {
            status: "passed",
            resultDigest: digest,
            commands: ["review-fixture-validator"],
          },
        }),
        { now },
      ),
    ).toThrowError(RemediationReviewError);
    expect(() =>
      createRemediationReview(
        request({ finalDisposition: "applied-externally" }),
        { now },
      ),
    ).toThrowError(RemediationReviewError);
  });

  it("keeps runtime and JSON Schema output aligned with stable provenance", () => {
    const review = createRemediationReview(request(), { now });
    expect(RemediationReviewSchema.parse(review)).toEqual(review);
    const schema = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../schema/remediation-review.v0.1.schema.json",
        ),
        "utf8",
      ),
    ) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(review)).toBe(true);
    const serialized = serializeRemediationReview(review);
    expect(JSON.parse(serialized)).toEqual(review);
    const reordered = Object.fromEntries(Object.entries(review).reverse());
    expect(serializeRemediationReview(reordered)).toBe(serialized);
    expect(() =>
      serializeRemediationReview({ ...review, reviewDigest: digest }),
    ).toThrowError(RemediationReviewError);
  });
});
