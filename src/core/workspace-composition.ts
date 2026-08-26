import { lstatSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { z } from "zod";

import { stableStringify } from "./canonical.js";
import { GRAPH_SNAPSHOT_SCHEMA_VERSION } from "./schemas.js";

export const WORKSPACE_COMPOSITION_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_COMPOSITION_CONTRACT =
  "cartograph.workspace-composition" as const;
export const WORKSPACE_COMPOSITION_MAX_REPOSITORIES = 64 as const;
export const WORKSPACE_COMPOSITION_MAX_OMISSIONS = 64 as const;
export const WORKSPACE_COMPOSITION_MAX_BOUNDARIES = 256 as const;
export const WORKSPACE_COMPOSITION_MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const WORKSPACE_COMPOSITION_MAX_TOTAL_SNAPSHOT_BYTES =
  1024 * 1024 * 1024;
export const WORKSPACE_COMPOSITION_MAX_MANIFEST_BYTES = 1024 * 1024;

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

const TextSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .transform((value) => value.normalize("NFC"));

const SemverSchema = z
  .string()
  .trim()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "must be a semantic version",
  );

const AdapterVersionSchema = SemverSchema.refine(
  (value) => value.startsWith("1."),
  "adapter major version is incompatible with workspace composition v1",
);

const RevisionSchema = z
  .string()
  .trim()
  .min(7)
  .max(128)
  .regex(
    /^(?:[0-9a-f]{7,128}|working-tree)$/iu,
    "must be an immutable hexadecimal revision or the explicit working-tree marker",
  );

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const portablePath = (
  value: string,
  context: z.RefinementCtx,
  allowDirectory: boolean,
): string => {
  const normalized = value.normalize("NFC").replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    normalized.startsWith("//") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    context.addIssue({
      code: "custom",
      message:
        "must be a portable local path; absolute paths, URI schemes, and parent traversal are not allowed",
    });
    return z.NEVER;
  }
  const compact = normalized
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  if (compact.length === 0) {
    if (allowDirectory) return ".";
    context.addIssue({
      code: "custom",
      message: "must name a local file",
    });
    return z.NEVER;
  }
  return compact.join("/");
};

export const WorkspaceLocalPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .transform((value, context) => portablePath(value, context, true));

export const WorkspaceLocalFileSchema = WorkspaceLocalPathSchema.refine(
  (value) => value !== ".",
  "must name a local file",
);

export const WorkspaceCompositionLimitsSchema = z
  .object({
    maxRepositories: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_COMPOSITION_MAX_REPOSITORIES),
    maxOmissions: z
      .number()
      .int()
      .nonnegative()
      .max(WORKSPACE_COMPOSITION_MAX_OMISSIONS),
    maxBoundaries: z
      .number()
      .int()
      .nonnegative()
      .max(WORKSPACE_COMPOSITION_MAX_BOUNDARIES),
    maxSnapshotBytes: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_COMPOSITION_MAX_SNAPSHOT_BYTES),
    maxTotalSnapshotBytes: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_COMPOSITION_MAX_TOTAL_SNAPSHOT_BYTES),
  })
  .strict()
  .superRefine((limits, context) => {
    if (limits.maxTotalSnapshotBytes < limits.maxSnapshotBytes) {
      context.addIssue({
        code: "custom",
        path: ["maxTotalSnapshotBytes"],
        message: "must be at least maxSnapshotBytes",
      });
    }
  });

export const WorkspaceRepositorySnapshotSchema = z
  .object({
    path: WorkspaceLocalFileSchema,
    schemaVersion: z.literal(GRAPH_SNAPSHOT_SCHEMA_VERSION),
    adapterId: IdentifierSchema,
    adapterVersion: AdapterVersionSchema,
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(WORKSPACE_COMPOSITION_MAX_SNAPSHOT_BYTES),
  })
  .strict();

