import { Buffer } from "node:buffer";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { z } from "zod";

import { stableStringify } from "./canonical.js";

export const LOCAL_POLICY_SCHEMA_VERSION = 1 as const;
export const LOCAL_POLICY_CONTRACT = "cartograph.policy" as const;
export const POLICY_CONFIG_MAX_BYTES = 1024 * 1024;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u,
    "must be a portable lower-case identifier",
  );

const SelectorValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );

export const LocalPolicyPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => {
    const normalized = value.replaceAll("\\", "/");
    return (
      !normalized.startsWith("/") &&
      !normalized.startsWith("~") &&
      !normalized.startsWith("//") &&
      !normalized.includes("\0") &&
      !/^[A-Za-z][A-Za-z\d+.-]*:/.test(normalized) &&
      !normalized.split("/").some((part) => part === "..")
    );
  }, "must be a repository-relative local policy path");

const NameSelectorSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );

const NodeKindSchema = z.enum([
  "endpoint",
  "module",
  "service",
  "function",
  "database_table",
  "queue",
  "external_service",
  "file",
  "unknown",
]);

const EdgeKindSchema = z.enum([
  "calls",
  "imports",
  "reads",
  "writes",
  "publishes",
  "subscribes",
  "requests",
  "contains",
  "routes_to",
  "depends_on",
  "implements",
  "unknown",
]);

const DiffKindSchema = z.enum([
  "node-added",
  "node-removed",
  "node-changed",
  "edge-added",
  "edge-removed",
  "edge-changed",
  "edge-rewired",
  "diagnostic-added",
  "diagnostic-removed",
  "diagnostic-changed",
  "identity-matched",
  "identity-ambiguous",
  "identity-unsupported",
]);

const DiffClassificationSchema = z.enum([
  "node-changed",
  "edge-changed",
  "evidence-only",
  "confidence-changed",
  "endpoint-rewired",
  "diagnostic-changed",
]);

const requireSelectorField = <T extends { readonly [key: string]: unknown }>(
  selector: T,
  context: z.RefinementCtx,
): void => {
  if (Object.values(selector).every((value) => value === undefined)) {
    context.addIssue({
      code: "custom",
      message: "selector must contain at least one field",
    });
  }
};

export const LocalPolicyNodeSelectorSchema = z
  .object({
    kind: NodeKindSchema.optional(),
    id: SelectorValueSchema.optional(),
    name: NameSelectorSchema.optional(),
  })
  .strict()
  .superRefine(requireSelectorField);

export const LocalPolicyEdgeSelectorSchema = z
  .object({
    kind: EdgeKindSchema.optional(),
    from: SelectorValueSchema.optional(),
    to: SelectorValueSchema.optional(),
  })
  .strict()
  .superRefine(requireSelectorField);

export const LocalPolicyDiffSelectorSchema = z
  .object({
    kind: DiffKindSchema.optional(),
    id: SelectorValueSchema.optional(),
    code: IdentifierSchema.optional(),
    classification: DiffClassificationSchema.optional(),
  })
  .strict()
  .superRefine(requireSelectorField);

const AssertionSchema = z.enum([
  "exists",
  "absent",
  "count-at-most",
  "count-at-least",
]);

const EffectSchema = z.enum(["informational", "enforce"]);

export const LocalPolicyIncludeSchema = z
  .object({
    path: LocalPolicyPathSchema,
  })
  .strict();

const ruleInvariant = (
  rule: {
    assertion: z.infer<typeof AssertionSchema>;
    value?: number | undefined;
  },
  context: z.RefinementCtx,
): void => {
  const countAssertion =
    rule.assertion === "count-at-most" || rule.assertion === "count-at-least";
  if (countAssertion && rule.value === undefined) {
    context.addIssue({
      code: "custom",
      path: ["value"],
      message: "count assertions require a non-negative integer value",
    });
  }
  if (!countAssertion && rule.value !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["value"],
      message: "exists and absent assertions do not accept value",
    });
  }
};

const PolicyRuleCommonShape = {
  id: IdentifierSchema,
  assertion: AssertionSchema,
  value: z.number().int().nonnegative().max(1_000_000).optional(),
  effect: EffectSchema.optional(),
};

