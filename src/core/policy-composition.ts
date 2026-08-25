import { z } from "zod";

import { stableStringify } from "./canonical.js";
import {
  LocalPolicyPathSchema,
  PolicyConfigSchema,
  readPolicyConfig,
  type LocalPolicyRule,
  type PolicyConfig,
} from "./policy.js";

export const POLICY_COMPOSITION_SCHEMA_VERSION = 1 as const;
export const POLICY_COMPOSITION_CONTRACT =
  "cartograph.policy-composition" as const;
export const POLICY_COMPOSITION_MAX_DEPTH = 16 as const;
export const POLICY_COMPOSITION_MAX_FILES = 64 as const;
export const POLICY_COMPOSITION_MAX_RULES = 256 as const;
export const POLICY_COMPOSITION_MAX_OVERRIDES = 128 as const;

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const normalizePathReference = (value: string): string => {
  let parsed: string;
  try {
    parsed = LocalPolicyPathSchema.parse(value);
  } catch (error) {
    throw new PolicyCompositionError(
      "invalid-source",
      "policy path must be a repository-relative local file",
      [`policy-path:${String(value)}`],
      [],
      error,
    );
  }
  const normalized = parsed
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
  if (normalized.length === 0) {
    throw new PolicyCompositionError(
      "invalid-source",
      "policy path must name a repository-relative file",
      [`policy-path:${value}`],
      [],
    );
  }
  return normalized;
};

const policyFileEvidence = (path: string): string => `policy-file:${path}`;
const policyRuleEvidence = (id: string): string => `policy-rule:${id}`;
const scopeEvidence = (scope: string): string => `policy-scope:${scope}`;

export type PolicyCompositionErrorCode =
  | "invalid-source"
  | "include-cycle"
  | "duplicate-include"
  | "duplicate-rule-id"
  | "precedence-conflict"
  | "override-limit"
  | "contradictory-rules"
  | "file-limit"
  | "depth-limit"
  | "rule-limit";

export class PolicyCompositionError extends Error {
  readonly code: PolicyCompositionErrorCode;
  readonly evidenceRefs: readonly string[];
  readonly sourcePaths: readonly string[];

  constructor(
    code: PolicyCompositionErrorCode,
    message: string,
    evidenceRefs: readonly string[],
    sourcePaths: readonly string[],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PolicyCompositionError";
    this.code = code;
    this.evidenceRefs = uniqueSorted(evidenceRefs);
    this.sourcePaths = uniqueSorted(sourcePaths);
  }
}

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u);
const SemverSchema = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
const SourceSchema = z
  .object({
    path: LocalPolicyPathSchema,
    policyId: IdentifierSchema,
    version: SemverSchema,
    scope: IdentifierSchema,
    precedence: z.number().int().nonnegative().max(1_000),
    ruleCount: z.number().int().nonnegative().max(POLICY_COMPOSITION_MAX_RULES),
  })
  .strict();
const OverrideSchema = z
  .object({
    ruleId: IdentifierSchema,
    winnerPath: LocalPolicyPathSchema,
    loserPath: LocalPolicyPathSchema,
    winnerPrecedence: z.number().int().nonnegative().max(1_000),
    loserPrecedence: z.number().int().nonnegative().max(1_000),
  })
  .strict();

export const PolicyCompositionSchema = z
  .object({
    schemaVersion: z.literal(POLICY_COMPOSITION_SCHEMA_VERSION),
    contract: z.literal(POLICY_COMPOSITION_CONTRACT),
    rootPath: LocalPolicyPathSchema,
    policy: PolicyConfigSchema,
    sources: z.array(SourceSchema).min(1).max(POLICY_COMPOSITION_MAX_FILES),
    overrides: z.array(OverrideSchema).max(POLICY_COMPOSITION_MAX_OVERRIDES),
  })
  .strict();

export type PolicyCompositionSource = {
  path: string;
  policyId: string;
  version: string;
  scope: string;
  precedence: number;
  ruleCount: number;
};