export const WorkspaceRepositorySchema = z
  .object({
    id: IdentifierSchema,
    logicalName: DisplayNameSchema,
    revision: RevisionSchema,
    localPath: WorkspaceLocalPathSchema,
    snapshot: WorkspaceRepositorySnapshotSchema,
  })
  .strict();

export const WorkspaceOmissionSchema = z
  .object({
    id: IdentifierSchema,
    logicalName: DisplayNameSchema,
    reason: TextSchema,
    requestedPath: WorkspaceLocalPathSchema.optional(),
  })
  .strict();

export const WorkspaceBoundarySchema = z
  .object({
    id: IdentifierSchema,
    fromRepository: IdentifierSchema,
    toRepository: IdentifierSchema,
    relation: z.enum(["depends-on", "references", "contains", "unknown"]),
    status: z.enum(["declared", "unresolved"]).default("declared"),
    evidencePath: WorkspaceLocalFileSchema.optional(),
  })
  .strict();

export const WorkspaceCompositionManifestSchema = z
  .object({
    $schema: z.string().trim().max(512).optional(),
    schemaVersion: z.literal(WORKSPACE_COMPOSITION_SCHEMA_VERSION),
    contract: z.literal(WORKSPACE_COMPOSITION_CONTRACT),
    workspaceId: IdentifierSchema,
    workspaceVersion: SemverSchema,
    repositories: z
      .array(WorkspaceRepositorySchema)
      .min(1)
      .max(WORKSPACE_COMPOSITION_MAX_REPOSITORIES),
    omissions: z
      .array(WorkspaceOmissionSchema)
      .max(WORKSPACE_COMPOSITION_MAX_OMISSIONS)
      .default([]),
    boundaries: z
      .array(WorkspaceBoundarySchema)
      .max(WORKSPACE_COMPOSITION_MAX_BOUNDARIES)
      .default([]),
    limits: WorkspaceCompositionLimitsSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.repositories.length > manifest.limits.maxRepositories) {
      context.addIssue({
        code: "custom",
        path: ["repositories"],
        message: `declares ${manifest.repositories.length} repositories but the manifest limit is ${manifest.limits.maxRepositories}`,
      });
    }
    if (manifest.omissions.length > manifest.limits.maxOmissions) {
      context.addIssue({
        code: "custom",
        path: ["omissions"],
        message: `declares ${manifest.omissions.length} omissions but the manifest limit is ${manifest.limits.maxOmissions}`,
      });
    }
    if (manifest.boundaries.length > manifest.limits.maxBoundaries) {
      context.addIssue({
        code: "custom",
        path: ["boundaries"],
        message: `declares ${manifest.boundaries.length} boundaries but the manifest limit is ${manifest.limits.maxBoundaries}`,
      });
    }

    const repositoryIds = new Set<string>();
    const logicalNames = new Set<string>();
    const localPaths = new Set<string>();
    const snapshotPaths = new Set<string>();
    for (const [index, repository] of manifest.repositories.entries()) {
      if (repositoryIds.has(repository.id)) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "id"],
          message: `duplicate repository identity: ${repository.id}`,
        });
      }
      repositoryIds.add(repository.id);

      if (logicalNames.has(repository.logicalName)) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "logicalName"],
          message: `duplicate repository logical name: ${repository.logicalName}`,
        });
      }
      logicalNames.add(repository.logicalName);

      if (localPaths.has(repository.localPath)) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "localPath"],
          message: `duplicate repository local path: ${repository.localPath}`,
        });
      }
      localPaths.add(repository.localPath);

      if (snapshotPaths.has(repository.snapshot.path)) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "snapshot", "path"],
          message: `duplicate snapshot path: ${repository.snapshot.path}`,
        });
      }
      snapshotPaths.add(repository.snapshot.path);

      if (repository.snapshot.sizeBytes > manifest.limits.maxSnapshotBytes) {
        context.addIssue({
          code: "custom",
          path: ["repositories", index, "snapshot", "sizeBytes"],
          message: `snapshot exceeds the ${manifest.limits.maxSnapshotBytes} byte per-snapshot limit`,
        });
      }
    }

    const omissionIds = new Set<string>();
    for (const [index, omission] of manifest.omissions.entries()) {
      if (repositoryIds.has(omission.id) || omissionIds.has(omission.id)) {
        context.addIssue({
          code: "custom",
          path: ["omissions", index, "id"],
          message: `duplicate workspace identity: ${omission.id}`,
        });
      }
      omissionIds.add(omission.id);
      if (logicalNames.has(omission.logicalName)) {
        context.addIssue({
          code: "custom",
          path: ["omissions", index, "logicalName"],
          message: `duplicate workspace logical name: ${omission.logicalName}`,
        });
      }
      logicalNames.add(omission.logicalName);
    }

    const totalSnapshotBytes = manifest.repositories.reduce(
      (total, repository) => total + repository.snapshot.sizeBytes,
      0,
    );
    if (totalSnapshotBytes > manifest.limits.maxTotalSnapshotBytes) {
      context.addIssue({
        code: "custom",
        path: ["limits", "maxTotalSnapshotBytes"],
        message: `snapshots total ${totalSnapshotBytes} bytes but the manifest limit is ${manifest.limits.maxTotalSnapshotBytes}`,
      });
    }

    const boundaryIds = new Set<string>();
    const knownIdentities = new Set([...repositoryIds, ...omissionIds]);
    for (const [index, boundary] of manifest.boundaries.entries()) {
      if (boundaryIds.has(boundary.id)) {
        context.addIssue({
          code: "custom",
          path: ["boundaries", index, "id"],
          message: `duplicate boundary identity: ${boundary.id}`,
        });
      }
      boundaryIds.add(boundary.id);
      if (!knownIdentities.has(boundary.fromRepository)) {
        context.addIssue({
          code: "custom",
          path: ["boundaries", index, "fromRepository"],
          message: `boundary refers to unknown repository identity: ${boundary.fromRepository}`,
        });
      }
      if (!knownIdentities.has(boundary.toRepository)) {
        context.addIssue({
          code: "custom",
          path: ["boundaries", index, "toRepository"],
          message: `boundary refers to unknown repository identity: ${boundary.toRepository}`,
        });
      }
      if (boundary.fromRepository === boundary.toRepository) {
        context.addIssue({
          code: "custom",
          path: ["boundaries", index],
          message: "boundary endpoints must be different repository identities",
        });
      }
      if (
        boundary.status === "declared" &&
        (omissionIds.has(boundary.fromRepository) ||
          omissionIds.has(boundary.toRepository))
      ) {
        context.addIssue({
          code: "custom",
          path: ["boundaries", index, "status"],
          message:
            "a boundary involving a declared omission must be marked unresolved",
        });
      }
    }
  });

