import { createHash } from "node:crypto";

import { z, ZodError } from "zod";

import {
  ArchitectureWaiverEvaluationSchema,
  ArchitectureWaiverStatusSchema,
  type ArchitectureWaiverEvaluation,
  type ArchitectureWaiverReport,
} from "./architecture-waivers.js";
import {
  OwnershipResolutionReportSchema,
  type OwnershipResolutionReport,
  type OwnershipResult,
} from "./ownership.js";
import { stableStringify } from "./canonical.js";

/**
 * G-004 is deliberately a comparison contract rather than another source
 * scanner. It consumes the already-reviewed ownership and waiver reports and
 * makes changes in their decision surface explicit. No source body, signing
 * material, network lookup, or automatic renewal is part of this boundary.
 */
export const OWNERSHIP_WAIVER_DRIFT_SCHEMA_VERSION = 1 as const;
export const OWNERSHIP_WAIVER_DRIFT_CONTRACT =
  "cartograph.ownership-waiver-drift" as const;
export const OWNERSHIP_WAIVER_DRIFT_MEDIA_TYPE =
  "application/vnd.cartograph.ownership-waiver-drift+json" as const;
export const OWNERSHIP_WAIVER_DRIFT_MAX_TARGETS = 100_000 as const;
export const OWNERSHIP_WAIVER_DRIFT_MAX_WAIVERS = 128 as const;
export const OWNERSHIP_WAIVER_DRIFT_MAX_TRAIL = 20_000 as const;
export const OWNERSHIP_WAIVER_DRIFT_MAX_DIAGNOSTICS = 100_000 as const;

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
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const DateTimeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), "must be a date-time");
const SemverSchema = z
  .string()
  .trim()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "must be a semantic version",
  );
const EvidenceReferenceSchema = IdentifierSchema.max(1_024);

export const OwnershipWaiverDriftWorkspaceSchema = z
  .object({
    id: IdentifierSchema,
    repositoryIds: z.array(IdentifierSchema).max(1_024),
    complete: z.boolean(),
    missingRepositoryIds: z.array(IdentifierSchema).max(1_024).default([]),
  })
  .strict()
  .superRefine((workspace, context) => {
    const repositories = new Set(workspace.repositoryIds);
    for (const [
      index,
      repositoryId,
    ] of workspace.missingRepositoryIds.entries()) {
      if (repositories.has(repositoryId)) {
        context.addIssue({
          code: "custom",
          path: ["missingRepositoryIds", index],
          message:
            "a missing repository cannot also be present in repositoryIds",
        });
      }
    }
    if (workspace.complete && workspace.missingRepositoryIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["complete"],
        message: "a complete workspace cannot declare missing repositories",
      });
    }
  });

export const OwnershipWaiverDriftKeySchema = z
  .object({
    keyId: IdentifierSchema,
    trustRootId: IdentifierSchema,
    status: z.enum(["active", "retired", "revoked"]),
    validFrom: DateTimeSchema,
    validUntil: DateTimeSchema,
    rotatedFrom: IdentifierSchema.nullable(),
    retiredAt: DateTimeSchema.nullable(),
    revokedAt: DateTimeSchema.nullable(),
  })
  .strict();

/** A safe, digest-oriented waiver projection. It intentionally has no signature bytes. */
export const OwnershipWaiverDriftWaiverSchema = z
  .object({
    id: IdentifierSchema,
    ruleId: IdentifierSchema,
    policyVersion: SemverSchema,
    evidenceRevision: IdentifierSchema,
    createdAt: DateTimeSchema,
    expiresAt: DateTimeSchema,
    waiverDigest: DigestSchema,
    scopeDigest: DigestSchema,
    affectedIds: z.array(IdentifierSchema).max(10_000),
    signerKeyId: IdentifierSchema.optional(),
    trustRootIds: z.array(IdentifierSchema).max(32).default([]),
    status: ArchitectureWaiverStatusSchema,
    code: z.string().regex(/^WAIVER_[A-Z0-9_]+$/u),
    evidenceRefs: z.array(EvidenceReferenceSchema).min(1).max(128),
  })
  .strict();

const DecisionSchema = z.enum([
  "ownership:resolved",
  "ownership:unowned",
  "ownership:ambiguous",
  "ownership:unavailable",
  "ownership:unsupported",
  "waiver:active",
  "waiver:expiring",
  "waiver:unsigned",
  "waiver:invalid",
  "waiver:broadened",
  "waiver:replayed",
  "waiver:expired",
  "waiver:not-effective",
  "waiver:revoked",
  "waiver:signature-invalid",
  "waiver:trust-root-untrusted",
  "waiver:scope-mismatch",
  "waiver:no-match",
  "waiver:shadowed",
]);

/**
 * Decision entries are append-only evidence pointers. The two literal false
 * fields prevent this report from becoming an authorization or renewal log.
 */
export const OwnershipWaiverDriftDecisionSchema = z
  .object({
    id: IdentifierSchema,
    sequence: z.number().int().positive().max(1_000_000_000),
    revision: IdentifierSchema,
    at: DateTimeSchema,
    kind: z.enum(["ownership", "waiver"]),
    subjectId: IdentifierSchema,
    decision: DecisionSchema,
    ownerRefs: z.array(IdentifierSchema).max(64).default([]),
    policyVersion: SemverSchema.optional(),
    evidenceRevision: IdentifierSchema.optional(),
    waiverDigest: DigestSchema.optional(),
    evidenceRefs: z.array(EvidenceReferenceSchema).max(128).default([]),
    authorityGranted: z.literal(false),
    autoExtended: z.literal(false),
  })
  .strict();

export type OwnershipWaiverDriftDecision = z.infer<
  typeof OwnershipWaiverDriftDecisionSchema
>;

