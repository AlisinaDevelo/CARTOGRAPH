import { createHash } from "node:crypto";

import { z } from "zod";

import { parseAdrReferenceDocument } from "./adr.js";
import {
  ASSURANCE_SIGNING_ALGORITHM,
  ASSURANCE_SIGNING_ALGORITHM_VERSION,
  ASSURANCE_SIGNING_CONTRACT,
  ASSURANCE_SIGNING_SCHEMA_VERSION,
  assuranceSigningPayload,
  evaluateAssuranceSigningRecord,
  type AssuranceSigningKey,
  type AssuranceSigningKeyring,
} from "./assurance-signing.js";
import { parseArchitectureWaiver } from "./architecture-waivers.js";
import { stableStringify } from "./canonical.js";
import { parseCartographConfig } from "./config.js";
import { parseGraphSnapshot } from "./canonical.js";
import { parseGraphDiff } from "./diff.js";
import { FindingLifecycleInputSchema } from "./finding-lifecycle.js";
import { parsePolicyConfig } from "./policy.js";
import { PolicyEvaluationSchema } from "./policy-evaluation.js";
import { ArchitectureQueryResultSchema } from "./query.js";
import { GraphQueryResultSchema } from "./query-language.js";
import { parseReviewSummaryReport } from "./review-summary.js";

export const ASSURANCE_BUNDLE_SCHEMA_VERSION = 1 as const;
export const ASSURANCE_BUNDLE_CONTRACT = "cartograph.assurance-bundle" as const;
export const ASSURANCE_BUNDLE_MANIFEST = "manifest.json" as const;
export const ASSURANCE_BUNDLE_LIMITS = {
  maxArtifacts: 128,
  maxArtifactBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
} as const;

type RoleDefinition = {
  mediaType: string;
  extension: string;
  validate?: (value: unknown) => unknown;
};

const json = (validate?: (value: unknown) => unknown): RoleDefinition => ({
  mediaType: "application/json",
  extension: "json",
  ...(validate === undefined ? {} : { validate }),
});

/**
 * What a bundle can carry. Every role is a CARTOGRAPH contract or report, all
 * of which are source-body-free; there is deliberately no role for source.
 */
export const ASSURANCE_BUNDLE_ROLES = {
  "snapshot-base": json(parseGraphSnapshot),
  "snapshot-head": json(parseGraphSnapshot),
  diff: json(parseGraphDiff),
  policy: json(parsePolicyConfig),
  "policy-evaluation": json((value) => PolicyEvaluationSchema.parse(value)),
  decisions: json(parseAdrReferenceDocument),
  "finding-lifecycle": json((value) =>
    FindingLifecycleInputSchema.parse(value),
  ),
  waiver: json(parseArchitectureWaiver),
  "query-result": json((value) => {
    const graph = GraphQueryResultSchema.safeParse(value);
    return graph.success
      ? graph.data
      : ArchitectureQueryResultSchema.parse(value);
  }),
  "review-summary": json(parseReviewSummaryReport),
  configuration: json((value) => parseCartographConfig(value).config),
  "adapter-manifest": json(),
  "report-html": { mediaType: "text/html", extension: "html" },
  "report-markdown": { mediaType: "text/markdown", extension: "md" },
  "report-sarif": { mediaType: "application/sarif+json", extension: "sarif" },
} as const satisfies Record<string, RoleDefinition>;

export type AssuranceBundleRole = keyof typeof ASSURANCE_BUNDLE_ROLES;
const ROLE_NAMES = Object.keys(ASSURANCE_BUNDLE_ROLES) as [
  AssuranceBundleRole,
  ...AssuranceBundleRole[],
];
const RoleSchema = z.enum(ROLE_NAMES);
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const TextSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !/[\0\r\n]/u.test(value), "must be a single line");
const ArtifactPathSchema = z
  .string()
  .regex(
    /^artifacts\/[a-z0-9-]+-[0-9a-f]{12}\.(?:json|html|md|sarif)$/u,
    "must be an artifacts/<role>-<digest>.<ext> path",
  );

export const AssuranceBundleArtifactSchema = z
  .object({
    role: RoleSchema,
    path: ArtifactPathSchema,
    mediaType: z.string().min(1).max(64),
    sha256: DigestSchema,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(ASSURANCE_BUNDLE_LIMITS.maxArtifactBytes),
    label: TextSchema.optional(),
  })
  .strict();

