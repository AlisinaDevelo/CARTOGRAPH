import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { relative, resolve, sep } from "node:path";

import { z } from "zod";

import { createResourceBudget, ResourceLimitError } from "../resources.js";
import { materializeRevision, resolveRepositoryRoot } from "../git/revision.js";
import { stableStringify } from "./canonical.js";

const execFileAsync = promisify(execFile);

export const PATCH_PREVIEW_SCHEMA_VERSION = 1 as const;
export const PATCH_PREVIEW_CONTRACT = "cartograph.patch-preview" as const;
export const PATCH_PREVIEW_MAX_OPERATIONS = 32 as const;
export const PATCH_PREVIEW_MAX_REPLACEMENT_BYTES = 64 * 1024;

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
        message: "must be a repository-relative path without traversal",
      });
      return z.NEVER;
    }
    const compact = parts.filter((part) => part.length > 0 && part !== ".");
    if (compact.length === 0) {
      context.addIssue({
        code: "custom",
        message: "must name a file",
      });
      return z.NEVER;
    }
    return compact.join("/");
  });

const GitRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) => !value.startsWith("-") && !/[\0\r\n]/u.test(value),
    "must be a safe Git ref",
  );

export const PatchPreviewOperationSchema = z
  .object({
    path: PortableRelativePathSchema,
    expectedDigest: DigestSchema,
    replacement: z.string().max(PATCH_PREVIEW_MAX_REPLACEMENT_BYTES),
  })
  .strict();

export const PatchPreviewValidationCommandSchema = z.enum([
  "verify-patch",
  "node-version",
  "npm-version",
]);

export const PatchPreviewRequestSchema = z
  .object({
    schemaVersion: z.literal(PATCH_PREVIEW_SCHEMA_VERSION),
    contract: z.literal(PATCH_PREVIEW_CONTRACT),
    previewId: IdentifierSchema,
    sourceRef: GitRefSchema,
    operations: z
      .array(PatchPreviewOperationSchema)
      .min(1)
      .max(PATCH_PREVIEW_MAX_OPERATIONS),
    validationCommands: z
      .array(PatchPreviewValidationCommandSchema)
      .min(1)
      .max(4)
      .default(["verify-patch"]),
  })
  .strict()
  .superRefine((request, context) => {
    const paths = new Set<string>();
    for (const [index, operation] of request.operations.entries()) {
      if (paths.has(operation.path)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "path"],
          message: "patch operation paths must be unique",
        });
      }
      paths.add(operation.path);
    }
    if (
      new Set(request.validationCommands).size !==
      request.validationCommands.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["validationCommands"],
        message: "validation commands must be unique",
      });
    }
  });

export const PatchPreviewAppliedOperationSchema = z
  .object({
    path: PortableRelativePathSchema,
    beforeDigest: DigestSchema,
    afterDigest: DigestSchema,
  })
  .strict();

export const PatchPreviewValidationResultSchema = z
  .object({
    command: PatchPreviewValidationCommandSchema,
    status: z.enum(["passed", "failed", "skipped"]),
    outputDigest: DigestSchema.nullable(),
    detail: z.string().trim().min(1).max(512),
  })
  .strict();

export const PatchPreviewReportSchema = z
  .object({
    schemaVersion: z.literal(PATCH_PREVIEW_SCHEMA_VERSION),
    contract: z.literal(PATCH_PREVIEW_CONTRACT),
    previewId: IdentifierSchema,
    sourceRef: GitRefSchema,
    sourceCommit: z.string().regex(/^[0-9a-f]{40,64}$/u),
    requestDigest: DigestSchema,
    originalStatusDigest: DigestSchema,
    originalDirty: z.boolean(),
    status: z.enum(["passed", "conflict", "validation-failed"]),
    operations: z
      .array(PatchPreviewAppliedOperationSchema)
      .max(PATCH_PREVIEW_MAX_OPERATIONS),
    validation: z.array(PatchPreviewValidationResultSchema).max(4),
    conflictPath: PortableRelativePathSchema.nullable(),
    errorCode: z
      .enum([
        "path-conflict",
        "digest-conflict",
        "invalid-target",
        "validation-failed",
      ])
      .nullable(),
    worktreePreserved: z.literal(true),
    requiresExplicitApplication: z.literal(true),
    rollbackInstructions: z
      .array(z.string().trim().min(1).max(512))
      .min(1)
      .max(8),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.status === "passed" && report.errorCode !== null) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "passed previews cannot contain an error code",
      });
    }
    if (report.status === "conflict" && report.conflictPath === null) {
      context.addIssue({
        code: "custom",
        path: ["conflictPath"],
        message: "conflicted previews must identify a path",
      });
    }
  });