export const OwnershipWaiverDriftStateSchema = z
  .object({
    schemaVersion: z.literal(OWNERSHIP_WAIVER_DRIFT_SCHEMA_VERSION),
    contract: z.literal(OWNERSHIP_WAIVER_DRIFT_CONTRACT),
    revision: IdentifierSchema,
    at: DateTimeSchema,
    workspace: OwnershipWaiverDriftWorkspaceSchema,
    policyId: IdentifierSchema,
    policyVersion: SemverSchema,
    evidenceRevision: IdentifierSchema,
    ownership: OwnershipResolutionReportSchema,
    waiverEvaluation: ArchitectureWaiverEvaluationSchema,
    waivers: z
      .array(OwnershipWaiverDriftWaiverSchema)
      .max(OWNERSHIP_WAIVER_DRIFT_MAX_WAIVERS),
    keyring: z.array(OwnershipWaiverDriftKeySchema).max(1_000).default([]),
    decisionTrail: z
      .array(OwnershipWaiverDriftDecisionSchema)
      .max(OWNERSHIP_WAIVER_DRIFT_MAX_TRAIL)
      .default([]),
  })
  .strict()
  .superRefine((state, context) => {
    const waiverIds = new Set<string>();
    for (const [index, waiver] of state.waivers.entries()) {
      if (waiverIds.has(waiver.id)) {
        context.addIssue({
          code: "custom",
          path: ["waivers", index, "id"],
          message: `duplicate waiver snapshot ID: ${waiver.id}`,
        });
      }
      waiverIds.add(waiver.id);
    }
    const keyIds = new Set<string>();
    for (const [index, key] of state.keyring.entries()) {
      if (keyIds.has(key.keyId)) {
        context.addIssue({
          code: "custom",
          path: ["keyring", index, "keyId"],
          message: `duplicate signing key ID: ${key.keyId}`,
        });
      }
      keyIds.add(key.keyId);
    }
    const decisionIds = new Set<string>();
    for (const [index, decision] of state.decisionTrail.entries()) {
      if (decisionIds.has(decision.id)) {
        context.addIssue({
          code: "custom",
          path: ["decisionTrail", index, "id"],
          message: `duplicate decision ID: ${decision.id}`,
        });
      }
      decisionIds.add(decision.id);
    }
  });

export const OwnershipWaiverDriftInputSchema = z
  .object({
    schemaVersion: z.literal(OWNERSHIP_WAIVER_DRIFT_SCHEMA_VERSION),
    contract: z.literal(OWNERSHIP_WAIVER_DRIFT_CONTRACT),
    current: OwnershipWaiverDriftStateSchema,
    previous: OwnershipWaiverDriftStateSchema.optional(),
  })
  .strict();

const DriftChangeValueSchema = z
  .object({
    owners: z.array(IdentifierSchema).max(64).optional(),
    repositoryId: IdentifierSchema.optional(),
    status: z.string().max(160).optional(),
    policyVersion: SemverSchema.optional(),
    evidenceRevision: IdentifierSchema.optional(),
    signerKeyId: IdentifierSchema.optional(),
    scopeDigest: DigestSchema.optional(),
    waiverDigest: DigestSchema.optional(),
  })
  .strict();

export const OwnershipWaiverDriftChangeSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum([
      "owner",
      "repository",
      "waiver",
      "policy",
      "evidence",
      "signing-key",
      "workspace",
    ]),
    subjectId: IdentifierSchema,
    previous: DriftChangeValueSchema.optional(),
    current: DriftChangeValueSchema.optional(),
    diagnosticCodes: z.array(z.string().regex(/^DRIFT_[A-Z0-9_]+$/u)),
    evidenceRefs: z.array(EvidenceReferenceSchema).min(1).max(128),
  })
  .strict();

export const OwnershipWaiverDriftDiagnosticCodeSchema = z
  .string()
  .regex(/^DRIFT_[A-Z0-9_]+$/u);

export const OwnershipWaiverDriftDiagnosticSchema = z
  .object({
    id: IdentifierSchema,
    code: OwnershipWaiverDriftDiagnosticCodeSchema,
    severity: z.enum(["info", "warning", "error"]),
    message: IdentifierSchema,
    subjectId: IdentifierSchema.optional(),
    previousRevision: IdentifierSchema.optional(),
    currentRevision: IdentifierSchema,
    evidenceRefs: z.array(EvidenceReferenceSchema).min(1).max(128),
  })
  .strict();

export const OwnershipWaiverDriftSummarySchema = z
  .object({
    targets: z.number().int().nonnegative(),
    waivers: z.number().int().nonnegative(),
    ownerDisappeared: z.number().int().nonnegative(),
    ambiguousReassignment: z.number().int().nonnegative(),
    repositoryMoves: z.number().int().nonnegative(),
    waiverScopeDrift: z.number().int().nonnegative(),
    waiversExpiring: z.number().int().nonnegative(),
    waiversExpired: z.number().int().nonnegative(),
    invalidSignatures: z.number().int().nonnegative(),
    evidenceChanges: z.number().int().nonnegative(),
    policyChanges: z.number().int().nonnegative(),
    keyRotations: z.number().int().nonnegative(),
    partialWorkspaces: z.number().int().nonnegative(),
    changes: z.number().int().nonnegative(),
    diagnostics: z.number().int().nonnegative(),
    decisionTrail: z.number().int().nonnegative(),
  })
  .strict();

export const OwnershipWaiverDriftProvenanceSchema = z
  .object({
    resolver: z.literal(OWNERSHIP_WAIVER_DRIFT_CONTRACT),
    resolverVersion: z.literal("1"),
    inputDigest: DigestSchema,
    network: z.literal(false),
    sourceBodiesIncluded: z.literal(false),
    privateKeysIncluded: z.literal(false),
    authorityGranted: z.literal(false),
    autoExtended: z.literal(false),
    deterministic: z.literal(true),
  })
  .strict();

