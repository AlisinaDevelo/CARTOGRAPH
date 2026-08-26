import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { z, type ZodIssue } from "zod";

import { stableStringify } from "./canonical.js";

export const WORKSPACE_RECOMPOSITION_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_RECOMPOSITION_CONTRACT =
  "cartograph.workspace-recomposition" as const;

export const WORKSPACE_RECOMPOSITION_MAX_INPUTS = 4_096 as const;
export const WORKSPACE_RECOMPOSITION_MAX_UNITS = 4_096 as const;
export const WORKSPACE_RECOMPOSITION_MAX_DEPENDENCIES = 8_192 as const;
export const WORKSPACE_RECOMPOSITION_MAX_CACHE_ENTRIES = 4_096 as const;
export const WORKSPACE_RECOMPOSITION_MAX_RESULT_BYTES = 16 * 1024 * 1024;
export const WORKSPACE_RECOMPOSITION_MAX_CACHE_BYTES = 256 * 1024 * 1024;
export const WORKSPACE_RECOMPOSITION_MAX_TEMP_ENTRIES = 64 as const;

const DigestSchema = z
  .string()
  .trim()
  .regex(/^sha256:[0-9a-f]{64}$/u, "must be a lower-case SHA-256 digest");

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(
    /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u,
    "must be a portable lower-case identifier",
  )
  .transform((value) => value.normalize("NFC"));

const VersionTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.includes("\r") &&
      !value.includes("\n") &&
      !/\s/u.test(value),
    "must not contain whitespace or control characters",
  )
  .transform((value) => value.normalize("NFC"));

const ComponentKindSchema = z.enum([
  "content",
  "contract",
  "adapter",
  "policy",
  "workspace",
  "tool",
]);

export type WorkspaceRecompositionComponentKind = z.infer<
  typeof ComponentKindSchema
>;

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const digestText = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const digestValue = (value: unknown): `sha256:${string}` =>
  digestText(stableStringify(value));

const issueText = (issues: readonly ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "request";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

export const WorkspaceRecompositionLimitsSchema = z
  .object({
    maxInputs: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_RECOMPOSITION_MAX_INPUTS),
    maxUnits: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_RECOMPOSITION_MAX_UNITS),
    maxDependencies: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_RECOMPOSITION_MAX_DEPENDENCIES),
    maxCacheEntries: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_RECOMPOSITION_MAX_CACHE_ENTRIES),
    maxResultBytes: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_RECOMPOSITION_MAX_RESULT_BYTES),
  })
  .strict();

export type WorkspaceRecompositionLimits = z.infer<
  typeof WorkspaceRecompositionLimitsSchema
>;

export const DEFAULT_WORKSPACE_RECOMPOSITION_LIMITS: WorkspaceRecompositionLimits =
  {
    maxInputs: WORKSPACE_RECOMPOSITION_MAX_INPUTS,
    maxUnits: WORKSPACE_RECOMPOSITION_MAX_UNITS,
    maxDependencies: WORKSPACE_RECOMPOSITION_MAX_DEPENDENCIES,
    maxCacheEntries: WORKSPACE_RECOMPOSITION_MAX_CACHE_ENTRIES,
    maxResultBytes: WORKSPACE_RECOMPOSITION_MAX_RESULT_BYTES,
  };

export const WorkspaceRecompositionInputSchema = z
  .object({
    id: IdentifierSchema,
    kind: ComponentKindSchema,
    digest: DigestSchema,
    version: VersionTokenSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.kind !== "content" && input.version === undefined) {
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: `${input.kind} inputs require an explicit version token`,
      });
    }
  });

export type WorkspaceRecompositionInput = z.infer<
  typeof WorkspaceRecompositionInputSchema
>;

const KeyComponentSchema = z
  .object({
    id: IdentifierSchema,
    digest: DigestSchema,
    version: VersionTokenSchema.optional(),
  })
  .strict();

export type WorkspaceRecompositionKeyComponent = z.infer<
  typeof KeyComponentSchema
>;

const KeyComponentArraySchema = z
  .array(KeyComponentSchema)
  .max(WORKSPACE_RECOMPOSITION_MAX_INPUTS);

export const WorkspaceRecompositionCacheKeySchema = z
  .object({
    content: KeyComponentArraySchema,
    contract: KeyComponentArraySchema,
    adapter: KeyComponentArraySchema,
    policy: KeyComponentArraySchema,
    workspace: KeyComponentArraySchema,
    tool: KeyComponentArraySchema,
    keyDigest: DigestSchema,
  })
  .strict();

export type WorkspaceRecompositionCacheKey = z.infer<
  typeof WorkspaceRecompositionCacheKeySchema
>;

const RecompositionUnitInputSchema = z
  .array(IdentifierSchema)
  .min(1)
  .max(WORKSPACE_RECOMPOSITION_MAX_INPUTS);

export const WorkspaceRecompositionUnitSchema = z
  .object({
    id: IdentifierSchema,
    inputIds: RecompositionUnitInputSchema,
    dependsOn: z
      .array(IdentifierSchema)
      .max(WORKSPACE_RECOMPOSITION_MAX_UNITS)
      .default([]),
    result: z.unknown().optional(),
  })
  .strict();