export const AssuranceBundleManifestSchema = z
  .object({
    schemaVersion: z.literal(ASSURANCE_BUNDLE_SCHEMA_VERSION),
    contract: z.literal(ASSURANCE_BUNDLE_CONTRACT),
    bundleId: DigestSchema,
    tool: z
      .object({ name: z.literal("cartograph-cli"), version: TextSchema })
      .strict(),
    // Digest of the analyzer build that produced the bundle (every file of the
    // installed package plus the TypeScript and ts-morph versions).
    provenance: z
      .object({ analyzerFingerprint: DigestSchema })
      .strict()
      .optional(),
    limits: z
      .object({
        maxArtifacts: z.literal(ASSURANCE_BUNDLE_LIMITS.maxArtifacts),
        maxArtifactBytes: z.literal(ASSURANCE_BUNDLE_LIMITS.maxArtifactBytes),
        maxTotalBytes: z.literal(ASSURANCE_BUNDLE_LIMITS.maxTotalBytes),
      })
      .strict(),
    requiredRoles: z.array(RoleSchema).max(ROLE_NAMES.length),
    artifacts: z
      .array(AssuranceBundleArtifactSchema)
      .max(ASSURANCE_BUNDLE_LIMITS.maxArtifacts),
    missing: z
      .array(z.object({ role: RoleSchema, reason: TextSchema }).strict())
      .max(ROLE_NAMES.length),
    sourceBodiesIncluded: z.literal(false),
  })
  .strict();

export type AssuranceBundleManifest = z.infer<
  typeof AssuranceBundleManifestSchema
>;

export class AssuranceBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssuranceBundleError";
  }
}

export type AssuranceBundleInput = {
  role: AssuranceBundleRole;
  content: Uint8Array;
  label?: string;
};

export type AssuranceBundleBuildOptions = {
  toolVersion: string;
  analyzerFingerprint?: string;
  requiredRoles?: readonly AssuranceBundleRole[];
  missing?: readonly { role: AssuranceBundleRole; reason: string }[];
};

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const contractErrorText = (error: unknown): string => {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (issue !== undefined)
      return `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`;
  }
  const cause =
    error instanceof Error && "cause" in error ? error.cause : undefined;
  if (cause instanceof z.ZodError) return contractErrorText(cause);
  return error instanceof Error
    ? (error.message.split("\n")[0] ?? "invalid")
    : "invalid";
};

const validateContent = (role: AssuranceBundleRole, content: Uint8Array) => {
  const definition: RoleDefinition = ASSURANCE_BUNDLE_ROLES[role];
  if (definition.mediaType === "application/json" || role === "report-sarif") {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
    } catch {
      throw new AssuranceBundleError(`${role} artifact is not valid JSON`);
    }
    try {
      definition.validate?.(value);
    } catch (error) {
      throw new AssuranceBundleError(
        `${role} artifact does not match its contract: ${contractErrorText(error)}`,
      );
    }
  }
};

const serializeManifest = (manifest: AssuranceBundleManifest): string =>
  `${stableStringify(manifest)}\n`;

/**
 * Build a canonical bundle: the manifest text and the artifact files keyed by
 * bundle-relative path. Identical inputs always produce identical bytes; no
 * timestamps, hostnames, or absolute paths are recorded.
 */
