import { z, type ZodIssue } from "zod";

import { canonicalizeGraphSnapshot, stableStringify } from "./canonical.js";
import {
  GraphNodeSchema,
  GraphSnapshotSchema,
  type GraphNode,
  type GraphSnapshot,
} from "./schemas.js";
import { WorkspaceLocalPathSchema } from "./workspace-composition.js";

export const WORKSPACE_IDENTITY_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_IDENTITY_CONTRACT =
  "cartograph.workspace-identity" as const;
export const WORKSPACE_IDENTITY_MAX_REPOSITORIES = 64 as const;
export const WORKSPACE_IDENTITY_MAX_ORIGIN_ALIASES = 32 as const;
export const WORKSPACE_IDENTITY_MAX_REPOSITORY_ALIASES = 32 as const;
export const WORKSPACE_IDENTITY_MAX_NODES = 200_000 as const;
export const WORKSPACE_IDENTITY_MAX_AMBIGUITIES = 256 as const;
export const WORKSPACE_IDENTITY_MAX_ORIGIN_LENGTH = 2_048 as const;
export const WORKSPACE_IDENTITY_MAX_COMPOSED_KEY_LENGTH = 4_096 as const;

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u,
    "must be a portable lower-case identifier",
  )
  .transform((value) => value.normalize("NFC"));

const DisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .transform((value) => value.normalize("NFC"));

const OriginReferenceInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(WORKSPACE_IDENTITY_MAX_ORIGIN_LENGTH)
  .transform((value) => value.normalize("NFC"));

const OriginMetadataInputSchema = z
  .object({
    availability: z.enum(["available", "unavailable"]).default("unavailable"),
    canonical: OriginReferenceInputSchema.optional(),
    aliases: z
      .array(OriginReferenceInputSchema)
      .max(WORKSPACE_IDENTITY_MAX_ORIGIN_ALIASES)
      .default([]),
    forkOf: OriginReferenceInputSchema.optional(),
  })
  .strict()
  .superRefine((origin, context) => {
    if (origin.availability === "available" && origin.canonical === undefined) {
      context.addIssue({
        code: "custom",
        path: ["canonical"],
        message: "available origin metadata requires a canonical origin",
      });
    }
    if (
      origin.availability === "unavailable" &&
      origin.canonical !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["canonical"],
        message:
          "unavailable origin metadata cannot include a canonical origin",
      });
    }
  });

const withOriginAliases = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (!("canonical" in record) && "canonicalOrigin" in record)
    record.canonical = record.canonicalOrigin;
  if (!("aliases" in record) && "originAliases" in record)
    record.aliases = record.originAliases;
  if (!("forkOf" in record) && "forkOrigin" in record)
    record.forkOf = record.forkOrigin;
  if (!("availability" in record)) {
    record.availability = "canonical" in record ? "available" : "unavailable";
  }
  delete record.canonicalOrigin;
  delete record.originAliases;
  delete record.forkOrigin;
  return record;
};

export const WorkspaceOriginMetadataSchema = z.preprocess(
  withOriginAliases,
  OriginMetadataInputSchema,
);

const withRepositoryAliases = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (!("repositoryId" in record) && "id" in record)
    record.repositoryId = record.id;
  if (typeof record.origin === "string") {
    record.origin = { availability: "available", canonical: record.origin };
  }
  delete record.id;
  return record;
};

export const WorkspaceIdentityRepositorySchema = z.preprocess(
  withRepositoryAliases,
  z
    .object({
      repositoryId: IdentifierSchema,
      logicalName: DisplayNameSchema,
      localPath: WorkspaceLocalPathSchema.optional(),
      origin: WorkspaceOriginMetadataSchema.optional(),
      aliases: z
        .array(IdentifierSchema)
        .max(WORKSPACE_IDENTITY_MAX_REPOSITORY_ALIASES)
        .default([]),
      snapshot: z.unknown(),
    })
    .strict(),
);

export type WorkspaceOriginMetadata = z.infer<
  typeof WorkspaceOriginMetadataSchema
>;
export type WorkspaceIdentityRepository = z.infer<
  typeof WorkspaceIdentityRepositorySchema
>;

export const WorkspaceIdentityResolutionSchema = z.enum([
  "unique",
  "ambiguous",
  "origin-unavailable",
]);
export type WorkspaceIdentityResolution = z.infer<
  typeof WorkspaceIdentityResolutionSchema
>;

