#!/usr/bin/env node
/* global console, process, structuredClone */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  exportSarifPolicyEvaluation,
  importSarifPolicyEvaluation,
  serializeSarifExport,
  serializeSarifLog,
  stableStringify,
} from "../src/core/index.ts";

const CONTRACT = "cartograph.sarif-interchange";
const SCHEMA_VERSION = 1;
const repositoryRoot = resolve(process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  process.argv.includes("--fixture")
    ? process.argv[process.argv.indexOf("--fixture") + 1]
    : "test/fixtures/sarif-interchange/round-trip.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/sarif-interchange.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(`${CONTRACT} validation failed: ${message}`);
};
const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const containsKey = (value, key) => {
  if (Array.isArray(value))
    return value.some((entry) => containsKey(entry, key));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([entryKey, entry]) => entryKey === key || containsKey(entry, key),
  );
};

const expectRejected = (operation, label) => {
  try {
    operation();
  } catch {
    return;
  }
  fail(`${label} was accepted`);
};

const validate = () => {
  const fixture = readJson(fixturePath);
  const schema = readJson(schemaPath);
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(fixture))
    fail(`schema validation failed: ${JSON.stringify(validateSchema.errors)}`);
  if (fixture.contract !== CONTRACT || fixture.schemaVersion !== SCHEMA_VERSION)
    fail("fixture contract or version drifted");
  if (
    fixture.method.network ||
    fixture.method.sourceBodiesIncluded ||
    fixture.method.credentialsUsed ||
    fixture.method.hiddenTelemetry
  )
    fail("fixture violates the offline and source-body boundary");

  const exported = exportSarifPolicyEvaluation(
    fixture.evaluation,
    { kind: "snapshot", snapshot: fixture.snapshot },
    { toolName: "cartograph-sarif-fixture", toolVersion: "0.1.0" },
  );
  if (
    exported.provenance.sourceBodiesIncluded ||
    !exported.provenance.lineLocalOnly
  )
    fail("export provenance violates the line-local or source-body boundary");
  if (
    containsKey(exported.log, "contents") ||
    containsKey(exported.log, "snippet")
  )
    fail("export inserted source bodies");

  const serialized = serializeSarifExport(exported);
  if (serialized !== serializeSarifExport(JSON.parse(serialized)))
    fail("interchange serialization is not byte-stable");
  if (
    serializeSarifLog(exported.log) !==
    serializeSarifLog(JSON.parse(serializeSarifLog(exported.log)))
  )
    fail("native SARIF serialization is not byte-stable");

  const imported = importSarifPolicyEvaluation(exported.log);
  const importedEnvelope = importSarifPolicyEvaluation(exported);
  const mappedViolationIds = imported.mappings.map(
    (mapping) => mapping.violationId,
  );
  const unsupportedViolationIds = exported.unsupported.map(
    (record) => record.violationId,
  );
  if (
    stableStringify(mappedViolationIds) !==
    stableStringify(fixture.expected.mappedViolationIds)
  )
    fail(
      `mapped violation IDs drifted: expected ${JSON.stringify(fixture.expected.mappedViolationIds)}, found ${JSON.stringify(mappedViolationIds)}`,
    );
  if (
    stableStringify(unsupportedViolationIds) !==
    stableStringify(fixture.expected.unsupportedViolationIds)
  )
    fail(
      `unsupported violation IDs drifted: expected ${JSON.stringify(fixture.expected.unsupportedViolationIds)}, found ${JSON.stringify(unsupportedViolationIds)}`,
    );
  if (imported.mappings.length !== importedEnvelope.mappings.length)
    fail("native and envelope imports disagree");
  if (
    imported.mappings.some(
      (mapping) => !mapping.fingerprint.startsWith("sha256:"),
    )
  )
    fail("a mapped result is missing a canonical fingerprint");

  const unsupportedKind = structuredClone(exported.log);
  unsupportedKind.runs[0].results[0].kind = "pass";
  expectRejected(
    () => importSarifPolicyEvaluation(unsupportedKind),
    "unsupported SARIF result kind",
  );
  const sourceBody = structuredClone(exported.log);
  sourceBody.runs[0].results[0].locations[0].physicalLocation.region.snippet = {
    text: "source body must never cross this boundary",
  };
  expectRejected(
    () => importSarifPolicyEvaluation(sourceBody),
    "SARIF source body",
  );
  const missingFingerprint = structuredClone(exported.log);
  delete missingFingerprint.runs[0].results[0].partialFingerprints
    .cartographFingerprint;
  expectRejected(
    () => importSarifPolicyEvaluation(missingFingerprint),
    "missing SARIF fingerprint",
  );
  const absolutePath = structuredClone(exported.log);
  absolutePath.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri =
    "/private/project/src/app.ts";
  expectRejected(
    () => importSarifPolicyEvaluation(absolutePath),
    "absolute SARIF artifact path",
  );

  const digestInput = stableStringify({
    exported: {
      provenance: exported.provenance,
      mappings: exported.mappings,
      unsupported: exported.unsupported,
      log: exported.log,
    },
    imported: imported.mappings,
  });
  return {
    ok: true,
    contract: CONTRACT,
    schemaVersion: SCHEMA_VERSION,
    fixtureId: fixture.fixtureId,
    mappedResults: imported.mappings.length,
    mappedViolationIds,
    unsupportedViolationIds,
    sourceBodiesIncluded: false,
    lineLocalOnly: true,
    network: false,
    digest: digest(digestInput),
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/sarif-interchange.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`${CONTRACT} validation failed: ${error.message}`);
  process.exit(1);
}
