#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  parseCodeowners,
  parseOwnershipInput,
  resolveOwnership,
  serializeOwnershipReport,
  stableStringify,
} from "../src/core/index.ts";

const CONTRACT = "cartograph.ownership-resolution";
const SCHEMA_VERSION = 1;
const repositoryRoot = resolve(process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  process.argv.includes("--fixture")
    ? process.argv[process.argv.indexOf("--fixture") + 1]
    : "test/fixtures/ownership-resolution/report.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/ownership-resolution.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(`${CONTRACT} validation failed: ${message}`);
};
const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const sorted = (values) =>
  [...values].sort((left, right) => left.localeCompare(right));

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

  const parsedCodeowners = fixture.codeowners.map((entry) =>
    parseCodeowners(entry.text, {
      id: entry.id,
      repositoryId: entry.repositoryId,
      path: entry.path,
      revision: entry.revision,
      precedence: entry.precedence,
    }),
  );
  const input = parseOwnershipInput({
    ...fixture.request,
    sources: [
      ...fixture.request.sources,
      ...parsedCodeowners.map((entry) => entry.source),
    ],
    sourceDiagnostics: [
      ...fixture.request.sourceDiagnostics,
      ...parsedCodeowners.flatMap((entry) => entry.diagnostics),
    ],
  });
  const report = resolveOwnership(input);
  const serialized = serializeOwnershipReport(report);
  if (serialized !== serializeOwnershipReport(JSON.parse(serialized)))
    fail("ownership report serialization is not byte-stable");

  if (
    stableStringify(report.summary) !==
    stableStringify(fixture.expected.summary)
  )
    fail(
      `summary drifted: expected ${JSON.stringify(fixture.expected.summary)}, found ${JSON.stringify(report.summary)}`,
    );
  const statuses = Object.fromEntries(
    report.results.map((result) => [result.target.id, result.status]),
  );
  if (stableStringify(statuses) !== stableStringify(fixture.expected.statuses))
    fail(
      `statuses drifted: expected ${JSON.stringify(fixture.expected.statuses)}, found ${JSON.stringify(statuses)}`,
    );
  const owners = Object.fromEntries(
    report.results.map((result) => [
      result.target.id,
      [...result.owners].sort(),
    ]),
  );
  if (stableStringify(owners) !== stableStringify(fixture.expected.owners))
    fail(
      `owners drifted: expected ${JSON.stringify(fixture.expected.owners)}, found ${JSON.stringify(owners)}`,
    );

  const reportCodes = new Set(
    report.diagnostics.map((diagnostic) => diagnostic.code),
  );
  for (const code of fixture.expected.diagnosticCodes) {
    if (!reportCodes.has(code)) fail(`missing report diagnostic ${code}`);
  }
  const sourceCodes = new Set(
    parsedCodeowners.flatMap((entry) =>
      entry.diagnostics.map((diagnostic) => diagnostic.code),
    ),
  );
  for (const code of fixture.expected.sourceDiagnosticCodes) {
    if (!sourceCodes.has(code)) fail(`missing CODEOWNERS diagnostic ${code}`);
  }
  const evidence = report.results.flatMap((result) =>
    result.evidence.map((record) => record.reference),
  );
  for (const prefix of fixture.expected.evidencePrefixes) {
    if (!evidence.some((reference) => reference.startsWith(prefix)))
      fail(`missing evidence reference with prefix ${prefix}`);
  }

  return {
    ok: true,
    contract: CONTRACT,
    schemaVersion: SCHEMA_VERSION,
    fixtureId: fixture.fixtureId,
    summary: report.summary,
    statuses,
    diagnosticCodes: sorted([...reportCodes]),
    sourceDiagnosticCodes: sorted([...sourceCodes]),
    evidenceReferences: sorted(evidence),
    sourceBodiesIncluded: report.provenance.sourceBodiesIncluded,
    network: false,
    digest: digest(serialized),
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/ownership-resolution.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`${CONTRACT} validation failed: ${error.message}`);
  process.exit(1);
}