export type WorkspaceRecompositionUnit = z.infer<
  typeof WorkspaceRecompositionUnitSchema
>;

const CacheInputStateSchema = KeyComponentSchema;

export const WorkspaceRecompositionCacheEntrySchema = z
  .object({
    id: IdentifierSchema,
    key: WorkspaceRecompositionCacheKeySchema,
    inputState: z
      .array(CacheInputStateSchema)
      .min(1)
      .max(WORKSPACE_RECOMPOSITION_MAX_INPUTS),
    dependsOn: z
      .array(IdentifierSchema)
      .max(WORKSPACE_RECOMPOSITION_MAX_UNITS)
      .default([]),
    result: z.unknown(),
    resultDigest: DigestSchema,
  })
  .strict();

export type WorkspaceRecompositionCacheEntry = z.infer<
  typeof WorkspaceRecompositionCacheEntrySchema
>;

export const WorkspaceRecompositionCacheSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_RECOMPOSITION_SCHEMA_VERSION),
    contract: z.literal(WORKSPACE_RECOMPOSITION_CONTRACT),
    workspaceId: IdentifierSchema,
    entries: z
      .array(WorkspaceRecompositionCacheEntrySchema)
      .max(WORKSPACE_RECOMPOSITION_MAX_CACHE_ENTRIES),
  })
  .strict();

export type WorkspaceRecompositionCache = z.infer<
  typeof WorkspaceRecompositionCacheSchema
>;

export const WorkspaceRecompositionRequestSchema = z
  .object({
    $schema: z.string().trim().max(512).optional(),
    schemaVersion: z.literal(WORKSPACE_RECOMPOSITION_SCHEMA_VERSION),
    contract: z.literal(WORKSPACE_RECOMPOSITION_CONTRACT),
    workspaceId: IdentifierSchema,
    inputs: z
      .array(WorkspaceRecompositionInputSchema)
      .min(1)
      .max(WORKSPACE_RECOMPOSITION_MAX_INPUTS),
    units: z
      .array(WorkspaceRecompositionUnitSchema)
      .min(1)
      .max(WORKSPACE_RECOMPOSITION_MAX_UNITS),
    limits: WorkspaceRecompositionLimitsSchema,
  })
  .strict();

export type WorkspaceRecompositionRequest = z.infer<
  typeof WorkspaceRecompositionRequestSchema
>;

export const WorkspaceRecompositionUnitStatusSchema = z.enum([
  "hit",
  "miss",
  "invalidated",
  "recomputed",
]);

export type WorkspaceRecompositionUnitStatus = z.infer<
  typeof WorkspaceRecompositionUnitStatusSchema
>;

export const WorkspaceRecompositionPlanUnitSchema = z
  .object({
    id: IdentifierSchema,
    inputIds: RecompositionUnitInputSchema,
    dependsOn: z.array(IdentifierSchema),
    status: WorkspaceRecompositionUnitStatusSchema,
    reason: z.enum([
      "cache-hit",
      "cache-miss",
      "input-changed",
      "dependency-changed",
      "computed",
    ]),
    key: WorkspaceRecompositionCacheKeySchema,
    result: z.unknown().optional(),
    resultDigest: DigestSchema.optional(),
  })
  .strict()
  .superRefine((unit, context) => {
    if (unit.status === "hit" && unit.result === undefined) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "cache hits must carry the reusable result",
      });
    }
    if (
      (unit.status === "hit" || unit.status === "recomputed") &&
      unit.resultDigest === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["resultDigest"],
        message: `${unit.status} units must carry a result digest`,
      });
    }
  });

export type WorkspaceRecompositionPlanUnit = z.infer<
  typeof WorkspaceRecompositionPlanUnitSchema
>;

export const WorkspaceRecompositionPlanSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_RECOMPOSITION_SCHEMA_VERSION),
    contract: z.literal(WORKSPACE_RECOMPOSITION_CONTRACT),
    workspaceId: IdentifierSchema,
    changedInputIds: z.array(IdentifierSchema),
    units: z.array(WorkspaceRecompositionPlanUnitSchema),
    cache: WorkspaceRecompositionCacheSchema,
    stats: z
      .object({
        hits: z.number().int().nonnegative(),
        misses: z.number().int().nonnegative(),
        invalidated: z.number().int().nonnegative(),
        recomputed: z.number().int().nonnegative(),
      })
      .strict(),
    resultDigest: DigestSchema,
  })
  .strict();

export type WorkspaceRecompositionPlan = z.infer<
  typeof WorkspaceRecompositionPlanSchema
>;

export type WorkspaceRecompositionErrorCode =
  | "invalid-request"
  | "invalid-cache"
  | "cache-missing"
  | "cache-too-large"
  | "cache-path"
  | "cache-corrupt"
  | "resource-limit"
  | "dependency-cycle"
  | "cache-mismatch";

export class WorkspaceRecompositionValidationError extends Error {
  readonly code: WorkspaceRecompositionErrorCode;
  readonly issues: readonly ZodIssue[];