export const OwnershipWaiverDriftReportSchema = z
  .object({
    schemaVersion: z.literal(OWNERSHIP_WAIVER_DRIFT_SCHEMA_VERSION),
    contract: z.literal(OWNERSHIP_WAIVER_DRIFT_CONTRACT),
    mediaType: z.literal(OWNERSHIP_WAIVER_DRIFT_MEDIA_TYPE),
    status: z.enum(["clean", "drift", "unsupported"]),
    previousRevision: IdentifierSchema.optional(),
    currentRevision: IdentifierSchema,
    summary: OwnershipWaiverDriftSummarySchema,
    changes: z
      .array(OwnershipWaiverDriftChangeSchema)
      .max(OWNERSHIP_WAIVER_DRIFT_MAX_TARGETS),
    diagnostics: z
      .array(OwnershipWaiverDriftDiagnosticSchema)
      .max(OWNERSHIP_WAIVER_DRIFT_MAX_DIAGNOSTICS),
    decisionTrail: z
      .array(OwnershipWaiverDriftDecisionSchema)
      .max(OWNERSHIP_WAIVER_DRIFT_MAX_TRAIL),
    provenance: OwnershipWaiverDriftProvenanceSchema,
  })
  .strict()
  .superRefine((report, context) => {
    if (report.summary.changes !== report.changes.length) {
      context.addIssue({
        code: "custom",
        path: ["summary", "changes"],
        message: "change count must match changes",
      });
    }
    if (report.summary.diagnostics !== report.diagnostics.length) {
      context.addIssue({
        code: "custom",
        path: ["summary", "diagnostics"],
        message: "diagnostic count must match diagnostics",
      });
    }
    if (report.summary.decisionTrail !== report.decisionTrail.length) {
      context.addIssue({
        code: "custom",
        path: ["summary", "decisionTrail"],
        message: "decision-trail count must match decisionTrail",
      });
    }
    if (report.status === "clean" && report.diagnostics.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "clean reports cannot contain diagnostics",
      });
    }
    if (
      report.status === "unsupported" &&
      report.summary.partialWorkspaces === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "unsupported reports must identify a partial workspace",
      });
    }
  });

export type OwnershipWaiverDriftWorkspace = z.infer<
  typeof OwnershipWaiverDriftWorkspaceSchema
>;
export type OwnershipWaiverDriftKey = z.infer<
  typeof OwnershipWaiverDriftKeySchema
>;
export type OwnershipWaiverDriftWaiver = z.infer<
  typeof OwnershipWaiverDriftWaiverSchema
>;
export type OwnershipWaiverDriftState = z.infer<
  typeof OwnershipWaiverDriftStateSchema
>;
export type OwnershipWaiverDriftInput = z.infer<
  typeof OwnershipWaiverDriftInputSchema
>;
export type OwnershipWaiverDriftChange = z.infer<
  typeof OwnershipWaiverDriftChangeSchema
>;
export type OwnershipWaiverDriftDiagnostic = z.infer<
  typeof OwnershipWaiverDriftDiagnosticSchema
>;
export type OwnershipWaiverDriftSummary = z.infer<
  typeof OwnershipWaiverDriftSummarySchema
>;
export type OwnershipWaiverDriftProvenance = z.infer<
  typeof OwnershipWaiverDriftProvenanceSchema
>;
export type OwnershipWaiverDriftReport = z.infer<
  typeof OwnershipWaiverDriftReportSchema
>;

export class OwnershipWaiverDriftValidationError extends Error {
  readonly issues: readonly z.ZodIssue[];

  constructor(message: string, issues: readonly z.ZodIssue[] = []) {
    super(message);
    this.name = "OwnershipWaiverDriftValidationError";
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
      throw new OwnershipWaiverDriftValidationError(
        `${label} validation failed: ${issueText(error.issues)}`,
        error.issues,
      );
    }
    throw error;
  }
};

export const parseOwnershipWaiverDriftInput = (
  value: unknown,
): OwnershipWaiverDriftInput =>
  parseWith(
    OwnershipWaiverDriftInputSchema,
    value,
    "ownership/waiver drift input",
  );

export const parseOwnershipWaiverDriftReport = (
  value: unknown,
): OwnershipWaiverDriftReport =>
  parseWith(
    OwnershipWaiverDriftReportSchema,
    value,
    "ownership/waiver drift report",
  );

export const serializeOwnershipWaiverDriftReport = (value: unknown): string =>
  stableStringify(parseOwnershipWaiverDriftReport(value));

const digest = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const targetIdentity = (result: OwnershipResult): string =>
  result.target.stableKey ?? `target:${result.target.id}`;

const targetMap = (
  report: OwnershipResolutionReport,
): Map<string, OwnershipResult> =>
  new Map(report.results.map((result) => [targetIdentity(result), result]));

const waiverMap = (
  state: OwnershipWaiverDriftState,
): Map<string, OwnershipWaiverDriftWaiver> =>
  new Map(state.waivers.map((waiver) => [waiver.id, waiver]));

const evaluationWaiverMap = (
  report: ArchitectureWaiverEvaluation,
): Map<string, ArchitectureWaiverReport> =>
  new Map(report.waivers.map((waiver) => [waiver.id, waiver]));

type DiagnosticCode =
  | "DRIFT_OWNER_DISAPPEARED"
  | "DRIFT_OWNER_REASSIGNED"
  | "DRIFT_OWNER_REASSIGNED_AMBIGUOUS"
  | "DRIFT_REPOSITORY_MOVED"
  | "DRIFT_TARGET_ADDED"
  | "DRIFT_TARGET_REMOVED"
  | "DRIFT_WAIVER_SCOPE_DRIFT"
  | "DRIFT_WAIVER_EXPIRING"
  | "DRIFT_WAIVER_EXPIRED"
  | "DRIFT_WAIVER_SIGNATURE_INVALID"
  | "DRIFT_WAIVER_EVIDENCE_CHANGED"
  | "DRIFT_WAIVER_POLICY_CHANGED"
  | "DRIFT_WAIVER_REMOVED"
  | "DRIFT_WAIVER_ADDED"
  | "DRIFT_POLICY_MIGRATED"
  | "DRIFT_KEY_ROTATED"
  | "DRIFT_SIGNING_KEY_STATUS_CHANGED"
  | "DRIFT_PARTIAL_WORKSPACE"
  | "DRIFT_STATE_MISMATCH"
  | "DRIFT_DECISION_TRAIL_TRUNCATED";

