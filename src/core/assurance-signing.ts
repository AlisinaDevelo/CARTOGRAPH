import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

import { z } from "zod";

import { stableStringify } from "./canonical.js";

export const ASSURANCE_SIGNING_SCHEMA_VERSION = 1 as const;
export const ASSURANCE_SIGNING_CONTRACT =
  "cartograph.assurance-signing" as const;
export const ASSURANCE_SIGNING_ALGORITHM = "ed25519" as const;
export const ASSURANCE_SIGNING_ALGORITHM_VERSION = 1 as const;

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
const DateTimeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "must be a parseable date-time",
  );
const Base64UrlSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/u, "must be unpadded base64url");

export const AssuranceSigningKeySchema = z
  .object({
    keyId: IdentifierSchema,
    trustRootId: IdentifierSchema,
    algorithm: z.string().trim().min(1).max(64),
    algorithmVersion: z.number().int().positive(),
    publicKey: Base64UrlSchema,
    status: z.enum(["active", "retired", "revoked"]),
    validFrom: DateTimeSchema,
    validUntil: DateTimeSchema,
    retiredAt: DateTimeSchema.nullable(),
    revokedAt: DateTimeSchema.nullable(),
    rotatedFrom: IdentifierSchema.nullable(),
  })
  .strict()
  .superRefine((key, context) => {
    if (Date.parse(key.validFrom) >= Date.parse(key.validUntil)) {
      context.addIssue({
        code: "custom",
        path: ["validUntil"],
        message: "must be later than validFrom",
      });
    }
    if (key.status === "retired" && key.retiredAt === null) {
      context.addIssue({
        code: "custom",
        path: ["retiredAt"],
        message: "retired keys require retiredAt",
      });
    }
    if (key.status === "revoked" && key.revokedAt === null) {
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "revoked keys require revokedAt",
      });
    }
  });

export const AssuranceSigningKeyringSchema = z
  .object({
    schemaVersion: z.literal(ASSURANCE_SIGNING_SCHEMA_VERSION),
    keys: z.array(AssuranceSigningKeySchema).min(1).max(1_000),
  })
  .strict()
  .superRefine((keyring, context) => {
    const ids = new Set<string>();
    for (const [index, key] of keyring.keys.entries()) {
      if (ids.has(key.keyId)) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "keyId"],
          message: "key IDs must be unique",
        });
      }
      ids.add(key.keyId);
    }
  });

export const AssuranceSigningRecordSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    contract: z.string().trim().min(1).max(160),
    manifestDigest: DigestSchema,
    signerKeyId: IdentifierSchema,
    algorithm: z.string().trim().min(1).max(64),
    algorithmVersion: z.number().int().positive(),
    signature: Base64UrlSchema,
    signedAt: DateTimeSchema,
    expiresAt: DateTimeSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (Date.parse(record.signedAt) >= Date.parse(record.expiresAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "must be later than signedAt",
      });
    }
  });

const VerificationCodeSchema = z.enum([
  "verified",
  "invalid-record",
  "unsupported-version",
  "unsupported-algorithm",
  "missing-key",
  "missing-trust-root",
  "rotation-invalid",
  "revoked",
  "expired",
  "key-not-valid",
  "invalid-signature",
]);

export const AssuranceSigningVerificationReportSchema = z
  .object({
    schemaVersion: z.literal(ASSURANCE_SIGNING_SCHEMA_VERSION),
    contract: z.literal(ASSURANCE_SIGNING_CONTRACT),
    digestOnly: z.literal(true),
    manifestDigest: DigestSchema,
    signerKeyId: IdentifierSchema,
    status: z.enum(["verified", "failed"]),
    code: VerificationCodeSchema,
  })
  .strict()
  .superRefine((report, context) => {
    if (
      (report.status === "verified" && report.code !== "verified") ||
      (report.status === "failed" && report.code === "verified")
    ) {
      context.addIssue({
        code: "custom",
        path: ["code"],
        message: "verification status and code must agree",
      });
    }
  });

export type AssuranceSigningKey = z.infer<typeof AssuranceSigningKeySchema>;
export type AssuranceSigningKeyring = z.infer<
  typeof AssuranceSigningKeyringSchema
