import { createHash } from "node:crypto";

import { z } from "zod";

import { CAPABILITY_REGISTRY_VERSION } from "./capabilities.js";
import {
  GRAPH_DIFF_SCHEMA_VERSION,
  GRAPH_SNAPSHOT_SCHEMA_VERSION,
} from "./schemas.js";
import { stableStringify } from "./canonical.js";

export const POLICY_BUNDLE_SCHEMA_VERSION = 1 as const;
export const POLICY_BUNDLE_CONTRACT = "cartograph.policy-bundle" as const;
export const POLICY_BUNDLE_MEDIA_TYPE =
  "application/vnd.cartograph.policy+json" as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u,
    "must be a portable lower-case identifier",
  );

const PortableRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .transform((value, context) => {
    const normalized = value.replaceAll("\\", "/");
    const parts = normalized.split("/");
    if (
      normalized.startsWith("/") ||
      normalized.startsWith("~") ||
      normalized.includes("\0") ||
      /^[A-Za-z][A-Za-z\d+.-]*:/.test(normalized) ||
      parts.some((part) => part === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "must be a portable repository-relative path",
      });
      return z.NEVER;
    }

    const compact = parts.filter((part) => part.length > 0 && part !== ".");
    if (compact.length === 0) {
      context.addIssue({
        code: "custom",
        message: "must name a repository-relative source",
      });
      return z.NEVER;
    }
    return compact.join("/");
  });

const DateTimeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "must be a parseable date-time",
  );

const DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, "must be a lower-case SHA-256 digest");

const RuleSelectorSchema = z.string().trim().min(1).max(512);

export const PolicyRuleSchema = z
  .object({
    id: IdentifierSchema,
    target: z.enum(["node", "edge", "diff"]),
    selector: RuleSelectorSchema,
    assertion: z.enum(["exists", "absent", "count-at-most", "count-at-least"]),
    effect: z.enum(["informational", "enforce"]),
    value: z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .strict()
  .superRefine((rule, context) => {
    const isCount =
      rule.assertion === "count-at-most" || rule.assertion === "count-at-least";
    if (isCount && rule.value === undefined) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "count assertions require a non-negative integer value",
      });
    }
    if (!isCount && rule.value !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "exists and absent assertions do not accept value",
      });
    }
  });

const PolicyRulesSchema = z.array(PolicyRuleSchema).min(1).max(1_000);

export const PolicySourceSchema = z
  .object({
    path: PortableRelativePathSchema,
    mediaType: z.literal(POLICY_BUNDLE_MEDIA_TYPE),
    digest: DigestSchema,
    rules: PolicyRulesSchema,
  })
  .strict();

const PolicySourceDraftSchema = z
  .object({
    path: PortableRelativePathSchema,
    mediaType: z.literal(POLICY_BUNDLE_MEDIA_TYPE).optional(),
    digest: DigestSchema.optional(),
    rules: PolicyRulesSchema,
  })
  .strict();

export const PolicySchema = z
  .object({
    id: IdentifierSchema,
    version: z
      .string()
      .trim()
      .regex(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
        "must be a semantic version",
      ),
    source: PolicySourceSchema,
  })
  .strict();

const PolicyDraftSchema = z
  .object({
    id: IdentifierSchema,
    version: z
      .string()
      .trim()
      .regex(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
        "must be a semantic version",
      ),
    source: PolicySourceDraftSchema,
  })
  .strict();

export const PolicyBundleCompatibilitySchema = z
  .object({
    contract: z.string().trim().min(1).max(160),
    bundleVersion: z.number().int().positive(),
    graphSnapshotSchemaVersion: z.number().int().positive(),
    graphDiffSchemaVersion: z.number().int().positive(),
    capabilityRegistryVersion: z.number().int().positive(),
  })
  .strict();

const PolicyBundleCompatibilityPatchSchema =
  PolicyBundleCompatibilitySchema.partial().strict();

export const PolicyBundleAuthoritySchema = z
  .object({
    network: z.literal(false),
    filesystem: z.literal(false),
    execution: z.literal(false),
  })
  .strict();

