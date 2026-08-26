import { createHash } from "node:crypto";

import { z, ZodError } from "zod";

import {
  AdrReferenceDocumentSchema,
  type AdrReferenceDocument,
} from "./adr.js";
import {
  ArchitectureWaiverEvaluationSchema,
  ArchitectureWaiverStatusSchema,
  type ArchitectureWaiverReport,
} from "./architecture-waivers.js";
import {
  FindingLifecycleReportSchema,
  FindingLifecycleStateSchema,
  type FindingLifecycleFindingResult,
  type FindingLifecycleState,
} from "./finding-lifecycle.js";
import { GraphDiffSchema } from "./schemas.js";
import {
  OwnershipResolutionReportSchema,
  type OwnershipResult,
} from "./ownership.js";
import {
  OwnershipWaiverDriftReportSchema,
  OwnershipWaiverDriftWaiverSchema,
  type OwnershipWaiverDriftWaiver,
} from "./ownership-waiver-drift.js";
import {
  PolicyEvaluationSchema,
  type PolicyViolation,
} from "./policy-evaluation.js";
import { stableStringify } from "./canonical.js";

/**
 * G-005 is a presentation contract over already-materialized local artifacts.
 * It does not rescan a repository, evaluate policy, verify signatures, or
 * grant authority. Missing context is represented explicitly instead of being
 * treated as a clean result.
 */
export const REVIEW_SUMMARY_SCHEMA_VERSION = 1 as const;
export const REVIEW_SUMMARY_CONTRACT = "cartograph.review-summary" as const;
export const REVIEW_SUMMARY_MEDIA_TYPE =
  "application/vnd.cartograph.review-summary+json" as const;
export const REVIEW_SUMMARY_MAX_FINDINGS = 10_000 as const;
export const REVIEW_SUMMARY_MAX_NEXT_STEPS = 10_000 as const;
export const REVIEW_SUMMARY_MAX_EVIDENCE_REFS = 128 as const;
export const REVIEW_SUMMARY_MAX_ARTIFACTS = 128 as const;
export const REVIEW_SUMMARY_MAX_CONTEXT_ITEMS = 10_000 as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );

const ShortTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );

const PortablePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .transform((value, context) => {
    const normalized = value.replaceAll("\\", "/");
    if (
      normalized.includes("\0") ||
      normalized.startsWith("/") ||
      normalized.startsWith("~") ||
      normalized.startsWith("//") ||
      /^[A-Za-z][A-Za-z\d+.-]*:/.test(normalized) ||
      normalized.split("/").some((part) => part === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "must be a repository-relative local path",
      });
      return z.NEVER;
    }
    const compact = normalized
      .split("/")
      .filter((part) => part.length > 0 && part !== ".")
      .join("/");
    if (compact.length === 0) {
      context.addIssue({
        code: "custom",
        message: "must be a repository-relative local path",
      });
      return z.NEVER;
    }
    return compact;
  });

const DateTimeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), "must be a date-time");
const EvidenceReferenceSchema = IdentifierSchema.max(1_024);
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const ReviewSummaryArtifactLinkSchema = z
  .object({
    id: IdentifierSchema,
    label: ShortTextSchema,
    kind: z.enum([
      "diff",
      "policy",
      "lifecycle",
      "ownership",
      "waiver",
      "drift",
      "adr",
      "review",
    ]),
    path: PortablePathSchema,
    local: z.literal(true),
  })
  .strict();

export const ReviewSummaryContextInputSchema = z
  .object({
    policy: PolicyEvaluationSchema.optional(),
    lifecycle: FindingLifecycleReportSchema.optional(),
    ownership: OwnershipResolutionReportSchema.optional(),
    waiverEvaluation: ArchitectureWaiverEvaluationSchema.optional(),
    waiverDrift: OwnershipWaiverDriftReportSchema.optional(),
    waiverSnapshots: z
      .array(OwnershipWaiverDriftWaiverSchema)
      .max(REVIEW_SUMMARY_MAX_CONTEXT_ITEMS)
      .optional(),
    adr: AdrReferenceDocumentSchema.optional(),
    artifacts: z
      .array(ReviewSummaryArtifactLinkSchema)
      .max(REVIEW_SUMMARY_MAX_ARTIFACTS)
      .default([]),
  })
  .strict()
  .superRefine((context, refinement) => {
    const ids = new Set<string>();
    for (const [index, artifact] of context.artifacts.entries()) {
      if (ids.has(artifact.id)) {
        refinement.addIssue({
          code: "custom",
          path: ["artifacts", index, "id"],
          message: `duplicate artifact link ID: ${artifact.id}`,
        });
      }
      ids.add(artifact.id);
    }
    if (context.waiverSnapshots !== undefined) {
      const waiverIds = new Set<string>();
      for (const [index, waiver] of context.waiverSnapshots.entries()) {
        if (waiverIds.has(waiver.id)) {
          refinement.addIssue({
            code: "custom",
            path: ["waiverSnapshots", index, "id"],
            message: `duplicate waiver snapshot ID: ${waiver.id}`,
          });
        }
        waiverIds.add(waiver.id);
      }
    }
  });

export const ReviewSummaryInputSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_SUMMARY_SCHEMA_VERSION),
    contract: z.literal(REVIEW_SUMMARY_CONTRACT),
    diff: GraphDiffSchema,
    context: ReviewSummaryContextInputSchema.default({ artifacts: [] }),
  })
  .strict();

export const ReviewSummaryOwnerSchema = z
  .object({
    status: z.enum([
      "resolved",
      "unowned",
      "ambiguous",
      "unavailable",
      "unsupported",
      "not-provided",
    ]),
    refs: z.array(IdentifierSchema).max(64),
    source: z
      .object({
        id: IdentifierSchema,
        path: PortablePathSchema,
        ruleId: IdentifierSchema,
        matchedPath: z.enum(["current", "previous"]),
      })
      .strict()
      .optional(),
    evidenceRefs: z
      .array(EvidenceReferenceSchema)
      .max(REVIEW_SUMMARY_MAX_EVIDENCE_REFS),
  })
  .strict();