  constructor(
    code: WorkspaceRecompositionErrorCode,
    message: string,
    issues: readonly ZodIssue[] = [],
  ) {
    super(message);
    this.name = "WorkspaceRecompositionValidationError";
    this.code = code;
    this.issues = issues;
  }
}

export class WorkspaceRecompositionCacheError extends Error {
  readonly code: WorkspaceRecompositionErrorCode;

  constructor(code: WorkspaceRecompositionErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceRecompositionCacheError";
    this.code = code;
  }
}

const keyPayload = (
  key: Omit<WorkspaceRecompositionCacheKey, "keyDigest">,
): Omit<WorkspaceRecompositionCacheKey, "keyDigest"> => ({
  content: key.content,
  contract: key.contract,
  adapter: key.adapter,
  policy: key.policy,
  workspace: key.workspace,
  tool: key.tool,
});

const sortComponents = (
  components: readonly WorkspaceRecompositionKeyComponent[],
): WorkspaceRecompositionKeyComponent[] =>
  [...components].sort((left, right) => compareStrings(left.id, right.id));

const canonicalKey = (
  input: Omit<WorkspaceRecompositionCacheKey, "keyDigest">,
): WorkspaceRecompositionCacheKey => {
  const payload = keyPayload({
    content: sortComponents(input.content),
    contract: sortComponents(input.contract),
    adapter: sortComponents(input.adapter),
    policy: sortComponents(input.policy),
    workspace: sortComponents(input.workspace),
    tool: sortComponents(input.tool),
  });
  return { ...payload, keyDigest: digestValue(payload) };
};

const componentById = (
  inputs: readonly WorkspaceRecompositionInput[],
): Map<string, WorkspaceRecompositionInput> => {
  const result = new Map<string, WorkspaceRecompositionInput>();
  for (const input of inputs) {
    if (result.has(input.id)) {
      throw new WorkspaceRecompositionValidationError(
        "invalid-request",
        `duplicate recomposition input identity: ${input.id}`,
      );
    }
    result.set(input.id, input);
  }
  return result;
};

const keyForInputs = (
  inputs: readonly WorkspaceRecompositionInput[],
  selectedIds?: readonly string[],
): WorkspaceRecompositionCacheKey => {
  const byId = componentById(inputs);
  const ids = selectedIds
    ? [...new Set(selectedIds)].sort(compareStrings)
    : [...byId.keys()].sort(compareStrings);
  const components: Record<
    WorkspaceRecompositionComponentKind,
    WorkspaceRecompositionKeyComponent[]
  > = {
    content: [],
    contract: [],
    adapter: [],
    policy: [],
    workspace: [],
    tool: [],
  };
  for (const id of ids) {
    const input = byId.get(id);
    if (!input) {
      throw new WorkspaceRecompositionValidationError(
        "invalid-request",
        `recomposition unit refers to unknown input: ${id}`,
      );
    }
    components[input.kind].push({
      id: input.id,
      digest: input.digest,
      ...(input.version ? { version: input.version } : {}),
    });
  }
  return canonicalKey(components);
};

/** Build a canonical key. Pass selected IDs for a unit-scoped key. */
export const createWorkspaceRecompositionKey = (
  inputs: readonly WorkspaceRecompositionInput[],
  selectedIds?: readonly string[],
): WorkspaceRecompositionCacheKey => {
  const parsed = inputs.map((input) =>
    WorkspaceRecompositionInputSchema.parse(input),
  );
  return keyForInputs(parsed, selectedIds);
};

export const buildWorkspaceRecompositionKey = createWorkspaceRecompositionKey;
export const workspaceCacheKey = createWorkspaceRecompositionKey;

const flattenKey = (
  key: WorkspaceRecompositionCacheKey,
): WorkspaceRecompositionKeyComponent[] =>
  [
    ...key.content,
    ...key.contract,
    ...key.adapter,
    ...key.policy,
    ...key.workspace,
    ...key.tool,
  ].sort((left, right) => compareStrings(left.id, right.id));

const keyEqual = (
  left: WorkspaceRecompositionCacheKey,
  right: WorkspaceRecompositionCacheKey,
): boolean => left.keyDigest === right.keyDigest;

const changedComponents = (
  previous: WorkspaceRecompositionCacheKey,
  current: WorkspaceRecompositionCacheKey,
): string[] => {
  const before = new Map(flattenKey(previous).map((item) => [item.id, item]));
  const after = new Map(flattenKey(current).map((item) => [item.id, item]));
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids]
    .filter(
      (id) =>
        stableStringify(before.get(id)) !== stableStringify(after.get(id)),
    )
    .sort(compareStrings);
};

