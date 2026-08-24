import { createHash } from "node:crypto";

import { z } from "zod";

import { stableStringify } from "./canonical.js";

export const REMEDIATION_SUGGESTION_SCHEMA_VERSION = 1 as const;
export const REMEDIATION_SUGGESTION_CONTRACT =
  "cartograph.remediation-suggestion" as const;
export const REMEDIATION_SUGGESTION_MAX_SUGGESTIONS = 32 as const;
export const REMEDIATION_SUGGESTION_MAX_FINDINGS = 1_000 as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u,
    "must be a portable lower-case identifier",
  );
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const TextSchema = z.string().trim().min(1).max(2_000);
const PortableReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !value.startsWith("~") &&
      !/^[A-Za-z]:/.test(value) &&
      !/^file:/iu.test(value) &&
      !value.split(/[\\/]/u).some((part) => part === "..") &&
      !value.includes("\0"),
    "must not contain an absolute local path",
  );

export const RemediationSuggestionKindSchema = z.enum([
  "explanation",
  "investigation-step",
  "configuration-change",
  "policy-action",
  "waiver-action",
  "documentation-action",
  "code-change-suggestion",
]);

export const RemediationSuggestionRiskSchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);

const RemediationSuggestionOperationSchema = z.enum([
  "explain",
  "investigate",
  "configure",
  "policy",
  "waiver",
  "document",
  "code",
]);

const operationForKind: Record<
  z.infer<typeof RemediationSuggestionKindSchema>,
  z.infer<typeof RemediationSuggestionOperationSchema>
> = {
  explanation: "explain",
  "investigation-step": "investigate",
  "configuration-change": "configure",
  "policy-action": "policy",
  "waiver-action": "waiver",
  "documentation-action": "document",
  "code-change-suggestion": "code",
};

export const RemediationEvidenceReferenceSchema = z
  .object({
    id: IdentifierSchema,
    kind: z.enum(["source", "diff", "policy", "runtime", "review"]),
    digest: DigestSchema,
    reference: PortableReferenceSchema,
  })
  .strict();

export const RemediationFindingInputSchema = z
  .object({
    name: IdentifierSchema,
    reference: PortableReferenceSchema,
    valueDigest: DigestSchema,
  })
  .strict();

export const RemediationFindingSchema = z
  .object({
    findingId: IdentifierSchema,
    findingCode: IdentifierSchema,
    severity: z.enum(["info", "warning", "error", "critical"]),
    summary: TextSchema,
    baselineDigest: DigestSchema,
    evidenceDigest: DigestSchema,
    evidence: z.array(RemediationEvidenceReferenceSchema).min(1).max(32),
    inputs: z.array(RemediationFindingInputSchema).min(1).max(32),
    ownerId: IdentifierSchema.nullable(),
    ambiguity: z.enum(["clear", "ambiguous"]),
    securitySensitive: z.boolean(),
  })
  .strict()
  .superRefine((finding, context) => {
    const evidenceIds = new Set<string>();
    for (const [index, evidence] of finding.evidence.entries()) {
      if (evidenceIds.has(evidence.id)) {
        context.addIssue({
          code: "custom",
          path: ["evidence", index, "id"],
          message: "evidence IDs must be unique",
        });
      }
      evidenceIds.add(evidence.id);
    }
    const inputNames = new Set<string>();
    for (const [index, input] of finding.inputs.entries()) {
      if (inputNames.has(input.name)) {
        context.addIssue({
          code: "custom",
          path: ["inputs", index, "name"],
          message: "input names must be unique",
        });
      }
      inputNames.add(input.name);
    }
  });

export const RemediationEditSchema = z
  .object({
    target: PortableReferenceSchema,
    change: TextSchema,
    reversible: z.literal(true),
  })
  .strict();

export const RemediationProposalSchema = z
  .object({
    operation: RemediationSuggestionOperationSchema,
    description: TextSchema,
    targets: z.array(PortableReferenceSchema).max(16),
    edits: z.array(RemediationEditSchema).max(16),
  })
  .strict();

export const RemediationValidationStepSchema = z
  .object({
    id: IdentifierSchema,
    action: TextSchema,
    expected: TextSchema,
  })
  .strict();

export const RemediationRuleSchema = z
  .object({
    ruleId: IdentifierSchema,
    findingCode: IdentifierSchema,
    kind: RemediationSuggestionKindSchema,
    title: TextSchema,
    rationale: TextSchema,
    proposal: RemediationProposalSchema,
    confidence: z.number().min(0).max(1),
    assumptions: z.array(TextSchema).max(16),
    risk: RemediationSuggestionRiskSchema,
    validationPlan: z.array(RemediationValidationStepSchema).min(1).max(16),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.proposal.operation !== operationForKind[rule.kind]) {
      context.addIssue({
        code: "custom",
        path: ["proposal", "operation"],
        message: `proposal operation must match ${rule.kind}`,
      });
    }
    if (
      !["explanation", "investigation-step"].includes(rule.kind) &&
      rule.proposal.edits.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["proposal", "edits"],
        message: `${rule.kind} rules require at least one reversible proposed edit`,
      });
    }
  });