export type PolicyCompositionOverride = {
  ruleId: string;
  winnerPath: string;
  loserPath: string;
  winnerPrecedence: number;
  loserPrecedence: number;
};

export type PolicyComposition = {
  schemaVersion: typeof POLICY_COMPOSITION_SCHEMA_VERSION;
  contract: typeof POLICY_COMPOSITION_CONTRACT;
  rootPath: string;
  policy: PolicyConfig;
  sources: PolicyCompositionSource[];
  overrides: PolicyCompositionOverride[];
};

type LoadedPolicy = {
  path: string;
  policy: PolicyConfig;
  depth: number;
};

type RuleEntry = {
  path: string;
  policy: PolicyConfig;
  rule: LocalPolicyRule;
};

type Bounds = { min: number; max: number };

const boundsFor = (rule: LocalPolicyRule): Bounds => {
  switch (rule.assertion) {
    case "exists":
      return { min: 1, max: Number.POSITIVE_INFINITY };
    case "absent":
      return { min: 0, max: 0 };
    case "count-at-most":
      return { min: 0, max: rule.value ?? 0 };
    case "count-at-least":
      return { min: rule.value ?? 0, max: Number.POSITIVE_INFINITY };
  }
};

const selectorKey = (entry: RuleEntry): string =>
  stableStringify({
    scope: entry.policy.scope,
    target: entry.rule.target,
    selector: entry.rule.selector,
  });