type MutableSummary = {
  targets: number;
  waivers: number;
  ownerDisappeared: number;
  ambiguousReassignment: number;
  repositoryMoves: number;
  waiverScopeDrift: number;
  waiversExpiring: number;
  waiversExpired: number;
  invalidSignatures: number;
  evidenceChanges: number;
  policyChanges: number;
  keyRotations: number;
  partialWorkspaces: number;
  changes: number;
  diagnostics: number;
  decisionTrail: number;
};

const emptySummary = (): MutableSummary => ({
  targets: 0,
  waivers: 0,
  ownerDisappeared: 0,
  ambiguousReassignment: 0,
  repositoryMoves: 0,
  waiverScopeDrift: 0,
  waiversExpiring: 0,
  waiversExpired: 0,
  invalidSignatures: 0,
  evidenceChanges: 0,
  policyChanges: 0,
  keyRotations: 0,
  partialWorkspaces: 0,
  changes: 0,
  diagnostics: 0,
  decisionTrail: 0,
});

const diagnosticId = (
  code: DiagnosticCode,
  subjectId: string | undefined,
  previousRevision: string | undefined,
  currentRevision: string,
): string =>
  `drift:diagnostic:${digest(
    stableStringify({ code, subjectId, previousRevision, currentRevision }),
  )}`;

const makeDiagnostic = (
  code: DiagnosticCode,
  severity: OwnershipWaiverDriftDiagnostic["severity"],
  message: string,
  currentRevision: string,
  previousRevision: string | undefined,
  subjectId: string | undefined,
  evidenceRefs: readonly string[],
): OwnershipWaiverDriftDiagnostic => ({
  id: diagnosticId(code, subjectId, previousRevision, currentRevision),
  code,
  severity,
  message,
  ...(subjectId === undefined ? {} : { subjectId }),
  ...(previousRevision === undefined ? {} : { previousRevision }),
  currentRevision,
  evidenceRefs: sortedUnique(evidenceRefs).slice(0, 128),
});

const changeId = (
  kind: OwnershipWaiverDriftChange["kind"],
  subjectId: string,
  previous: unknown,
  current: unknown,
): string =>
  `drift:change:${digest(stableStringify({ kind, subjectId, previous, current }))}`;

const decisionId = (
  revision: string,
  kind: OwnershipWaiverDriftDecision["kind"],
  subjectId: string,
  decision: OwnershipWaiverDriftDecision["decision"],
): string =>
  `drift:decision:${digest(stableStringify({ revision, kind, subjectId, decision }))}`;

const decisionFromOwnership = (
  state: OwnershipWaiverDriftState,
  result: OwnershipResult,
  sequence: number,
): OwnershipWaiverDriftDecision => {
  const subjectId = targetIdentity(result);
  const decision =
    `ownership:${result.status}` as OwnershipWaiverDriftDecision["decision"];
  return {
    id: decisionId(state.revision, "ownership", subjectId, decision),
    sequence,
    revision: state.revision,
    at: state.at,
    kind: "ownership",
    subjectId,
    decision,
    ownerRefs: result.owners,
    policyVersion: state.policyVersion,
    evidenceRevision: state.evidenceRevision,
    evidenceRefs: result.evidence.map((evidence) => evidence.reference),
    authorityGranted: false,
    autoExtended: false,
  };
};

const decisionFromWaiver = (
  state: OwnershipWaiverDriftState,
  waiver: ArchitectureWaiverReport,
  snapshot: OwnershipWaiverDriftWaiver | undefined,
  sequence: number,
): OwnershipWaiverDriftDecision => {
  const decision =
    `waiver:${waiver.status}` as OwnershipWaiverDriftDecision["decision"];
  return {
    id: decisionId(state.revision, "waiver", waiver.id, decision),
    sequence,
    revision: state.revision,
    at: state.at,
    kind: "waiver",
    subjectId: waiver.id,
    decision,
    ownerRefs: [],
    policyVersion: state.policyVersion,
    evidenceRevision: state.evidenceRevision,
    ...(snapshot?.waiverDigest === undefined
      ? {}
      : { waiverDigest: snapshot.waiverDigest }),
    evidenceRefs: waiver.evidenceRefs,
    authorityGranted: false,
    autoExtended: false,
  };
};

const appendDecisionTrail = (
  previous: readonly OwnershipWaiverDriftDecision[],
  current: OwnershipWaiverDriftState,
  summary: MutableSummary,
  diagnostics: OwnershipWaiverDriftDiagnostic[],
): OwnershipWaiverDriftDecision[] => {
  const currentWaivers = waiverMap(current);
  const generated: OwnershipWaiverDriftDecision[] = [];
  let sequence = [...previous, ...current.decisionTrail].reduce(
    (maximum, entry) => Math.max(maximum, entry.sequence),
    0,
  );
  for (const result of [...current.ownership.results].sort((left, right) =>
    compareStrings(targetIdentity(left), targetIdentity(right)),
  )) {
    generated.push(decisionFromOwnership(current, result, ++sequence));
  }
  for (const waiver of [...current.waiverEvaluation.waivers].sort(
    (left, right) => compareStrings(left.id, right.id),
  )) {
    generated.push(
      decisionFromWaiver(
        current,
        waiver,
        currentWaivers.get(waiver.id),
        ++sequence,
      ),
    );
  }
  const entries = new Map<string, OwnershipWaiverDriftDecision>();
  for (const entry of previous) entries.set(entry.id, entry);
  for (const entry of current.decisionTrail) {
    if (entries.has(entry.id)) {
      diagnostics.push(
        makeDiagnostic(
          "DRIFT_STATE_MISMATCH",
          "error",
          `current decision ${entry.id} attempted to replace an earlier trail entry; the prior entry was preserved`,
          current.revision,
          undefined,
          entry.subjectId,
          entry.evidenceRefs,
        ),
      );
      continue;
    }
    entries.set(entry.id, entry);
  }
  for (const entry of generated) {
    if (!entries.has(entry.id)) entries.set(entry.id, entry);
  }
  const trail = [...entries.values()].sort(
    (left, right) =>
      left.sequence - right.sequence || compareStrings(left.id, right.id),
  );
  if (trail.length > OWNERSHIP_WAIVER_DRIFT_MAX_TRAIL) {
    trail.splice(OWNERSHIP_WAIVER_DRIFT_MAX_TRAIL);
    diagnostics.push(
      makeDiagnostic(
        "DRIFT_DECISION_TRAIL_TRUNCATED",
        "error",
        `decision trail exceeded ${OWNERSHIP_WAIVER_DRIFT_MAX_TRAIL} entries and was truncated without deleting source records`,
        current.revision,
        undefined,
        undefined,
        [`revision:${current.revision}`],
      ),
    );
  }
  summary.decisionTrail = trail.length;
  return trail;
};