const PolicyNodeRuleSchema = z
  .object({
    ...PolicyRuleCommonShape,
    target: z.literal("node"),
    selector: LocalPolicyNodeSelectorSchema,
  })
  .strict()
  .superRefine(ruleInvariant);

const PolicyEdgeRuleSchema = z
  .object({
    ...PolicyRuleCommonShape,
    target: z.literal("edge"),
    selector: LocalPolicyEdgeSelectorSchema,
  })
  .strict()
  .superRefine(ruleInvariant);

const PolicyDiffRuleSchema = z
  .object({
    ...PolicyRuleCommonShape,
    target: z.literal("diff"),
    selector: LocalPolicyDiffSelectorSchema,
  })
  .strict()
  .superRefine(ruleInvariant);

export const LocalPolicyRuleSchema = z.discriminatedUnion("target", [
  PolicyNodeRuleSchema,
  PolicyEdgeRuleSchema,
  PolicyDiffRuleSchema,
]);

const SemverSchema = z
  .string()
  .trim()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "must be a semantic version",
  );

export const PolicyConfigSchema = z
  .object({
    schemaVersion: z
      .literal(LOCAL_POLICY_SCHEMA_VERSION)
      .default(LOCAL_POLICY_SCHEMA_VERSION),
    policyId: IdentifierSchema,
    version: SemverSchema,
    mode: EffectSchema.default("informational"),
    scope: IdentifierSchema.default("repository"),
    precedence: z.number().int().nonnegative().max(1_000).default(0),
    overrideLimit: z.number().int().nonnegative().max(128).default(0),
    includes: z.array(LocalPolicyIncludeSchema).max(32).default([]),
    rules: z.array(LocalPolicyRuleSchema).min(1).max(256),
  })
  .strict();

export type LocalPolicyNodeSelector = z.infer<
  typeof LocalPolicyNodeSelectorSchema
>;
export type LocalPolicyEdgeSelector = z.infer<
  typeof LocalPolicyEdgeSelectorSchema
>;
export type LocalPolicyDiffSelector = z.infer<
  typeof LocalPolicyDiffSelectorSchema
>;
export type LocalPolicyInclude = z.infer<typeof LocalPolicyIncludeSchema>;
export type LocalPolicyRule = z.infer<typeof LocalPolicyRuleSchema>;
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

export class PolicyConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyConfigValidationError";
  }
}

const issueText = (issues: z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "policy";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

export const parsePolicyConfig = (value: unknown): PolicyConfig => {
  const parsed = PolicyConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new PolicyConfigValidationError(issueText(parsed.error.issues));
  }
  return parsed.data;
};

const containedPolicyPath = (root: string, candidate: string): string => {
  const normalized = candidate.replaceAll("\\", "/").trim();
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    normalized.startsWith("//") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new PolicyConfigValidationError(
      "policy path must be a repository-relative local file",
    );
  }

  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = realpathSync(root);
    realCandidate = realpathSync(resolve(realRoot, normalized));
  } catch {
    throw new PolicyConfigValidationError(
      `policy file does not exist: ${candidate}`,
    );
  }
  const relativePath = relative(realRoot, realCandidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  ) {
    throw new PolicyConfigValidationError(
      "policy path must stay inside the analyzed repository",
    );
  }
  if (!lstatSync(realCandidate).isFile()) {
    throw new PolicyConfigValidationError(
      `policy path is not a regular file: ${candidate}`,
    );
  }
  return realCandidate;
};

export const readPolicyConfig = (
  root: string,
  policyPath: string,
): PolicyConfig => {
  const inputPath = containedPolicyPath(root, policyPath);
  const metadata = lstatSync(inputPath);
  if (metadata.size > POLICY_CONFIG_MAX_BYTES) {
    throw new PolicyConfigValidationError(
      `policy file exceeds the ${POLICY_CONFIG_MAX_BYTES} byte limit`,
    );
  }
  const source = readFileSync(inputPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > POLICY_CONFIG_MAX_BYTES) {
    throw new PolicyConfigValidationError(
      `policy file exceeds the ${POLICY_CONFIG_MAX_BYTES} byte limit`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new PolicyConfigValidationError(
      `could not parse policy JSON: ${detail}`,
    );
  }
  return parsePolicyConfig(value);
};

export const serializePolicyConfig = (value: unknown): string =>
  stableStringify(parsePolicyConfig(value));
