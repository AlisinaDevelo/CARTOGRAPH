import { createHash } from "node:crypto";

import { z } from "zod";

import { stableStringify } from "./canonical.js";
import {
  CURRENT_POLICY_BUNDLE_COMPATIBILITY,
  POLICY_BUNDLE_SCHEMA_VERSION,
  PolicyBundleSchema,
  PolicyRuleSchema,
  policySourceDigest,
  type PolicyBundle,
  type PolicyBundleCompatibility,
} from "./policy-bundles.js";

export const POLICY_BUNDLE_MIGRATION_SCHEMA_VERSION = 1 as const;
export const POLICY_BUNDLE_MIGRATION_CONTRACT =
  "cartograph.policy-bundle-migration" as const;

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const SemverSchema = z
  .string()
  .trim()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "must be a semantic version",
  );

export const PolicyBundleRevocationListSchema = z
  .object({
    schemaVersion: z.literal(POLICY_BUNDLE_MIGRATION_SCHEMA_VERSION),
    revokedDigests: z.array(DigestSchema).max(10_000),
  })
  .strict();

const MigrationFindingSchema = z
  .object({
    code: z.enum([
      "version-upgrade",
      "expired",
      "revoked",
      "incompatible-compatibility",
      "incompatible-selector",
      "missing-owner",
      "digest-mismatch",
      "unsupported-version",
      "invalid-bundle",
    ]),
    severity: z.enum(["review", "blocking"]),
    digest: DigestSchema,
  })
  .strict();

export const PolicyBundleMigrationReportSchema = z
  .object({
    schemaVersion: z.literal(POLICY_BUNDLE_MIGRATION_SCHEMA_VERSION),
    contract: z.literal(POLICY_BUNDLE_MIGRATION_CONTRACT),
    digestOnly: z.literal(true),
    bundleDigest: DigestSchema,
    policyVersion: SemverSchema.nullable(),
    targetPolicyVersion: SemverSchema.nullable(),
    reviewed: z.boolean(),
    status: z.enum([
      "ready",
      "migration-required",
      "review-required",
      "blocked",
    ]),
    enforceable: z.boolean(),
    findings: z.array(MigrationFindingSchema).max(32),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.status === "ready" && report.findings.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "ready reports must not contain findings",
      });
    }
    if (report.status === "blocked" && report.enforceable) {
      context.addIssue({
        code: "custom",
        path: ["enforceable"],
        message: "blocked reports cannot be enforceable",
      });
    }
  });

export type PolicyBundleRevocationList = z.infer<
  typeof PolicyBundleRevocationListSchema
>;
export type PolicyBundleMigrationFinding = z.infer<
  typeof MigrationFindingSchema
>;
export type PolicyBundleMigrationReport = z.infer<
  typeof PolicyBundleMigrationReportSchema
>;

export type PolicyBundleMigrationErrorCode =
  "invalid-input" | "enforcement-blocked";

export class PolicyBundleMigrationError extends Error {
  readonly code: PolicyBundleMigrationErrorCode;
  readonly report?: PolicyBundleMigrationReport;

  constructor(
    code: PolicyBundleMigrationErrorCode,
    message: string,
    report?: PolicyBundleMigrationReport,
  ) {
    super(message);
    this.name = "PolicyBundleMigrationError";
    this.code = code;
    if (report) this.report = report;
  }
}

export interface EvaluatePolicyBundleMigrationOptions {
  targetPolicyVersion?: string;
  expectedCompatibility?: Partial<PolicyBundleCompatibility>;
  revokedDigests?: readonly string[];
  revocationList?: PolicyBundleRevocationList;
  reviewed?: boolean;
  mode?: "report" | "enforce";
  now?: Date | string;
}

