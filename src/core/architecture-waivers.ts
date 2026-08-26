import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalizeGraphSnapshot, stableStringify } from "./canonical.js";
import { canonicalizeGraphDiff } from "./diff.js";
import {
  AssuranceSigningRecordSchema,
  AssuranceSigningVerificationError,
  evaluateAssuranceSigningRecord,
  type AssuranceSigningKey,
  type AssuranceSigningKeyring,
} from "./assurance-signing.js";
import {
  LocalPolicyExceptionScopeSchema,
  parsePolicyConfig,
  type LocalPolicyExceptionScope,
  type LocalPolicyRule,
} from "./policy.js";
import {
  evaluatePolicy,
  PolicyEvaluationSchema,
  type PolicyEvaluationInput,
  type PolicyViolation,
} from "./policy-evaluation.js";

export const ARCHITECTURE_WAIVER_SCHEMA_VERSION = 1 as const;
export const ARCHITECTURE_WAIVER_CONTRACT =
  "cartograph.architecture-waiver" as const;
export const ARCHITECTURE_WAIVER_MEDIA_TYPE =
  "application/vnd.cartograph.architecture-waiver+json" as const;
export const ARCHITECTURE_WAIVER_MAX_RECORDS = 128 as const;
export const ARCHITECTURE_WAIVER_MAX_AFFECTED_IDS = 10_000 as const;
export const ARCHITECTURE_WAIVER_MAX_EVIDENCE_REFS = 128 as const;
export const ARCHITECTURE_WAIVER_MAX_TRUST_ROOTS = 32 as const;
export const ARCHITECTURE_WAIVER_EXPIRING_WINDOW_DAYS = 7 as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
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
const ReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );
const EvidenceReferenceSchema = IdentifierSchema.refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !value.includes("\\") &&
    !/^file:/iu.test(value) &&
    !/^https?:/iu.test(value),
  "must be a portable local evidence reference",
).max(1_024);
const SemverSchema = z
  .string()
  .trim()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "must be a semantic version",
  );

const AffectedIdsSchema = z
  .array(IdentifierSchema)
  .max(ARCHITECTURE_WAIVER_MAX_AFFECTED_IDS);

export const ArchitectureWaiverChangeScopeSchema = z.discriminatedUnion(
  "inputKind",
  [
    z
      .object({
        inputKind: z.literal("snapshot"),
        inputDigest: DigestSchema,
        affectedIds: AffectedIdsSchema,
      })
      .strict(),
    z
      .object({
        inputKind: z.literal("diff"),
        inputDigest: DigestSchema,
        baselineDigest: DigestSchema,
        candidateDigest: DigestSchema,
        affectedIds: AffectedIdsSchema,
      })
      .strict(),
  ],
);

export const ArchitectureWaiverSchema = z
  .object({
    schemaVersion: z.literal(ARCHITECTURE_WAIVER_SCHEMA_VERSION),
    contract: z.literal(ARCHITECTURE_WAIVER_CONTRACT),
    mediaType: z.literal(ARCHITECTURE_WAIVER_MEDIA_TYPE),
    id: IdentifierSchema,
    ruleId: IdentifierSchema,
    scope: LocalPolicyExceptionScopeSchema,
    changeScope: ArchitectureWaiverChangeScopeSchema,
    rationale: ReasonSchema,
    owner: IdentifierSchema,
    approver: IdentifierSchema,
    createdAt: DateTimeSchema,
    expiresAt: DateTimeSchema,
    policyVersion: SemverSchema,
    evidenceRevision: IdentifierSchema,
    evidenceRefs: z
      .array(EvidenceReferenceSchema)
      .min(1)
      .max(ARCHITECTURE_WAIVER_MAX_EVIDENCE_REFS),
    trustRootIds: z
      .array(IdentifierSchema)
      .min(1)
      .max(ARCHITECTURE_WAIVER_MAX_TRUST_ROOTS),
    authority: z.literal("none"),
    precedence: z.number().int().nonnegative().max(1_000).default(0),
    digest: DigestSchema,
    signature: AssuranceSigningRecordSchema.optional(),
  })
  .strict()
  .superRefine((waiver, context) => {
    if (Date.parse(waiver.createdAt) >= Date.parse(waiver.expiresAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "must be later than createdAt",
      });
    }
    if (waiver.owner === waiver.approver) {
      context.addIssue({
        code: "custom",
        path: ["approver"],
        message: "approver must be distinct from owner",
      });
    }
  });