const validateResultSize = (
  value: unknown,
  maxBytes: number,
  label: string,
): string => {
  let serialized: string;
  try {
    serialized = stableStringify(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new WorkspaceRecompositionValidationError(
      "invalid-request",
      `${label} is not canonically serializable: ${detail}`,
    );
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxBytes) {
    throw new WorkspaceRecompositionValidationError(
      "resource-limit",
      `${label} is ${bytes} bytes but the limit is ${maxBytes}`,
    );
  }
  return serialized;
};

const cycleForUnits = (
  units: readonly WorkspaceRecompositionUnit[],
): string[] | undefined => {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (visiting.has(id)) {
      const index = stack.indexOf(id);
      return [...stack.slice(index), id];
    }
    if (visited.has(id)) return undefined;
    const unit = byId.get(id);
    if (!unit) return undefined;
    visiting.add(id);
    stack.push(id);
    for (const dependency of unit.dependsOn) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };
  for (const unit of units) {
    const cycle = visit(unit.id);
    if (cycle) return cycle;
  }
  return undefined;
};

const canonicalizeRequest = (
  request: WorkspaceRecompositionRequest,
): WorkspaceRecompositionRequest => ({
  ...request,
  inputs: [...request.inputs].sort((left, right) =>
    compareStrings(left.id, right.id),
  ),
  units: [...request.units]
    .map((unit) => ({
      ...unit,
      inputIds: [...unit.inputIds].sort(compareStrings),
      dependsOn: [...unit.dependsOn].sort(compareStrings),
    }))
    .sort((left, right) => compareStrings(left.id, right.id)),
});

export const parseWorkspaceRecompositionRequest = (
  value: unknown,
): WorkspaceRecompositionRequest => {
  const parsed = WorkspaceRecompositionRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkspaceRecompositionValidationError(
      "invalid-request",
      `workspace recomposition request validation failed: ${issueText(parsed.error.issues)}`,
      parsed.error.issues,
    );
  }
  const request = canonicalizeRequest(parsed.data);
  const limits = request.limits;
  if (request.inputs.length > limits.maxInputs) {
    throw new WorkspaceRecompositionValidationError(
      "resource-limit",
      `request declares ${request.inputs.length} inputs but the limit is ${limits.maxInputs}`,
    );
  }
  if (request.units.length > limits.maxUnits) {
    throw new WorkspaceRecompositionValidationError(
      "resource-limit",
      `request declares ${request.units.length} units but the limit is ${limits.maxUnits}`,
    );
  }
  const inputs = componentById(request.inputs);
  const units = new Map<string, WorkspaceRecompositionUnit>();
  let dependencyCount = 0;
  for (const [index, unit] of request.units.entries()) {
    if (units.has(unit.id)) {
      throw new WorkspaceRecompositionValidationError(
        "invalid-request",
        `duplicate recomposition unit identity: ${unit.id}`,
      );
    }
    units.set(unit.id, unit);
    const distinctInputs = new Set(unit.inputIds);
    if (distinctInputs.size !== unit.inputIds.length) {
      throw new WorkspaceRecompositionValidationError(
        "invalid-request",
        `unit ${unit.id} contains duplicate input dependencies`,
      );
    }
    for (const inputId of unit.inputIds) {
      if (!inputs.has(inputId)) {
        throw new WorkspaceRecompositionValidationError(
          "invalid-request",
          `unit ${unit.id} refers to unknown input: ${inputId}`,
        );
      }
    }
    const distinctDependencies = new Set(unit.dependsOn);
    if (distinctDependencies.size !== unit.dependsOn.length) {
      throw new WorkspaceRecompositionValidationError(
        "invalid-request",
        `unit ${unit.id} contains duplicate unit dependencies`,
      );
    }
    if (distinctDependencies.has(unit.id)) {
      throw new WorkspaceRecompositionValidationError(
        "dependency-cycle",
        `unit ${unit.id} depends on itself`,
      );
    }
    dependencyCount += unit.inputIds.length + unit.dependsOn.length;
    if (dependencyCount > limits.maxDependencies) {
      throw new WorkspaceRecompositionValidationError(
        "resource-limit",
        `workspace recomposition declares more than ${limits.maxDependencies} dependencies`,
      );
    }
    if (unit.result !== undefined)
      validateResultSize(
        unit.result,
        limits.maxResultBytes,
        `unit ${unit.id} result`,
      );
    void index;
  }
  for (const unit of request.units) {
    for (const dependency of unit.dependsOn) {
      if (!units.has(dependency)) {
        throw new WorkspaceRecompositionValidationError(
          "invalid-request",
          `unit ${unit.id} refers to unknown unit dependency: ${dependency}`,
        );
      }
    }
  }
  const cycle = cycleForUnits(request.units);
  if (cycle) {
    throw new WorkspaceRecompositionValidationError(
      "dependency-cycle",
      `workspace recomposition unit dependency cycle: ${cycle.join(" -> ")}`,
    );
  }
  return request;
};