const SELECTOR_PATTERN = /^(?:kind|id|stableKey|relation)=[a-zA-Z0-9_.:/-]+$/u;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const digestUnknown = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(stableStringify(value), "utf8").digest("hex")}`;

const sourceDigestFor = (input: unknown): `sha256:${string}` => {
  const bundle = asRecord(input);
  const policy = asRecord(bundle?.policy);
  const source = asRecord(policy?.source);
  if (Array.isArray(source?.rules)) {
    const parsedRules = PolicyRuleSchema.array().safeParse(source.rules);
    if (parsedRules.success)
      return policySourceDigest(parsedRules.data) as `sha256:${string}`;
  }
  if (
    typeof source?.digest === "string" &&
    DigestSchema.safeParse(source.digest).success
  )
    return source.digest as `sha256:${string}`;
  return digestUnknown(input);
};

const validNow = (input: Date | string | undefined): Date => {
  const now =
    input instanceof Date
      ? new Date(input.valueOf())
      : new Date(input ?? Date.now());
  if (!Number.isFinite(now.valueOf()))
    throw new PolicyBundleMigrationError(
      "invalid-input",
      "migration now must be a valid date",
    );
  return now;
};

const semverParts = (value: string): [number, number, number] | undefined => {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/u);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const compareSemver = (left: string, right: string): number => {
  const leftParts = semverParts(left);
  const rightParts = semverParts(right);
  if (!leftParts || !rightParts) return 0;
  for (let index = 0; index < leftParts.length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
};

const compatibilityFor = (
  expectedPatch: Partial<PolicyBundleCompatibility> | undefined,
): PolicyBundleCompatibility => ({
  ...CURRENT_POLICY_BUNDLE_COMPATIBILITY,
  ...(expectedPatch ?? {}),
});

const revokedSetFor = (
  options: EvaluatePolicyBundleMigrationOptions,
): Set<string> => {
  let revocationList: PolicyBundleRevocationList | undefined;
  if (options.revocationList !== undefined) {
    const parsed = PolicyBundleRevocationListSchema.safeParse(
      options.revocationList,
    );
    if (!parsed.success) {
      throw new PolicyBundleMigrationError(
        "invalid-input",
        "revocation list does not match the migration contract",
      );
    }
    revocationList = parsed.data;
  }
  const values = [
    ...(options.revokedDigests ?? []),
    ...(revocationList?.revokedDigests ?? []),
  ];
  const parsed = values.map((digest) => DigestSchema.safeParse(digest));
  if (parsed.some((result) => !result.success)) {
    throw new PolicyBundleMigrationError(
      "invalid-input",
      "revocation digests must be lower-case SHA-256 digests",
    );
  }
  return new Set(values);
};

const addFinding = (
  findings: PolicyBundleMigrationFinding[],
  code: PolicyBundleMigrationFinding["code"],
  severity: PolicyBundleMigrationFinding["severity"],
  digest: `sha256:${string}`,
): void => {
  if (findings.some((finding) => finding.code === code)) return;
  findings.push({ code, severity, digest });
};

const rawPolicyVersion = (input: unknown): string | null => {
  const policy = asRecord(asRecord(input)?.policy);
  return typeof policy?.version === "string" &&
    SemverSchema.safeParse(policy.version).success
    ? policy.version.trim()
    : null;
};

const rawTargetVersion = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const parsed = SemverSchema.safeParse(value);
  if (!parsed.success)
    throw new PolicyBundleMigrationError(
      "invalid-input",
      "target policy version must be a semantic version",
    );
  return parsed.data;
};

const inspectSelectors = (input: unknown): boolean => {
  const source = asRecord(asRecord(asRecord(input)?.policy)?.source);
  if (!Array.isArray(source?.rules)) return false;
  return source.rules.some((rule) => {
    const record = asRecord(rule);
    return (
      typeof record?.selector !== "string" ||
      !SELECTOR_PATTERN.test(record.selector.trim())
    );
  });
};

const evaluateReport = (
  input: unknown,
  options: EvaluatePolicyBundleMigrationOptions,
): PolicyBundleMigrationReport => {
  const bundleDigest = sourceDigestFor(input);
  const rawBundle = asRecord(input);
  const rawPolicy = asRecord(rawBundle?.policy);
  const rawSource = asRecord(rawPolicy?.source);
  const policyVersion = rawPolicyVersion(input);
  const targetPolicyVersion = rawTargetVersion(options.targetPolicyVersion);
  const reviewed = options.reviewed === true;
  const expectedCompatibility = compatibilityFor(options.expectedCompatibility);
  const findings: PolicyBundleMigrationFinding[] = [];
  const parsed = PolicyBundleSchema.safeParse(input);

  const ownerPresent =
    typeof rawBundle?.owner === "string" && rawBundle.owner.trim().length > 0;
  if (!parsed.success && ownerPresent)
    addFinding(findings, "invalid-bundle", "blocking", bundleDigest);
  if (rawBundle?.schemaVersion !== POLICY_BUNDLE_SCHEMA_VERSION)
    addFinding(findings, "unsupported-version", "blocking", bundleDigest);

  if (!ownerPresent)
    addFinding(findings, "missing-owner", "blocking", bundleDigest);

  if (inspectSelectors(input))
    addFinding(findings, "incompatible-selector", "review", bundleDigest);

  if (
    policyVersion &&
    targetPolicyVersion &&
    compareSemver(policyVersion, targetPolicyVersion) < 0
  )
    addFinding(findings, "version-upgrade", "review", bundleDigest);

  const compatibility = asRecord(rawBundle?.compatibility);
  const compatibilityMismatch = Object.entries(expectedCompatibility).some(
    ([key, value]) => compatibility?.[key] !== value,
  );
  if (compatibilityMismatch)
    addFinding(findings, "incompatible-compatibility", "review", bundleDigest);

  if (
    typeof rawSource?.digest === "string" &&
    Array.isArray(rawSource.rules) &&
    PolicyRuleSchema.array().safeParse(rawSource.rules).success
  ) {
    const computed = policySourceDigest(
      rawSource.rules as PolicyBundle["policy"]["source"]["rules"],
    );
    if (computed !== rawSource.digest)
      addFinding(findings, "digest-mismatch", "blocking", bundleDigest);
  }

  if (revokedSetFor(options).has(bundleDigest))
    addFinding(findings, "revoked", "blocking", bundleDigest);

  const now = validNow(options.now);
  if (
    typeof rawBundle?.expiresAt === "string" &&
    Number.isFinite(Date.parse(rawBundle.expiresAt))
  ) {
    if (Date.parse(rawBundle.expiresAt) <= now.valueOf())
      addFinding(findings, "expired", "blocking", bundleDigest);
  }

  const hasBlocking = findings.some(
    (finding) => finding.severity === "blocking",
  );
  const hasUnreviewedReview = findings.some(
    (finding) => finding.severity === "review" && !reviewed,
  );
  const enforceable = !hasBlocking && !hasUnreviewedReview;
  const status = hasBlocking
    ? "blocked"
    : hasUnreviewedReview
      ? "review-required"
      : findings.length > 0
        ? "migration-required"
        : "ready";

  return PolicyBundleMigrationReportSchema.parse({
    schemaVersion: POLICY_BUNDLE_MIGRATION_SCHEMA_VERSION,
    contract: POLICY_BUNDLE_MIGRATION_CONTRACT,
    digestOnly: true,
    bundleDigest,
    policyVersion,
    targetPolicyVersion,
    reviewed,
    status,
    enforceable,
    findings,
  });
};

export const evaluatePolicyBundleMigration = (
  input: unknown,
  options: EvaluatePolicyBundleMigrationOptions = {},
): PolicyBundleMigrationReport => {
  const report = evaluateReport(input, options);
  if (options.mode === "enforce" && !report.enforceable) {
    throw new PolicyBundleMigrationError(
      "enforcement-blocked",
      report.status === "review-required"
        ? "refusing to enforce an incompatible policy bundle without explicit review"
        : `refusing to enforce policy bundle migration in ${report.status} state`,
      report,
    );
  }
  return report;
};

export const migratePolicyBundle = evaluatePolicyBundleMigration;

export const serializePolicyBundleMigrationReport = (report: unknown): string =>
  stableStringify(PolicyBundleMigrationReportSchema.parse(report));