export const WorkspaceIdentityAmbiguityKindSchema = z.enum([
  "duplicate-origin",
  "alias-collision",
  "logical-name-collision",
  "origin-unavailable",
]);
export type WorkspaceIdentityAmbiguityKind = z.infer<
  typeof WorkspaceIdentityAmbiguityKindSchema
>;

const OriginKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(WORKSPACE_IDENTITY_MAX_ORIGIN_LENGTH)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.includes("\r") &&
      !value.includes("\n") &&
      !/\s/u.test(value),
    "must not contain whitespace or control characters",
  );

const NoLineBreaksSchema = z
  .string()
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );

const NamespaceSchema = z
  .object({
    repositoryId: IdentifierSchema,
    logicalName: DisplayNameSchema,
    namespace: NoLineBreaksSchema.min(1).max(
      WORKSPACE_IDENTITY_MAX_COMPOSED_KEY_LENGTH,
    ),
    resolution: WorkspaceIdentityResolutionSchema,
    canonicalOrigin: OriginKeySchema.optional(),
    forkOf: OriginKeySchema.optional(),
    originAliases: z
      .array(OriginKeySchema)
      .max(WORKSPACE_IDENTITY_MAX_ORIGIN_ALIASES),
    repositoryAliases: z
      .array(IdentifierSchema)
      .max(WORKSPACE_IDENTITY_MAX_REPOSITORY_ALIASES),
    localPath: WorkspaceLocalPathSchema.optional(),
  })
  .strict();

export const WorkspaceIdentityNamespaceSchema = NamespaceSchema;
export type WorkspaceIdentityNamespace = z.infer<
  typeof WorkspaceIdentityNamespaceSchema
>;

export const WorkspaceIdentityAmbiguitySchema = z
  .object({
    kind: WorkspaceIdentityAmbiguityKindSchema,
    key: NoLineBreaksSchema.min(1).max(
      WORKSPACE_IDENTITY_MAX_COMPOSED_KEY_LENGTH,
    ),
    repositoryIds: z
      .array(IdentifierSchema)
      .min(1)
      .max(WORKSPACE_IDENTITY_MAX_REPOSITORIES),
    detail: z.string().trim().min(1).max(1_024),
  })
  .strict();
export type WorkspaceIdentityAmbiguity = z.infer<
  typeof WorkspaceIdentityAmbiguitySchema
>;

export const WorkspaceComposedIdentitySchema = z
  .object({
    repositoryId: IdentifierSchema,
    namespace: NoLineBreaksSchema.min(1).max(
      WORKSPACE_IDENTITY_MAX_COMPOSED_KEY_LENGTH,
    ),
    resolution: WorkspaceIdentityResolutionSchema,
    localStableKey: z
      .string()
      .trim()
      .min(1)
      .max(WORKSPACE_IDENTITY_MAX_COMPOSED_KEY_LENGTH),
    composedStableKey: z
      .string()
      .trim()
      .min(1)
      .max(WORKSPACE_IDENTITY_MAX_COMPOSED_KEY_LENGTH),
    nodeId: z
      .string()
      .trim()
      .min(1)
      .max(WORKSPACE_IDENTITY_MAX_COMPOSED_KEY_LENGTH),
    node: GraphNodeSchema,
  })
  .strict();
export type WorkspaceComposedIdentity = z.infer<
  typeof WorkspaceComposedIdentitySchema
>;

export const WorkspaceIdentitySnapshotSchema = z
  .object({
    repositoryId: IdentifierSchema,
    snapshot: GraphSnapshotSchema,
  })
  .strict();
export type WorkspaceIdentitySnapshot = z.infer<
  typeof WorkspaceIdentitySnapshotSchema
>;

export const WorkspaceIdentityCompositionSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_IDENTITY_SCHEMA_VERSION),
    contract: z.literal(WORKSPACE_IDENTITY_CONTRACT),
    namespaces: z
      .array(WorkspaceIdentityNamespaceSchema)
      .max(WORKSPACE_IDENTITY_MAX_REPOSITORIES),
    identities: z
      .array(WorkspaceComposedIdentitySchema)
      .max(WORKSPACE_IDENTITY_MAX_NODES),
    ambiguities: z
      .array(WorkspaceIdentityAmbiguitySchema)
      .max(WORKSPACE_IDENTITY_MAX_AMBIGUITIES),
    snapshots: z
      .array(WorkspaceIdentitySnapshotSchema)
      .max(WORKSPACE_IDENTITY_MAX_REPOSITORIES),
  })
  .strict();