export const ReviewSummaryWaiverSchema = z
  .object({
    status: z.union([
      ArchitectureWaiverStatusSchema,
      z.literal("not-provided"),
    ]),
    code: z.string().regex(/^(?:WAIVER_[A-Z0-9_]+|NOT_PROVIDED)$/u),
    id: IdentifierSchema.optional(),
    expiresAt: DateTimeSchema.optional(),
    expiryState: z.enum(["none", "expiring", "expired", "not-provided"]),
    evidenceRefs: z
      .array(EvidenceReferenceSchema)
      .max(REVIEW_SUMMARY_MAX_EVIDENCE_REFS),
  })
  .strict();

export const ReviewSummaryPolicySchema = z
  .object({
    policyId: IdentifierSchema,
    policyVersion: IdentifierSchema,
    mode: z.enum(["informational", "enforce"]),
    status: z.enum(["passed", "violations", "unsupported"]),
    ruleId: IdentifierSchema.optional(),
    violationId: IdentifierSchema.optional(),
    evidenceRefs: z
      .array(EvidenceReferenceSchema)
      .max(REVIEW_SUMMARY_MAX_EVIDENCE_REFS),
  })
  .strict();

export const ReviewSummaryAdrReferenceSchema = z
  .object({
    id: IdentifierSchema,
    title: ShortTextSchema,
    status: z.enum([
      "draft",
      "proposed",
      "accepted",
      "rejected",
      "deprecated",
      "superseded",
    ]),
    file: PortablePathSchema,
    graphIds: z.array(IdentifierSchema).max(256),
  })
  .strict();

export const ReviewSummaryAdrSchema = z
  .object({
    available: z.boolean(),
    references: z
      .array(ReviewSummaryAdrReferenceSchema)
      .max(REVIEW_SUMMARY_MAX_CONTEXT_ITEMS),
    diagnostics: z.array(ShortTextSchema).max(REVIEW_SUMMARY_MAX_CONTEXT_ITEMS),
  })
  .strict();

export const ReviewSummaryFindingSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum(["policy", "lifecycle", "ownership", "waiver", "drift"]),
    title: ShortTextSchema,
    severity: z.enum(["info", "warning", "error"]),
    change: z.enum(["new", "changed", "accepted", "removed", "unchanged"]),
    code: IdentifierSchema.optional(),
    lifecycleState: FindingLifecycleStateSchema.optional(),
    owner: ReviewSummaryOwnerSchema,
    waiver: ReviewSummaryWaiverSchema,
    policy: ReviewSummaryPolicySchema.optional(),
    adrIds: z.array(IdentifierSchema).max(256),
    driftCodes: z.array(z.string().regex(/^DRIFT_[A-Z0-9_]+$/u)).max(256),
    evidenceRefs: z
      .array(EvidenceReferenceSchema)
      .max(REVIEW_SUMMARY_MAX_EVIDENCE_REFS),
    nextStepIds: z.array(IdentifierSchema).max(64),
  })
  .strict();

export const ReviewSummaryNextStepSchema = z
  .object({
    id: IdentifierSchema,
    code: z.enum([
      "provide-policy",
      "provide-lifecycle",
      "provide-ownership",
      "provide-waiver",
      "provide-adr",
      "assign-owner",
      "resolve-owner",
      "triage-finding",
      "review-policy",
      "review-waiver",
      "review-adr",
      "refresh-evidence",
    ]),
    title: ShortTextSchema,
    action: ShortTextSchema,
    severity: z.enum(["info", "warning", "error"]),
    subjectId: IdentifierSchema.optional(),
    evidenceRefs: z
      .array(EvidenceReferenceSchema)
      .max(REVIEW_SUMMARY_MAX_EVIDENCE_REFS),
    mutates: z.literal(false),
  })
  .strict();

const CountSchema = z.number().int().nonnegative();
export const ReviewSummaryContextSchema = z
  .object({
    policy: z
      .object({
        available: z.boolean(),
        policyId: IdentifierSchema.optional(),
        policyVersion: IdentifierSchema.optional(),
        mode: z.enum(["informational", "enforce"]).optional(),
        status: z.enum(["passed", "violations", "unsupported"]).optional(),
        violations: CountSchema,
        unsupported: CountSchema,
        exceptions: CountSchema,
      })
      .strict(),
    lifecycle: z
      .object({
        available: z.boolean(),
        findings: CountSchema,
        events: CountSchema,
        diagnostics: CountSchema,
        states: z.record(FindingLifecycleStateSchema, CountSchema),
      })
      .strict(),
    ownership: z
      .object({
        available: z.boolean(),
        targets: CountSchema,
        resolved: CountSchema,
        unowned: CountSchema,
        ambiguous: CountSchema,
        unavailable: CountSchema,
        unsupported: CountSchema,
      })
      .strict(),
    waivers: z
      .object({
        available: z.boolean(),
        total: CountSchema,
        active: CountSchema,
        expiring: CountSchema,
        expired: CountSchema,
        invalid: CountSchema,
        suppressed: CountSchema,
        driftDiagnostics: CountSchema,
      })
      .strict(),
    adr: ReviewSummaryAdrSchema,
    artifacts: z
      .array(ReviewSummaryArtifactLinkSchema)
      .max(REVIEW_SUMMARY_MAX_ARTIFACTS),
  })
  .strict();

export const ReviewSummaryCountsSchema = z
  .object({
    findings: CountSchema,
    new: CountSchema,
    changed: CountSchema,
    accepted: CountSchema,
    removed: CountSchema,
    unchanged: CountSchema,
    ownerless: CountSchema,
    ambiguousOwners: CountSchema,
    waiverActive: CountSchema,
    waiverExpiring: CountSchema,
    waiverExpired: CountSchema,
    waiverInvalid: CountSchema,
    policyViolations: CountSchema,
    policyUnsupported: CountSchema,
    adrStale: CountSchema,
    actionable: CountSchema,
    evidenceRefs: CountSchema,
  })
  .strict();