const loadPolicy = (repositoryRoot: string, path: string): PolicyConfig => {
  try {
    return readPolicyConfig(repositoryRoot, path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid policy";
    throw new PolicyCompositionError(
      "invalid-source",
      `could not load included policy ${path}: ${detail}`,
      [policyFileEvidence(path)],
      [path],
      error,
    );
  }
};

const conflictError = (
  code: PolicyCompositionErrorCode,
  message: string,
  entries: readonly RuleEntry[],
  extraEvidence: readonly string[] = [],
): PolicyCompositionError =>
  new PolicyCompositionError(
    code,
    message,
    [
      ...entries.flatMap((entry) => [
        policyFileEvidence(entry.path),
        policyRuleEvidence(entry.rule.id),
        scopeEvidence(entry.policy.scope),
      ]),
      ...extraEvidence,
    ],
    entries.map((entry) => entry.path),
  );

const assertLocalRuleIds = (loaded: LoadedPolicy): void => {
  const seen = new Map<string, LocalPolicyRule>();
  for (const rule of loaded.policy.rules) {
    const previous = seen.get(rule.id);
    if (previous === undefined) {
      seen.set(rule.id, rule);
      continue;
    }
    throw conflictError(
      "duplicate-rule-id",
      `policy ${loaded.path} declares duplicate rule ID ${rule.id}`,
      [
        { path: loaded.path, policy: loaded.policy, rule: previous },
        { path: loaded.path, policy: loaded.policy, rule },
      ],
    );
  }
};

const selectRules = (
  loaded: readonly LoadedPolicy[],
): {
  entries: RuleEntry[];
  overrides: PolicyCompositionOverride[];
} => {
  const entriesByRuleId = new Map<string, RuleEntry[]>();
  for (const source of loaded) {
    for (const rule of source.policy.rules) {
      const entries = entriesByRuleId.get(rule.id) ?? [];
      entries.push({ path: source.path, policy: source.policy, rule });
      entriesByRuleId.set(rule.id, entries);
    }
  }

  const selected: RuleEntry[] = [];
  const overrides: PolicyCompositionOverride[] = [];
  const overrideCounts = new Map<string, number>();
  for (const [ruleId, entries] of [...entriesByRuleId.entries()].sort(
    ([left], [right]) => compareStrings(left, right),
  )) {
    const sorted = [...entries].sort((left, right) => {
      const precedence = right.policy.precedence - left.policy.precedence;
      if (precedence !== 0) return precedence;
      return compareStrings(left.path, right.path);
    });
    const winner = sorted[0];
    if (winner === undefined) continue;
    const differing = sorted.filter(
      (entry) => stableStringify(entry.rule) !== stableStringify(winner.rule),
    );
    const highest = sorted.filter(
      (entry) => entry.policy.precedence === winner.policy.precedence,
    );
    if (
      differing.some(
        (entry) => entry.policy.precedence === winner.policy.precedence,
      )
    ) {
      throw conflictError(
        "precedence-conflict",
        `rule ID ${ruleId} has contradictory definitions at precedence ${winner.policy.precedence}`,
        highest,
        [`conflict:rule-id:${ruleId}`],
      );
    }
    if (differing.length > 0) {
      const used = overrideCounts.get(winner.path) ?? 0;
      const allowed = winner.policy.overrideLimit;
      if (used + differing.length > allowed) {
        throw conflictError(
          "override-limit",
          `rule ID ${ruleId} requires ${differing.length} override(s) from ${winner.path}, exceeding its override limit of ${allowed}`,
          [winner, ...differing],
          [`conflict:rule-id:${ruleId}`, `override-limit:${winner.path}`],
        );
      }
      overrideCounts.set(winner.path, used + differing.length);
      for (const loser of differing) {
        overrides.push({
          ruleId,
          winnerPath: winner.path,
          loserPath: loser.path,
          winnerPrecedence: winner.policy.precedence,
          loserPrecedence: loser.policy.precedence,
        });
      }
    }
    selected.push(winner);
  }

  return {
    entries: selected,
    overrides: overrides.sort((left, right) => {
      const rule = compareStrings(left.ruleId, right.ruleId);
      if (rule !== 0) return rule;
      const winner = compareStrings(left.winnerPath, right.winnerPath);
      if (winner !== 0) return winner;
      return compareStrings(left.loserPath, right.loserPath);
    }),
  };
};

const assertNoContradictions = (entries: readonly RuleEntry[]): void => {
  const groups = new Map<string, RuleEntry[]>();
  for (const entry of entries) {
    const group = groups.get(selectorKey(entry)) ?? [];
    group.push(entry);
    groups.set(selectorKey(entry), group);
  }
  for (const group of groups.values()) {
    for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
      const left = group[leftIndex];
      if (left === undefined) continue;
      const leftBounds = boundsFor(left.rule);
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < group.length;
        rightIndex += 1
      ) {
        const right = group[rightIndex];
        if (right === undefined) continue;
        const rightBounds = boundsFor(right.rule);
        if (
          leftBounds.min > rightBounds.max ||
          rightBounds.min > leftBounds.max
        ) {
          throw conflictError(
            "contradictory-rules",
            `rules ${left.rule.id} and ${right.rule.id} require contradictory outcomes for the same ${left.policy.scope} ${left.rule.target} selector`,
            [left, right],
            [
              `conflict:selector:${stableStringify({ target: left.rule.target, selector: left.rule.selector })}`,
            ],
          );
        }
      }
    }
  }
};