const addChange = (
  changes: OwnershipWaiverDriftChange[],
  kind: OwnershipWaiverDriftChange["kind"],
  subjectId: string,
  previous: OwnershipWaiverDriftChange["previous"],
  current: OwnershipWaiverDriftChange["current"],
  diagnosticCodes: readonly DiagnosticCode[],
  evidenceRefs: readonly string[],
): void => {
  changes.push({
    id: changeId(kind, subjectId, previous, current),
    kind,
    subjectId,
    ...(previous === undefined ? {} : { previous }),
    ...(current === undefined ? {} : { current }),
    diagnosticCodes: sortedUnique(diagnosticCodes),
    evidenceRefs: sortedUnique(evidenceRefs).slice(0, 128),
  });
};

const addDiagnostic = (
  diagnostics: OwnershipWaiverDriftDiagnostic[],
  summary: MutableSummary,
  code: DiagnosticCode,
  severity: OwnershipWaiverDriftDiagnostic["severity"],
  message: string,
  current: OwnershipWaiverDriftState,
  previous: OwnershipWaiverDriftState | undefined,
  subjectId: string | undefined,
  evidenceRefs: readonly string[],
): void => {
  void summary;
  diagnostics.push(
    makeDiagnostic(
      code,
      severity,
      message,
      current.revision,
      previous?.revision,
      subjectId,
      evidenceRefs,
    ),
  );
};

const stateDiagnostics = (
  current: OwnershipWaiverDriftState,
  previous: OwnershipWaiverDriftState | undefined,
  diagnostics: OwnershipWaiverDriftDiagnostic[],
  summary: MutableSummary,
): void => {
  if (
    !current.workspace.complete ||
    current.workspace.missingRepositoryIds.length > 0
  ) {
    summary.partialWorkspaces += 1;
    addDiagnostic(
      diagnostics,
      summary,
      "DRIFT_PARTIAL_WORKSPACE",
      "warning",
      "workspace is partial; absent repositories and targets are unknown rather than clean",
      current,
      previous,
      current.workspace.id,
      [
        `workspace:${current.workspace.id}`,
        ...current.workspace.missingRepositoryIds.map(
          (repositoryId) => `repository:${repositoryId}`,
        ),
      ],
    );
  }
  if (
    current.ownership.provenance.inputDigest !==
    current.waiverEvaluation.inputDigest
  ) {
    addDiagnostic(
      diagnostics,
      summary,
      "DRIFT_STATE_MISMATCH",
      "error",
      "ownership and waiver reports refer to different graph input digests",
      current,
      previous,
      current.workspace.id,
      [
        `ownership-input:${current.ownership.provenance.inputDigest}`,
        `waiver-input:${current.waiverEvaluation.inputDigest}`,
      ],
    );
  }
  if (
    current.waiverEvaluation.policyVersion !== current.policyVersion ||
    current.waiverEvaluation.policyId !== current.policyId
  ) {
    addDiagnostic(
      diagnostics,
      summary,
      "DRIFT_STATE_MISMATCH",
      "error",
      "waiver evaluation metadata does not match the declared current policy",
      current,
      previous,
      current.workspace.id,
      [
        `policy:${current.policyId}@${current.policyVersion}`,
        `waiver-policy:${current.waiverEvaluation.policyId}@${current.waiverEvaluation.policyVersion}`,
      ],
    );
  }
  if (
    previous &&
    (previous.policyVersion !== current.policyVersion ||
      previous.policyId !== current.policyId)
  ) {
    summary.policyChanges += 1;
    addDiagnostic(
      diagnostics,
      summary,
      "DRIFT_POLICY_MIGRATED",
      "warning",
      `policy migrated from ${previous.policyId}@${previous.policyVersion} to ${current.policyId}@${current.policyVersion}; prior waiver decisions remain historical`,
      current,
      previous,
      current.policyId,
      [
        `policy:${previous.policyId}@${previous.policyVersion}`,
        `policy:${current.policyId}@${current.policyVersion}`,
      ],
    );
  }
};