const canonicalizeCacheEntry = (
  entry: WorkspaceRecompositionCacheEntry,
): WorkspaceRecompositionCacheEntry => {
  const key = canonicalKey(keyPayload(entry.key));
  if (key.keyDigest !== entry.key.keyDigest) {
    throw new WorkspaceRecompositionValidationError(
      "invalid-cache",
      `cache entry ${entry.id} has a forged key digest`,
    );
  }
  const expectedInputState = flattenKey(key);
  const actualInputState = [...entry.inputState].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
  if (
    stableStringify(expectedInputState) !== stableStringify(actualInputState)
  ) {
    throw new WorkspaceRecompositionValidationError(
      "invalid-cache",
      `cache entry ${entry.id} input state does not match its key`,
    );
  }
  if (entry.result === undefined) {
    throw new WorkspaceRecompositionValidationError(
      "invalid-cache",
      `cache entry ${entry.id} is missing a reusable result`,
    );
  }
  const serialized = validateResultSize(
    entry.result,
    WORKSPACE_RECOMPOSITION_MAX_RESULT_BYTES,
    `cache entry ${entry.id} result`,
  );
  const resultDigest = digestText(serialized);
  if (resultDigest !== entry.resultDigest) {
    throw new WorkspaceRecompositionValidationError(
      "invalid-cache",
      `cache entry ${entry.id} result digest does not match its result`,
    );
  }
  return {
    ...entry,
    key,
    inputState: [...entry.inputState].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
    dependsOn: [...entry.dependsOn].sort(compareStrings),
  };
};

export const parseWorkspaceRecompositionCache = (
  value: unknown,
): WorkspaceRecompositionCache => {
  const parsed = WorkspaceRecompositionCacheSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkspaceRecompositionValidationError(
      "invalid-cache",
      `workspace recomposition cache validation failed: ${issueText(parsed.error.issues)}`,
      parsed.error.issues,
    );
  }
  const ids = new Set<string>();
  const entries = parsed.data.entries.map((entry) => {
    if (ids.has(entry.id)) {
      throw new WorkspaceRecompositionValidationError(
        "invalid-cache",
        `duplicate cache entry identity: ${entry.id}`,
      );
    }
    ids.add(entry.id);
    return canonicalizeCacheEntry(entry);
  });
  return {
    ...parsed.data,
    entries: entries.sort((left, right) => compareStrings(left.id, right.id)),
  };
};

export const serializeWorkspaceRecompositionCache = (value: unknown): string =>
  stableStringify(parseWorkspaceRecompositionCache(value));

export const parseWorkspaceRecompositionKey = (
  value: unknown,
): WorkspaceRecompositionCacheKey => {
  const parsed = WorkspaceRecompositionCacheKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkspaceRecompositionValidationError(
      "invalid-request",
      `workspace recomposition key validation failed: ${issueText(parsed.error.issues)}`,
      parsed.error.issues,
    );
  }
  const key = canonicalKey(keyPayload(parsed.data));
  if (key.keyDigest !== parsed.data.keyDigest) {
    throw new WorkspaceRecompositionValidationError(
      "invalid-request",
      "workspace recomposition key digest does not match its components",
    );
  }
  return key;
};

const makeCacheEntry = (
  unit: WorkspaceRecompositionUnit,
  key: WorkspaceRecompositionCacheKey,
  inputs: readonly WorkspaceRecompositionInput[],
): WorkspaceRecompositionCacheEntry => {
  if (unit.result === undefined) {
    throw new WorkspaceRecompositionValidationError(
      "invalid-request",
      `unit ${unit.id} cannot be cached without a recomputed result`,
    );
  }
  const serialized = validateResultSize(
    unit.result,
    WORKSPACE_RECOMPOSITION_MAX_RESULT_BYTES,
    `unit ${unit.id} result`,
  );
  const selected = new Set(unit.inputIds);
  const inputState = inputs
    .filter((input) => selected.has(input.id))
    .map((input) => ({
      id: input.id,
      digest: input.digest,
      ...(input.version ? { version: input.version } : {}),
    }))
    .sort((left, right) => compareStrings(left.id, right.id));
  return {
    id: unit.id,
    key,
    inputState,
    dependsOn: [...unit.dependsOn].sort(compareStrings),
    result: unit.result,
    resultDigest: digestText(serialized),
  };
};

const cacheEntryFor = (
  cache: WorkspaceRecompositionCache | undefined,
  id: string,
): WorkspaceRecompositionCacheEntry | undefined =>
  cache?.entries.find((entry) => entry.id === id);

const planDigestPayload = (
  plan: Omit<WorkspaceRecompositionPlan, "resultDigest">,
): Omit<WorkspaceRecompositionPlan, "resultDigest"> => plan;

/**
 * Plan and, when supplied, materialize an incremental workspace recomposition.
 * A cache entry is reusable only when its unit-scoped input key is unchanged
 * and every declared unit dependency was reusable. No name-only or global
 * invalidation is performed.
 */
