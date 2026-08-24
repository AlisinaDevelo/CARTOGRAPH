import { createHash } from "node:crypto";

import { z } from "zod";

import { stableStringify } from "./canonical.js";

export const REMEDIATION_REVIEW_SCHEMA_VERSION = 1 as const;
export const REMEDIATION_REVIEW_CONTRACT =
  "cartograph.remediation-review" as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u,
    "must be a portable lower-case identifier",
  );
const DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, "must be a lower-case SHA-256 digest");
const DateTimeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "must be a parseable date-time",
  );
const TextSchema = z.string().trim().min(1).max(2_000);
const CommitSchema = z.string().regex(/^[0-9a-f]{40,64}$/u);

export const RemediationReviewStateSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
  "stale",
  "failed-validation",
  "applied-externally",
]);
export const RemediationReviewDecisionSchema = z.enum([
  "proposed",
  "approved",
  "rejected",
]);
export const RemediationReviewValidationStatusSchema = z.enum([
  "not-run",
  "passed",
  "failed",
]);
export const RemediationReviewFinalDispositionSchema = z.enum([
  "unapplied",
  "applied-externally",
]);

export const RemediationReviewEvidenceRevisionSchema = z
  .object({
    sourceCommit: CommitSchema,
    baselineDigest: DigestSchema,
    evidenceDigest: DigestSchema,
  })
  .strict();

export const RemediationReviewValidationSchema = z
  .object({
    status: RemediationReviewValidationStatusSchema,
    resultDigest: DigestSchema.nullable(),
    commands: z.array(TextSchema).max(16),
  })
  .strict()
  .superRefine((validation, context) => {
    if (validation.status === "not-run" && validation.resultDigest !== null) {
      context.addIssue({
        code: "custom",
        path: ["resultDigest"],
        message: "not-run validation cannot have a result digest",
      });
    }
    if (validation.status !== "not-run" && validation.resultDigest === null) {
      context.addIssue({
        code: "custom",
        path: ["resultDigest"],
        message: "completed validation requires a result digest",
      });
    }
  });

export const RemediationReviewExternalApplicationSchema = z
  .object({
    externalReference: TextSchema.max(240),
    actorId: IdentifierSchema,
    appliedAt: DateTimeSchema,
    evidenceDigest: DigestSchema,
  })
  .strict();

const ReviewRequestShape = {
  schemaVersion: z.literal(REMEDIATION_REVIEW_SCHEMA_VERSION),
  contract: z.literal(REMEDIATION_REVIEW_CONTRACT),
  reviewId: IdentifierSchema,
  suggestionId: IdentifierSchema,
  suggestionVersion: z.number().int().positive(),
  suggestionDigest: DigestSchema,
  ownerId: IdentifierSchema,
  reviewerId: IdentifierSchema.nullable(),
  evidenceRevision: RemediationReviewEvidenceRevisionSchema,
  decision: RemediationReviewDecisionSchema,
  rationale: TextSchema,
  validation: RemediationReviewValidationSchema,
  expiresAt: DateTimeSchema,
  reviewedAt: DateTimeSchema.nullable(),
  finalDisposition: RemediationReviewFinalDispositionSchema,
  externalApplication: RemediationReviewExternalApplicationSchema.nullable(),
} as const;

export const RemediationReviewRequestSchema = z
  .object(ReviewRequestShape)
  .strict()
  .superRefine((request, context) => {
    if (request.decision === "proposed") {
      if (request.reviewerId !== null || request.reviewedAt !== null) {
        context.addIssue({
          code: "custom",
          path: ["reviewerId"],
          message: "proposed reviews cannot claim a reviewer or review time",
        });
      }
    } else if (request.reviewerId === null || request.reviewedAt === null) {
      context.addIssue({
        code: "custom",
        path: ["reviewerId"],
        message: "approved or rejected reviews require reviewer provenance",
      });
    }

    if (request.finalDisposition === "applied-externally") {
      if (
        request.decision !== "approved" ||
        request.validation.status !== "passed" ||
        request.externalApplication === null
      ) {
        context.addIssue({
          code: "custom",
          path: ["finalDisposition"],
          message:
            "external application requires approved, passed, and external provenance",
        });
      }
    } else if (request.externalApplication !== null) {
      context.addIssue({
        code: "custom",
        path: ["externalApplication"],
        message:
          "unapplied reviews cannot contain external application evidence",
      });
    }
  });