export const buildAssuranceBundle = (
  inputs: readonly AssuranceBundleInput[],
  options: AssuranceBundleBuildOptions,
): { manifest: string; files: Map<string, Uint8Array> } => {
  if (inputs.length > ASSURANCE_BUNDLE_LIMITS.maxArtifacts)
    throw new AssuranceBundleError(
      `bundle exceeds the ${ASSURANCE_BUNDLE_LIMITS.maxArtifacts} artifact ceiling`,
    );
  const files = new Map<string, Uint8Array>();
  let total = 0;
  const artifacts = inputs.map((input) => {
    const role = RoleSchema.parse(input.role);
    if (input.content.byteLength > ASSURANCE_BUNDLE_LIMITS.maxArtifactBytes)
      throw new AssuranceBundleError(
        `${role} artifact exceeds the ${ASSURANCE_BUNDLE_LIMITS.maxArtifactBytes} byte ceiling`,
      );
    total += input.content.byteLength;
    if (total > ASSURANCE_BUNDLE_LIMITS.maxTotalBytes)
      throw new AssuranceBundleError(
        `bundle exceeds the ${ASSURANCE_BUNDLE_LIMITS.maxTotalBytes} byte total ceiling`,
      );
    validateContent(role, input.content);
    const digest = sha256(input.content);
    const definition: RoleDefinition = ASSURANCE_BUNDLE_ROLES[role];
    const path = `artifacts/${role}-${digest.slice(0, 12)}.${definition.extension}`;
    if (files.has(path))
      throw new AssuranceBundleError(`duplicate ${role} artifact`);
    files.set(path, input.content);
    return {
      role,
      path,
      mediaType: definition.mediaType,
      sha256: digest,
      bytes: input.content.byteLength,
      ...(input.label === undefined ? {} : { label: input.label }),
    };
  });
  artifacts.sort(
    (left, right) =>
      compare(left.role, right.role) || compare(left.path, right.path),
  );
  const requiredRoles = [
    ...new Set(options.requiredRoles ?? artifacts.map((item) => item.role)),
  ].sort(compare);
  const missing = [...(options.missing ?? [])].sort((left, right) =>
    compare(left.role, right.role),
  );
  const present = new Set(artifacts.map((item) => item.role));
  for (const role of requiredRoles)
    if (!present.has(role) && !missing.some((item) => item.role === role))
      throw new AssuranceBundleError(
        `required ${role} artifact is absent and not declared missing`,
      );
  for (const item of missing)
    if (present.has(item.role))
      throw new AssuranceBundleError(
        `${item.role} is declared missing but is present`,
      );
  const body = {
    schemaVersion: ASSURANCE_BUNDLE_SCHEMA_VERSION,
    contract: ASSURANCE_BUNDLE_CONTRACT,
    tool: { name: "cartograph-cli" as const, version: options.toolVersion },
    ...(options.analyzerFingerprint === undefined
      ? {}
      : { provenance: { analyzerFingerprint: options.analyzerFingerprint } }),
    limits: { ...ASSURANCE_BUNDLE_LIMITS },
    requiredRoles,
    artifacts,
    missing,
    sourceBodiesIncluded: false as const,
  };
  const manifest = AssuranceBundleManifestSchema.parse({
    ...body,
    bundleId: sha256(stableStringify(body)),
  });
  return { manifest: serializeManifest(manifest), files };
};

export type AssuranceBundleVerification = {
  ok: boolean;
  bundleId?: string;
  artifacts: number;
  problems: string[];
};

/**
 * Offline verification of a bundle directory's contents. `files` lists every
 * regular file under the bundle (bundle-relative, forward slashes) and
 * `read` returns its bytes. Reports altered, missing, unexpected, oversized,
 * substituted, and contract-invalid artifacts, and missing required roles.
 */