export const recomposeWorkspace = (
  value: unknown,
  previousCacheValue?: unknown,
): WorkspaceRecompositionPlan => {
  const request = parseWorkspaceRecompositionRequest(value);
  let previousCache: WorkspaceRecompositionCache | undefined;
  if (previousCacheValue !== undefined) {
    previousCache = parseWorkspaceRecompositionCache(previousCacheValue);
    if (previousCache.workspaceId !== request.workspaceId) {
      throw new WorkspaceRecompositionValidationError(
        "cache-mismatch",
        `cache belongs to workspace ${previousCache.workspaceId}, request belongs to ${request.workspaceId}`,
      );
    }
  }

  const unitById = new Map(request.units.map((unit) => [unit.id, unit]));
  const state = new Map<string, WorkspaceRecompositionPlanUnit>();
  const active = new Set<string>();
  const changedInputIds = new Set<string>();
  const cacheEntries: WorkspaceRecompositionCacheEntry[] = [];

  const visit = (unitId: string): WorkspaceRecompositionPlanUnit => {
    const existing = state.get(unitId);
    if (existing) return existing;
    if (active.has(unitId)) {
      throw new WorkspaceRecompositionValidationError(
        "dependency-cycle",
        `workspace recomposition dependency cycle includes ${unitId}`,
      );
    }
    const unit = unitById.get(unitId);
    if (!unit) {
      throw new WorkspaceRecompositionValidationError(
        "invalid-request",
        `unknown unit dependency: ${unitId}`,
      );
    }
    active.add(unitId);
    const dependencies = unit.dependsOn.map(visit);
    active.delete(unitId);

    const key = keyForInputs(request.inputs, unit.inputIds);
    const previous = cacheEntryFor(previousCache, unit.id);
    const directChanged = previous ? changedComponents(previous.key, key) : [];
    for (const inputId of directChanged) changedInputIds.add(inputId);
    const dependencyTopologyChanged = previous
      ? stableStringify([...previous.dependsOn].sort(compareStrings)) !==
        stableStringify([...unit.dependsOn].sort(compareStrings))
      : false;
    const dependencyChanged =
      dependencyTopologyChanged ||
      dependencies.some((dependency) => dependency.status !== "hit");

    if (previous && keyEqual(previous.key, key) && !dependencyChanged) {
      const hit: WorkspaceRecompositionPlanUnit = {
        id: unit.id,
        inputIds: [...unit.inputIds].sort(compareStrings),
        dependsOn: [...unit.dependsOn].sort(compareStrings),
        status: "hit",
        reason: "cache-hit",
        key,
        result: previous.result,
        resultDigest: previous.resultDigest,
      };
      state.set(unitId, hit);
      cacheEntries.push(previous);
      return hit;
    }

    const reason =
      dependencyChanged || (previous && directChanged.length === 0)
        ? "dependency-changed"
        : previous
          ? "input-changed"
          : "cache-miss";
    if (unit.result !== undefined) {
      const entry = makeCacheEntry(unit, key, request.inputs);
      const recomputed: WorkspaceRecompositionPlanUnit = {
        id: unit.id,
        inputIds: [...unit.inputIds].sort(compareStrings),
        dependsOn: [...unit.dependsOn].sort(compareStrings),
        status: "recomputed",
        reason: "computed",
        key,
        result: unit.result,
        resultDigest: entry.resultDigest,
      };
      state.set(unitId, recomputed);
      cacheEntries.push(entry);
      return recomputed;
    }
    const invalidated: WorkspaceRecompositionPlanUnit = {
      id: unit.id,
      inputIds: [...unit.inputIds].sort(compareStrings),
      dependsOn: [...unit.dependsOn].sort(compareStrings),
      status: previous ? "invalidated" : "miss",
      reason,
      key,
    };
    state.set(unitId, invalidated);
    return invalidated;
  };

  for (const unit of request.units) visit(unit.id);
  const units = [...state.values()].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
  const uniqueCacheEntries = new Map(
    cacheEntries.map((entry) => [entry.id, entry]),
  );
  const cache: WorkspaceRecompositionCache = {
    schemaVersion: WORKSPACE_RECOMPOSITION_SCHEMA_VERSION,
    contract: WORKSPACE_RECOMPOSITION_CONTRACT,
    workspaceId: request.workspaceId,
    entries: [...uniqueCacheEntries.values()].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
  };
  if (cache.entries.length > request.limits.maxCacheEntries) {
    throw new WorkspaceRecompositionValidationError(
      "resource-limit",
      `recomposition cache has ${cache.entries.length} entries but the limit is ${request.limits.maxCacheEntries}`,
    );
  }
  const stats = {
    hits: units.filter((unit) => unit.status === "hit").length,
    misses: units.filter((unit) => unit.status === "miss").length,
    invalidated: units.filter((unit) => unit.status === "invalidated").length,
    recomputed: units.filter((unit) => unit.status === "recomputed").length,
  };
  const withoutDigest = {
    schemaVersion: WORKSPACE_RECOMPOSITION_SCHEMA_VERSION,
    contract: WORKSPACE_RECOMPOSITION_CONTRACT,
    workspaceId: request.workspaceId,
    changedInputIds: [...changedInputIds].sort(compareStrings),
    units,
    cache,
    stats,
  } satisfies Omit<WorkspaceRecompositionPlan, "resultDigest">;
  const plan: WorkspaceRecompositionPlan = {
    ...withoutDigest,
    resultDigest: digestValue(planDigestPayload(withoutDigest)),
  };
  const validated = WorkspaceRecompositionPlanSchema.safeParse(plan);
  if (!validated.success) {
    throw new WorkspaceRecompositionValidationError(
      "invalid-request",
      `workspace recomposition plan validation failed: ${issueText(validated.error.issues)}`,
      validated.error.issues,
    );
  }
  // Ensure a result digest cannot be forged by a caller-provided cache.
  for (const unit of validated.data.units) {
    if (
      (unit.status === "hit" || unit.status === "recomputed") &&
      unit.resultDigest !== digestValue(unit.result)
    ) {
      throw new WorkspaceRecompositionValidationError(
        "invalid-cache",
        `unit ${unit.id} result digest does not match its reusable result`,
      );
    }
  }
  return {
    ...validated.data,
    units: [...validated.data.units].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
  };
};