export const ArchitectureWaiverDiagnosticCodeSchema = z
  .string()
  .regex(/^WAIVER_[A-Z0-9_]+$/u);

export const ArchitectureWaiverStatusSchema = z.enum([
  "active",
  "expiring",
  "unsigned",
  "invalid",
  "broadened",
  "replayed",
  "expired",
  "not-effective",
  "revoked",
  "signature-invalid",
  "trust-root-untrusted",
  "scope-mismatch",
  "no-match",
  "shadowed",
]);

export const ArchitectureWaiverReportSchema = z
  .object({
    id: IdentifierSchema,
    ruleId: IdentifierSchema.optional(),
    status: ArchitectureWaiverStatusSchema,
    code: ArchitectureWaiverDiagnosticCodeSchema,
    precedence: z.number().int().nonnegative().max(1_000).optional(),
    suppresses: z.boolean(),
    authorityGranted: z.literal(false),
    reason: ReasonSchema,
    evidenceRefs: z
      .array(EvidenceReferenceSchema)
      .min(1)
      .max(ARCHITECTURE_WAIVER_MAX_EVIDENCE_REFS),
    signatureCode: z.string().optional(),
  })
  .strict();

export const ArchitectureWaiverSuppressionSchema = z
  .object({
    violationId: IdentifierSchema,
    waiverId: IdentifierSchema,
    ruleId: IdentifierSchema,
    affectedIds: AffectedIdsSchema,
    authorityGranted: z.literal(false),
    reason: ReasonSchema,
    evidenceRefs: z
      .array(EvidenceReferenceSchema)
      .min(1)
      .max(ARCHITECTURE_WAIVER_MAX_EVIDENCE_REFS),
  })
  .strict();

export const ArchitectureWaiverSummarySchema = z
  .object({
    waivers: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    expiring: z.number().int().nonnegative(),
    suppressed: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    unsigned: z.number().int().nonnegative(),
    replayed: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
  })
  .strict();

export const ArchitectureWaiverProvenanceSchema = z
  .object({
    resolver: z.literal(ARCHITECTURE_WAIVER_CONTRACT),
    resolverVersion: z.literal("1"),
    inputDigest: DigestSchema,
    network: z.literal(false),
    sourceBodiesIncluded: z.literal(false),
    privateKeysIncluded: z.literal(false),
    authorityGranted: z.literal(false),
    deterministic: z.literal(true),
  })
  .strict();

export const ArchitectureWaiverEvaluationSchema = z
  .object({
    schemaVersion: z.literal(ARCHITECTURE_WAIVER_SCHEMA_VERSION),
    contract: z.literal(ARCHITECTURE_WAIVER_CONTRACT),
    mediaType: z.literal(ARCHITECTURE_WAIVER_MEDIA_TYPE),
    policyId: IdentifierSchema,
    policyVersion: SemverSchema,
    policyStatus: z.enum(["passed", "violations", "unsupported"]),
    inputKind: z.enum(["snapshot", "diff"]),
    inputDigest: DigestSchema,
    status: z.enum(["passed", "violations", "unsupported"]),
    authorityGranted: z.literal(false),
    violations: z
      .array(PolicyEvaluationSchema.shape.violations.element)
      .max(10_000),
    unsupported: z
      .array(PolicyEvaluationSchema.shape.unsupported.element)
      .max(10_000),
    suppressed: z.array(ArchitectureWaiverSuppressionSchema).max(10_000),
    waivers: z
      .array(ArchitectureWaiverReportSchema)
      .max(ARCHITECTURE_WAIVER_MAX_RECORDS),
    summary: ArchitectureWaiverSummarySchema,
    provenance: ArchitectureWaiverProvenanceSchema,
  })
  .strict()
  .superRefine((report, context) => {
    if (
      report.status === "passed" &&
      (report.violations.length > 0 || report.unsupported.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "passed reports cannot retain violations or unsupported rules",
      });
    }
    if (report.status === "violations" && report.violations.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "violations reports must retain at least one violation",
      });
    }
    if (report.status === "unsupported" && report.violations.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "unsupported reports cannot retain violations",
      });
    }
    if (report.summary.suppressed !== report.suppressed.length) {
      context.addIssue({
        code: "custom",
        path: ["summary", "suppressed"],
        message: "suppressed summary count must match suppression records",
      });
    }
    if (report.summary.waivers !== report.waivers.length) {
      context.addIssue({
        code: "custom",
        path: ["summary", "waivers"],
        message: "waiver summary count must match waiver records",
      });
    }
  });