>;
export type AssuranceSigningRecord = z.infer<
  typeof AssuranceSigningRecordSchema
>;
export type AssuranceSigningVerificationReport = z.infer<
  typeof AssuranceSigningVerificationReportSchema
>;
export type AssuranceSigningVerificationCode = z.infer<
  typeof VerificationCodeSchema
>;

export type AssuranceSigningVerificationErrorCode = Exclude<
  AssuranceSigningVerificationCode,
  "verified"
>;

export class AssuranceSigningVerificationError extends Error {
  readonly code: AssuranceSigningVerificationErrorCode;
  readonly report?: AssuranceSigningVerificationReport;

  constructor(
    code: AssuranceSigningVerificationErrorCode,
    message: string,
    report?: AssuranceSigningVerificationReport,
  ) {
    super(message);
    this.name = "AssuranceSigningVerificationError";
    this.code = code;
    if (report) this.report = report;
  }
}

export interface VerifyAssuranceSigningOptions {
  keyring: AssuranceSigningKeyring | readonly AssuranceSigningKey[];
  trustedRootIds: readonly string[];
  now?: Date | string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const fallbackDigest = (input: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(stableStringify(input), "utf8").digest("hex")}`;

const reportIdentity = (
  input: unknown,
): { manifestDigest: `sha256:${string}`; signerKeyId: string } => {
  const record = asRecord(input);
  const manifestDigest =
    typeof record?.manifestDigest === "string" &&
    DigestSchema.safeParse(record.manifestDigest).success
      ? (record.manifestDigest as `sha256:${string}`)
      : fallbackDigest(input);
  const signerKeyId =
    typeof record?.signerKeyId === "string" &&
    IdentifierSchema.safeParse(record.signerKeyId).success
      ? record.signerKeyId
      : "unknown-signer";
  return { manifestDigest, signerKeyId };
};

const parseNow = (value: Date | string | undefined): Date => {
  const now =
    value instanceof Date
      ? new Date(value.valueOf())
      : new Date(value ?? Date.now());
  if (!Number.isFinite(now.valueOf()))
    throw new AssuranceSigningVerificationError(
      "invalid-record",
      "verification now must be a valid date",
    );
  return now;
};

const parseKeyring = (
  input: AssuranceSigningKeyring | readonly AssuranceSigningKey[],
): AssuranceSigningKey[] => {
  const parsed = Array.isArray(input)
    ? AssuranceSigningKeyringSchema.safeParse({
        schemaVersion: ASSURANCE_SIGNING_SCHEMA_VERSION,
        keys: input,
      })
    : AssuranceSigningKeyringSchema.safeParse(input);
  if (!parsed.success)
    throw new AssuranceSigningVerificationError(
      "invalid-record",
      "assurance signing keyring does not match the contract",
    );
  return parsed.data.keys;
};

const parseTrustedRoots = (input: readonly string[]): string[] => {
  const parsed = z.array(IdentifierSchema).max(1_000).safeParse(input);
  if (!parsed.success)
    throw new AssuranceSigningVerificationError(
      "invalid-record",
      "trusted root references do not match the contract",
    );
  return parsed.data;
};

export const assuranceSigningPayload = (
  record: Pick<
    AssuranceSigningRecord,
    | "manifestDigest"
    | "signerKeyId"
    | "algorithm"
    | "algorithmVersion"
    | "signedAt"
    | "expiresAt"
  >,
): string =>
  stableStringify({
    algorithm: record.algorithm,
    algorithmVersion: record.algorithmVersion,
    expiresAt: record.expiresAt,
    manifestDigest: record.manifestDigest,
    signedAt: record.signedAt,
    signerKeyId: record.signerKeyId,
  });

const failedReport = (
  input: unknown,
  code: AssuranceSigningVerificationCode,
): AssuranceSigningVerificationReport => {
  const identity = reportIdentity(input);
  return AssuranceSigningVerificationReportSchema.parse({
    schemaVersion: ASSURANCE_SIGNING_SCHEMA_VERSION,
    contract: ASSURANCE_SIGNING_CONTRACT,
    digestOnly: true,
    manifestDigest: identity.manifestDigest,
    signerKeyId: identity.signerKeyId,
    status: "failed",
    code,
  });
};

const fail = (
  input: unknown,
  code: AssuranceSigningVerificationErrorCode,
  _message: string,
): AssuranceSigningVerificationReport => failedReport(input, code);

export const evaluateAssuranceSigningRecord = (
  input: unknown,
  options: VerifyAssuranceSigningOptions,
): AssuranceSigningVerificationReport => {
  const parsed = AssuranceSigningRecordSchema.safeParse(input);
  if (!parsed.success)
    return fail(input, "invalid-record", "signing record is invalid");
  const record = parsed.data;
  if (record.schemaVersion !== ASSURANCE_SIGNING_SCHEMA_VERSION)
    return fail(
      input,
      "unsupported-version",
      "unsupported signing record version",
    );
  if (record.contract !== ASSURANCE_SIGNING_CONTRACT)
    return fail(input, "unsupported-version", "unsupported signing contract");

  const keys = parseKeyring(options.keyring);
  const trustedRoots = parseTrustedRoots(options.trustedRootIds);
  const key = keys.find((candidate) => candidate.keyId === record.signerKeyId);
  if (!key)
    return fail(
      input,
      "missing-key",
      "signing key is not present; no fallback key is accepted",
    );
  if (!trustedRoots.includes(key.trustRootId))
    return fail(
      input,
      "missing-trust-root",
      "signing key trust root is not explicitly trusted",
    );
  if (
    record.algorithm !== ASSURANCE_SIGNING_ALGORITHM ||
    record.algorithmVersion !== ASSURANCE_SIGNING_ALGORITHM_VERSION ||
    key.algorithm !== ASSURANCE_SIGNING_ALGORITHM ||
    key.algorithmVersion !== ASSURANCE_SIGNING_ALGORITHM_VERSION
  )
    return fail(
      input,
      "unsupported-algorithm",
      "signing algorithm or version is unsupported",
    );

  if (
    key.rotatedFrom !== null &&
    !keys.some((candidate) => candidate.keyId === key.rotatedFrom)
  )
    return fail(
      input,
      "rotation-invalid",
      "rotated key references a missing predecessor",
    );
  if (key.status === "revoked" || key.revokedAt !== null)
    return fail(input, "revoked", "signing key is explicitly revoked");

  const now = parseNow(options.now);
  if (Date.parse(record.expiresAt) <= now.valueOf())
    return fail(input, "expired", "signing record is expired");
  if (
    Date.parse(record.signedAt) < Date.parse(key.validFrom) ||
    Date.parse(record.signedAt) > Date.parse(key.validUntil)
  )
    return fail(
      input,
      "key-not-valid",
      "signing key was not valid at signedAt",
    );
  if (
    key.status === "retired" &&
    (key.retiredAt === null ||
      Date.parse(record.signedAt) >= Date.parse(key.retiredAt))
  )
    return fail(
      input,
      "rotation-invalid",
      "retired signing key cannot sign after rotation",
    );

  let signatureValid: boolean;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKey, "base64url"),
      format: "der",
      type: "spki",
    });
    signatureValid = verifySignature(
      null,
      Buffer.from(assuranceSigningPayload(record), "utf8"),
      publicKey,
      Buffer.from(record.signature, "base64url"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid)
    return fail(input, "invalid-signature", "signature verification failed");

  return AssuranceSigningVerificationReportSchema.parse({
    schemaVersion: ASSURANCE_SIGNING_SCHEMA_VERSION,
    contract: ASSURANCE_SIGNING_CONTRACT,
    digestOnly: true,
    manifestDigest: record.manifestDigest,
    signerKeyId: record.signerKeyId,
    status: "verified",
    code: "verified",
  });
};

export const verifyAssuranceSigningRecord = (
  input: unknown,
  options: VerifyAssuranceSigningOptions,
): AssuranceSigningVerificationReport => {
  const report = evaluateAssuranceSigningRecord(input, options);
  if (report.status === "failed") {
    if (report.code === "verified") return report;
    throw new AssuranceSigningVerificationError(
      report.code,
      `assurance signing verification failed: ${report.code}`,
      report,
    );
  }
  return report;
};

export const serializeAssuranceSigningVerificationReport = (
  report: unknown,
): string =>
  stableStringify(AssuranceSigningVerificationReportSchema.parse(report));