export type PatchPreviewOperation = z.infer<typeof PatchPreviewOperationSchema>;
export type PatchPreviewValidationCommand = z.infer<
  typeof PatchPreviewValidationCommandSchema
>;
export type PatchPreviewRequest = z.infer<typeof PatchPreviewRequestSchema>;
export type PatchPreviewAppliedOperation = z.infer<
  typeof PatchPreviewAppliedOperationSchema
>;
export type PatchPreviewValidationResult = z.infer<
  typeof PatchPreviewValidationResultSchema
>;
export type PatchPreviewReport = z.infer<typeof PatchPreviewReportSchema>;

export type PatchPreviewErrorCode =
  "invalid-input" | "resource-limit" | "materialization-failed";

export class PatchPreviewError extends Error {
  readonly code: PatchPreviewErrorCode;

  constructor(code: PatchPreviewErrorCode, message: string) {
    super(message);
    this.name = "PatchPreviewError";
    this.code = code;
  }
}

export interface PatchPreviewOptions {
  root: string;
  request: unknown;
  resources?: {
    maxArchiveBytes?: number;
    maxMemoryBytes?: number;
    maxWallClockMs?: number;
    maxReplacementBytes?: number;
  };
  runValidation?: boolean;
  signal?: AbortSignal;
}

const digestText = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

export const patchContentDigest = (value: string): `sha256:${string}` =>
  digestText(value);

export const patchPreviewRequestDigest = (
  request: PatchPreviewRequest,
): `sha256:${string}` => digestText(stableStringify(request));

const containedPath = (root: string, path: string): string => {
  const candidate = resolve(root, path);
  const relativePath = relative(root, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  )
    throw new PatchPreviewError(
      "invalid-input",
      `patch path escapes the isolated worktree: ${path}`,
    );
  return candidate;
};

const statusSnapshot = async (
  root: string,
  maxWallClockMs: number,
): Promise<{ dirty: boolean; digest: `sha256:${string}` }> => {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"],
      { maxBuffer: 1024 * 1024, timeout: maxWallClockMs },
    );
    const status = String(result.stdout);
    return { dirty: status.length > 0, digest: digestText(status) };
  } catch (error) {
    throw new PatchPreviewError(
      "materialization-failed",
      `could not record original Git status: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const rollbackInstructions = [
  "The isolated preview is discarded after validation; the original worktree is not modified.",
  "Applying a suggestion requires an explicit user-controlled patch operation outside CARTOGRAPH's default flow.",
  "If a user applies it externally, revert the exact paths or restore the recorded source commit to roll back.",
];

const baseReport = (
  request: PatchPreviewRequest,
  sourceCommit: string,
  requestDigest: `sha256:${string}`,
  originalStatusDigest: `sha256:${string}`,
  originalDirty: boolean,
  status: PatchPreviewReport["status"],
  operations: PatchPreviewAppliedOperation[],
  validation: PatchPreviewValidationResult[],
  conflictPath: string | null,
  errorCode: PatchPreviewReport["errorCode"],
): PatchPreviewReport =>
  PatchPreviewReportSchema.parse({
    schemaVersion: PATCH_PREVIEW_SCHEMA_VERSION,
    contract: PATCH_PREVIEW_CONTRACT,
    previewId: request.previewId,
    sourceRef: request.sourceRef,
    sourceCommit,
    requestDigest,
    originalStatusDigest,
    originalDirty,
    status,
    operations,
    validation,
    conflictPath,
    errorCode,
    worktreePreserved: true,
    requiresExplicitApplication: true,
    rollbackInstructions,
  });

const runValidation = async (
  command: PatchPreviewValidationCommand,
  isolatedRoot: string,
  operations: readonly PatchPreviewAppliedOperation[],
  requestOperations: readonly PatchPreviewOperation[],
  maxWallClockMs: number,
): Promise<PatchPreviewValidationResult> => {
  try {
    if (command === "verify-patch") {
      for (const operation of operations) {
        const path = containedPath(isolatedRoot, operation.path);
        const current = await readFile(path, "utf8");
        if (patchContentDigest(current) !== operation.afterDigest)
          return {
            command,
            status: "failed",
            outputDigest: null,
            detail: `post-patch digest changed unexpectedly for ${operation.path}`,
          };
      }
      return {
        command,
        status: "passed",
        outputDigest: digestText(
          stableStringify({ operations, requestOperations }),
        ),
        detail: "all isolated patch digests match",
      };
    }
    const executable = command === "node-version" ? process.execPath : "npm";
    const args = ["--version"];
    const result = await execFileAsync(executable, args, {
      cwd: isolatedRoot,
      maxBuffer: 8 * 1024,
      timeout: maxWallClockMs,
    });
    return {
      command,
      status: "passed",
      outputDigest: digestText(String(result.stdout)),
      detail: `${command} completed without network or repository-selected arguments`,
    };
  } catch (error) {
    return {
      command,
      status: "failed",
      outputDigest: null,
      detail:
        `${command} failed: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          512,
        ),
    };
  }
};