export type WorkspaceCompositionLimits = z.infer<
  typeof WorkspaceCompositionLimitsSchema
>;
export type WorkspaceLocalPath = z.infer<typeof WorkspaceLocalPathSchema>;
export type WorkspaceRepositorySnapshot = z.infer<
  typeof WorkspaceRepositorySnapshotSchema
>;
export type WorkspaceRepository = z.infer<typeof WorkspaceRepositorySchema>;
export type WorkspaceOmission = z.infer<typeof WorkspaceOmissionSchema>;
export type WorkspaceBoundary = z.infer<typeof WorkspaceBoundarySchema>;
export type WorkspaceCompositionManifest = z.infer<
  typeof WorkspaceCompositionManifestSchema
>;

export type WorkspaceCompositionErrorCode =
  | "invalid-manifest"
  | "missing-manifest"
  | "manifest-too-large"
  | "invalid-json"
  | "path-escape";

const issueText = (issues: readonly z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "manifest";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

export class WorkspaceCompositionValidationError extends Error {
  readonly code: WorkspaceCompositionErrorCode;
  readonly issues: readonly z.ZodIssue[];

  constructor(
    code: WorkspaceCompositionErrorCode,
    message: string,
    issues: readonly z.ZodIssue[] = [],
  ) {
    super(message);
    this.name = "WorkspaceCompositionValidationError";
    this.code = code;
    this.issues = issues;
  }
}

const canonicalize = (
  manifest: WorkspaceCompositionManifest,
): WorkspaceCompositionManifest => ({
  ...manifest,
  repositories: [...manifest.repositories].sort((left, right) =>
    compareStrings(left.id, right.id),
  ),
  omissions: [...manifest.omissions].sort((left, right) =>
    compareStrings(left.id, right.id),
  ),
  boundaries: [...manifest.boundaries].sort((left, right) =>
    compareStrings(left.id, right.id),
  ),
});

export const parseWorkspaceCompositionManifest = (
  value: unknown,
): WorkspaceCompositionManifest => {
  const parsed = WorkspaceCompositionManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkspaceCompositionValidationError(
      "invalid-manifest",
      `workspace composition manifest validation failed: ${issueText(parsed.error.issues)}`,
      parsed.error.issues,
    );
  }
  return canonicalize(parsed.data);
};