export const planWorkspaceRecomposition = recomposeWorkspace;
export const recompositionPlan = recomposeWorkspace;

export const parseWorkspaceRecompositionPlan = (
  value: unknown,
): WorkspaceRecompositionPlan => {
  const parsed = WorkspaceRecompositionPlanSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkspaceRecompositionValidationError(
      "invalid-request",
      `workspace recomposition plan validation failed: ${issueText(parsed.error.issues)}`,
      parsed.error.issues,
    );
  }
  for (const unit of parsed.data.units) {
    if (
      (unit.status === "hit" || unit.status === "recomputed") &&
      unit.resultDigest !== digestValue(unit.result)
    ) {
      throw new WorkspaceRecompositionValidationError(
        "invalid-cache",
        `unit ${unit.id} result digest does not match its reusable result`,
      );
    }
  }
  const canonicalCache = parseWorkspaceRecompositionCache(parsed.data.cache);
  if (stableStringify(canonicalCache) !== stableStringify(parsed.data.cache)) {
    throw new WorkspaceRecompositionValidationError(
      "invalid-cache",
      "workspace recomposition plan contains a non-canonical cache",
    );
  }
  for (const unit of parsed.data.units) {
    const canonicalKeyValue = parseWorkspaceRecompositionKey(unit.key);
    if (stableStringify(canonicalKeyValue) !== stableStringify(unit.key)) {
      throw new WorkspaceRecompositionValidationError(
        "invalid-cache",
        `workspace recomposition plan unit ${unit.id} contains a non-canonical key`,
      );
    }
  }
  const withoutDigest = {
    schemaVersion: parsed.data.schemaVersion,
    contract: parsed.data.contract,
    workspaceId: parsed.data.workspaceId,
    changedInputIds: parsed.data.changedInputIds,
    units: parsed.data.units,
    cache: parsed.data.cache,
    stats: parsed.data.stats,
  } satisfies Omit<WorkspaceRecompositionPlan, "resultDigest">;
  if (
    digestValue(planDigestPayload(withoutDigest)) !== parsed.data.resultDigest
  ) {
    throw new WorkspaceRecompositionValidationError(
      "invalid-request",
      "workspace recomposition plan digest does not match its contents",
    );
  }
  return {
    ...parsed.data,
    units: [...parsed.data.units].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
  };
};

export const serializeWorkspaceRecompositionPlan = (value: unknown): string =>
  stableStringify(parseWorkspaceRecompositionPlan(value));

const resolveCachePath = (
  rootOrPath: string,
  relativePath?: string,
): string => {
  const candidate =
    relativePath === undefined
      ? resolve(rootOrPath)
      : resolve(rootOrPath, relativePath);
  if (candidate.includes("\0")) {
    throw new WorkspaceRecompositionCacheError(
      "cache-path",
      "cache path contains a NUL byte",
    );
  }
  if (relativePath !== undefined) {
    const root = resolve(rootOrPath);
    const withinRoot = relative(root, candidate);
    if (
      relativePath.startsWith("/") ||
      relativePath.startsWith("~") ||
      relativePath.includes("\\") ||
      /^[A-Za-z][A-Za-z\d+.-]*:/u.test(relativePath) ||
      relativePath.split("/").some((part) => part === "..") ||
      withinRoot === ".." ||
      withinRoot.startsWith(`..${sep}`) ||
      withinRoot.startsWith(sep)
    ) {
      throw new WorkspaceRecompositionCacheError(
        "cache-path",
        `cache path escapes the supplied root: ${relativePath}`,
      );
    }
  }
  return candidate;
};