export type ArchitectureWaiverChangeScope = z.infer<
  typeof ArchitectureWaiverChangeScopeSchema
>;
export type ArchitectureWaiver = z.infer<typeof ArchitectureWaiverSchema>;
export type ArchitectureWaiverStatus = z.infer<
  typeof ArchitectureWaiverStatusSchema
>;
export type ArchitectureWaiverReport = z.infer<
  typeof ArchitectureWaiverReportSchema
>;
export type ArchitectureWaiverSuppression = z.infer<
  typeof ArchitectureWaiverSuppressionSchema
>;
export type ArchitectureWaiverSummary = z.infer<
  typeof ArchitectureWaiverSummarySchema
>;
export type ArchitectureWaiverProvenance = z.infer<
  typeof ArchitectureWaiverProvenanceSchema
>;
export type ArchitectureWaiverEvaluation = z.infer<
  typeof ArchitectureWaiverEvaluationSchema
>;

export type ArchitectureWaiverEvaluationOptions = {
  asOf?: Date | string;
  expiringWithinDays?: number;
  evidenceRevision?: string;
  keyring?: AssuranceSigningKeyring | readonly AssuranceSigningKey[];
  trustedRootIds?: readonly string[];
  adr?: Parameters<typeof evaluatePolicy>[2] extends infer Options
    ? Options extends { adr?: infer Adr }
      ? Adr
      : never
    : never;
};

export class ArchitectureWaiverValidationError extends Error {
  readonly issues: readonly z.ZodIssue[];

  constructor(message: string, issues: readonly z.ZodIssue[] = []) {
    super(message);
    this.name = "ArchitectureWaiverValidationError";
    this.issues = issues;
  }
}