const compareOwnership = (
  current: OwnershipWaiverDriftState,
  previous: OwnershipWaiverDriftState | undefined,
  changes: OwnershipWaiverDriftChange[],
  diagnostics: OwnershipWaiverDriftDiagnostic[],
  summary: MutableSummary,
): void => {
  const currentTargets = targetMap(current.ownership);
  const previousTargets: Map<string, OwnershipResult> = previous
    ? targetMap(previous.ownership)
    : new Map<string, OwnershipResult>();
  const identities = new Set([
    ...currentTargets.keys(),
    ...previousTargets.keys(),
  ]);
  for (const identity of [...identities].sort(compareStrings)) {
    const now = currentTargets.get(identity);
    const before = previousTargets.get(identity);
    if (!now) {
      if (before && before.owners.length > 0) {
        summary.ownerDisappeared += 1;
        addDiagnostic(
          diagnostics,
          summary,
          "DRIFT_OWNER_DISAPPEARED",
          "error",
          "previously assigned ownership target is absent from the current workspace",
          current,
          previous,
          identity,
          before.evidence.map((evidence) => evidence.reference),
        );
        addChange(
          changes,
          "owner",
          identity,
          { owners: before.owners, status: before.status },
          undefined,
          ["DRIFT_OWNER_DISAPPEARED"],
          before.evidence.map((evidence) => evidence.reference),
        );
      } else if (before) {
        addDiagnostic(
          diagnostics,
          summary,
          "DRIFT_TARGET_REMOVED",
          "info",
          "previous target is not present in the current workspace",
          current,
          previous,
          identity,
          before.evidence.map((evidence) => evidence.reference),
        );
      }
      continue;
    }
    if (!before) {
      if (previous) {
        addDiagnostic(
          diagnostics,
          summary,
          "DRIFT_TARGET_ADDED",
          "info",
          "target is newly present in the current workspace",
          current,
          previous,
          identity,
          now.evidence.map((evidence) => evidence.reference),
        );
      }
      continue;
    }
    const evidenceRefs = [
      ...before.evidence.map((evidence) => evidence.reference),
      ...now.evidence.map((evidence) => evidence.reference),
    ];
    if (before.target.repositoryId !== now.target.repositoryId) {
      summary.repositoryMoves += 1;
      addDiagnostic(
        diagnostics,
        summary,
        "DRIFT_REPOSITORY_MOVED",
        "warning",
        `target moved from repository ${before.target.repositoryId} to ${now.target.repositoryId}; ownership was re-evaluated`,
        current,
        previous,
        identity,
        evidenceRefs,
      );
      addChange(
        changes,
        "repository",
        identity,
        { repositoryId: before.target.repositoryId },
        { repositoryId: now.target.repositoryId },
        ["DRIFT_REPOSITORY_MOVED"],
        evidenceRefs,
      );
    }
    const ownersChanged =
      stableStringify(before.owners) !== stableStringify(now.owners);
    const disappeared = before.owners.length > 0 && now.owners.length === 0;
    if (
      disappeared ||
      (before.status !== "unowned" && now.status === "unowned")
    ) {
      summary.ownerDisappeared += 1;
      addDiagnostic(
        diagnostics,
        summary,
        "DRIFT_OWNER_DISAPPEARED",
        "error",
        "a previously resolved owner disappeared from the current resolution",
        current,
        previous,
        identity,
        evidenceRefs,
      );
    } else if (
      now.status === "ambiguous" &&
      (ownersChanged || before.status !== "ambiguous")
    ) {
      summary.ambiguousReassignment += 1;
      addDiagnostic(
        diagnostics,
        summary,
        "DRIFT_OWNER_REASSIGNED_AMBIGUOUS",
        "error",
        "current ownership has multiple unresolved assignments; no reassignment was inferred",
        current,
        previous,
        identity,
        evidenceRefs,
      );
    } else if (ownersChanged) {
      addDiagnostic(
        diagnostics,
        summary,
        "DRIFT_OWNER_REASSIGNED",
        "warning",
        "ownership changed between revisions and requires explicit review",
        current,
        previous,
        identity,
        evidenceRefs,
      );
    }
    if (ownersChanged || before.status !== now.status) {
      addChange(
        changes,
        "owner",
        identity,
        {
          owners: before.owners,
          status: before.status,
          repositoryId: before.target.repositoryId,
        },
        {
          owners: now.owners,
          status: now.status,
          repositoryId: now.target.repositoryId,
        },
        now.status === "ambiguous"
          ? ["DRIFT_OWNER_REASSIGNED_AMBIGUOUS"]
          : disappeared
            ? ["DRIFT_OWNER_DISAPPEARED"]
            : ["DRIFT_OWNER_REASSIGNED"],
        evidenceRefs,
      );
    }
  }
  summary.targets = identities.size;
};

const statusDiagnostic = (
  report: ArchitectureWaiverReport,
):
  | { code: DiagnosticCode; severity: "warning" | "error"; message: string }
  | undefined => {
  if (report.status === "expiring")
    return {
      code: "DRIFT_WAIVER_EXPIRING",
      severity: "warning",
      message: "waiver is approaching expiry and must be renewed explicitly",
    };
  if (report.status === "expired")
    return {
      code: "DRIFT_WAIVER_EXPIRED",
      severity: "error",
      message: "waiver has expired; no automatic extension is permitted",
    };
  if (
    report.status === "signature-invalid" ||
    report.status === "revoked" ||
    report.status === "trust-root-untrusted" ||
    report.code.startsWith("WAIVER_SIGNATURE_")
  )
    return {
      code: "DRIFT_WAIVER_SIGNATURE_INVALID",
      severity: "error",
      message: "waiver signature or local trust binding is invalid",
    };
  if (report.code === "WAIVER_EVIDENCE_CHANGED")
    return {
      code: "DRIFT_WAIVER_EVIDENCE_CHANGED",
      severity: "error",
      message: "waiver evidence revision differs from the current evidence",
    };
  if (report.code === "WAIVER_POLICY_CHANGED")
    return {
      code: "DRIFT_WAIVER_POLICY_CHANGED",
      severity: "error",
      message:
        "waiver targets a policy version different from the current policy",
    };
  if (report.status === "scope-mismatch" || report.status === "broadened")
    return {
      code: "DRIFT_WAIVER_SCOPE_DRIFT",
      severity: "error",
      message:
        "waiver scope no longer matches the evaluated architecture change",
    };
  return undefined;
};