export const verifyAssuranceBundle = (
  files: readonly string[],
  read: (path: string) => Uint8Array,
): AssuranceBundleVerification => {
  const problems: string[] = [];
  if (!files.includes(ASSURANCE_BUNDLE_MANIFEST))
    return { ok: false, artifacts: 0, problems: ["manifest.json is missing"] };
  let manifest: AssuranceBundleManifest;
  const manifestText = Buffer.from(read(ASSURANCE_BUNDLE_MANIFEST)).toString(
    "utf8",
  );
  try {
    manifest = AssuranceBundleManifestSchema.parse(
      JSON.parse(manifestText) as unknown,
    );
  } catch (error) {
    return {
      ok: false,
      artifacts: 0,
      problems: [
        `manifest.json is not a valid assurance bundle manifest: ${error instanceof Error ? error.message.split("\n")[0] : "invalid"}`,
      ],
    };
  }
  if (serializeManifest(manifest) !== manifestText)
    problems.push("manifest.json is not in canonical form");
  const { bundleId, ...body } = manifest;
  if (sha256(stableStringify(body)) !== bundleId)
    problems.push("bundleId does not match the manifest contents");

  const listed = new Set(manifest.artifacts.map((item) => item.path));
  for (const file of files)
    if (file !== ASSURANCE_BUNDLE_MANIFEST && !listed.has(file))
      problems.push(`unexpected file ${file}`);
  let total = 0;
  for (const artifact of manifest.artifacts) {
    if (!files.includes(artifact.path)) {
      problems.push(`missing ${artifact.role} artifact ${artifact.path}`);
      continue;
    }
    const content = read(artifact.path);
    total += content.byteLength;
    if (content.byteLength !== artifact.bytes)
      problems.push(`${artifact.path} size does not match the manifest`);
    const digest = sha256(content);
    if (digest !== artifact.sha256)
      problems.push(`${artifact.path} digest does not match the manifest`);
    if (!artifact.path.includes(`-${artifact.sha256.slice(0, 12)}.`))
      problems.push(`${artifact.path} is not named for its digest`);
    const definition: RoleDefinition = ASSURANCE_BUNDLE_ROLES[artifact.role];
    if (artifact.mediaType !== definition.mediaType)
      problems.push(
        `${artifact.path} has the wrong media type for ${artifact.role}`,
      );
    if (digest === artifact.sha256)
      try {
        validateContent(artifact.role, content);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
  }
  if (total > ASSURANCE_BUNDLE_LIMITS.maxTotalBytes)
    problems.push("bundle exceeds its total byte ceiling");
  const present = new Set(manifest.artifacts.map((item) => item.role));
  for (const role of manifest.requiredRoles)
    if (
      !present.has(role) &&
      !manifest.missing.some((item) => item.role === role)
    )
      problems.push(
        `required ${role} artifact is absent and not declared missing`,
      );
  return {
    ok: problems.length === 0,
    bundleId,
    artifacts: manifest.artifacts.length,
    problems,
  };
};

/**
 * Digest a signature covers: the exact bytes of manifest.json, in the
 * assurance-signing `sha256:<hex>` form.
 */
export const assuranceBundleManifestDigest = (manifestText: string): string =>
  `sha256:${sha256(manifestText)}`;

export type AssuranceBundleSigningRequest = {
  signerKeyId: string;
  signedAt: string;
  expiresAt: string;
};

/**
 * The unsigned signing record for a bundle and the exact UTF-8 payload to
 * sign with Ed25519. Signing happens outside CARTOGRAPH, so no private key is
 * ever read, stored, or reported by the tool.
 */
export const assuranceBundleSigningPayload = (
  manifestText: string,
  request: AssuranceBundleSigningRequest,
): {
  payload: string;
  record: Record<string, unknown>;
} => {
  const record = {
    schemaVersion: ASSURANCE_SIGNING_SCHEMA_VERSION,
    contract: ASSURANCE_SIGNING_CONTRACT,
    manifestDigest: assuranceBundleManifestDigest(manifestText),
    signerKeyId: request.signerKeyId,
    algorithm: ASSURANCE_SIGNING_ALGORITHM,
    algorithmVersion: ASSURANCE_SIGNING_ALGORITHM_VERSION,
    signedAt: request.signedAt,
    expiresAt: request.expiresAt,
  };
  return { payload: assuranceSigningPayload(record), record };
};

export type AssuranceBundleSignatureResult = {
  status: "verified" | "failed";
  code: string;
  signerKeyId?: string;
};

/**
 * Verify a signing record against this bundle's manifest: it must cover the
 * manifest's exact digest, then pass the assurance-signing checks (trusted
 * root, key validity window, rotation, revocation, record expiry, algorithm,
 * and signature).
 */
export const verifyAssuranceBundleSignature = (
  manifestText: string,
  record: unknown,
  options: {
    keyring: AssuranceSigningKeyring | readonly AssuranceSigningKey[];
    trustedRootIds: readonly string[];
    now?: Date | string;
  },
): AssuranceBundleSignatureResult => {
  const digest =
    record && typeof record === "object" && "manifestDigest" in record
      ? record.manifestDigest
      : undefined;
  if (digest !== assuranceBundleManifestDigest(manifestText))
    return { status: "failed", code: "manifest-mismatch" };
  const report = evaluateAssuranceSigningRecord(record, options);
  return {
    status: report.status === "verified" ? "verified" : "failed",
    code: report.code,
    ...(report.signerKeyId === undefined
      ? {}
      : { signerKeyId: report.signerKeyId }),
  };
};
