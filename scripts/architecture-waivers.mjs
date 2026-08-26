#!/usr/bin/env node
/* global Buffer, console, process */

import { createHash, generateKeyPairSync, sign } from "node:crypto";
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
    "test/fixtures/architecture-waivers/scenarios.v0.1.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(
    `cartograph.architecture-waiver validation failed: ${message}`,
  );
};
const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const validate = async () => {
  const fixture = readJson(fixturePath);
  const fixtureSchema = readJson(
    resolve(
      repositoryRoot,
      "schema/architecture-waiver-fixtures.v0.1.schema.json",
    ),
  );
  const waiverSchema = readJson(
    resolve(repositoryRoot, "schema/architecture-waiver.v0.1.schema.json"),
  );
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateFixture = ajv.compile(fixtureSchema);
  const validateWaiver = ajv.compile(waiverSchema);
  if (!validateFixture(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validateFixture.errors)}`,
    );

  const {
    ARCHITECTURE_WAIVER_CONTRACT,
    ARCHITECTURE_WAIVER_MEDIA_TYPE,
    ARCHITECTURE_WAIVER_SCHEMA_VERSION,
    architectureWaiverDigest,
    architectureWaiverInputDigest,
    evaluateArchitectureWaivers,
    serializeArchitectureWaiverEvaluation,
    ASSURANCE_SIGNING_ALGORITHM,
    ASSURANCE_SIGNING_ALGORITHM_VERSION,
    ASSURANCE_SIGNING_CONTRACT,
    ASSURANCE_SIGNING_SCHEMA_VERSION,
    assuranceSigningPayload,
  } = await import("../src/core/index.ts");

  if (
    fixture.contract !== ARCHITECTURE_WAIVER_CONTRACT ||
    fixture.mediaType !== ARCHITECTURE_WAIVER_MEDIA_TYPE ||
    fixture.schemaVersion !== ARCHITECTURE_WAIVER_SCHEMA_VERSION
  )
    fail("fixture contract or version drifted");

  const input = { kind: "snapshot", snapshot: fixture.input };
  const inputDigest = architectureWaiverInputDigest(input);
  if (inputDigest !== fixture.inputDigest)
    fail(
      `input digest drifted: expected ${fixture.inputDigest}, found ${inputDigest}`,
    );

  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const baseKey = {
    keyId: "signer-local",
    trustRootId: "root-local",
    algorithm: ASSURANCE_SIGNING_ALGORITHM,
    algorithmVersion: ASSURANCE_SIGNING_ALGORITHM_VERSION,
    publicKey,
    status: "active",
    validFrom: "2029-01-01T00:00:00.000Z",
    validUntil: "2031-12-31T23:59:59.000Z",
    retiredAt: null,
    revokedAt: null,
    rotatedFrom: null,
  };
  const signWaiver = (waiver, scenario) => {
    const unsigned = {
      schemaVersion: ASSURANCE_SIGNING_SCHEMA_VERSION,
      contract: ASSURANCE_SIGNING_CONTRACT,
      manifestDigest: waiver.digest,
      signerKeyId:
        scenario === "missing-key" ? "missing-signer" : baseKey.keyId,
      algorithm: ASSURANCE_SIGNING_ALGORITHM,
      algorithmVersion: ASSURANCE_SIGNING_ALGORITHM_VERSION,
      signedAt: waiver.createdAt,
      expiresAt: waiver.expiresAt,
    };
    const record = {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(assuranceSigningPayload(unsigned), "utf8"),
        keyPair.privateKey,
      ).toString("base64url"),
    };
    if (scenario === "invalid") record.signature = "AAAA";
    return record;
  };

  const results = [];
  for (const scenario of fixture.cases) {
    const records = scenario.waivers.map((template) => ({
      ...template,
      ...(scenario.signatureScenario === "unsigned"
        ? {}
        : { signature: signWaiver(template, scenario.signatureScenario) }),
    }));
    for (const record of records) {
      if (!validateWaiver(record))
        fail(
          `waiver schema validation failed for ${scenario.id}: ${JSON.stringify(validateWaiver.errors)}`,
        );
      if (architectureWaiverDigest(record) !== record.digest)
        fail(`waiver digest drifted for ${scenario.id}:${record.id}`);
    }
    const key =
      scenario.signatureScenario === "revoked"
        ? {
            ...baseKey,
            status: "revoked",
            revokedAt: "2030-05-01T00:00:00.000Z",
          }
        : baseKey;
    const report = evaluateArchitectureWaivers(fixture.policy, input, records, {
      asOf: fixture.asOf,
      expiringWithinDays: fixture.expiringWithinDays,
      evidenceRevision: fixture.evidenceRevision,
      keyring: [key],
      trustedRootIds:
        scenario.signatureScenario === "missing-trust-root"
          ? []
          : [baseKey.trustRootId],
    });
    const expected = scenario.expected;
    const violationIds = report.violations.map((violation) => violation.id);
    const suppressedViolationIds = report.suppressed.map(
      (suppression) => suppression.violationId,
    );
    const statuses = report.waivers.map((waiver) => waiver.status);
    const codes = report.waivers.map((waiver) => waiver.code);
    if (report.status !== expected.status)
      fail(
        `case ${scenario.id} status drifted: expected ${expected.status}, found ${report.status}`,
      );
    if (report.policyStatus !== expected.policyStatus)
      fail(`case ${scenario.id} policy status drifted`);
    if (JSON.stringify(violationIds) !== JSON.stringify(expected.violationIds))
      fail(`case ${scenario.id} violations drifted`);
    if (
      JSON.stringify(suppressedViolationIds) !==
      JSON.stringify(expected.suppressedViolationIds)
    )
      fail(`case ${scenario.id} suppressions drifted`);
    if (JSON.stringify(statuses) !== JSON.stringify(expected.waiverStatuses))
      fail(`case ${scenario.id} waiver statuses drifted`);
    if (JSON.stringify(codes) !== JSON.stringify(expected.waiverCodes))
      fail(`case ${scenario.id} waiver codes drifted`);
    if (report.authorityGranted !== expected.authorityGranted)
      fail(`case ${scenario.id} authority boundary drifted`);
    const serialized = serializeArchitectureWaiverEvaluation(report);
    if (
      serialized !==
      serializeArchitectureWaiverEvaluation(JSON.parse(serialized))
    )
      fail(`case ${scenario.id} evaluation serialization is not deterministic`);
    if (
      serialized.includes('"privateKey"') ||
      records.some(
        (record) =>
          typeof record.signature === "string" &&
          serialized.includes(record.signature),
      )
    )
      fail(`case ${scenario.id} report leaked signing key material`);
    results.push({
      id: scenario.id,
      status: report.status,
      policyStatus: report.policyStatus,
      violations: violationIds,
      suppressed: suppressedViolationIds,
      waiverStatuses: statuses,
      waiverCodes: codes,
      authorityGranted: report.authorityGranted,
    });
  }
  return {
    ok: true,
    contract: ARCHITECTURE_WAIVER_CONTRACT,
    schemaVersion: ARCHITECTURE_WAIVER_SCHEMA_VERSION,
    fixtureId: fixture.fixtureId,
    inputDigest,
    cases: results,
    offline: true,
    privateKeysIncluded: false,
    authorityGranted: false,
    digest: digest(JSON.stringify(results)),
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/architecture-waivers.mjs validate [--root path] [--fixture path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(await validate()));
} catch (error) {
  console.error(
    `cartograph.architecture-waiver validation failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
}