export const RemediationReviewSchema = z
  .object({
    ...ReviewRequestShape,
    reviewDigest: DigestSchema,
    state: RemediationReviewStateSchema,
    readOnly: z.literal(true),
    authority: z
      .object({
        network: z.literal(false),
        filesystem: z.literal(false),
        execution: z.literal(false),
      })
      .strict(),
    autoApply: z.literal(false),
    policyMutation: z.literal(false),
    mergeAutomation: z.literal(false),
  })
  .strict()
  .superRefine((review, context) => {
    if (
      review.state === "applied-externally" &&
      review.finalDisposition !== "applied-externally"
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "applied-externally state requires matching disposition",
      });
    }
    if (
      review.state !== "applied-externally" &&
      review.finalDisposition === "applied-externally"
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "external disposition requires applied-externally state",
      });
    }
  });

export type RemediationReviewState = z.infer<
  typeof RemediationReviewStateSchema
>;
export type RemediationReviewDecision = z.infer<
  typeof RemediationReviewDecisionSchema
>;
export type RemediationReviewRequest = z.infer<
  typeof RemediationReviewRequestSchema
>;
export type RemediationReview = z.infer<typeof RemediationReviewSchema>;

export type RemediationReviewErrorCode = "invalid-input";

export class RemediationReviewError extends Error {
  readonly code: RemediationReviewErrorCode;

  constructor(code: RemediationReviewErrorCode, message: string) {
    super(message);
    this.name = "RemediationReviewError";
    this.code = code;
  }
}

export interface CreateRemediationReviewOptions {
  now?: Date | string;
}

const parseNow = (value: Date | string | undefined): Date => {
  const now =
    value instanceof Date
      ? new Date(value.valueOf())
      : new Date(value ?? Date.now());
  if (!Number.isFinite(now.valueOf()))
    throw new RemediationReviewError(
      "invalid-input",
      "review evaluation time must be a valid date",
    );
  return now;
};

const digest = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(stableStringify(value), "utf8").digest("hex")}`;

export const remediationReviewRequestDigest = (
  request: RemediationReviewRequest,
): `sha256:${string}` => digest(request);

const parseRequest = (input: unknown): RemediationReviewRequest => {
  const result = RemediationReviewRequestSchema.safeParse(input);
  if (!result.success)
    throw new RemediationReviewError(
      "invalid-input",
      `remediation review request is invalid: ${result.error.message}`,
    );
  return result.data;
};

const stateFor = (
  request: RemediationReviewRequest,
  now: Date,
): RemediationReviewState => {
  if (request.finalDisposition === "applied-externally")
    return "applied-externally";
  if (request.validation.status === "failed") return "failed-validation";
  if (request.decision === "rejected") return "rejected";
  if (Date.parse(request.expiresAt) <= now.valueOf()) return "stale";
  if (request.decision === "approved") return "approved";
  return "proposed";
};

export const createRemediationReview = (
  input: unknown,
  options: CreateRemediationReviewOptions = {},
): RemediationReview => {
  const request = parseRequest(input);
  const now = parseNow(options.now);
  return RemediationReviewSchema.parse({
    ...request,
    reviewDigest: remediationReviewRequestDigest(request),
    state: stateFor(request, now),
    readOnly: true,
    authority: { network: false, filesystem: false, execution: false },
    autoApply: false,
    policyMutation: false,
    mergeAutomation: false,
  });
};

const requestFromReview = (
  review: RemediationReview,
): RemediationReviewRequest => ({
  schemaVersion: review.schemaVersion,
  contract: review.contract,
  reviewId: review.reviewId,
  suggestionId: review.suggestionId,
  suggestionVersion: review.suggestionVersion,
  suggestionDigest: review.suggestionDigest,
  ownerId: review.ownerId,
  reviewerId: review.reviewerId,
  evidenceRevision: review.evidenceRevision,
  decision: review.decision,
  rationale: review.rationale,
  validation: review.validation,
  expiresAt: review.expiresAt,
  reviewedAt: review.reviewedAt,
  finalDisposition: review.finalDisposition,
  externalApplication: review.externalApplication,
});

export const serializeRemediationReview = (review: unknown): string => {
  const parsed = RemediationReviewSchema.parse(review);
  if (
    parsed.reviewDigest !==
    remediationReviewRequestDigest(requestFromReview(parsed))
  )
    throw new RemediationReviewError(
      "invalid-input",
      "remediation review digest does not match its request",
    );
  return stableStringify(parsed);
};