const issueText = (issues: readonly z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "waiver";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

const parseWith = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ArchitectureWaiverValidationError(
      `${label} validation failed: ${issueText(parsed.error.issues)}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
};

export const parseArchitectureWaiver = (value: unknown): ArchitectureWaiver =>
  parseWith(ArchitectureWaiverSchema, value, "architecture waiver");

export const parseArchitectureWaiverEvaluation = (
  value: unknown,
): ArchitectureWaiverEvaluation =>
  parseWith(
    ArchitectureWaiverEvaluationSchema,
    value,
    "architecture waiver evaluation",
  );

const hash = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const canonicalWaiverPayload = (value: unknown): Record<string, unknown> => {
  const record = asRecord(value);
  if (record === undefined)
    throw new ArchitectureWaiverValidationError(
      "architecture waiver must be an object",
    );
  const payload = Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => key !== "digest" && key !== "signature",
    ),
  );
  const scope = asRecord(payload.scope);
  if (scope !== undefined) payload.scope = scope;
  const changeScope = asRecord(payload.changeScope);
  if (changeScope !== undefined) {
    payload.changeScope = {
      ...changeScope,
      affectedIds: Array.isArray(changeScope.affectedIds)
        ? sortUnique(
            changeScope.affectedIds.filter(
              (value): value is string => typeof value === "string",
            ),
          )
        : changeScope.affectedIds,
    };
  }
  if (Array.isArray(payload.evidenceRefs)) {
    payload.evidenceRefs = sortUnique(
      payload.evidenceRefs.filter(
        (value): value is string => typeof value === "string",
      ),
    );
  }
  if (Array.isArray(payload.trustRootIds)) {
    payload.trustRootIds = sortUnique(
      payload.trustRootIds.filter(
        (value): value is string => typeof value === "string",
      ),
    );
  }
  return payload;
};

export const architectureWaiverDigest = (value: unknown): `sha256:${string}` =>
  hash(stableStringify(canonicalWaiverPayload(value)));

export const architectureWaiverInputDigest = (
  input: PolicyEvaluationInput,
): `sha256:${string}` => {
  const canonical =
    input.kind === "snapshot"
      ? canonicalizeGraphSnapshot(input.snapshot)
      : canonicalizeGraphDiff(input.diff);
  return hash(stableStringify(canonical));
};

const safeIdentifier = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const parsed = IdentifierSchema.safeParse(value.trim());
  return parsed.success ? parsed.data : undefined;
};

const baseEvidence = (
  index: number,
  id: string | undefined,
  ruleId: string | undefined,
): string[] => [
  `waiver:index:${index}`,
  ...(id === undefined ? [] : [`waiver:${id}`]),
  ...(ruleId === undefined ? [] : [`policy-rule:${ruleId}`]),
];

const evidence = (values: readonly string[]): string[] =>
  sortUnique(values).filter(
    (value) => EvidenceReferenceSchema.safeParse(value).success,
  );

const reason = (value: string): string => value.slice(0, 4_096);

const report = (input: {
  id: string;
  ruleId?: string;
  status: ArchitectureWaiverStatus;
  code: string;
  precedence?: number;
  reason: string;
  evidenceRefs: readonly string[];
  signatureCode?: string;
}): ArchitectureWaiverReport => ({
  id: input.id,
  ...(input.ruleId === undefined ? {} : { ruleId: input.ruleId }),
  status: input.status,
  code: input.code,
  ...(input.precedence === undefined ? {} : { precedence: input.precedence }),
  suppresses: false,
  authorityGranted: false,
  reason: reason(input.reason),
  evidenceRefs: evidence(input.evidenceRefs),
  ...(input.signatureCode === undefined
    ? {}
    : { signatureCode: input.signatureCode }),
});

const setEqual = (left: readonly string[], right: readonly string[]): boolean =>
  stableStringify(sortUnique(left)) === stableStringify(sortUnique(right));

const isStrictSuperset = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  const leftSet = new Set(left);
  return (
    leftSet.size > right.length && right.every((value) => leftSet.has(value))
  );
};

const selectorRelation = (
  waiverScope: LocalPolicyExceptionScope,
  rule: LocalPolicyRule,
): "match" | "broadened" | "mismatch" => {
  if (waiverScope.target !== rule.target) return "mismatch";
  const waiverSelector = waiverScope.selector as Record<string, unknown>;
  const ruleSelector = rule.selector as Record<string, unknown>;
  for (const [key, value] of Object.entries(ruleSelector)) {
    if (value === undefined) continue;
    if (waiverSelector[key] === undefined) return "broadened";
    if (waiverSelector[key] !== value) return "mismatch";
  }
  return "match";
};

const parseAsOf = (value: Date | string | undefined): Date => {
  const parsed =
    value instanceof Date
      ? new Date(value.valueOf())
      : new Date(value ?? Date.now());
  if (!Number.isFinite(parsed.valueOf()))
    throw new ArchitectureWaiverValidationError("asOf must be a valid date");
  return parsed;
};

const keyFor = (
  keyring: AssuranceSigningKeyring | readonly AssuranceSigningKey[] | undefined,
  keyId: string,
): AssuranceSigningKey | undefined => {
  const keys: readonly AssuranceSigningKey[] =
    keyring === undefined
      ? []
      : Array.isArray(keyring)
        ? (keyring as readonly AssuranceSigningKey[])
        : (keyring as AssuranceSigningKeyring).keys;
  return keys.find((key) => key.keyId === keyId);
};

const signatureFailure = (
  code: string,
): {
  status: ArchitectureWaiverStatus;
  diagnostic: string;
} => {
  switch (code) {
    case "revoked":
      return { status: "revoked", diagnostic: "WAIVER_SIGNATURE_REVOKED" };
    case "expired":
      return { status: "expired", diagnostic: "WAIVER_SIGNATURE_EXPIRED" };
    case "missing-trust-root":
      return {
        status: "trust-root-untrusted",
        diagnostic: "WAIVER_TRUST_ROOT_UNTRUSTED",
      };
    case "missing-key":
      return {
        status: "signature-invalid",
        diagnostic: "WAIVER_SIGNATURE_MISSING_KEY",
      };
    case "unsupported-algorithm":
      return {
        status: "signature-invalid",
        diagnostic: "WAIVER_SIGNATURE_UNSUPPORTED",
      };
    default:
      return {
        status: "signature-invalid",
        diagnostic: "WAIVER_SIGNATURE_INVALID",
      };
  }
};

type Candidate = {
  waiver: ArchitectureWaiver;
  report: ArchitectureWaiverReport;
  violation: PolicyViolation;
};

const statusCounts = (
  waivers: readonly ArchitectureWaiverReport[],
  suppressed: number,
): ArchitectureWaiverSummary => ({
  waivers: waivers.length,
  active: waivers.filter((waiver) => waiver.status === "active").length,
  expiring: waivers.filter((waiver) => waiver.status === "expiring").length,
  suppressed,
  invalid: waivers.filter((waiver) =>
    [
      "invalid",
      "broadened",
      "not-effective",
      "revoked",
      "signature-invalid",
      "trust-root-untrusted",
      "scope-mismatch",
      "no-match",
    ].includes(waiver.status),
  ).length,
  unsigned: waivers.filter((waiver) => waiver.status === "unsigned").length,
  replayed: waivers.filter((waiver) => waiver.status === "replayed").length,
  expired: waivers.filter((waiver) => waiver.status === "expired").length,
});

export const evaluateArchitectureWaivers = (
  policyInput: unknown,
  input: PolicyEvaluationInput,
  waiversInput: readonly unknown[],
  options: ArchitectureWaiverEvaluationOptions = {},
): ArchitectureWaiverEvaluation => {
  if (waiversInput.length > ARCHITECTURE_WAIVER_MAX_RECORDS) {
    throw new ArchitectureWaiverValidationError(
      `at most ${ARCHITECTURE_WAIVER_MAX_RECORDS} waiver records are supported`,
    );
  }
  const policy = parsePolicyConfig(policyInput);
  const asOf = parseAsOf(options.asOf);
  const expiringWithinDays =
    options.expiringWithinDays ?? ARCHITECTURE_WAIVER_EXPIRING_WINDOW_DAYS;
  if (
    !Number.isInteger(expiringWithinDays) ||
    expiringWithinDays < 0 ||
    expiringWithinDays > 3_650
  ) {
    throw new ArchitectureWaiverValidationError(
      "expiringWithinDays must be an integer from 0 to 3650",
    );
  }
  const inputDigest = architectureWaiverInputDigest(input);
  const policyEvaluation = evaluatePolicy(
    { ...policy, exceptions: [] },
    input,
    options.adr === undefined
      ? { asOf: asOf.toISOString() }
      : { asOf: asOf.toISOString(), adr: options.adr },
  );
  const trustedRootIds = options.trustedRootIds ?? [];
  const parsed = waiversInput.map((raw, index) => ({
    index,
    raw,
    result: ArchitectureWaiverSchema.safeParse(raw),
  }));
  const validIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const item of parsed) {
    if (!item.result.success) continue;
    if (validIds.has(item.result.data.id))
      duplicateIds.add(item.result.data.id);
    validIds.add(item.result.data.id);
  }

  const reports: ArchitectureWaiverReport[] = [];
  const candidates: Candidate[] = [];
  for (const item of parsed) {
    const rawRecord = asRecord(item.raw);
    const rawId = safeIdentifier(rawRecord?.id) ?? `waiver:index:${item.index}`;
    const rawRuleId = safeIdentifier(rawRecord?.ruleId);
    const refs = baseEvidence(
      item.index,
      safeIdentifier(rawRecord?.id),
      rawRuleId,
    );
    if (!item.result.success) {
      reports.push(
        report({
          id: rawId,
          ...(rawRuleId === undefined ? {} : { ruleId: rawRuleId }),
          status: "invalid",
          code: "WAIVER_INVALID",
          reason: `waiver is malformed: ${issueText(item.result.error.issues)}`,
          evidenceRefs: refs,
        }),
      );
      continue;
    }

    const waiver = item.result.data;
    const waiverRefs = [...refs, ...waiver.evidenceRefs];
    if (duplicateIds.has(waiver.id)) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "replayed",
          code: "WAIVER_REPLAYED",
          precedence: waiver.precedence,
          reason: `waiver ID ${waiver.id} is present more than once; no duplicate record can suppress enforcement`,
          evidenceRefs: waiverRefs,
        }),
      );
      continue;
    }
    if (architectureWaiverDigest(waiver) !== waiver.digest) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "invalid",
          code: "WAIVER_TAMPERED",
          precedence: waiver.precedence,
          reason: `waiver digest does not match its canonical payload: ${waiver.id}`,
          evidenceRefs: waiverRefs,
        }),
      );
      continue;
    }
    if (waiver.policyVersion !== policy.version) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "scope-mismatch",
          code: "WAIVER_POLICY_CHANGED",
          precedence: waiver.precedence,
          reason: `waiver targets policy ${waiver.policyVersion}, current policy is ${policy.version}`,
          evidenceRefs: waiverRefs,
        }),
      );
      continue;
    }
    if (waiver.changeScope.inputKind !== input.kind) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "scope-mismatch",
          code: "WAIVER_SCOPE_MISMATCH",
          precedence: waiver.precedence,
          reason: `waiver is bound to ${waiver.changeScope.inputKind}, current input is ${input.kind}`,
          evidenceRefs: waiverRefs,
        }),
      );
      continue;
    }
    if (waiver.changeScope.inputDigest !== inputDigest) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "replayed",
          code: "WAIVER_REPLAYED",
          precedence: waiver.precedence,
          reason: `waiver is bound to a different input digest and cannot be replayed on this revision`,
          evidenceRefs: [...waiverRefs, `input-digest:${inputDigest}`],
        }),
      );
      continue;
    }
    if (
      options.evidenceRevision !== undefined &&
      waiver.evidenceRevision !== options.evidenceRevision
    ) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "scope-mismatch",
          code: "WAIVER_EVIDENCE_CHANGED",
          precedence: waiver.precedence,
          reason: `waiver evidence revision ${waiver.evidenceRevision} does not match current revision ${options.evidenceRevision}`,
          evidenceRefs: waiverRefs,
        }),
      );
      continue;
    }

    const rule = policy.rules.find(
      (candidate) => candidate.id === waiver.ruleId,
    );
    if (rule === undefined) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "invalid",
          code: "WAIVER_INVALID",
          precedence: waiver.precedence,
          reason: `waiver references unknown policy rule ${waiver.ruleId}`,
          evidenceRefs: waiverRefs,
        }),
      );
      continue;
    }
    const selector = selectorRelation(waiver.scope, rule);
    if (selector === "broadened") {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "broadened",
          code: "WAIVER_BROADENED",
          precedence: waiver.precedence,
          reason:
            "waiver selector omits a policy selector field and would broaden the exception",
          evidenceRefs: waiverRefs,
        }),
      );
      continue;
    }
    if (selector === "mismatch") {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "scope-mismatch",
          code: "WAIVER_SCOPE_MISMATCH",
          precedence: waiver.precedence,
          reason:
            "waiver target does not match the policy rule target or selector",
          evidenceRefs: waiverRefs,
        }),
      );
      continue;
    }

    const violation = policyEvaluation.violations.find(
      (candidate) => candidate.ruleId === waiver.ruleId,
    );
    if (violation === undefined) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "no-match",
          code: "WAIVER_NO_MATCH",
          precedence: waiver.precedence,
          reason: "waiver does not match a current policy violation",
          evidenceRefs: waiverRefs,
        }),
      );
      continue;
    }
    if (isStrictSuperset(waiver.changeScope.affectedIds, violation.matches)) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "broadened",
          code: "WAIVER_BROADENED",
          precedence: waiver.precedence,
          reason:
            "waiver affected IDs include graph objects outside the current violation",
          evidenceRefs: waiverRefs,
        }),
      );
      continue;
    }
    if (!setEqual(waiver.changeScope.affectedIds, violation.matches)) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "scope-mismatch",
          code: "WAIVER_SCOPE_MISMATCH",
          precedence: waiver.precedence,
          reason:
            "waiver affected IDs do not exactly cover the current violation",
          evidenceRefs: waiverRefs,
        }),
      );
      continue;
    }

    const createdAt = Date.parse(waiver.createdAt);
    const expiresAt = Date.parse(waiver.expiresAt);
    if (createdAt > asOf.valueOf()) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "not-effective",
          code: "WAIVER_NOT_EFFECTIVE",
          precedence: waiver.precedence,
          reason: `waiver is not effective until ${waiver.createdAt}`,
          evidenceRefs: waiverRefs,
        }),
      );
      continue;
    }
    if (expiresAt <= asOf.valueOf()) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "expired",
          code: "WAIVER_EXPIRED",
          precedence: waiver.precedence,
          reason: `waiver expired at ${waiver.expiresAt}`,
          evidenceRefs: waiverRefs,
        }),
      );
      continue;
    }

    const lifecycleStatus =
      expiresAt - asOf.valueOf() <= expiringWithinDays * 24 * 60 * 60 * 1_000
        ? "expiring"
        : "active";
    if (waiver.signature === undefined) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "unsigned",
          code: "WAIVER_UNSIGNED",
          precedence: waiver.precedence,
          reason:
            "unsigned waivers remain visible and cannot suppress enforcement",
          evidenceRefs: waiverRefs,
        }),
      );
      continue;
    }
    if (waiver.signature.manifestDigest !== waiver.digest) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "signature-invalid",
          code: "WAIVER_SIGNATURE_MISMATCH",
          precedence: waiver.precedence,
          reason:
            "signature metadata is not bound to the canonical waiver digest",
          evidenceRefs: waiverRefs,
          signatureCode: "manifest-digest-mismatch",
        }),
      );
      continue;
    }
    if (
      Date.parse(waiver.signature.signedAt) < createdAt ||
      Date.parse(waiver.signature.signedAt) > expiresAt
    ) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "signature-invalid",
          code: "WAIVER_SIGNATURE_TIME_OUTSIDE_SCOPE",
          precedence: waiver.precedence,
          reason:
            "signature timestamp falls outside the waiver creation and expiry window",
          evidenceRefs: waiverRefs,
          signatureCode: "signed-at-outside-waiver",
        }),
      );
      continue;
    }
    if (Date.parse(waiver.signature.expiresAt) < expiresAt) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "signature-invalid",
          code: "WAIVER_SIGNATURE_EXPIRES_EARLY",
          precedence: waiver.precedence,
          reason:
            "signature expires before the waiver and cannot authorize its full validity window",
          evidenceRefs: waiverRefs,
          signatureCode: "signature-expires-early",
        }),
      );
      continue;
    }
    const signerKey = keyFor(options.keyring, waiver.signature.signerKeyId);
    if (
      signerKey !== undefined &&
      !waiver.trustRootIds.includes(signerKey.trustRootId)
    ) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "trust-root-untrusted",
          code: "WAIVER_TRUST_ROOT_UNTRUSTED",
          precedence: waiver.precedence,
          reason: "signing key trust root is not declared by the waiver",
          evidenceRefs: waiverRefs,
          signatureCode: "waiver-trust-root-mismatch",
        }),
      );
      continue;
    }
    if (!waiver.trustRootIds.every((root) => trustedRootIds.includes(root))) {
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: "trust-root-untrusted",
          code: "WAIVER_TRUST_ROOT_UNTRUSTED",
          precedence: waiver.precedence,
          reason:
            "waiver trust roots are not present in the explicit local verifier trust roots",
          evidenceRefs: waiverRefs,
          signatureCode: "local-trust-root-missing",
        }),
      );
      continue;
    }
    let signatureReport: { status: string; code: string };
    if (options.keyring === undefined) {
      signatureReport = { status: "failed", code: "missing-key" };
    } else {
      try {
        signatureReport = evaluateAssuranceSigningRecord(waiver.signature, {
          keyring: options.keyring,
          trustedRootIds,
          now: asOf,
        });
      } catch (error) {
        signatureReport = {
          status: "failed",
          code:
            error instanceof AssuranceSigningVerificationError
              ? error.code
              : "invalid-record",
        };
      }
    }
    if (signatureReport.code !== "verified") {
      const failure = signatureFailure(signatureReport.code);
      reports.push(
        report({
          id: waiver.id,
          ruleId: waiver.ruleId,
          status: failure.status,
          code: failure.diagnostic,
          precedence: waiver.precedence,
          reason: `waiver signature verification failed: ${signatureReport.code}`,
          evidenceRefs: waiverRefs,
          signatureCode: signatureReport.code,
        }),
      );
      continue;
    }
    const activeReport = report({
      id: waiver.id,
      ruleId: waiver.ruleId,
      status: lifecycleStatus,
      code:
        lifecycleStatus === "expiring" ? "WAIVER_EXPIRING" : "WAIVER_ACTIVE",
      precedence: waiver.precedence,
      reason:
        lifecycleStatus === "expiring"
          ? `signed waiver expires within ${expiringWithinDays} day(s)`
          : "signed waiver is active for the exact policy and change scope",
      evidenceRefs: waiverRefs,
      signatureCode: "verified",
    });
    reports.push(activeReport);
    candidates.push({ waiver, report: activeReport, violation });
  }

  const byViolation = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const list = byViolation.get(candidate.violation.id) ?? [];
    list.push(candidate);
    byViolation.set(candidate.violation.id, list);
  }
  const suppressions: ArchitectureWaiverSuppression[] = [];
  const suppressedViolationIds = new Set<string>();
  for (const [violationId, matching] of byViolation.entries()) {
    matching.sort((left, right) => {
      const precedence = right.waiver.precedence - left.waiver.precedence;
      return precedence !== 0
        ? precedence
        : compareStrings(left.waiver.id, right.waiver.id);
    });
    const winner = matching[0];
    if (winner === undefined) continue;
    winner.report.suppresses = true;
    winner.report.reason =
      winner.report.status === "expiring"
        ? `expiring signed waiver ${winner.waiver.id} suppresses the exact matching violation`
        : `signed waiver ${winner.waiver.id} suppresses the exact matching violation`;
    suppressedViolationIds.add(violationId);
    suppressions.push({
      violationId,
      waiverId: winner.waiver.id,
      ruleId: winner.waiver.ruleId,
      affectedIds: sortUnique(winner.violation.matches),
      authorityGranted: false,
      reason:
        "suppression is limited to the verified rule and exact change scope; no authority is granted",
      evidenceRefs: evidence([
        ...winner.report.evidenceRefs,
        ...winner.violation.evidenceRefs,
      ]),
    });
    for (const shadowed of matching.slice(1)) {
      shadowed.report.status = "shadowed";
      shadowed.report.code = "WAIVER_SHADOWED";
      shadowed.report.reason =
        "valid waiver was not selected because another valid waiver had higher precedence";
    }
  }
  suppressions.sort((left, right) =>
    compareStrings(left.violationId, right.violationId),
  );
  reports.sort((left, right) => compareStrings(left.id, right.id));
  const violations = policyEvaluation.violations.filter(
    (violation) => !suppressedViolationIds.has(violation.id),
  );
  const status =
    violations.length > 0
      ? "violations"
      : policyEvaluation.unsupported.length > 0
        ? "unsupported"
        : "passed";
  const summary = statusCounts(reports, suppressions.length);
  return parseArchitectureWaiverEvaluation({
    schemaVersion: ARCHITECTURE_WAIVER_SCHEMA_VERSION,
    contract: ARCHITECTURE_WAIVER_CONTRACT,
    mediaType: ARCHITECTURE_WAIVER_MEDIA_TYPE,
    policyId: policy.policyId,
    policyVersion: policy.version,
    policyStatus: policyEvaluation.status,
    inputKind: input.kind,
    inputDigest,
    status,
    authorityGranted: false,
    violations,
    unsupported: policyEvaluation.unsupported,
    suppressed: suppressions,
    waivers: reports,
    summary,
    provenance: {
      resolver: ARCHITECTURE_WAIVER_CONTRACT,
      resolverVersion: "1",
      inputDigest,
      network: false,
      sourceBodiesIncluded: false,
      privateKeysIncluded: false,
      authorityGranted: false,
      deterministic: true,
    },
  });
};

export const evaluateWaivers = evaluateArchitectureWaivers;

export const serializeArchitectureWaiverEvaluation = (value: unknown): string =>
  stableStringify(parseArchitectureWaiverEvaluation(value));