const compareWaivers = (
  current: OwnershipWaiverDriftState,
  previous: OwnershipWaiverDriftState | undefined,
  changes: OwnershipWaiverDriftChange[],
  diagnostics: OwnershipWaiverDriftDiagnostic[],
  summary: MutableSummary,
): void => {
  const currentSnapshots = waiverMap(current);
  const previousSnapshots: Map<string, OwnershipWaiverDriftWaiver> = previous
    ? waiverMap(previous)
    : new Map<string, OwnershipWaiverDriftWaiver>();
  const currentReports = evaluationWaiverMap(current.waiverEvaluation);
  const previousReports: Map<string, ArchitectureWaiverReport> = previous
    ? evaluationWaiverMap(previous.waiverEvaluation)
    : new Map<string, ArchitectureWaiverReport>();
  const ids = new Set([
    ...currentSnapshots.keys(),
    ...previousSnapshots.keys(),
    ...currentReports.keys(),
    ...previousReports.keys(),
  ]);
  for (const id of [...ids].sort(compareStrings)) {
    const snapshot = currentSnapshots.get(id);
    const beforeSnapshot = previousSnapshots.get(id);
    const report = currentReports.get(id);
    const beforeReport = previousReports.get(id);
    const evidenceRefs = [
      ...(beforeSnapshot?.evidenceRefs ?? []),
      ...(snapshot?.evidenceRefs ?? []),
      ...(beforeReport?.evidenceRefs ?? []),
      ...(report?.evidenceRefs ?? []),
    ];
    if (!snapshot && beforeSnapshot) {
      addDiagnostic(
        diagnostics,
        summary,
        "DRIFT_WAIVER_REMOVED",
        "warning",
        "waiver record disappeared; its prior decision remains in the trail",
        current,
        previous,
        id,
        evidenceRefs,
      );
      addChange(
        changes,
        "waiver",
        id,
        {
          policyVersion: beforeSnapshot.policyVersion,
          evidenceRevision: beforeSnapshot.evidenceRevision,
          signerKeyId: beforeSnapshot.signerKeyId,
          scopeDigest: beforeSnapshot.scopeDigest,
          waiverDigest: beforeSnapshot.waiverDigest,
          status: beforeReport?.status,
        },
        undefined,
        ["DRIFT_WAIVER_REMOVED"],
        evidenceRefs.length > 0 ? evidenceRefs : [`waiver:${id}`],
      );
      continue;
    }
    if (snapshot && !beforeSnapshot && previous) {
      addDiagnostic(
        diagnostics,
        summary,
        "DRIFT_WAIVER_ADDED",
        "info",
        "waiver record is newly present in the current revision",
        current,
        previous,
        id,
        evidenceRefs,
      );
      addChange(
        changes,
        "waiver",
        id,
        undefined,
        {
          policyVersion: snapshot.policyVersion,
          evidenceRevision: snapshot.evidenceRevision,
          signerKeyId: snapshot.signerKeyId,
          scopeDigest: snapshot.scopeDigest,
          waiverDigest: snapshot.waiverDigest,
          status: report?.status,
        },
        ["DRIFT_WAIVER_ADDED"],
        evidenceRefs.length > 0 ? evidenceRefs : [`waiver:${id}`],
      );
    }
    const status = report ? statusDiagnostic(report) : undefined;
    if (status) {
      if (status.code === "DRIFT_WAIVER_EXPIRING") summary.waiversExpiring += 1;
      if (status.code === "DRIFT_WAIVER_EXPIRED") summary.waiversExpired += 1;
      if (status.code === "DRIFT_WAIVER_SIGNATURE_INVALID")
        summary.invalidSignatures += 1;
      if (status.code === "DRIFT_WAIVER_EVIDENCE_CHANGED")
        summary.evidenceChanges += 1;
      if (status.code === "DRIFT_WAIVER_POLICY_CHANGED")
        summary.policyChanges += 1;
      if (status.code === "DRIFT_WAIVER_SCOPE_DRIFT")
        summary.waiverScopeDrift += 1;
      addDiagnostic(
        diagnostics,
        summary,
        status.code,
        status.severity,
        status.message,
        current,
        previous,
        id,
        evidenceRefs.length > 0 ? evidenceRefs : [`waiver:${id}`],
      );
    }
    if (snapshot && beforeSnapshot) {
      const waiverCodes: DiagnosticCode[] = [];
      if (
        snapshot.scopeDigest !== beforeSnapshot.scopeDigest ||
        stableStringify(snapshot.affectedIds) !==
          stableStringify(beforeSnapshot.affectedIds)
      ) {
        summary.waiverScopeDrift += 1;
        waiverCodes.push("DRIFT_WAIVER_SCOPE_DRIFT");
        addDiagnostic(
          diagnostics,
          summary,
          "DRIFT_WAIVER_SCOPE_DRIFT",
          "error",
          "waiver affected scope changed between revisions; it was not auto-carried forward",
          current,
          previous,
          id,
          evidenceRefs,
        );
      }
      if (snapshot.evidenceRevision !== beforeSnapshot.evidenceRevision) {
        summary.evidenceChanges += 1;
        waiverCodes.push("DRIFT_WAIVER_EVIDENCE_CHANGED");
        addDiagnostic(
          diagnostics,
          summary,
          "DRIFT_WAIVER_EVIDENCE_CHANGED",
          "error",
          "waiver evidence revision changed between decisions",
          current,
          previous,
          id,
          evidenceRefs,
        );
      }
      if (snapshot.policyVersion !== beforeSnapshot.policyVersion) {
        summary.policyChanges += 1;
        waiverCodes.push("DRIFT_WAIVER_POLICY_CHANGED");
        addDiagnostic(
          diagnostics,
          summary,
          "DRIFT_WAIVER_POLICY_CHANGED",
          "error",
          "waiver policy version changed between decisions",
          current,
          previous,
          id,
          evidenceRefs,
        );
      }
      if (
        snapshot.signerKeyId !== undefined &&
        beforeSnapshot.signerKeyId !== undefined &&
        snapshot.signerKeyId !== beforeSnapshot.signerKeyId
      ) {
        summary.keyRotations += 1;
        waiverCodes.push("DRIFT_KEY_ROTATED");
        addDiagnostic(
          diagnostics,
          summary,
          "DRIFT_KEY_ROTATED",
          "warning",
          `waiver signer changed from ${beforeSnapshot.signerKeyId} to ${snapshot.signerKeyId}; re-verification is required`,
          current,
          previous,
          id,
          evidenceRefs,
        );
      }
      if (
        snapshot.waiverDigest !== beforeSnapshot.waiverDigest &&
        waiverCodes.length === 0
      ) {
        waiverCodes.push("DRIFT_WAIVER_SCOPE_DRIFT");
        addDiagnostic(
          diagnostics,
          summary,
          "DRIFT_WAIVER_SCOPE_DRIFT",
          "error",
          "waiver digest changed without a declared compatible migration",
          current,
          previous,
          id,
          evidenceRefs,
        );
      }
      if (waiverCodes.length > 0) {
        addChange(
          changes,
          "waiver",
          id,
          {
            policyVersion: beforeSnapshot.policyVersion,
            evidenceRevision: beforeSnapshot.evidenceRevision,
            signerKeyId: beforeSnapshot.signerKeyId,
            scopeDigest: beforeSnapshot.scopeDigest,
            waiverDigest: beforeSnapshot.waiverDigest,
            status: beforeReport?.status,
          },
          {
            policyVersion: snapshot.policyVersion,
            evidenceRevision: snapshot.evidenceRevision,
            signerKeyId: snapshot.signerKeyId,
            scopeDigest: snapshot.scopeDigest,
            waiverDigest: snapshot.waiverDigest,
            status: report?.status,
          },
          waiverCodes,
          evidenceRefs,
        );
      }
    }
  }
  summary.waivers = ids.size;
};

