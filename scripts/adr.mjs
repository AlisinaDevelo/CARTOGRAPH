#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  ADR_REFERENCE_SCHEMA_VERSION,
  parseAdrReferenceDocument,
  serializeAdrReferenceDocument,
  validateAdrReferences,
} from "../src/core/adr.ts";

const repositoryRoot = resolve(process.cwd());
const readJson = (relativePath) =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));

const validate = () => {
  const schema = readJson("schema/adr-reference.v0.1.schema.json");
  const sample = readJson("schema/adr-reference.v0.1.json");
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(sample)) {
    throw new Error(
      `ADR reference JSON Schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }
  const parsed = parseAdrReferenceDocument(sample);
  const validation = validateAdrReferences(parsed, { root: repositoryRoot });
  if (!validation.ok) {
    throw new Error(
      `ADR reference validation failed: ${JSON.stringify(validation.diagnostics)}`,
    );
  }
  const serialized = serializeAdrReferenceDocument(parsed);
  if (serializeAdrReferenceDocument(JSON.parse(serialized)) !== serialized) {
    throw new Error(
      "ADR reference canonical serialization drifted from runtime output",
    );
  }
  return {
    ok: true,
    schemaVersion: ADR_REFERENCE_SCHEMA_VERSION,
    references: parsed.references.length,
    statuses: [
      ...new Set(parsed.references.map((reference) => reference.status)),
    ].sort(),
    remoteFetching: false,
    diagnostics: validation.diagnostics,
  };
};

if (process.argv[2] !== "validate") {
  console.error("usage: node --import tsx scripts/adr.mjs validate");
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`ADR reference validation failed: ${error.message}`);
  process.exit(1);
}
