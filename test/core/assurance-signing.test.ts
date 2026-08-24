import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  assuranceSigningPayload,
  AssuranceSigningKeySchema,
  AssuranceSigningKeyringSchema,
  AssuranceSigningRecordSchema,
  AssuranceSigningVerificationError,
  AssuranceSigningVerificationReportSchema,
  ASSURANCE_SIGNING_ALGORITHM,
  ASSURANCE_SIGNING_ALGORITHM_VERSION,
  ASSURANCE_SIGNING_CONTRACT,
  ASSURANCE_SIGNING_SCHEMA_VERSION,
  evaluateAssuranceSigningRecord,
  serializeAssuranceSigningVerificationReport,
  verifyAssuranceSigningRecord,
  type AssuranceSigningKey,
  type AssuranceSigningRecord,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixture = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "test/fixtures/assurance-signing/scenarios.v0.1.json",
    ),
    "utf8",
  ),
) as { manifestDigest: `sha256:${string}` };

const keyPair = generateKeyPairSync("ed25519");
const publicKey = keyPair.publicKey
  .export({ type: "spki", format: "der" })
  .toString("base64url");

const baseKey: AssuranceSigningKey = {
  keyId: "signer-old",
  trustRootId: "root-local",
  algorithm: ASSURANCE_SIGNING_ALGORITHM,
  algorithmVersion: ASSURANCE_SIGNING_ALGORITHM_VERSION,
  publicKey,
  status: "active",
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: "2028-12-31T23:59:59.000Z",
  retiredAt: null,
  revokedAt: null,
  rotatedFrom: null,
};

const makeRecord = (
  signerKeyId = baseKey.keyId,
  manifestDigest = fixture.manifestDigest,
): AssuranceSigningRecord => {
  const unsigned = {
    schemaVersion: ASSURANCE_SIGNING_SCHEMA_VERSION,
    contract: ASSURANCE_SIGNING_CONTRACT,
    manifestDigest,
    signerKeyId,
    algorithm: ASSURANCE_SIGNING_ALGORITHM,
    algorithmVersion: ASSURANCE_SIGNING_ALGORITHM_VERSION,
    signedAt: "2026-06-01T00:00:00.000Z",
    expiresAt: "2027-06-01T00:00:00.000Z",
  };
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(assuranceSigningPayload(unsigned), "utf8"),
      keyPair.privateKey,
    ).toString("base64url"),
  };
};

const options = (key: AssuranceSigningKey = baseKey) => ({
  keyring: [key],
  trustedRootIds: [baseKey.trustRootId],
  now: "2026-08-24T00:00:00.000Z",
});

describe("assurance signing metadata", () => {
  it("verifies a historical signature from a retired key without accepting post-rotation signatures", () => {
    const retired = {
      ...baseKey,
      status: "retired" as const,
      retiredAt: "2026-12-31T23:59:59.000Z",
    };
    expect(
      evaluateAssuranceSigningRecord(makeRecord(), options(retired)),
    ).toMatchObject({
      status: "verified",
      code: "verified",
      digestOnly: true,
    });

    const postRotation = makeRecord();
    postRotation.signedAt = "2027-01-01T00:00:00.000Z";
    postRotation.expiresAt = "2027-06-01T00:00:00.000Z";
    postRotation.signature = sign(
      null,
      Buffer.from(assuranceSigningPayload(postRotation), "utf8"),
      keyPair.privateKey,
    ).toString("base64url");
    expect(
      evaluateAssuranceSigningRecord(postRotation, options(retired)).code,
    ).toBe("rotation-invalid");
  });

  it("fails for missing roots, tampering, revocation, and unknown keys without fallback", () => {
    expect(
      evaluateAssuranceSigningRecord(makeRecord(), {
        ...options(),
        trustedRootIds: [],
      }).code,
    ).toBe("missing-trust-root");

    const tampered = makeRecord();
    tampered.manifestDigest =
      "sha256:2a5c6a2a1e2a0e0a55f7a1b0f0c3d8d84c8ec7c8e6a1b4e4d1a5c9e0b7d5f6a1";
    expect(evaluateAssuranceSigningRecord(tampered, options()).code).toBe(
      "invalid-signature",
    );

    expect(
      evaluateAssuranceSigningRecord(makeRecord(), {
        ...options({
          ...baseKey,
          status: "revoked",
          revokedAt: "2026-05-01T00:00:00.000Z",
        }),
      }).code,
    ).toBe("revoked");

    expect(
      evaluateAssuranceSigningRecord(makeRecord("missing-signer"), options())
        .code,
    ).toBe("missing-key");
  });

  it("throws on explicit verification failure and never exposes key or signature material in reports", () => {
    const tampered = makeRecord();
    tampered.manifestDigest =
      "sha256:2a5c6a2a1e2a0e0a55f7a1b0f0c3d8d84c8ec7c8e6a1b4e4d1a5c9e0b7d5f6a1";
    expect(() =>
      verifyAssuranceSigningRecord(tampered, options()),
    ).toThrowError(AssuranceSigningVerificationError);
    try {
      verifyAssuranceSigningRecord(tampered, options());
    } catch (error) {
      expect((error as AssuranceSigningVerificationError).code).toBe(
        "invalid-signature",
      );
      const report = (error as AssuranceSigningVerificationError).report;
      expect(report).toBeDefined();
      const serialized = serializeAssuranceSigningVerificationReport(report);
      expect(serialized).not.toContain(publicKey);
      expect(serialized).not.toContain(tampered.signature);
    }
  });

  it("keeps key, record, keyring, and report JSON Schemas aligned", () => {
    const record = makeRecord();
    expect(AssuranceSigningKeySchema.parse(baseKey)).toEqual(baseKey);
    expect(
      AssuranceSigningKeyringSchema.parse({
        schemaVersion: 1,
        keys: [baseKey],
      }),
    ).toMatchObject({ schemaVersion: 1 });
    expect(AssuranceSigningRecordSchema.parse(record)).toEqual(record);
    const report = evaluateAssuranceSigningRecord(record, options());
    expect(AssuranceSigningVerificationReportSchema.parse(report)).toEqual(
      report,
    );

    const schema = JSON.parse(
      readFileSync(
        resolve(
          repositoryRoot,
          "schema/assurance-signing-verification.v0.1.schema.json",
        ),
        "utf8",
      ),
    ) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(report)).toBe(true);
  });
});