export const ReviewSummaryLimitsSchema = z
  .object({
    maxFindings: z.literal(REVIEW_SUMMARY_MAX_FINDINGS),
    maxNextSteps: z.literal(REVIEW_SUMMARY_MAX_NEXT_STEPS),
    maxEvidenceRefs: z.literal(REVIEW_SUMMARY_MAX_EVIDENCE_REFS),
    maxArtifacts: z.literal(REVIEW_SUMMARY_MAX_ARTIFACTS),
  })
  .strict();

export const ReviewSummaryProvenanceSchema = z
  .object({
    resolver: z.literal(REVIEW_SUMMARY_CONTRACT),
    resolverVersion: z.literal("1"),
    inputDigest: DigestSchema,
    deterministic: z.literal(true),
    readOnly: z.literal(true),
    network: z.literal(false),
    sourceBodiesIncluded: z.literal(false),
    privateKeysIncluded: z.literal(false),
    authorityGranted: z.literal(false),
    automaticActions: z.literal(false),
  })
  .strict();

export const ReviewSummaryReportSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_SUMMARY_SCHEMA_VERSION),
    contract: z.literal(REVIEW_SUMMARY_CONTRACT),
    mediaType: z.literal(REVIEW_SUMMARY_MEDIA_TYPE),
    status: z.enum(["clean", "attention", "unsupported"]),
    fromRevision: GraphDiffSchema.shape.fromRevision,
    toRevision: GraphDiffSchema.shape.toRevision,
    comparison: GraphDiffSchema.shape.comparison,
    summary: ReviewSummaryCountsSchema,
    context: ReviewSummaryContextSchema,
    findings: z
      .array(ReviewSummaryFindingSchema)
      .max(REVIEW_SUMMARY_MAX_FINDINGS),
    nextSteps: z
      .array(ReviewSummaryNextStepSchema)
      .max(REVIEW_SUMMARY_MAX_NEXT_STEPS),
    artifacts: z
      .array(ReviewSummaryArtifactLinkSchema)
      .max(REVIEW_SUMMARY_MAX_ARTIFACTS),
    limits: ReviewSummaryLimitsSchema,
    provenance: ReviewSummaryProvenanceSchema,
  })
  .strict()
  .superRefine((report, refinement) => {
    if (report.summary.findings !== report.findings.length) {
      refinement.addIssue({
        code: "custom",
        path: ["summary", "findings"],
        message: "finding count must match findings",
      });
    }
    if (report.summary.actionable !== report.nextSteps.length) {
      refinement.addIssue({
        code: "custom",
        path: ["summary", "actionable"],
        message: "actionable count must match nextSteps",
      });
    }
    if (report.status === "clean" && report.nextSteps.length > 0) {
      refinement.addIssue({
        code: "custom",
        path: ["status"],
        message: "clean reports cannot contain next steps",
      });
    }
  });

export type ReviewSummaryArtifactLink = z.infer<
  typeof ReviewSummaryArtifactLinkSchema
>;
export type ReviewSummaryInput = z.infer<typeof ReviewSummaryInputSchema>;
export type ReviewSummaryContextInput = z.infer<
  typeof ReviewSummaryContextInputSchema
>;
export type ReviewSummaryOwner = z.infer<typeof ReviewSummaryOwnerSchema>;
export type ReviewSummaryWaiver = z.infer<typeof ReviewSummaryWaiverSchema>;
export type ReviewSummaryPolicy = z.infer<typeof ReviewSummaryPolicySchema>;
export type ReviewSummaryAdrReference = z.infer<
  typeof ReviewSummaryAdrReferenceSchema
>;
export type ReviewSummaryAdr = z.infer<typeof ReviewSummaryAdrSchema>;
export type ReviewSummaryFinding = z.infer<typeof ReviewSummaryFindingSchema>;
export type ReviewSummaryNextStep = z.infer<typeof ReviewSummaryNextStepSchema>;
export type ReviewSummaryContext = z.infer<typeof ReviewSummaryContextSchema>;
export type ReviewSummaryCounts = z.infer<typeof ReviewSummaryCountsSchema>;
export type ReviewSummaryLimits = z.infer<typeof ReviewSummaryLimitsSchema>;
export type ReviewSummaryProvenance = z.infer<
  typeof ReviewSummaryProvenanceSchema
>;
export type ReviewSummaryReport = z.infer<typeof ReviewSummaryReportSchema>;

export class ReviewSummaryValidationError extends Error {
  readonly issues: readonly z.ZodIssue[];

  constructor(message: string, issues: readonly z.ZodIssue[] = []) {
    super(message);
    this.name = "ReviewSummaryValidationError";
    this.issues = issues;
  }
}

const issueText = (issues: readonly z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

const parseWith = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T => {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ReviewSummaryValidationError(
        `${label} validation failed: ${issueText(error.issues)}`,
        error.issues,
      );
    }
    throw error;
  }
};

export const parseReviewSummaryInput = (value: unknown): ReviewSummaryInput =>
  parseWith(ReviewSummaryInputSchema, value, "review summary input");

export const parseReviewSummaryReport = (value: unknown): ReviewSummaryReport =>
  parseWith(ReviewSummaryReportSchema, value, "review summary report");

export const serializeReviewSummary = (value: unknown): string =>
  stableStringify(parseReviewSummaryReport(value));