export const previewPatch = async (
  options: PatchPreviewOptions,
): Promise<PatchPreviewReport> => {
  const parsed = PatchPreviewRequestSchema.safeParse(options.request);
  if (!parsed.success)
    throw new PatchPreviewError(
      "invalid-input",
      `patch preview request is invalid: ${parsed.error.message}`,
    );
  const request = parsed.data;
  const maxWallClockMs = options.resources?.maxWallClockMs ?? 30_000;
  const maxMemoryBytes = options.resources?.maxMemoryBytes ?? 512 * 1024 * 1024;
  const maxArchiveBytes =
    options.resources?.maxArchiveBytes ?? 64 * 1024 * 1024;
  const maxReplacementBytes =
    options.resources?.maxReplacementBytes ??
    PATCH_PREVIEW_MAX_REPLACEMENT_BYTES;
  const checkBudget = createResourceBudget({
    maxMemoryBytes,
    maxWallClockMs,
    subject: "patch preview",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  checkBudget();
  const repositoryRoot = await resolveRepositoryRoot(options.root, {
    maxWallClockMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const originalStatus = await statusSnapshot(repositoryRoot, maxWallClockMs);
  const requestDigest = patchPreviewRequestDigest(request);
  let revision: Awaited<ReturnType<typeof materializeRevision>> | undefined;
  try {
    revision = await materializeRevision(repositoryRoot, request.sourceRef, {
      resources: {
        maxArchiveBytes,
        maxMemoryBytes,
        maxWallClockMs,
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    checkBudget();
    const applied: PatchPreviewAppliedOperation[] = [];
    for (const operation of request.operations) {
      checkBudget();
      const target = containedPath(revision.root, operation.path);
      let metadata;
      try {
        metadata = await lstat(target);
      } catch {
        return baseReport(
          request,
          revision.commit,
          requestDigest,
          originalStatus.digest,
          originalStatus.dirty,
          "conflict",
          applied,
          [],
          operation.path,
          "invalid-target",
        );
      }
      if (!metadata.isFile() || metadata.isSymbolicLink())
        return baseReport(
          request,
          revision.commit,
          requestDigest,
          originalStatus.digest,
          originalStatus.dirty,
          "conflict",
          applied,
          [],
          operation.path,
          "invalid-target",
        );
      if (metadata.size > maxReplacementBytes)
        throw new ResourceLimitError(
          `patch target exceeds the ${maxReplacementBytes} byte replacement ceiling`,
        );
      const current = await readFile(target, "utf8");
      const beforeDigest = patchContentDigest(current);
      if (beforeDigest !== operation.expectedDigest)
        return baseReport(
          request,
          revision.commit,
          requestDigest,
          originalStatus.digest,
          originalStatus.dirty,
          "conflict",
          applied,
          [],
          operation.path,
          "digest-conflict",
        );
      if (
        Buffer.byteLength(operation.replacement, "utf8") > maxReplacementBytes
      )
        throw new ResourceLimitError(
          `patch replacement exceeds the ${maxReplacementBytes} byte replacement ceiling`,
        );
      await writeFile(target, operation.replacement, "utf8");
      applied.push({
        path: operation.path,
        beforeDigest,
        afterDigest: patchContentDigest(operation.replacement),
      });
    }
    const validation: PatchPreviewValidationResult[] = [];
    for (const command of request.validationCommands) {
      checkBudget();
      validation.push(
        options.runValidation === false
          ? {
              command,
              status: "skipped",
              outputDigest: null,
              detail: "validation was explicitly disabled by the caller",
            }
          : await runValidation(
              command,
              revision.root,
              applied,
              request.operations,
              maxWallClockMs,
            ),
      );
    }
    const failed = validation.some((result) => result.status === "failed");
    return baseReport(
      request,
      revision.commit,
      requestDigest,
      originalStatus.digest,
      originalStatus.dirty,
      failed ? "validation-failed" : "passed",
      applied,
      validation,
      null,
      failed ? "validation-failed" : null,
    );
  } catch (error) {
    if (error instanceof ResourceLimitError)
      throw new PatchPreviewError("resource-limit", error.message);
    if (error instanceof PatchPreviewError) throw error;
    throw new PatchPreviewError(
      "materialization-failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await revision?.cleanup();
  }
};

export const serializePatchPreviewReport = (report: unknown): string =>
  stableStringify(PatchPreviewReportSchema.parse(report));