export const composePolicyConfig = (
  repositoryRoot: string,
  policyPath: string,
): PolicyComposition => {
  const rootPath = normalizePathReference(policyPath);
  const loadedByPath = new Map<string, LoadedPolicy>();
  const stack: string[] = [];

  const visit = (path: string, depth: number): void => {
    const normalizedPath = normalizePathReference(path);
    if (stack.includes(normalizedPath)) {
      const cycleStart = stack.indexOf(normalizedPath);
      const cycle = [...stack.slice(cycleStart), normalizedPath];
      throw new PolicyCompositionError(
        "include-cycle",
        `policy include cycle detected: ${cycle.join(" -> ")}`,
        [...cycle.map(policyFileEvidence), `include-cycle:${cycle.join("->")}`],
        cycle,
      );
    }
    if (depth > POLICY_COMPOSITION_MAX_DEPTH) {
      throw new PolicyCompositionError(
        "depth-limit",
        `policy include depth exceeds ${POLICY_COMPOSITION_MAX_DEPTH}`,
        [policyFileEvidence(normalizedPath), "composition-limit:depth"],
        [normalizedPath],
      );
    }
    if (loadedByPath.has(normalizedPath)) return;
    if (loadedByPath.size >= POLICY_COMPOSITION_MAX_FILES) {
      throw new PolicyCompositionError(
        "file-limit",
        `policy composition exceeds the ${POLICY_COMPOSITION_MAX_FILES} file limit`,
        [policyFileEvidence(normalizedPath), "composition-limit:files"],
        [normalizedPath],
      );
    }

    stack.push(normalizedPath);
    const policy = loadPolicy(repositoryRoot, normalizedPath);
    const loaded = {
      path: normalizedPath,
      policy,
      depth,
    } satisfies LoadedPolicy;
    assertLocalRuleIds(loaded);
    loadedByPath.set(normalizedPath, loaded);
    if (loadedByPath.size > POLICY_COMPOSITION_MAX_FILES) {
      throw new PolicyCompositionError(
        "file-limit",
        `policy composition exceeds the ${POLICY_COMPOSITION_MAX_FILES} file limit`,
        [policyFileEvidence(normalizedPath), "composition-limit:files"],
        [normalizedPath],
      );
    }
    const includes = loaded.policy.includes.map((include) =>
      normalizePathReference(include.path),
    );
    if (new Set(includes).size !== includes.length) {
      throw new PolicyCompositionError(
        "duplicate-include",
        `policy ${normalizedPath} declares a duplicate include`,
        [policyFileEvidence(normalizedPath), "conflict:duplicate-include"],
        [normalizedPath],
      );
    }
    for (const include of includes.sort(compareStrings))
      visit(include, depth + 1);
    stack.pop();
  };

  visit(rootPath, 0);
  const loaded = [...loadedByPath.values()].sort((left, right) =>
    compareStrings(left.path, right.path),
  );
  const totalRules = loaded.reduce(
    (total, source) => total + source.policy.rules.length,
    0,
  );
  if (totalRules > POLICY_COMPOSITION_MAX_RULES) {
    throw new PolicyCompositionError(
      "rule-limit",
      `policy composition contains ${totalRules} rules, exceeding the ${POLICY_COMPOSITION_MAX_RULES} rule limit`,
      [
        "composition-limit:rules",
        ...loaded.map((source) => policyFileEvidence(source.path)),
      ],
      loaded.map((source) => source.path),
    );
  }
  const { entries, overrides } = selectRules(loaded);
  if (overrides.length > POLICY_COMPOSITION_MAX_OVERRIDES) {
    throw new PolicyCompositionError(
      "override-limit",
      `policy composition contains ${overrides.length} overrides, exceeding the ${POLICY_COMPOSITION_MAX_OVERRIDES} override limit`,
      [
        "composition-limit:overrides",
        ...overrides.flatMap((override) => [
          policyFileEvidence(override.winnerPath),
          policyFileEvidence(override.loserPath),
          policyRuleEvidence(override.ruleId),
        ]),
      ],
      overrides.flatMap((override) => [
        override.winnerPath,
        override.loserPath,
      ]),
    );
  }
  assertNoContradictions(entries);
  const root = loadedByPath.get(rootPath);
  if (root === undefined) {
    throw new PolicyCompositionError(
      "invalid-source",
      `root policy was not loaded: ${rootPath}`,
      [policyFileEvidence(rootPath)],
      [rootPath],
    );
  }
  const policy = PolicyConfigSchema.parse({
    ...root.policy,
    includes: [],
    rules: entries
      .map((entry) => entry.rule)
      .sort((left, right) => compareStrings(left.id, right.id)),
  });
  const sources: PolicyCompositionSource[] = loaded.map((source) => ({
    path: source.path,
    policyId: source.policy.policyId,
    version: source.policy.version,
    scope: source.policy.scope,
    precedence: source.policy.precedence,
    ruleCount: source.policy.rules.length,
  }));
  return PolicyCompositionSchema.parse({
    schemaVersion: POLICY_COMPOSITION_SCHEMA_VERSION,
    contract: POLICY_COMPOSITION_CONTRACT,
    rootPath,
    policy,
    sources,
    overrides,
  });
};

export const serializePolicyComposition = (value: unknown): string =>
  stableStringify(PolicyCompositionSchema.parse(value));