export type WorkspaceIdentityComposition = z.infer<
  typeof WorkspaceIdentityCompositionSchema
>;

export type WorkspaceIdentityErrorCode = "invalid-input" | "resource-limit";

const issueText = (issues: readonly ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

export class WorkspaceIdentityValidationError extends Error {
  readonly code: WorkspaceIdentityErrorCode;
  readonly issues: readonly ZodIssue[];

  constructor(
    code: WorkspaceIdentityErrorCode,
    message: string,
    issues: readonly ZodIssue[] = [],
  ) {
    super(message);
    this.name = "WorkspaceIdentityValidationError";
    this.code = code;
    this.issues = issues;
  }
}

class InvalidOriginReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOriginReferenceError";
  }
}

const normalizeOriginReference = (input: string): string => {
  const value = input.trim().normalize("NFC");
  if (
    value.length === 0 ||
    value.length > WORKSPACE_IDENTITY_MAX_ORIGIN_LENGTH ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.includes("\u007f") ||
    /\s/u.test(value) ||
    value.includes("\\")
  ) {
    throw new InvalidOriginReferenceError(
      "origin references must be bounded and cannot contain whitespace, control characters, or backslashes",
    );
  }

  let host: string;
  let path: string;
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new InvalidOriginReferenceError(
        "origin reference is not a valid URL",
      );
    }
    const protocol = parsed.protocol.toLowerCase();
    if (
      !new Set(["http:", "https:", "ssh:", "git+ssh:", "git:"]).has(protocol)
    ) {
      throw new InvalidOriginReferenceError(
        "origin URL must use http, https, ssh, git+ssh, or git",
      );
    }
    const allowsTransportUser =
      protocol === "ssh:" || protocol === "git+ssh:" || protocol === "git:";
    if (
      parsed.password ||
      (parsed.username && !allowsTransportUser) ||
      parsed.search ||
      parsed.hash
    ) {
      throw new InvalidOriginReferenceError(
        "origin URL cannot contain credentials, query parameters, or fragments",
      );
    }
    host = parsed.hostname.toLowerCase();
    if (!host) throw new InvalidOriginReferenceError("origin URL has no host");
    const port = parsed.port;
    const defaultPort =
      (protocol === "http:" && port === "80") ||
      (protocol === "https:" && port === "443") ||
      (protocol === "ssh:" && port === "22");
    if (port && !defaultPort) host = `${host}:${port}`;
    path = parsed.pathname;
  } else {
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/u.exec(value);
    if (scp) {
      host = scp[1]!.toLowerCase();
      path = scp[2]!;
    } else {
      const bare = /^([^/]+)\/(.+)$/u.exec(value);
      if (!bare) {
        throw new InvalidOriginReferenceError(
          "origin reference must be a supported URL, SCP-style Git reference, or host/path reference",
        );
      }
      host = bare[1]!.toLowerCase();
      path = bare[2]!;
    }
  }

  if (
    host.length === 0 ||
    host === "." ||
    host === ".." ||
    host.includes("/") ||
    host.includes("\\")
  ) {
    throw new InvalidOriginReferenceError(
      "origin reference has an invalid host",
    );
  }
  const segments = path
    .replace(/^\/+|\/+$/gu, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new InvalidOriginReferenceError(
      "origin reference must contain a non-traversing repository path",
    );
  }
  const last = segments.at(-1);
  if (last === undefined)
    throw new InvalidOriginReferenceError("origin path is empty");
  if (/\.git$/iu.test(last)) segments[segments.length - 1] = last.slice(0, -4);
  if (segments.at(-1)?.length === 0) {
    throw new InvalidOriginReferenceError("origin path is empty");
  }
  return `${host}/${segments.join("/")}`;
};

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const normalizeRepositoryAlias = (value: string): string =>
  value.normalize("NFC").toLowerCase();

const logicalNameKey = (value: string): string =>
  value.normalize("NFC").toLowerCase();

type ParsedRepository = {
  readonly repository: WorkspaceIdentityRepository;
  readonly snapshot: GraphSnapshot;
  readonly canonicalOrigin?: string;
  readonly originAliases: readonly string[];
  readonly forkOf?: string;
  readonly originAvailable: boolean;
};