export const validateWorkspaceCompositionManifest =
  parseWorkspaceCompositionManifest;

export const serializeWorkspaceCompositionManifest = (value: unknown): string =>
  stableStringify(parseWorkspaceCompositionManifest(value));

export const readWorkspaceCompositionManifest = (
  repositoryRoot: string,
  manifestPath: string,
): WorkspaceCompositionManifest => {
  const parsedPath = WorkspaceLocalFileSchema.safeParse(manifestPath);
  if (!parsedPath.success) {
    throw new WorkspaceCompositionValidationError(
      "path-escape",
      `workspace composition manifest path is not local and relative: ${manifestPath}`,
      parsedPath.error.issues,
    );
  }
  const root = resolve(repositoryRoot);
  const candidate = resolve(root, parsedPath.data);
  const withinRoot = relative(root, candidate);
  if (
    withinRoot === ".." ||
    withinRoot.startsWith(`..${sep}`) ||
    withinRoot.startsWith(sep)
  ) {
    throw new WorkspaceCompositionValidationError(
      "path-escape",
      `workspace composition manifest path escapes the repository root: ${manifestPath}`,
    );
  }
  let metadata;
  try {
    metadata = lstatSync(candidate);
  } catch {
    throw new WorkspaceCompositionValidationError(
      "missing-manifest",
      `workspace composition manifest is missing: ${parsedPath.data}`,
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new WorkspaceCompositionValidationError(
      "missing-manifest",
      `workspace composition manifest is not a regular file: ${parsedPath.data}`,
    );
  }
  if (metadata.size > WORKSPACE_COMPOSITION_MAX_MANIFEST_BYTES) {
    throw new WorkspaceCompositionValidationError(
      "manifest-too-large",
      `workspace composition manifest exceeds the ${WORKSPACE_COMPOSITION_MAX_MANIFEST_BYTES} byte ceiling: ${parsedPath.data}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(candidate, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new WorkspaceCompositionValidationError(
      "invalid-json",
      `could not parse workspace composition manifest ${parsedPath.data}: ${detail}`,
    );
  }
  return parseWorkspaceCompositionManifest(value);
};

// Short aliases keep the contract discoverable alongside the existing policy
// and adapter schemas while the longer names remain unambiguous in callers.
export const WorkspaceManifestSchema = WorkspaceCompositionManifestSchema;
export const parseWorkspaceManifest = parseWorkspaceCompositionManifest;
export const serializeWorkspaceManifest = serializeWorkspaceCompositionManifest;

export type WorkspaceManifest = WorkspaceCompositionManifest;