const digest = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const unsafePayloadPatterns = [
  /(?:ghp_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16})/iu,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /(?:^|[\s"'`])\/(?:Users|home|private|var|tmp|etc)\//u,
  /(?:^|[\s"'`])[A-Za-z]:[\\/]/u,
];

const assertSafePayload = (value: unknown, path = "input"): void => {
  if (typeof value === "string") {
    if (unsafePayloadPatterns.some((pattern) => pattern.test(value)))
      throw new ReviewSummaryValidationError(
        `review summary input contains unsafe payload at ${path}`,
      );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSafePayload(item, `${path}[${index}]`),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value))
      assertSafePayload(child, `${path}.${key}`);
  }
};

type MutableFinding = {
  id: string;
  kind: ReviewSummaryFinding["kind"];
  title: string;
  severity: ReviewSummaryFinding["severity"];
  change: ReviewSummaryFinding["change"];
  code?: string;
  lifecycleState?: FindingLifecycleState;
  owner: ReviewSummaryOwner;
  waiver: ReviewSummaryWaiver;
  policy?: ReviewSummaryPolicy;
  adrIds: string[];
  driftCodes: string[];
  evidenceRefs: string[];
  nextStepIds: string[];
};

type MutableNextStep = ReviewSummaryNextStep;

const emptyOwner = (): ReviewSummaryOwner => ({
  status: "not-provided",
  refs: [],
  evidenceRefs: [],
});

const emptyWaiver = (): ReviewSummaryWaiver => ({
  status: "not-provided",
  code: "NOT_PROVIDED",
  expiryState: "not-provided",
  evidenceRefs: [],
});

const severityForLifecycle = (
  state: FindingLifecycleState,
): ReviewSummaryFinding["severity"] => {
  if (state === "open" || state === "regressed") return "error";
  if (state === "acknowledged" || state === "waived") return "warning";
  return "info";
};

const changeForLifecycle = (
  finding: FindingLifecycleFindingResult,
): ReviewSummaryFinding["change"] => {
  if (finding.state === "obsolete") return "removed";
  if (finding.eventIds.length > 0) return "changed";
  if (finding.state === "acknowledged" || finding.state === "waived")
    return "accepted";
  return "new";
};

const createFinding = (
  id: string,
  kind: MutableFinding["kind"],
  title: string,
  severity: MutableFinding["severity"],
  change: MutableFinding["change"],
): MutableFinding => ({
  id,
  kind,
  title,
  severity,
  change,
  owner: emptyOwner(),
  waiver: emptyWaiver(),
  adrIds: [],
  driftCodes: [],
  evidenceRefs: [],
  nextStepIds: [],
});

const addEvidence = (
  finding: MutableFinding,
  refs: readonly string[],
): void => {
  finding.evidenceRefs = sortedUnique([...finding.evidenceRefs, ...refs]).slice(
    0,
    REVIEW_SUMMARY_MAX_EVIDENCE_REFS,
  );
};

const ownerSource = (
  result: OwnershipResult,
): ReviewSummaryOwner["source"] | undefined => {
  const match = [...result.matches].sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      left.ruleId.localeCompare(right.ruleId),
  )[0];
  if (match === undefined) return undefined;
  return {
    id: match.sourceId,
    path: match.sourcePath,
    ruleId: match.ruleId,
    matchedPath: match.matchedPath,
  };
};

const ownerForResult = (result: OwnershipResult): ReviewSummaryOwner => ({
  status: result.status,
  refs: [...result.owners].sort(compareStrings),
  ...(ownerSource(result) === undefined ? {} : { source: ownerSource(result) }),
  evidenceRefs: sortedUnique(
    result.evidence.map((entry) => entry.reference),
  ).slice(0, REVIEW_SUMMARY_MAX_EVIDENCE_REFS),
});

const ownerMatchesFinding = (
  result: OwnershipResult,
  finding: MutableFinding,
  policyViolation?: PolicyViolation,
): boolean => {
  const identity = result.target.stableKey ?? result.target.id;
  if (finding.id === result.target.id || finding.id === identity) return true;
  if (policyViolation?.matches.includes(result.target.id)) return true;
  if (finding.id.startsWith("ownership:") && finding.id.endsWith(identity))
    return true;
  return false;
};

const adrProjection = (
  document: AdrReferenceDocument | undefined,
): ReviewSummaryAdr => {
  if (document === undefined)
    return { available: false, references: [], diagnostics: [] };
  return {
    available: true,
    references: [...document.references]
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((reference) => ({
        id: reference.id,
        title: reference.title,
        status: reference.status,
        file: reference.file,
        graphIds: [...reference.graphIds].sort(compareStrings),
      })),
    diagnostics: [],
  };
};

const attachAdr = (
  finding: MutableFinding,
  adr: AdrReferenceDocument | undefined,
  policyViolation?: PolicyViolation,
): void => {
  if (adr === undefined) return;
  const ids = new Set<string>();
  if (policyViolation?.adrReferenceId !== undefined)
    ids.add(policyViolation.adrReferenceId);
  for (const reference of adr.references) {
    if (
      reference.graphIds.includes(finding.id) ||
      reference.graphIds.some((graphId) =>
        policyViolation?.matches.includes(graphId),
      )
    )
      ids.add(reference.id);
  }
  finding.adrIds = sortedUnique([...finding.adrIds, ...ids]);
};

const waiverExpiry = (
  report: ArchitectureWaiverReport,
  snapshot: OwnershipWaiverDriftWaiver | undefined,
): Pick<ReviewSummaryWaiver, "expiresAt" | "expiryState"> => {
  if (report.status === "expiring")
    return {
      ...(snapshot?.expiresAt === undefined
        ? {}
        : { expiresAt: snapshot.expiresAt }),
      expiryState: "expiring",
    };
  if (report.status === "expired")
    return {
      ...(snapshot?.expiresAt === undefined
        ? {}
        : { expiresAt: snapshot.expiresAt }),
      expiryState: "expired",
    };
  return {
    ...(snapshot?.expiresAt === undefined
      ? {}
      : { expiresAt: snapshot.expiresAt }),
    expiryState: "none",
  };
};

const waiverSeverity = (
  status: ReviewSummaryWaiver["status"],
): ReviewSummaryFinding["severity"] => {
  if (
    status === "expired" ||
    status === "invalid" ||
    status === "broadened" ||
    status === "replayed" ||
    status === "revoked" ||
    status === "signature-invalid" ||
    status === "trust-root-untrusted" ||
    status === "scope-mismatch"
  )
    return "error";
  if (
    status === "expiring" ||
    status === "unsigned" ||
    status === "not-effective" ||
    status === "no-match" ||
    status === "shadowed"
  )
    return "warning";
  return "info";
};