const compareKeys = (
  current: OwnershipWaiverDriftState,
  previous: OwnershipWaiverDriftState | undefined,
  changes: OwnershipWaiverDriftChange[],
  diagnostics: OwnershipWaiverDriftDiagnostic[],
  summary: MutableSummary,
): void => {
  if (!previous) return;
  const oldKeys = new Map(previous.keyring.map((key) => [key.keyId, key]));
  const newKeys = new Map(current.keyring.map((key) => [key.keyId, key]));
  for (const key of current.keyring) {
    if (key.rotatedFrom !== null && oldKeys.has(key.rotatedFrom)) {
      summary.keyRotations += 1;
      const evidenceRefs = [
        `signing-key:${key.keyId}`,
        `signing-key:${key.rotatedFrom}`,
      ];
      addDiagnostic(
        diagnostics,
        summary,
        "DRIFT_KEY_ROTATED",
        "warning",
        `signing key ${key.keyId} declares rotation from ${key.rotatedFrom}; old signatures are not silently reissued`,
        current,
        previous,
        key.keyId,
        evidenceRefs,
      );
      addChange(
        changes,
        "signing-key",
        key.keyId,
        {
          status: oldKeys.get(key.rotatedFrom)?.status,
          signerKeyId: key.rotatedFrom,
        },
        { status: key.status, signerKeyId: key.keyId },
        ["DRIFT_KEY_ROTATED"],
        evidenceRefs,
      );
    }
    const old = oldKeys.get(key.keyId);
    if (old && old.status !== key.status) {
      addDiagnostic(
        diagnostics,
        summary,
        "DRIFT_SIGNING_KEY_STATUS_CHANGED",
        key.status === "revoked" ? "error" : "warning",
        `signing key ${key.keyId} changed status from ${old.status} to ${key.status}`,
        current,
        previous,
        key.keyId,
        [`signing-key:${key.keyId}`],
      );
    }
  }
  for (const old of previous.keyring) {
    if (!newKeys.has(old.keyId) && old.status === "active") {
      addDiagnostic(
        diagnostics,
        summary,
        "DRIFT_SIGNING_KEY_STATUS_CHANGED",
        "error",
        `previously active signing key ${old.keyId} is absent from the current keyring`,
        current,
        previous,
        old.keyId,
        [`signing-key:${old.keyId}`],
      );
    }
  }
};

export const evaluateOwnershipWaiverDrift = (
  value: unknown,
): OwnershipWaiverDriftReport => {
  const input = parseOwnershipWaiverDriftInput(value);
  const current = input.current;
  const previous = input.previous;
  const summary = emptySummary();
  const changes: OwnershipWaiverDriftChange[] = [];
  const diagnostics: OwnershipWaiverDriftDiagnostic[] = [];

  // Re-parse the nested reports explicitly so callers cannot smuggle a
  // structurally similar object through a widened type boundary.
  const ownership = OwnershipResolutionReportSchema.parse(current.ownership);
  const waiverEvaluation = ArchitectureWaiverEvaluationSchema.parse(
    current.waiverEvaluation,
  );
  const normalizedCurrent = { ...current, ownership, waiverEvaluation };
  stateDiagnostics(normalizedCurrent, previous, diagnostics, summary);
  compareOwnership(normalizedCurrent, previous, changes, diagnostics, summary);
  compareWaivers(normalizedCurrent, previous, changes, diagnostics, summary);
  compareKeys(normalizedCurrent, previous, changes, diagnostics, summary);

  const previousTrail = previous?.decisionTrail ?? [];
  const decisionTrail = appendDecisionTrail(
    previousTrail,
    normalizedCurrent,
    summary,
    diagnostics,
  );
  diagnostics.sort((left, right) => compareStrings(left.id, right.id));
  changes.sort((left, right) => compareStrings(left.id, right.id));
  summary.changes = changes.length;
  summary.diagnostics = diagnostics.length;
  const status =
    summary.partialWorkspaces > 0
      ? "unsupported"
      : diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
          diagnostics.length > 0
        ? "drift"
        : "clean";
  const normalizedInputDigest = digest(stableStringify(input));
  return parseOwnershipWaiverDriftReport({
    schemaVersion: OWNERSHIP_WAIVER_DRIFT_SCHEMA_VERSION,
    contract: OWNERSHIP_WAIVER_DRIFT_CONTRACT,
    mediaType: OWNERSHIP_WAIVER_DRIFT_MEDIA_TYPE,
    status,
    ...(previous === undefined ? {} : { previousRevision: previous.revision }),
    currentRevision: current.revision,
    summary,
    changes,
    diagnostics,
    decisionTrail,
    provenance: {
      resolver: OWNERSHIP_WAIVER_DRIFT_CONTRACT,
      resolverVersion: "1",
      inputDigest: normalizedInputDigest,
      network: false,
      sourceBodiesIncluded: false,
      privateKeysIncluded: false,
      authorityGranted: false,
      autoExtended: false,
      deterministic: true,
    },
  });
};

export const detectOwnershipWaiverDrift = evaluateOwnershipWaiverDrift;
