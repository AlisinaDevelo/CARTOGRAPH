#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  exportScipIndex,
  importScipIndex,
  parseScipIndex,
  serializeScipIndex,
  stableStringify,
} from "../src/core/index.ts";

const CONTRACT = "cartograph.scip-interchange";
const SCHEMA_VERSION = 1;
const repositoryRoot = resolve(process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  process.argv.includes("--fixture")
    ? process.argv[process.argv.indexOf("--fixture") + 1]
    : "test/fixtures/scip-interchange/round-trip.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/scip-interchange.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(`${CONTRACT} validation failed: ${message}`);
};
const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const sorted = (values) =>
  [...values].sort((left, right) => left.localeCompare(right));

const containsKey = (value, key) => {
  if (Array.isArray(value))
    return value.some((entry) => containsKey(entry, key));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([entryKey, entry]) => entryKey === key || containsKey(entry, key),
  );
};

const evidenceReferences = (snapshot) =>
  sorted(
    snapshot.edges.flatMap((edge) =>
      edge.evidence
        .map((evidence) => evidence.reference)
        .filter((reference) => reference !== undefined),
    ),
  );

const stableKeys = (snapshot) =>
  sorted(snapshot.nodes.map((node) => node.stableKey));

const validate = () => {
  const fixture = readJson(fixturePath);
  const schema = readJson(schemaPath);
  const validator = new Ajv({ allErrors: true }).compile(schema);
  if (!validator(fixture))
    fail(`schema validation failed: ${JSON.stringify(validator.errors)}`);
  if (fixture.contract !== CONTRACT || fixture.schemaVersion !== SCHEMA_VERSION)
    fail("fixture contract or version drifted");
  if (fixture.method.network || fixture.method.sourceBodiesIncluded)
    fail("fixture violates the offline and source-body boundary");

  const index = parseScipIndex(fixture.index);
  if (containsKey(index, "text"))
    fail("native source text payloads are not accepted");
  const serialized = serializeScipIndex(index);
  if (serialized !== serializeScipIndex(JSON.parse(serialized)))
    fail("SCIP index serialization is not byte-stable");

  const imported = importScipIndex(index);
  const exported = exportScipIndex(imported.snapshot, {
    toolName: "cartograph-scip-export",
    toolVersion: "0.1.0",
    protocolVersion: index.metadata.version,
  });
  if (containsKey(exported.index, "text"))
    fail("export inserted a native source text payload");
  const roundTrip = importScipIndex(exported.index);

  const expectedStableKeys = sorted(fixture.expected.stableKeys);
  const importedStableKeys = stableKeys(imported.snapshot);
  const roundTripStableKeys = stableKeys(roundTrip.snapshot);
  if (
    stableStringify(importedStableKeys) !== stableStringify(expectedStableKeys)
  )
    fail(
      `import stable identities drifted: expected ${JSON.stringify(expectedStableKeys)}, found ${JSON.stringify(importedStableKeys)}`,
    );
  if (
    stableStringify(roundTripStableKeys) !== stableStringify(expectedStableKeys)
  )
    fail(
      `round-trip stable identities drifted: expected ${JSON.stringify(expectedStableKeys)}, found ${JSON.stringify(roundTripStableKeys)}`,
    );

  const expectedReferences = sorted(fixture.expected.evidenceReferences);
  const importedReferences = evidenceReferences(imported.snapshot);
  const roundTripReferences = evidenceReferences(roundTrip.snapshot);
  for (const reference of expectedReferences) {
    if (!importedReferences.includes(reference))
      fail(`import dropped evidence reference ${reference}`);
    if (!roundTripReferences.includes(reference))
      fail(`round-trip dropped evidence reference ${reference}`);
  }

  const importedUnsupportedCodes = new Set(
    imported.unsupported.map((record) => record.code),
  );
  for (const code of fixture.expected.unsupportedCodes) {
    if (!importedUnsupportedCodes.has(code))
      fail(`import did not report unsupported field ${code}`);
  }
  if (
    imported.provenance.sourceBodiesIncluded ||
    exported.provenance.sourceBodiesIncluded
  )
    fail("provenance reports source bodies");

  const digestInput = stableStringify({
    index,
    imported: {
      mappings: imported.mappings,
      unsupported: imported.unsupported,
      snapshot: imported.snapshot,
    },
    exported: {
      index: exported.index,
      mappings: exported.mappings,
      unsupported: exported.unsupported,
    },
    roundTrip: roundTrip.snapshot,
  });
  return {
    ok: true,
    contract: CONTRACT,
    schemaVersion: SCHEMA_VERSION,
    fixtureId: fixture.fixtureId,
    documents: index.documents.length,
    symbols:
      index.documents.reduce(
        (count, document) => count + document.symbols.length,
        0,
      ) + index.externalSymbols.length,
    importedNodes: imported.snapshot.nodes.length,
    importedEdges: imported.snapshot.edges.length,
    exportedDocuments: exported.index.documents.length,
    exportedSymbols:
      exported.index.documents.reduce(
        (count, document) => count + document.symbols.length,
        0,
      ) + exported.index.externalSymbols.length,
    stableKeys: importedStableKeys,
    roundTripStableKeys,
    evidenceReferences: expectedReferences,
    unsupportedCodes: sorted([...importedUnsupportedCodes]),
    sourceBodiesIncluded: false,
    network: false,
    digest: digest(digestInput),
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/scip-interchange.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`${CONTRACT} validation failed: ${error.message}`);
  process.exit(1);
}