const parseRepository = (input: unknown, index: number): ParsedRepository => {
  const parsed = WorkspaceIdentityRepositorySchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      ...issue,
      path: ["repositories", index, ...issue.path],
    }));
    throw new WorkspaceIdentityValidationError(
      "invalid-input",
      `workspace identity repository validation failed: ${issueText(issues)}`,
      issues,
    );
  }

  let snapshot: GraphSnapshot;
  try {
    snapshot = canonicalizeGraphSnapshot(parsed.data.snapshot);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "invalid graph snapshot";
    throw new WorkspaceIdentityValidationError(
      "invalid-input",
      `workspace identity repository ${parsed.data.repositoryId} has an invalid graph snapshot: ${detail}`,
    );
  }

  const origin = parsed.data.origin;
  if (!origin) {
    return {
      repository: parsed.data,
      snapshot,
      originAvailable: false,
      originAliases: [],
    };
  }

  try {
    const canonicalOrigin = origin.canonical
      ? normalizeOriginReference(origin.canonical)
      : undefined;
    const originAliases = uniqueSorted(
      origin.aliases.map(normalizeOriginReference),
    ).filter((alias) => alias !== canonicalOrigin);
    const forkOf = origin.forkOf
      ? normalizeOriginReference(origin.forkOf)
      : undefined;
    if (canonicalOrigin && forkOf && canonicalOrigin === forkOf) {
      throw new InvalidOriginReferenceError(
        "fork origin must differ from the repository canonical origin",
      );
    }
    return {
      repository: parsed.data,
      snapshot,
      originAliases,
      originAvailable: origin.availability === "available",
      ...(canonicalOrigin ? { canonicalOrigin } : {}),
      ...(forkOf ? { forkOf } : {}),
    };
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "invalid origin metadata";
    throw new WorkspaceIdentityValidationError(
      "invalid-input",
      `workspace identity repository ${parsed.data.repositoryId} has invalid origin metadata: ${detail}`,
    );
  }
};

const option = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new WorkspaceIdentityValidationError(
      "invalid-input",
      `${name} must be a positive safe integer no greater than ${maximum}`,
    );
  }
  return result;
};

export type WorkspaceIdentityCompositionOptions = {
  maxRepositories?: number;
  maxNodes?: number;
  maxAmbiguities?: number;
};

const ambiguitySort = (
  left: WorkspaceIdentityAmbiguity,
  right: WorkspaceIdentityAmbiguity,
): number => {
  const kind = compareStrings(left.kind, right.kind);
  if (kind !== 0) return kind;
  const key = compareStrings(left.key, right.key);
  if (key !== 0) return key;
  return compareStrings(
    left.repositoryIds.join("\u0000"),
    right.repositoryIds.join("\u0000"),
  );
};

const canonicalizeComposition = (
  composition: WorkspaceIdentityComposition,
): WorkspaceIdentityComposition => ({
  ...composition,
  namespaces: [...composition.namespaces].sort((left, right) =>
    compareStrings(left.repositoryId, right.repositoryId),
  ),
  identities: [...composition.identities].sort((left, right) => {
    const key = compareStrings(left.composedStableKey, right.composedStableKey);
    return key !== 0 ? key : compareStrings(left.nodeId, right.nodeId);
  }),
  ambiguities: [...composition.ambiguities].sort(ambiguitySort),
  snapshots: [...composition.snapshots].sort((left, right) =>
    compareStrings(left.repositoryId, right.repositoryId),
  ),
});

const addCollisionAmbiguities = (
  values: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
  kind: WorkspaceIdentityAmbiguityKind,
  detail: string,
  ambiguities: WorkspaceIdentityAmbiguity[],
  ambiguousRepositories: Set<string>,
): void => {
  for (const [key, owners] of [...values.entries()].sort(([left], [right]) =>
    compareStrings(left, right),
  )) {
    if (owners.size < 2) continue;
    const repositoryIds = [...owners.keys()].sort(compareStrings);
    ambiguities.push({ kind, key, repositoryIds, detail });
    for (const repositoryId of repositoryIds)
      ambiguousRepositories.add(repositoryId);
  }
};