const addNextStep = (
  steps: Map<string, MutableNextStep>,
  code: MutableNextStep["code"],
  title: string,
  action: string,
  severity: MutableNextStep["severity"],
  subjectId: string | undefined,
  evidenceRefs: readonly string[],
): string => {
  const id = `next:${code}:${subjectId ?? "context"}`;
  const existing = steps.get(id);
  if (existing) {
    existing.evidenceRefs = sortedUnique([
      ...existing.evidenceRefs,
      ...evidenceRefs,
    ]).slice(0, REVIEW_SUMMARY_MAX_EVIDENCE_REFS);
    return id;
  }
  steps.set(id, {
    id,
    code,
    title,
    action,
    severity,
    ...(subjectId === undefined ? {} : { subjectId }),
    evidenceRefs: sortedUnique(evidenceRefs).slice(
      0,
      REVIEW_SUMMARY_MAX_EVIDENCE_REFS,
    ),
    mutates: false,
  });
  return id;
};

const addFinding = (
  findings: Map<string, MutableFinding>,
  finding: MutableFinding,
): MutableFinding => {
  const existing = findings.get(finding.id);
  if (!existing) {
    findings.set(finding.id, finding);
    return finding;
  }
  if (finding.severity === "error" || existing.severity === "info")
    existing.severity = finding.severity;
  if (finding.change === "changed" || existing.change === "unchanged")
    existing.change = finding.change;
  if (finding.code !== undefined) existing.code = finding.code;
  if (finding.lifecycleState !== undefined)
    existing.lifecycleState = finding.lifecycleState;
  if (finding.policy !== undefined) {
    if (existing.policy === undefined) existing.policy = finding.policy;
    else if (
      existing.policy.policyId === finding.policy.policyId &&
      existing.policy.policyVersion === finding.policy.policyVersion &&
      existing.policy.mode === finding.policy.mode &&
      existing.policy.status === finding.policy.status &&
      existing.policy.ruleId === finding.policy.ruleId &&
      existing.policy.violationId === finding.policy.violationId
    ) {
      existing.policy.evidenceRefs = sortedUnique([
        ...existing.policy.evidenceRefs,
        ...finding.policy.evidenceRefs,
      ]).slice(0, REVIEW_SUMMARY_MAX_EVIDENCE_REFS);
    }
  }
  if (finding.owner.status !== "not-provided") {
    if (existing.owner.status === "not-provided") {
      existing.owner = finding.owner;
    } else {
      existing.owner = {
        ...existing.owner,
        refs: sortedUnique([
          ...existing.owner.refs,
          ...finding.owner.refs,
        ]).slice(0, 64),
        ...(existing.owner.source === undefined &&
        finding.owner.source !== undefined
          ? { source: finding.owner.source }
          : {}),
        evidenceRefs: sortedUnique([
          ...existing.owner.evidenceRefs,
          ...finding.owner.evidenceRefs,
        ]).slice(0, REVIEW_SUMMARY_MAX_EVIDENCE_REFS),
      };
    }
  }
  if (finding.waiver.status !== "not-provided") {
    if (existing.waiver.status === "not-provided")
      existing.waiver = finding.waiver;
    else if (existing.waiver.id === finding.waiver.id) {
      existing.waiver.evidenceRefs = sortedUnique([
        ...existing.waiver.evidenceRefs,
        ...finding.waiver.evidenceRefs,
      ]).slice(0, REVIEW_SUMMARY_MAX_EVIDENCE_REFS);
      if (
        existing.waiver.expiresAt === undefined &&
        finding.waiver.expiresAt !== undefined
      )
        existing.waiver.expiresAt = finding.waiver.expiresAt;
      if (existing.waiver.expiryState === "not-provided")
        existing.waiver.expiryState = finding.waiver.expiryState;
    }
  }
  existing.adrIds = sortedUnique([...existing.adrIds, ...finding.adrIds]);
  existing.driftCodes = sortedUnique([
    ...existing.driftCodes,
    ...finding.driftCodes,
  ]);
  addEvidence(existing, finding.evidenceRefs);
  if (existing.title.length === 0) existing.title = finding.title;
  return existing;
};

const contextProjection = (
  input: ReviewSummaryInput,
  adr: ReviewSummaryAdr,
): ReviewSummaryContext => {
  const policy = input.context.policy;
  const lifecycle = input.context.lifecycle;
  const ownership = input.context.ownership;
  const waiverEvaluation = input.context.waiverEvaluation;
  const drift = input.context.waiverDrift;
  const snapshots = input.context.waiverSnapshots ?? [];
  const snapshotCount = (status: ReviewSummaryWaiver["status"]): number =>
    snapshots.filter((snapshot) => snapshot.status === status).length;
  const lifecycleStates = Object.fromEntries(
    [
      "open",
      "acknowledged",
      "remediated",
      "waived",
      "regressed",
      "obsolete",
    ].map((state) => [
      state,
      lifecycle?.summary.states[state as FindingLifecycleState] ?? 0,
    ]),
  ) as Record<FindingLifecycleState, number>;
  return {
    policy: {
      available: policy !== undefined,
      ...(policy === undefined
        ? {}
        : {
            policyId: policy.policyId,
            policyVersion: policy.policyVersion,
            mode: policy.mode,
            status: policy.status,
          }),
      violations: policy?.violations.length ?? 0,
      unsupported: policy?.unsupported.length ?? 0,
      exceptions: policy?.exceptions.length ?? 0,
    },
    lifecycle: {
      available: lifecycle !== undefined,
      findings: lifecycle?.findings.length ?? 0,
      events: lifecycle?.summary.events ?? 0,
      diagnostics: lifecycle?.diagnostics.length ?? 0,
      states: lifecycleStates,
    },
    ownership: {
      available: ownership !== undefined,
      targets: ownership?.summary.targets ?? 0,
      resolved: ownership?.summary.resolved ?? 0,
      unowned: ownership?.summary.unowned ?? 0,
      ambiguous: ownership?.summary.ambiguous ?? 0,
      unavailable: ownership?.summary.unavailable ?? 0,
      unsupported: ownership?.summary.unsupported ?? 0,
    },
    waivers: {
      available:
        waiverEvaluation !== undefined ||
        drift !== undefined ||
        input.context.waiverSnapshots !== undefined,
      total:
        waiverEvaluation?.waivers.length ??
        drift?.summary.waivers ??
        snapshots.length,
      active: waiverEvaluation?.summary.active ?? snapshotCount("active"),
      expiring:
        waiverEvaluation?.summary.expiring ??
        drift?.summary.waiversExpiring ??
        snapshotCount("expiring"),
      expired:
        waiverEvaluation?.summary.expired ??
        drift?.summary.waiversExpired ??
        snapshotCount("expired"),
      invalid:
        waiverEvaluation?.summary.invalid ??
        drift?.summary.invalidSignatures ??
        snapshots.filter(
          (snapshot) =>
            snapshot.status !== "active" &&
            snapshot.status !== "expiring" &&
            snapshot.status !== "expired",
        ).length,
      suppressed: waiverEvaluation?.suppressed.length ?? 0,
      driftDiagnostics: drift?.diagnostics.length ?? 0,
    },
    adr,
    artifacts: [...input.context.artifacts].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
  };
};

