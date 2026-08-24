#!/usr/bin/env node
/* global Buffer, console, process */

import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  argumentValue("--fixture") ??
    "test/fixtures/assurance-signing/scenarios.v0.1.json",
);

const readJson = (filePath) => {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read JSON ${filePath}: ${detail}`, {
      cause: error,
    });
  }
};

const validate = async () => {
  const fixture = readJson(fixturePath);
  const fixtureSchema = readJson(
    resolve(
      repositoryRoot,
      "schema/assurance-signing-fixtures.v0.1.schema.json",
    ),
  );
  const reportSchema = readJson(
    resolve(
      repositoryRoot,
      "schema/assurance-signing-verification.v0.1.schema.json",
    ),
  );
  const keySchema = readJson(
    resolve(repositoryRoot, "schema/assurance-signing-key.v0.1.schema.json"),
  );
  const keyringSchema = readJson(
    resolve(
      repositoryRoot,
      "schema/assurance-signing-keyring.v0.1.schema.json",
    ),
  );
  const validateFixture = new Ajv({ allErrors: true }).compile(fixtureSchema);
  if (!validateFixture(fixture))
    throw new Error(
      `assurance signing fixture schema validation failed: ${JSON.stringify(validateFixture.errors)}`,
    );
  const validateReport = new Ajv({ allErrors: true }).compile(reportSchema);
  const validateKey = new Ajv({ allErrors: true }).compile(keySchema);
  const validateKeyring = new Ajv({ allErrors: true }).compile(keyringSchema);
  const {
    ASSURANCE_SIGNING_ALGORITHM,
    ASSURANCE_SIGNING_ALGORITHM_VERSION,
    ASSURANCE_SIGNING_CONTRACT,
    ASSURANCE_SIGNING_SCHEMA_VERSION,
    assuranceSigningPayload,
    evaluateAssuranceSigningRecord,
    serializeAssuranceSigningVerificationReport,
  } = await import("../src/core/index.ts");

  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const baseKey = {
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
  if (!validateKey(baseKey))
    throw new Error(
      `generated key failed schema validation: ${JSON.stringify(validateKey.errors)}`,
    );
  if (!validateKeyring({ schemaVersion: 1, keys: [baseKey] }))
    throw new Error(
      `generated keyring failed schema validation: ${JSON.stringify(validateKeyring.errors)}`,
    );

  const makeRecord = (signerKeyId = baseKey.keyId) => {
    const unsigned = {
      schemaVersion: ASSURANCE_SIGNING_SCHEMA_VERSION,
      contract: ASSURANCE_SIGNING_CONTRACT,
      manifestDigest: fixture.manifestDigest,
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

  const results = [];
  for (const scenario of fixture.cases) {
    const record = makeRecord(
      scenario.scenario === "no-fallback" ? "missing-signer" : baseKey.keyId,
    );
    const key = {
      ...baseKey,
      ...(scenario.scenario === "old-key"
        ? { status: "retired", retiredAt: "2026-12-31T23:59:59.000Z" }
        : {}),
      ...(scenario.scenario === "revoked-key"
        ? { status: "revoked", revokedAt: "2026-05-01T00:00:00.000Z" }
        : {}),
    };
    if (scenario.scenario === "tampered-manifest")
      record.manifestDigest =
        "sha256:2a5c6a2a1e2a0e0a55f7a1b0f0c3d8d84c8ec7c8e6a1b4e4d1a5c9e0b7d5f6a1";
    const report = evaluateAssuranceSigningRecord(record, {
      keyring: [key],
      trustedRootIds:
        scenario.scenario === "missing-trust-root" ? [] : [baseKey.trustRootId],
      now: "2026-08-24T00:00:00.000Z",
    });
    if (!validateReport(report))
      throw new Error(
        `assurance signing report schema validation failed for ${scenario.id}: ${JSON.stringify(validateReport.errors)}`,
      );
    if (report.code !== scenario.expectedCode)
      throw new Error(
        `assurance signing fixture ${scenario.id} expected ${scenario.expectedCode}, found ${report.code}`,
      );
    if (serializeAssuranceSigningVerificationReport(report).includes(publicKey))
      throw new Error(
        `assurance signing report ${scenario.id} leaked public key material`,
      );
    results.push({
      id: scenario.id,
      status: report.status,
      code: report.code,
      manifestDigest: report.manifestDigest,
    });
  }

  console.log(
    JSON.stringify({
      ok: true,
      schemaVersion: ASSURANCE_SIGNING_SCHEMA_VERSION,
      contract: ASSURANCE_SIGNING_CONTRACT,
      cases: results,
    }),
  );
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/assurance-signing.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  await validate();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`assurance signing validation failed: ${message}`);
  process.exit(1);
}