export const PolicyBundleSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    bundleId: IdentifierSchema,
    policy: PolicySchema,
    compatibility: PolicyBundleCompatibilitySchema,
    owner: z.string().trim().min(1).max(240),
    createdAt: DateTimeSchema,
    expiresAt: DateTimeSchema,
    authority: PolicyBundleAuthoritySchema,
  })
  .strict()
  .superRefine((bundle, context) => {
    if (Date.parse(bundle.createdAt) >= Date.parse(bundle.expiresAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "must be later than createdAt",
      });
    }
  });

export const PolicyBundleDraftSchema = z
  .object({
    schemaVersion: z.number().int().positive().optional(),
    bundleId: IdentifierSchema,
    policy: PolicyDraftSchema,
    compatibility: PolicyBundleCompatibilityPatchSchema.optional(),
    owner: z.string().trim().min(1).max(240),
    createdAt: DateTimeSchema,
    expiresAt: DateTimeSchema,
    authority: PolicyBundleAuthoritySchema.optional(),
  })
  .strict();

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type PolicySource = z.infer<typeof PolicySourceSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type PolicyBundleCompatibility = z.infer<
  typeof PolicyBundleCompatibilitySchema
>;
export type PolicyBundleAuthority = z.infer<typeof PolicyBundleAuthoritySchema>;
export type PolicyBundle = z.infer<typeof PolicyBundleSchema>;
export type PolicyBundleDraft = z.input<typeof PolicyBundleDraftSchema>;

export const CURRENT_POLICY_BUNDLE_COMPATIBILITY: PolicyBundleCompatibility =
  Object.freeze({
    contract: POLICY_BUNDLE_CONTRACT,
    bundleVersion: POLICY_BUNDLE_SCHEMA_VERSION,
    graphSnapshotSchemaVersion: GRAPH_SNAPSHOT_SCHEMA_VERSION,
    graphDiffSchemaVersion: GRAPH_DIFF_SCHEMA_VERSION,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
  });

export type PolicyBundleErrorCode =
  | "invalid"
  | "unsupported-version"
  | "digest-mismatch"
  | "incompatible"
  | "expired"
  | "authority";

export class PolicyBundleVerificationError extends Error {
  readonly code: PolicyBundleErrorCode;

  constructor(code: PolicyBundleErrorCode, message: string) {
    super(message);
    this.name = "PolicyBundleVerificationError";
    this.code = code;
  }
}

const parsedRules = (rules: readonly PolicyRule[]): PolicyRule[] =>
  PolicyRulesSchema.parse(rules);

