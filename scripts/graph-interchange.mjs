#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  GraphInterchangeValidationError,
  parseGraphInterchange,
  parseGraphInterchangeEdgeList,
  parseGraphInterchangeJson,
  parseGraphInterchangeJsonLd,
  parseGraphSnapshot,
  serializeGraphInterchange,
  serializeGraphInterchangeEdgeList,
  serializeGraphInterchangeJson,
  stableStringify,
} from "../src/core/index.ts";

const repositoryRoot = resolve(process.cwd());
const fixtureRoot = resolve(repositoryRoot, "test/fixtures/graph-interchange");
const fixturePath = resolve(fixtureRoot, "scenarios.v0.1.json");
const interchangeSchemaPath = resolve(
  repositoryRoot,
  "schema/graph-interchange.v0.1.schema.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/graph-interchange-fixtures.v0.1.schema.json",
);
const snapshotSchemaPath = resolve(
  repositoryRoot,
  "schema/graph-snapshot.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(`cartograph.graph-interchange validation failed: ${message}`);
};
const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const sorted = (values) =>
  [...values].sort((left, right) => left.localeCompare(right));
const edgeIdentity = (edge) => `${edge.from}|${edge.kind}|${edge.to}`;

const evidenceRecords = (snapshot) => [
  ...snapshot.edges.flatMap((edge) => edge.evidence),
  ...snapshot.diagnostics.flatMap((diagnostic) => diagnostic.evidence),
];
const evidenceIds = (snapshot) =>
  sorted(evidenceRecords(snapshot).map((item) => item.id));
const evidenceReferences = (snapshot) =>
  sorted(
    evidenceRecords(snapshot)
      .map((item) => item.reference)
      .filter((reference) => reference !== undefined),
  );
const edgeIdentities = (snapshot) =>
  snapshot.edges
    .map(edgeIdentity)
    .sort((left, right) => left.localeCompare(right));
const unresolvedReasons = (snapshot) =>
  sorted(
    snapshot.edges
      .map((edge) => edge.unresolvedReason)
      .filter((reason) => reason !== undefined),
  );

const expectEqual = (actual, expected, label) => {
  if (stableStringify(actual) !== stableStringify(expected))
    fail(
      `${label} drifted: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
    );
};

const assertSchema = (validator, value, label) => {
  if (!validator(value))
    fail(
      `${label} schema validation failed: ${JSON.stringify(validator.errors)}`,
    );
};

const assertRejected = (action, pattern, label) => {
  try {
    action();
  } catch (error) {
    if (
      error instanceof GraphInterchangeValidationError &&
      pattern.test(error.message)
    )
      return;
    throw new Error(
      `${label} failed with an unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  fail(`${label} was accepted`);
};

const makeValidator = () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const snapshotSchema = readJson(snapshotSchemaPath);
  ajv.addSchema(snapshotSchema, snapshotSchema.$id);
  return {
    fixture: ajv.compile(readJson(fixtureSchemaPath)),
    interchange: ajv.compile(readJson(interchangeSchemaPath)),
  };
};

const validate = () => {
  const fixture = readJson(fixturePath);
  const validators = makeValidator();
  assertSchema(validators.fixture, fixture, "fixture");
  if (fixture.method.network || fixture.method.sourceBodiesIncluded)
    fail("fixture violates the offline and source-body boundary");

  const snapshotInput = readJson(resolve(fixtureRoot, fixture.snapshotFile));
  const snapshot = parseGraphSnapshot(snapshotInput);
  const snapshotSchema = readJson(snapshotSchemaPath);
  const snapshotValidator = new Ajv({ allErrors: true, strict: false }).compile(
    snapshotSchema,
  );
  assertSchema(snapshotValidator, snapshot, "snapshot");

  const reorderedInput = {
    ...snapshotInput,
    nodes: [...snapshotInput.nodes].reverse(),
    edges: [...snapshotInput.edges].reverse(),
    diagnostics: [...snapshotInput.diagnostics].reverse(),
  };
  const expected = fixture.expected;
  const results = [];

  for (const format of fixture.formats) {
    const serialized = serializeGraphInterchange(snapshot, format);
    const roundTrip = parseGraphInterchange(serialized, format);
    const reordered = serializeGraphInterchange(reorderedInput, format);
    expectEqual(serialized, reordered, `${format} reordered serialization`);
    expectEqual(
      serializeGraphInterchange(roundTrip, format),
      serialized,
      `${format} round-trip serialization`,
    );
    expectEqual(
      edgeIdentities(roundTrip),
      sorted(expected.edgeIdentities),
      `${format} edge identities`,
    );
    expectEqual(
      evidenceIds(roundTrip),
      sorted(expected.evidenceIds),
      `${format} evidence IDs`,
    );
    expectEqual(
      evidenceReferences(roundTrip),
      sorted(expected.evidenceReferences),
      `${format} evidence references`,
    );
    expectEqual(
      unresolvedReasons(roundTrip),
      sorted(expected.unresolvedReasons),
      `${format} unresolved reasons`,
    );
    if (roundTrip.nodes.length !== expected.nodes)
      fail(`${format} node count drifted`);
    if (roundTrip.edges.length !== expected.edges)
      fail(`${format} edge count drifted`);
    if (roundTrip.diagnostics.length !== expected.diagnostics)
      fail(`${format} diagnostic count drifted`);

    if (format === "edge-list") {
      for (const line of serialized.trimEnd().split("\n"))
        assertSchema(
          validators.interchange,
          JSON.parse(line),
          `${format} line`,
        );
    } else {
      assertSchema(validators.interchange, JSON.parse(serialized), format);
    }

    results.push({
      format,
      bytes: Buffer.byteLength(serialized, "utf8"),
      digest: digest(serialized),
      nodes: roundTrip.nodes.length,
      edges: roundTrip.edges.length,
      diagnostics: roundTrip.diagnostics.length,
    });
  }

  const json = JSON.parse(serializeGraphInterchangeJson(snapshot));
  json.snapshot.unexpected = true;
  assertRejected(
    () => parseGraphInterchangeJson(json),
    /unrecognized key|unexpected/u,
    "JSON unsupported field",
  );

  const jsonLd = JSON.parse(serializeGraphInterchange(snapshot, "json-ld"));
  jsonLd.unexpected = true;
  assertRejected(
    () => parseGraphInterchangeJsonLd(jsonLd),
    /unrecognized key|unexpected/u,
    "JSON-LD unsupported field",
  );

  const edgeList = serializeGraphInterchangeEdgeList(snapshot)
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  edgeList[0].unexpected = true;
  assertRejected(
    () =>
      parseGraphInterchangeEdgeList(
        `${edgeList.map((line) => JSON.stringify(line)).join("\n")}\n`,
      ),
    /unrecognized key|unexpected/u,
    "edge-list unsupported field",
  );

  return {
    ok: true,
    contract: "cartograph.graph-interchange",
    schemaVersion: 1,
    fixtureId: fixture.fixtureId,
    formats: results,
    edgeIdentities: edgeIdentities(snapshot),
    evidenceIds: evidenceIds(snapshot),
    evidenceReferences: evidenceReferences(snapshot),
    unresolvedReasons: unresolvedReasons(snapshot),
    network: false,
    sourceBodiesIncluded: false,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/graph-interchange.mjs validate",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