const regularCacheFile = (
  candidate: string,
  missingCode: "cache-missing" | "cache-path" = "cache-missing",
): { size: number } => {
  let metadata;
  try {
    metadata = lstatSync(candidate);
  } catch {
    throw new WorkspaceRecompositionCacheError(
      missingCode,
      `workspace recomposition cache is missing: ${candidate}`,
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new WorkspaceRecompositionCacheError(
      "cache-path",
      `workspace recomposition cache is not a regular file: ${candidate}`,
    );
  }
  if (metadata.size > WORKSPACE_RECOMPOSITION_MAX_CACHE_BYTES) {
    throw new WorkspaceRecompositionCacheError(
      "cache-too-large",
      `workspace recomposition cache exceeds ${WORKSPACE_RECOMPOSITION_MAX_CACHE_BYTES} bytes: ${candidate}`,
    );
  }
  return { size: metadata.size };
};

export function readWorkspaceRecompositionCache(
  cachePath: string,
): WorkspaceRecompositionCache;
export function readWorkspaceRecompositionCache(
  repositoryRoot: string,
  cachePath: string,
): WorkspaceRecompositionCache;
export function readWorkspaceRecompositionCache(
  rootOrPath: string,
  relativePath?: string,
): WorkspaceRecompositionCache {
  const candidate = resolveCachePath(rootOrPath, relativePath);
  regularCacheFile(candidate);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(candidate, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new WorkspaceRecompositionCacheError(
      "cache-corrupt",
      `could not parse workspace recomposition cache ${candidate}: ${detail}`,
    );
  }
  try {
    return parseWorkspaceRecompositionCache(value);
  } catch (error) {
    if (error instanceof WorkspaceRecompositionValidationError) {
      throw new WorkspaceRecompositionCacheError(
        "cache-corrupt",
        error.message,
      );
    }
    throw error;
  }
}

export const tryReadWorkspaceRecompositionCache = (
  cachePath: string,
): WorkspaceRecompositionCache | undefined => {
  try {
    return readWorkspaceRecompositionCache(cachePath);
  } catch (error) {
    if (
      error instanceof WorkspaceRecompositionCacheError &&
      error.code === "cache-missing"
    ) {
      return undefined;
    }
    throw error;
  }
};

export type WorkspaceRecompositionAtomicWriteOptions = {
  readonly beforeCommit?: () => void;
};

export function writeWorkspaceRecompositionCacheAtomic(
  cachePath: string,
  value: unknown,
  options?: WorkspaceRecompositionAtomicWriteOptions,
): void;
export function writeWorkspaceRecompositionCacheAtomic(
  repositoryRoot: string,
  cachePath: string,
  value: unknown,
  options?: WorkspaceRecompositionAtomicWriteOptions,
): void;
export function writeWorkspaceRecompositionCacheAtomic(
  rootOrPath: string,
  valueOrPath: unknown,
  valueOrOptions?: unknown,
  maybeOptions?: WorkspaceRecompositionAtomicWriteOptions,
): void {
  const relativeMode = typeof valueOrPath === "string";
  const candidate = relativeMode
    ? resolveCachePath(rootOrPath, valueOrPath)
    : resolveCachePath(rootOrPath);
  const value = relativeMode ? valueOrOptions : valueOrPath;
  const options = (relativeMode ? maybeOptions : valueOrOptions) as
    WorkspaceRecompositionAtomicWriteOptions | undefined;
  const cache = parseWorkspaceRecompositionCache(value);
  const serialized = stableStringify(cache);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > WORKSPACE_RECOMPOSITION_MAX_CACHE_BYTES) {
    throw new WorkspaceRecompositionCacheError(
      "cache-too-large",
      `workspace recomposition cache is ${bytes} bytes but the limit is ${WORKSPACE_RECOMPOSITION_MAX_CACHE_BYTES}`,
    );
  }
  mkdirSync(dirname(candidate), { recursive: true });
  try {
    const existing = lstatSync(candidate);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new WorkspaceRecompositionCacheError(
        "cache-path",
        `workspace recomposition cache target is not a regular file: ${candidate}`,
      );
    }
  } catch (error) {
    if (
      error instanceof WorkspaceRecompositionCacheError ||
      (error instanceof Error && "code" in error && error.code !== "ENOENT")
    ) {
      throw error;
    }
  }
  const temporaryDirectory = mkdtempSync(
    join(dirname(candidate), `.${candidate.split(sep).pop() ?? "cache"}.tmp-`),
  );
  const temporaryPath = join(temporaryDirectory, "payload");
  try {
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
    options?.beforeCommit?.();
    renameSync(temporaryPath, candidate);
  } catch (error) {
    if (error instanceof WorkspaceRecompositionCacheError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new WorkspaceRecompositionCacheError(
      "cache-corrupt",
      `atomic workspace cache write failed: ${detail}`,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export const writeWorkspaceCacheAtomic = writeWorkspaceRecompositionCacheAtomic;

export const cleanupWorkspaceRecompositionCache = (
  cachePath: string,
): number => {
  const candidate = resolveCachePath(cachePath);
  const directory = dirname(candidate);
  const basename = candidate.split(sep).pop() ?? "cache";
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  const prefix = `.${basename}.tmp-`;
  const temporaryEntries = entries
    .filter((entry) => entry.name.startsWith(prefix))
    .slice(0, WORKSPACE_RECOMPOSITION_MAX_TEMP_ENTRIES);
  for (const entry of temporaryEntries) {
    const path = join(directory, entry.name);
    rmSync(path, { recursive: true, force: true });
  }
  return temporaryEntries.length;
};

export const removeWorkspaceRecompositionCache = (cachePath: string): void => {
  const candidate = resolveCachePath(cachePath);
  try {
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new WorkspaceRecompositionCacheError(
        "cache-path",
        `workspace recomposition cache is not a regular file: ${candidate}`,
      );
    }
    unlinkSync(candidate);
  } catch (error) {
    if (
      error instanceof WorkspaceRecompositionCacheError ||
      (error instanceof Error && "code" in error && error.code !== "ENOENT")
    ) {
      throw error;
    }
  }
};

export const workspaceRecompositionDigest = digestValue;