export const policySourceDigest = (
  sourceOrRules: Pick<PolicySource, "rules"> | readonly PolicyRule[],
): PolicySource["digest"] => {
  const rules =
    "rules" in sourceOrRules
      ? parsedRules(sourceOrRules.rules)
      : parsedRules(sourceOrRules);
  const digest = createHash("sha256")
    .update(stableStringify(rules), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
};

const defaultAuthority = (): PolicyBundleAuthority => ({
  network: false,
  filesystem: false,
  execution: false,
});

export const createPolicyBundle = (input: PolicyBundleDraft): PolicyBundle => {
  const draft = PolicyBundleDraftSchema.parse(input);
  const compatibility = PolicyBundleCompatibilitySchema.parse({
    ...CURRENT_POLICY_BUNDLE_COMPATIBILITY,
    ...(draft.compatibility ?? {}),
  });
  const source: PolicySource = {
    path: draft.policy.source.path,
    mediaType: draft.policy.source.mediaType ?? POLICY_BUNDLE_MEDIA_TYPE,
    digest: policySourceDigest(draft.policy.source.rules),
    rules: draft.policy.source.rules,
  };

  return PolicyBundleSchema.parse({
    schemaVersion: POLICY_BUNDLE_SCHEMA_VERSION,
    bundleId: draft.bundleId,
    policy: {
      id: draft.policy.id,
      version: draft.policy.version,
      source,
    },
    compatibility,
    owner: draft.owner,
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
    authority: draft.authority ?? defaultAuthority(),
  });
};

export interface PolicyBundleVerification {
  bundle: PolicyBundle;
  digest: {
    expected: PolicySource["digest"];
    actual: PolicySource["digest"];
    verified: true;
  };
  compatibility: {
    expected: PolicyBundleCompatibility;
    actual: PolicyBundleCompatibility;
    verified: true;
  };
  authority: PolicyBundleAuthority;
}

export interface VerifyPolicyBundleOptions {
  now?: Date | string;
  expectedCompatibility?: Partial<PolicyBundleCompatibility>;
}

const asInvalid = (message: string): never => {
  throw new PolicyBundleVerificationError("invalid", message);
};

const parseBundle = (input: unknown): PolicyBundle => {
  const parsed = PolicyBundleSchema.safeParse(input);
  if (!parsed.success) {
    return asInvalid(
      `policy bundle schema validation failed: ${parsed.error.message}`,
    );
  }
  return parsed.data;
};

const assertCompatible = (
  bundle: PolicyBundle,
  expectedPatch: Partial<PolicyBundleCompatibility> | undefined,
): PolicyBundleCompatibility => {
  const expected: PolicyBundleCompatibility = {
    ...CURRENT_POLICY_BUNDLE_COMPATIBILITY,
    ...(expectedPatch ?? {}),
  };
  const mismatch = Object.entries(expected).find(
    ([key, value]) =>
      bundle.compatibility[key as keyof PolicyBundleCompatibility] !== value,
  );
  if (mismatch) {
    const [key, value] = mismatch;
    throw new PolicyBundleVerificationError(
      "incompatible",
      `policy bundle compatibility mismatch for ${key}: expected ${String(value)}, found ${String(bundle.compatibility[key as keyof PolicyBundleCompatibility])}`,
    );
  }
  return expected;
};

const verificationNow = (value: Date | string | undefined): Date => {
  const now =
    value instanceof Date
      ? new Date(value.valueOf())
      : new Date(value ?? Date.now());
  if (!Number.isFinite(now.valueOf())) {
    throw new PolicyBundleVerificationError(
      "invalid",
      "verification now must be a valid date",
    );
  }
  return now;
};

export const verifyPolicyBundle = (
  input: unknown,
  options: VerifyPolicyBundleOptions = {},
): PolicyBundleVerification => {
  if (
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    "authority" in input
  ) {
    const authority = (input as { authority?: unknown }).authority;
    if (
      authority &&
      typeof authority === "object" &&
      !Array.isArray(authority) &&
      Object.values(authority).some((value) => value !== false)
    ) {
      throw new PolicyBundleVerificationError(
        "authority",
        "policy bundles cannot grant network, filesystem, or execution authority",
      );
    }
  }

  const bundle = parseBundle(input);
  if (bundle.schemaVersion !== POLICY_BUNDLE_SCHEMA_VERSION) {
    throw new PolicyBundleVerificationError(
      "unsupported-version",
      `unsupported policy bundle schema version ${bundle.schemaVersion}; supported version is ${POLICY_BUNDLE_SCHEMA_VERSION}`,
    );
  }

  const expectedCompatibility = assertCompatible(
    bundle,
    options.expectedCompatibility,
  );
  const actualDigest = policySourceDigest(bundle.policy.source.rules);
  if (actualDigest !== bundle.policy.source.digest) {
    throw new PolicyBundleVerificationError(
      "digest-mismatch",
      `policy source digest mismatch: expected ${bundle.policy.source.digest}, computed ${actualDigest}`,
    );
  }

  const now = verificationNow(options.now);
  if (Date.parse(bundle.expiresAt) <= now.valueOf()) {
    throw new PolicyBundleVerificationError(
      "expired",
      `policy bundle expired at ${bundle.expiresAt}`,
    );
  }

  return {
    bundle,
    digest: {
      expected: bundle.policy.source.digest,
      actual: actualDigest,
      verified: true,
    },
    compatibility: {
      expected: expectedCompatibility,
      actual: bundle.compatibility,
      verified: true,
    },
    authority: bundle.authority,
  };
};

export const importPolicyBundle = (
  input: unknown,
  options: VerifyPolicyBundleOptions = {},
): PolicyBundle => verifyPolicyBundle(input, options).bundle;

export const parsePolicyBundle = importPolicyBundle;

export const serializePolicyBundle = (bundle: unknown): string =>
  stableStringify(PolicyBundleSchema.parse(bundle));