export const composeWorkspaceIdentities = (
  inputs: readonly unknown[],
  options: WorkspaceIdentityCompositionOptions = {},
): WorkspaceIdentityComposition => {
  const maxRepositories = option(
    options.maxRepositories,
    WORKSPACE_IDENTITY_MAX_REPOSITORIES,
    WORKSPACE_IDENTITY_MAX_REPOSITORIES,
    "maxRepositories",
  );
  const maxNodes = option(
    options.maxNodes,
    WORKSPACE_IDENTITY_MAX_NODES,
    WORKSPACE_IDENTITY_MAX_NODES,
    "maxNodes",
  );
  const maxAmbiguities = option(
    options.maxAmbiguities,
    WORKSPACE_IDENTITY_MAX_AMBIGUITIES,
    WORKSPACE_IDENTITY_MAX_AMBIGUITIES,
    "maxAmbiguities",
  );
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new WorkspaceIdentityValidationError(
      "invalid-input",
      "workspace identity composition requires at least one repository",
    );
  }
  if (inputs.length > maxRepositories) {
    throw new WorkspaceIdentityValidationError(
      "resource-limit",
      `workspace identity composition contains ${inputs.length} repositories but the limit is ${maxRepositories}`,
    );
  }

  const repositories = inputs.map(parseRepository);
  const repositoryIds = new Set<string>();
  const duplicateIssues: ZodIssue[] = [];
  for (const [index, entry] of repositories.entries()) {
    const repositoryId = entry.repository.repositoryId;
    if (repositoryIds.has(repositoryId)) {
      duplicateIssues.push({
        code: "custom",
        path: ["repositories", index, "repositoryId"],
        message: `duplicate repository identity: ${repositoryId}`,
      });
    }
    repositoryIds.add(repositoryId);
  }
  if (duplicateIssues.length > 0) {
    throw new WorkspaceIdentityValidationError(
      "invalid-input",
      `workspace identity composition validation failed: ${issueText(duplicateIssues)}`,
      duplicateIssues,
    );
  }

  const totalNodes = repositories.reduce(
    (total, entry) => total + entry.snapshot.nodes.length,
    0,
  );
  if (totalNodes > maxNodes) {
    throw new WorkspaceIdentityValidationError(
      "resource-limit",
      `workspace identity composition contains ${totalNodes} nodes but the limit is ${maxNodes}`,
    );
  }

  const ambiguities: WorkspaceIdentityAmbiguity[] = [];
  const ambiguousRepositories = new Set<string>();
  const originOwners = new Map<string, Map<string, string[]>>();
  const repositoryAliasOwners = new Map<string, Map<string, string[]>>();
  const logicalNameOwners = new Map<string, Map<string, string[]>>();
  const addOwner = (
    map: Map<string, Map<string, string[]>>,
    key: string,
    repositoryId: string,
    role: string,
  ): void => {
    const owners = map.get(key) ?? new Map<string, string[]>();
    const roles = owners.get(repositoryId) ?? [];
    if (!roles.includes(role)) roles.push(role);
    owners.set(repositoryId, roles);
    map.set(key, owners);
  };

  for (const entry of repositories) {
    const repositoryId = entry.repository.repositoryId;
    if (entry.canonicalOrigin)
      addOwner(originOwners, entry.canonicalOrigin, repositoryId, "canonical");
    for (const alias of entry.originAliases)
      addOwner(originOwners, alias, repositoryId, "alias");
    addOwner(
      repositoryAliasOwners,
      normalizeRepositoryAlias(repositoryId),
      repositoryId,
      "repository-id",
    );
    for (const alias of entry.repository.aliases)
      addOwner(
        repositoryAliasOwners,
        normalizeRepositoryAlias(alias),
        repositoryId,
        "alias",
      );
    addOwner(
      logicalNameOwners,
      logicalNameKey(entry.repository.logicalName),
      repositoryId,
      "logical-name",
    );
  }

  for (const [key, owners] of [...originOwners.entries()].sort(
    ([left], [right]) => compareStrings(left, right),
  )) {
    if (owners.size < 2) continue;
    const repositoryIdsForKey = [...owners.keys()].sort(compareStrings);
    const hasAlias = [...owners.values()].some((roles) =>
      roles.includes("alias"),
    );
    const kind: WorkspaceIdentityAmbiguityKind = hasAlias
      ? "alias-collision"
      : "duplicate-origin";
    ambiguities.push({
      kind,
      key,
      repositoryIds: repositoryIdsForKey,
      detail: hasAlias
        ? "an origin alias resolves to more than one repository; identities remain separate and require review"
        : "multiple repositories claim the same canonical origin; identities remain separate and require review",
    });
    for (const repositoryId of repositoryIdsForKey)
      ambiguousRepositories.add(repositoryId);
  }

  addCollisionAmbiguities(
    repositoryAliasOwners,
    "alias-collision",
    "repository identifiers or aliases resolve to more than one repository; identities remain separate and require review",
    ambiguities,
    ambiguousRepositories,
  );
  addCollisionAmbiguities(
    logicalNameOwners,
    "logical-name-collision",
    "logical names are not unique across the composition; identities remain separate and require review",
    ambiguities,
    ambiguousRepositories,
  );

  for (const entry of repositories) {
    if (entry.originAvailable) continue;
    const repositoryId = entry.repository.repositoryId;
    ambiguities.push({
      kind: "origin-unavailable",
      key: `repository:${repositoryId}`,
      repositoryIds: [repositoryId],
      detail:
        "canonical origin metadata is unavailable; the repository-scoped namespace is stable only for this declared repository identity",
    });
  }

  if (ambiguities.length > maxAmbiguities) {
    throw new WorkspaceIdentityValidationError(
      "resource-limit",
      `workspace identity composition produced ${ambiguities.length} ambiguity records but the limit is ${maxAmbiguities}`,
    );
  }

  const namespaceByRepository = new Map<string, WorkspaceIdentityNamespace>();
  for (const entry of repositories) {
    const repositoryId = entry.repository.repositoryId;
    const resolution: WorkspaceIdentityResolution = ambiguousRepositories.has(
      repositoryId,
    )
      ? "ambiguous"
      : entry.originAvailable
        ? "unique"
        : "origin-unavailable";
    const namespace = entry.canonicalOrigin
      ? `origin:${entry.canonicalOrigin}`
      : `repository:${repositoryId}`;
    namespaceByRepository.set(repositoryId, {
      repositoryId,
      logicalName: entry.repository.logicalName,
      namespace,
      resolution,
      ...(entry.canonicalOrigin
        ? { canonicalOrigin: entry.canonicalOrigin }
        : {}),
      ...(entry.forkOf ? { forkOf: entry.forkOf } : {}),
      originAliases: [...entry.originAliases],
      repositoryAliases: uniqueSorted(
        entry.repository.aliases.map(normalizeRepositoryAlias),
      ),
      ...(entry.repository.localPath
        ? { localPath: entry.repository.localPath }
        : {}),
    });
  }

  const identities: WorkspaceComposedIdentity[] = [];
  for (const entry of repositories) {
    const repositoryId = entry.repository.repositoryId;
    const namespaceRecord = namespaceByRepository.get(repositoryId);
    if (!namespaceRecord)
      throw new Error("workspace identity namespace missing");
    for (const node of entry.snapshot.nodes) {
      const localStableKey = node.stableKey;
      const baseKey = `${namespaceRecord.namespace}::${localStableKey}`;
      const composedStableKey =
        namespaceRecord.resolution === "ambiguous"
          ? `${baseKey}::repository:${repositoryId}`
          : baseKey;
      if (
        composedStableKey.length > WORKSPACE_IDENTITY_MAX_COMPOSED_KEY_LENGTH
      ) {
        throw new WorkspaceIdentityValidationError(
          "resource-limit",
          `composed identity key exceeds ${WORKSPACE_IDENTITY_MAX_COMPOSED_KEY_LENGTH} characters for ${repositoryId}/${localStableKey}`,
        );
      }
      identities.push({
        repositoryId,
        namespace: namespaceRecord.namespace,
        resolution: namespaceRecord.resolution,
        localStableKey,
        composedStableKey,
        nodeId: `${composedStableKey}::${node.id}`,
        node: { ...node },
      });
    }
  }

  const composition: WorkspaceIdentityComposition = {
    schemaVersion: WORKSPACE_IDENTITY_SCHEMA_VERSION,
    contract: WORKSPACE_IDENTITY_CONTRACT,
    namespaces: [...namespaceByRepository.values()],
    identities,
    ambiguities,
    snapshots: repositories.map((entry) => ({
      repositoryId: entry.repository.repositoryId,
      snapshot: entry.snapshot,
    })),
  };
  return canonicalizeComposition(composition);
};

export const composeWorkspaceIdentityNamespaces = composeWorkspaceIdentities;
export const composeWorkspaceIdentity = composeWorkspaceIdentities;

export const parseWorkspaceIdentityComposition = (
  value: unknown,
): WorkspaceIdentityComposition => {
  const parsed = WorkspaceIdentityCompositionSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkspaceIdentityValidationError(
      "invalid-input",
      `workspace identity composition validation failed: ${issueText(parsed.error.issues)}`,
      parsed.error.issues,
    );
  }
  return canonicalizeComposition(parsed.data);
};

export const serializeWorkspaceIdentityComposition = (value: unknown): string =>
  stableStringify(parseWorkspaceIdentityComposition(value));

export type WorkspaceIdentityInputNode = GraphNode;