const countAdrStale = (
  finding: MutableFinding,
  adr: ReviewSummaryAdr,
): boolean =>
  finding.adrIds.some((id) => {
    const reference = adr.references.find((candidate) => candidate.id === id);
    return (
      reference?.status === "deprecated" || reference?.status === "superseded"
    );
  });

export const buildReviewSummary = (value: unknown): ReviewSummaryReport => {
  const parsed = parseReviewSummaryInput(value);
  assertSafePayload(parsed);
  const findings = new Map<string, MutableFinding>();
  const policyViolations = new Map<string, PolicyViolation>();

  for (const lifecycleFinding of parsed.context.lifecycle?.findings ?? []) {
    const finding = createFinding(
      lifecycleFinding.findingId,
      "lifecycle",
      lifecycleFinding.identity.code,
      severityForLifecycle(lifecycleFinding.state),
      changeForLifecycle(lifecycleFinding),
    );
    finding.lifecycleState = lifecycleFinding.state;
    finding.code = lifecycleFinding.identity.code;
    addEvidence(
      finding,
      lifecycleFinding.evidence.map((entry) => entry.reference),
    );
    addFinding(findings, finding);
  }

  for (const violation of parsed.context.policy?.violations ?? []) {
    policyViolations.set(violation.id, violation);
    const finding = createFinding(
      violation.id,
      "policy",
      `Policy rule ${violation.ruleId}`,
      violation.effect === "enforce" ? "error" : "warning",
      "new",
    );
    finding.code = violation.ruleId;
    finding.policy = {
      policyId: violation.policyId,
      policyVersion: parsed.context.policy?.policyVersion ?? "0.0.0",
      mode: violation.effect,
      status: parsed.context.policy?.status ?? "violations",
      ruleId: violation.ruleId,
      violationId: violation.id,
      evidenceRefs: sortedUnique(violation.evidenceRefs).slice(
        0,
        REVIEW_SUMMARY_MAX_EVIDENCE_REFS,
      ),
    };
    addEvidence(finding, violation.evidenceRefs);
    addFinding(findings, finding);
  }

  for (const unsupported of parsed.context.policy?.unsupported ?? []) {
    const finding = createFinding(
      unsupported.id,
      "policy",
      `Unsupported policy rule ${unsupported.ruleId}`,
      "warning",
      "changed",
    );
    finding.code = unsupported.code;
    finding.policy = {
      policyId: unsupported.policyId,
      policyVersion: parsed.context.policy?.policyVersion ?? "0.0.0",
      mode: parsed.context.policy?.mode ?? "informational",
      status: "unsupported",
      ruleId: unsupported.ruleId,
      violationId: unsupported.id,
      evidenceRefs: sortedUnique(unsupported.evidenceRefs).slice(
        0,
        REVIEW_SUMMARY_MAX_EVIDENCE_REFS,
      ),
    };
    addEvidence(finding, unsupported.evidenceRefs);
    addFinding(findings, finding);
  }

  for (const result of parsed.context.ownership?.results ?? []) {
    const identity = result.target.stableKey ?? result.target.id;
    let matched = [...findings.values()].find((finding) =>
      ownerMatchesFinding(
        result,
        finding,
        finding.policy?.violationId === undefined
          ? undefined
          : policyViolations.get(finding.policy.violationId),
      ),
    );
    if (matched === undefined) {
      matched = addFinding(
        findings,
        createFinding(
          `ownership:${identity}`,
          "ownership",
          `Ownership target ${identity}`,
          result.status === "resolved" ? "info" : "warning",
          result.status === "unowned" ? "new" : "unchanged",
        ),
      );
    }
    matched.owner = ownerForResult(result);
    addEvidence(matched, matched.owner.evidenceRefs);
  }

  const waiverSnapshots = new Map(
    (parsed.context.waiverSnapshots ?? []).map((snapshot) => [
      snapshot.id,
      snapshot,
    ]),
  );
  const suppressionByViolation = new Map(
    (parsed.context.waiverEvaluation?.suppressed ?? []).map((suppression) => [
      suppression.violationId,
      suppression.waiverId,
    ]),
  );
  for (const report of parsed.context.waiverEvaluation?.waivers ?? []) {
    const violationId = [...suppressionByViolation.entries()].find(
      ([, waiverId]) => waiverId === report.id,
    )?.[0];
    let matched =
      violationId === undefined ? undefined : findings.get(violationId);
    if (matched === undefined) {
      matched = addFinding(
        findings,
        createFinding(
          `waiver:${report.id}`,
          "waiver",
          `Waiver ${report.id}`,
          waiverSeverity(report.status),
          report.status === "active" || report.status === "expiring"
            ? "accepted"
            : "changed",
        ),
      );
    }
    const snapshot = waiverSnapshots.get(report.id);
    const expiry = waiverExpiry(report, snapshot);
    matched.waiver = {
      status: report.status,
      code: report.code,
      id: report.id,
      ...expiry,
      evidenceRefs: sortedUnique(report.evidenceRefs).slice(
        0,
        REVIEW_SUMMARY_MAX_EVIDENCE_REFS,
      ),
    };
    addEvidence(matched, report.evidenceRefs);
    if (matched.policy === undefined && report.ruleId !== undefined) {
      const violation = [...policyViolations.values()].find(
        (candidate) => candidate.ruleId === report.ruleId,
      );
      if (violation !== undefined) {
        matched.policy = {
          policyId: violation.policyId,
          policyVersion: parsed.context.policy?.policyVersion ?? "0.0.0",
          mode: violation.effect,
          status: parsed.context.policy?.status ?? "violations",
          ruleId: violation.ruleId,
          violationId: violation.id,
          evidenceRefs: sortedUnique(violation.evidenceRefs).slice(
            0,
            REVIEW_SUMMARY_MAX_EVIDENCE_REFS,
          ),
        };
      }
    }
  }

  if (parsed.context.waiverEvaluation === undefined) {
    for (const snapshot of parsed.context.waiverSnapshots ?? []) {
      const finding = addFinding(
        findings,
        createFinding(
          `waiver:${snapshot.id}`,
          "waiver",
          `Waiver ${snapshot.id}`,
          waiverSeverity(snapshot.status),
          snapshot.status === "active" || snapshot.status === "expiring"
            ? "accepted"
            : "changed",
        ),
      );
      finding.waiver = {
        status: snapshot.status,
        code: snapshot.code,
        id: snapshot.id,
        expiresAt: snapshot.expiresAt,
        expiryState:
          snapshot.status === "expiring"
            ? "expiring"
            : snapshot.status === "expired"
              ? "expired"
              : "none",
        evidenceRefs: sortedUnique(snapshot.evidenceRefs).slice(
          0,
          REVIEW_SUMMARY_MAX_EVIDENCE_REFS,
        ),
      };
      addEvidence(finding, snapshot.evidenceRefs);
    }
  }

  for (const diagnostic of parsed.context.waiverDrift?.diagnostics ?? []) {
    const subject = diagnostic.subjectId;
    let matched = subject === undefined ? undefined : findings.get(subject);
    if (matched === undefined && subject !== undefined) {
      matched = [...findings.values()].find(
        (finding) => finding.id === `waiver:${subject}`,
      );
    }
    if (matched === undefined) {
      matched = addFinding(
        findings,
        createFinding(
          `drift:${diagnostic.id}`,
          "drift",
          diagnostic.message,
          diagnostic.severity,
          "changed",
        ),
      );
    }
    matched.driftCodes = sortedUnique([...matched.driftCodes, diagnostic.code]);
    addEvidence(matched, diagnostic.evidenceRefs);
  }

  const adr = adrProjection(parsed.context.adr);
  for (const finding of findings.values()) {
    const violation =
      finding.policy?.violationId === undefined
        ? undefined
        : policyViolations.get(finding.policy.violationId);
    attachAdr(finding, parsed.context.adr, violation);
  }

  const steps = new Map<string, MutableNextStep>();
  const context = contextProjection(parsed, adr);
  const missingContexts: Array<{
    available: boolean;
    code: MutableNextStep["code"];
    title: string;
    action: string;
  }> = [
    {
      available: context.policy.available,
      code: "provide-policy",
      title: "Provide policy context",
      action:
        "Attach the local policy-evaluation artifact so each finding can show its rule, mode, and status.",
    },
    {
      available: context.lifecycle.available,
      code: "provide-lifecycle",
      title: "Provide lifecycle context",
      action:
        "Attach the local finding-lifecycle artifact to distinguish new, acknowledged, remediated, waived, regressed, and obsolete findings.",
    },
    {
      available: context.ownership.available,
      code: "provide-ownership",
      title: "Provide ownership context",
      action:
        "Attach the local ownership-resolution artifact to show owner references and the source rule that resolved them.",
    },
    {
      available: context.waivers.available,
      code: "provide-waiver",
      title: "Provide waiver context",
      action:
        "Attach the local waiver evaluation and safe snapshot artifacts to show validity and expiry without signing material.",
    },
    {
      available: context.adr.available,
      code: "provide-adr",
      title: "Provide ADR context",
      action:
        "Attach the repository-relative ADR reference index so decisions and evidence links can be reviewed.",
    },
  ];
  for (const missing of missingContexts) {
    if (!missing.available)
      addNextStep(
        steps,
        missing.code,
        missing.title,
        missing.action,
        "info",
        undefined,
        [`context:${missing.code.replace("provide-", "")}`],
      );
  }

  for (const finding of findings.values()) {
    const refs = finding.evidenceRefs;
    if (finding.owner.status === "unowned")
      finding.nextStepIds.push(
        addNextStep(
          steps,
          "assign-owner",
          "Assign an owner",
          "Assign an explicit owner and rerun ownership resolution; no owner was inferred.",
          "error",
          finding.id,
          refs,
        ),
      );
    else if (
      finding.owner.status === "ambiguous" ||
      finding.owner.status === "unavailable" ||
      finding.owner.status === "unsupported"
    )
      finding.nextStepIds.push(
        addNextStep(
          steps,
          "resolve-owner",
          "Resolve ownership",
          "Review the competing or unavailable ownership evidence before accepting a workflow decision.",
          "warning",
          finding.id,
          refs,
        ),
      );

    if (
      finding.lifecycleState === "open" ||
      finding.lifecycleState === "regressed"
    )
      finding.nextStepIds.push(
        addNextStep(
          steps,
          "triage-finding",
          "Triage the finding",
          "Acknowledge, remediate, or explicitly waive the finding through the lifecycle contract.",
          "warning",
          finding.id,
          refs,
        ),
      );

    if (
      finding.policy !== undefined &&
      finding.policy.status === "violations" &&
      finding.waiver.status === "not-provided"
    )
      finding.nextStepIds.push(
        addNextStep(
          steps,
          "review-policy",
          "Review policy finding",
          "Review the cited policy rule and evidence; this summary does not change policy or suppress a violation.",
          finding.severity,
          finding.id,
          refs,
        ),
      );

    if (
      finding.waiver.status !== "not-provided" &&
      (finding.waiver.expiryState === "expiring" ||
        finding.waiver.expiryState === "expired" ||
        finding.waiver.status !== "active")
    )
      finding.nextStepIds.push(
        addNextStep(
          steps,
          "review-waiver",
          "Review waiver validity",
          "Review or replace the explicit waiver; this report never renews or authorizes an exception.",
          finding.severity,
          finding.id,
          refs,
        ),
      );

    if (countAdrStale(finding, adr))
      finding.nextStepIds.push(
        addNextStep(
          steps,
          "review-adr",
          "Review ADR reference",
          "Update or supersede the stale ADR reference before relying on its decision context.",
          "warning",
          finding.id,
          refs,
        ),
      );

    if (finding.driftCodes.includes("DRIFT_WAIVER_EVIDENCE_CHANGED"))
      finding.nextStepIds.push(
        addNextStep(
          steps,
          "refresh-evidence",
          "Refresh evidence",
          "Re-review the changed evidence revision; the prior decision remains historical.",
          "warning",
          finding.id,
          refs,
        ),
      );

    if (finding.evidenceRefs.length === 0)
      finding.nextStepIds.push(
        addNextStep(
          steps,
          "refresh-evidence",
          "Provide evidence",
          "Attach bounded evidence references before relying on this finding in a review decision.",
          "warning",
          finding.id,
          [],
        ),
      );
  }

  if (findings.size > REVIEW_SUMMARY_MAX_FINDINGS)
    throw new ReviewSummaryValidationError(
      `review summary exceeds the ${REVIEW_SUMMARY_MAX_FINDINGS} finding limit`,
    );
  if (steps.size > REVIEW_SUMMARY_MAX_NEXT_STEPS)
    throw new ReviewSummaryValidationError(
      `review summary exceeds the ${REVIEW_SUMMARY_MAX_NEXT_STEPS} next-step limit`,
    );

  const finalFindings = [...findings.values()]
    .map((finding) => ({
      ...finding,
      adrIds: sortedUnique(finding.adrIds),
      driftCodes: sortedUnique(finding.driftCodes),
      evidenceRefs: sortedUnique(finding.evidenceRefs).slice(
        0,
        REVIEW_SUMMARY_MAX_EVIDENCE_REFS,
      ),
      nextStepIds: sortedUnique(finding.nextStepIds),
    }))
    .sort((left, right) => compareStrings(left.id, right.id));
  const finalSteps = [...steps.values()].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
  const evidenceRefs = sortedUnique(
    finalFindings.flatMap((finding) => finding.evidenceRefs),
  );
  const summary: ReviewSummaryCounts = {
    findings: finalFindings.length,
    new: finalFindings.filter((finding) => finding.change === "new").length,
    changed: finalFindings.filter((finding) => finding.change === "changed")
      .length,
    accepted: finalFindings.filter((finding) => finding.change === "accepted")
      .length,
    removed: finalFindings.filter((finding) => finding.change === "removed")
      .length,
    unchanged: finalFindings.filter((finding) => finding.change === "unchanged")
      .length,
    ownerless: finalFindings.filter(
      (finding) => finding.owner.status === "unowned",
    ).length,
    ambiguousOwners: finalFindings.filter(
      (finding) =>
        finding.owner.status === "ambiguous" ||
        finding.owner.status === "unavailable" ||
        finding.owner.status === "unsupported",
    ).length,
    waiverActive: finalFindings.filter(
      (finding) => finding.waiver.status === "active",
    ).length,
    waiverExpiring: finalFindings.filter(
      (finding) => finding.waiver.expiryState === "expiring",
    ).length,
    waiverExpired: finalFindings.filter(
      (finding) => finding.waiver.expiryState === "expired",
    ).length,
    waiverInvalid: finalFindings.filter(
      (finding) =>
        finding.waiver.status !== "not-provided" &&
        finding.waiver.status !== "active" &&
        finding.waiver.status !== "expiring" &&
        finding.waiver.status !== "expired",
    ).length,
    policyViolations: context.policy.violations,
    policyUnsupported: context.policy.unsupported,
    adrStale: finalFindings.filter((finding) => countAdrStale(finding, adr))
      .length,
    actionable: finalSteps.length,
    evidenceRefs: evidenceRefs.length,
  };
  const unsupportedContext =
    context.policy.status === "unsupported" ||
    parsed.context.waiverDrift?.status === "unsupported";
  const status: ReviewSummaryReport["status"] = unsupportedContext
    ? "unsupported"
    : finalSteps.length === 0
      ? "clean"
      : "attention";
  const report = {
    schemaVersion: REVIEW_SUMMARY_SCHEMA_VERSION,
    contract: REVIEW_SUMMARY_CONTRACT,
    mediaType: REVIEW_SUMMARY_MEDIA_TYPE,
    status,
    fromRevision: parsed.diff.fromRevision,
    toRevision: parsed.diff.toRevision,
    ...(parsed.diff.comparison === undefined
      ? { comparison: undefined }
      : { comparison: parsed.diff.comparison }),
    summary,
    context,
    findings: finalFindings,
    nextSteps: finalSteps,
    artifacts: context.artifacts,
    limits: {
      maxFindings: REVIEW_SUMMARY_MAX_FINDINGS,
      maxNextSteps: REVIEW_SUMMARY_MAX_NEXT_STEPS,
      maxEvidenceRefs: REVIEW_SUMMARY_MAX_EVIDENCE_REFS,
      maxArtifacts: REVIEW_SUMMARY_MAX_ARTIFACTS,
    },
    provenance: {
      resolver: REVIEW_SUMMARY_CONTRACT,
      resolverVersion: "1" as const,
      inputDigest: digest(stableStringify(parsed)),
      deterministic: true as const,
      readOnly: true as const,
      network: false as const,
      sourceBodiesIncluded: false as const,
      privateKeysIncluded: false as const,
      authorityGranted: false as const,
      automaticActions: false as const,
    },
  } satisfies ReviewSummaryReport;
  return parseReviewSummaryReport(report);
};

export const evaluateReviewSummary = buildReviewSummary;