export const RemediationSuggestionSchema = z
  .object({
    schemaVersion: z.literal(REMEDIATION_SUGGESTION_SCHEMA_VERSION),
    contract: z.literal(REMEDIATION_SUGGESTION_CONTRACT),
    suggestionId: IdentifierSchema,
    ruleId: IdentifierSchema,
    findingId: IdentifierSchema,
    findingCode: IdentifierSchema,
    findingDigest: DigestSchema,
    baselineDigest: DigestSchema,
    evidenceDigest: DigestSchema,
    kind: RemediationSuggestionKindSchema,
    status: z.literal("unverified"),
    title: TextSchema,
    rationale: TextSchema,
    inputs: z.array(RemediationFindingInputSchema).min(1).max(32),
    evidence: z.array(RemediationEvidenceReferenceSchema).min(1).max(32),
    confidence: z.number().min(0).max(1),
    assumptions: z.array(TextSchema).max(16),
    risk: RemediationSuggestionRiskSchema,
    proposal: RemediationProposalSchema,
    validationPlan: z.array(RemediationValidationStepSchema).min(1).max(16),
    readOnly: z.literal(true),
    authority: z
      .object({
        network: z.literal(false),
        filesystem: z.literal(false),
        execution: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((suggestion, context) => {
    if (suggestion.proposal.operation !== operationForKind[suggestion.kind]) {
      context.addIssue({
        code: "custom",
        path: ["proposal", "operation"],
        message: `proposal operation must match ${suggestion.kind}`,
      });
    }
  });

export const RemediationSkipReasonSchema = z.enum([
  "generation-disabled",
  "invalid-finding",
  "unsupported-finding",
  "stale-baseline",
  "stale-evidence",
  "ambiguous-finding",
  "ownerless-finding",
  "security-sensitive",
  "resource-limit",
]);

export const RemediationSuggestionSkipSchema = z
  .object({
    findingId: IdentifierSchema,
    findingCode: IdentifierSchema,
    reason: RemediationSkipReasonSchema,
  })
  .strict();

export const RemediationSuggestionReportSchema = z
  .object({
    schemaVersion: z.literal(REMEDIATION_SUGGESTION_SCHEMA_VERSION),
    contract: z.literal(REMEDIATION_SUGGESTION_CONTRACT),
    mode: z.enum(["disabled", "enabled"]),
    readOnly: z.literal(true),
    authority: z
      .object({
        network: z.literal(false),
        filesystem: z.literal(false),
        execution: z.literal(false),
      })
      .strict(),
    suggestions: z
      .array(RemediationSuggestionSchema)
      .max(REMEDIATION_SUGGESTION_MAX_SUGGESTIONS),
    skipped: z
      .array(RemediationSuggestionSkipSchema)
      .max(REMEDIATION_SUGGESTION_MAX_FINDINGS),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.mode === "disabled" && report.suggestions.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["suggestions"],
        message: "disabled generation cannot emit suggestions",
      });
    }
  });

export type RemediationSuggestionKind = z.infer<
  typeof RemediationSuggestionKindSchema
>;
export type RemediationSuggestionRisk = z.infer<
  typeof RemediationSuggestionRiskSchema
>;
export type RemediationEvidenceReference = z.infer<
  typeof RemediationEvidenceReferenceSchema
>;
export type RemediationFindingInput = z.infer<
  typeof RemediationFindingInputSchema
>;
export type RemediationFinding = z.infer<typeof RemediationFindingSchema>;
export type RemediationEdit = z.infer<typeof RemediationEditSchema>;
export type RemediationProposal = z.infer<typeof RemediationProposalSchema>;
export type RemediationValidationStep = z.infer<
  typeof RemediationValidationStepSchema
>;
export type RemediationRule = z.infer<typeof RemediationRuleSchema>;
export type RemediationSuggestion = z.infer<typeof RemediationSuggestionSchema>;
export type RemediationSkipReason = z.infer<typeof RemediationSkipReasonSchema>;
export type RemediationSuggestionSkip = z.infer<
  typeof RemediationSuggestionSkipSchema
>;
export type RemediationSuggestionReport = z.infer<
  typeof RemediationSuggestionReportSchema
>;

export type RemediationSuggestionErrorCode = "invalid-input" | "resource-limit";

export class RemediationSuggestionError extends Error {
  readonly code: RemediationSuggestionErrorCode;

  constructor(code: RemediationSuggestionErrorCode, message: string) {
    super(message);
    this.name = "RemediationSuggestionError";
    this.code = code;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const digest = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(stableStringify(value), "utf8").digest("hex")}`;

const compareById = (left: { id: string }, right: { id: string }): number =>
  left.id.localeCompare(right.id);

const canonicalFinding = (input: unknown): RemediationFinding => {
  const parsed = RemediationFindingSchema.parse(input);
  return {
    ...parsed,
    evidence: [...parsed.evidence].sort(compareById),
    inputs: [...parsed.inputs].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  };
};

export const remediationFindingDigest = (
  finding: RemediationFinding,
): `sha256:${string}` => digest(canonicalFinding(finding));

const identityFor = (
  input: unknown,
): { findingId: string; findingCode: string } => {
  const record = asRecord(input);
  const findingId =
    typeof record?.findingId === "string" &&
    IdentifierSchema.safeParse(record.findingId).success
      ? record.findingId
      : "unknown-finding";
  const findingCode =
    typeof record?.findingCode === "string" &&
    IdentifierSchema.safeParse(record.findingCode).success
      ? record.findingCode
      : "unknown-finding";
  return { findingId, findingCode };
};

const report = (
  mode: RemediationSuggestionReport["mode"],
  suggestions: RemediationSuggestion[],
  skipped: RemediationSuggestionSkip[],
): RemediationSuggestionReport =>
  RemediationSuggestionReportSchema.parse({
    schemaVersion: REMEDIATION_SUGGESTION_SCHEMA_VERSION,
    contract: REMEDIATION_SUGGESTION_CONTRACT,
    mode,
    readOnly: true,
    authority: { network: false, filesystem: false, execution: false },
    suggestions,
    skipped,
  });

const parseDigest = (value: unknown, label: string): `sha256:${string}` => {
  const parsed = DigestSchema.safeParse(value);
  if (!parsed.success)
    throw new RemediationSuggestionError(
      "invalid-input",
      `${label} must be a lower-case SHA-256 digest`,
    );
  return parsed.data as `sha256:${string}`;
};

const parseRules = (rules: readonly RemediationRule[]): RemediationRule[] => {
  if (rules.length > REMEDIATION_SUGGESTION_MAX_FINDINGS)
    throw new RemediationSuggestionError(
      "resource-limit",
      `at most ${REMEDIATION_SUGGESTION_MAX_FINDINGS} remediation rules are supported`,
    );
  const values: RemediationRule[] = rules.map((rule) => {
    const parsed = RemediationRuleSchema.safeParse(rule);
    if (!parsed.success)
      throw new RemediationSuggestionError(
        "invalid-input",
        "remediation rules do not match the contract",
      );
    return parsed.data;
  });
  const ruleIds = new Set<string>();
  const findingCodes = new Set<string>();
  for (const rule of values) {
    if (ruleIds.has(rule.ruleId) || findingCodes.has(rule.findingCode))
      throw new RemediationSuggestionError(
        "invalid-input",
        "remediation rule IDs and finding codes must be unique",
      );
    ruleIds.add(rule.ruleId);
    findingCodes.add(rule.findingCode);
  }
  return values;
};

export interface GenerateRemediationSuggestionsOptions {
  enabled?: boolean;
  currentBaselineDigest?: string;
  currentEvidenceDigests?: Readonly<Record<string, string>>;
  rules?: readonly RemediationRule[];
  maxSuggestions?: number;
}

const suggestionFor = (
  finding: RemediationFinding,
  rule: RemediationRule,
): RemediationSuggestion => {
  const findingDigest = remediationFindingDigest(finding);
  const suggestionId = `suggestion-${digest({ findingDigest, ruleId: rule.ruleId }).slice(7, 31)}`;
  return RemediationSuggestionSchema.parse({
    schemaVersion: REMEDIATION_SUGGESTION_SCHEMA_VERSION,
    contract: REMEDIATION_SUGGESTION_CONTRACT,
    suggestionId,
    ruleId: rule.ruleId,
    findingId: finding.findingId,
    findingCode: finding.findingCode,
    findingDigest,
    baselineDigest: finding.baselineDigest,
    evidenceDigest: finding.evidenceDigest,
    kind: rule.kind,
    status: "unverified",
    title: rule.title,
    rationale: rule.rationale,
    inputs: finding.inputs,
    evidence: finding.evidence,
    confidence: rule.confidence,
    assumptions: rule.assumptions,
    risk: rule.risk,
    proposal: rule.proposal,
    validationPlan: rule.validationPlan,
    readOnly: true,
    authority: { network: false, filesystem: false, execution: false },
  });
};

export const createRemediationSuggestion = (
  findingInput: unknown,
  ruleInput: unknown,
): RemediationSuggestion => {
  const findingResult = RemediationFindingSchema.safeParse(findingInput);
  const ruleResult = RemediationRuleSchema.safeParse(ruleInput);
  if (!findingResult.success || !ruleResult.success)
    throw new RemediationSuggestionError(
      "invalid-input",
      "finding or remediation rule does not match the contract",
    );
  if (findingResult.data.findingCode !== ruleResult.data.findingCode)
    throw new RemediationSuggestionError(
      "invalid-input",
      "remediation rule does not support the finding code",
    );
  return suggestionFor(canonicalFinding(findingResult.data), ruleResult.data);
};

export const generateRemediationSuggestions = (
  findings: readonly unknown[],
  options: GenerateRemediationSuggestionsOptions = {},
): RemediationSuggestionReport => {
  if (!Array.isArray(findings))
    throw new RemediationSuggestionError(
      "invalid-input",
      "findings must be an array",
    );
  if (findings.length > REMEDIATION_SUGGESTION_MAX_FINDINGS)
    throw new RemediationSuggestionError(
      "resource-limit",
      `at most ${REMEDIATION_SUGGESTION_MAX_FINDINGS} findings are supported`,
    );

  if (options.enabled !== true) {
    return report(
      "disabled",
      [],
      findings.map((finding) => ({
        ...identityFor(finding),
        reason: "generation-disabled" as const,
      })),
    );
  }

  const currentBaselineDigest = parseDigest(
    options.currentBaselineDigest,
    "currentBaselineDigest",
  );
  const evidenceDigests = options.currentEvidenceDigests ?? {};
  if (
    typeof evidenceDigests !== "object" ||
    evidenceDigests === null ||
    Array.isArray(evidenceDigests)
  )
    throw new RemediationSuggestionError(
      "invalid-input",
      "currentEvidenceDigests must be an object",
    );
  for (const [findingId, currentDigest] of Object.entries(evidenceDigests))
    parseDigest(currentDigest, `currentEvidenceDigests.${findingId}`);
  const maxSuggestions =
    options.maxSuggestions ?? REMEDIATION_SUGGESTION_MAX_SUGGESTIONS;
  if (
    !Number.isInteger(maxSuggestions) ||
    maxSuggestions < 1 ||
    maxSuggestions > REMEDIATION_SUGGESTION_MAX_SUGGESTIONS
  )
    throw new RemediationSuggestionError(
      "resource-limit",
      `maxSuggestions must be between 1 and ${REMEDIATION_SUGGESTION_MAX_SUGGESTIONS}`,
    );
  const rules = parseRules(options.rules ?? []);
  const rulesByCode = new Map(rules.map((rule) => [rule.findingCode, rule]));
  const suggestions: RemediationSuggestion[] = [];
  const skipped: RemediationSuggestionSkip[] = [];

  for (const rawFinding of findings) {
    const identity = identityFor(rawFinding);
    const parsed = RemediationFindingSchema.safeParse(rawFinding);
    if (!parsed.success) {
      skipped.push({ ...identity, reason: "invalid-finding" });
      continue;
    }
    const finding = canonicalFinding(parsed.data);
    const rule = rulesByCode.get(finding.findingCode);
    if (!rule) {
      skipped.push({ ...identity, reason: "unsupported-finding" });
      continue;
    }
    if (finding.baselineDigest !== currentBaselineDigest) {
      skipped.push({ ...identity, reason: "stale-baseline" });
      continue;
    }
    if (evidenceDigests[finding.findingId] !== finding.evidenceDigest) {
      skipped.push({ ...identity, reason: "stale-evidence" });
      continue;
    }
    if (finding.ambiguity !== "clear") {
      skipped.push({ ...identity, reason: "ambiguous-finding" });
      continue;
    }
    if (finding.ownerId === null) {
      skipped.push({ ...identity, reason: "ownerless-finding" });
      continue;
    }
    if (finding.securitySensitive) {
      skipped.push({ ...identity, reason: "security-sensitive" });
      continue;
    }
    if (suggestions.length >= maxSuggestions) {
      skipped.push({ ...identity, reason: "resource-limit" });
      continue;
    }
    suggestions.push(suggestionFor(finding, rule));
  }

  return report("enabled", suggestions, skipped);
};

export const serializeRemediationSuggestion = (suggestion: unknown): string =>
  stableStringify(RemediationSuggestionSchema.parse(suggestion));

export const serializeRemediationSuggestionReport = (
  reportInput: unknown,
): string =>
  stableStringify(RemediationSuggestionReportSchema.parse(reportInput));
