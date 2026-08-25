#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  parseAdrReferenceDocument,
  serializeAdrReferenceDocument,
  validateAdrReferences,
} from "../src/core/adr.ts";

const repositoryRoot = resolve(process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/adr-lifecycle/scenarios.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/adr-lifecycle-fixtures.v0.1.schema.json",
);
const adrSchemaPath = resolve(
  repositoryRoot,
  "schema/adr-reference.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const fail = (message) => {
  throw new Error(message);
};

const validate = () => {
  const fixture = readJson(fixturePath);
  const fixtureSchema = readJson(fixtureSchemaPath);
  const adrSchema = readJson(adrSchemaPath);
  const ajv = new Ajv({ allErrors: true });
  const validateFixture = ajv.compile(fixtureSchema);
  if (!validateFixture(fixture)) {
    fail(
      `ADR lifecycle fixture schema failed: ${JSON.stringify(validateFixture.errors)}`,
    );
  }
  const validateAdrSchema = ajv.compile(adrSchema);
  const results = [];

  for (const scenario of fixture.cases) {
    const schemaValid = validateAdrSchema(scenario.document);
    if (scenario.expected.parse === "error") {
      if (schemaValid) {
        fail(`scenario ${scenario.id} unexpectedly passed the ADR JSON Schema`);
      }
      let threw = false;
      try {
        parseAdrReferenceDocument(scenario.document);
      } catch {
        threw = true;
      }
      if (!threw) fail(`scenario ${scenario.id} unexpectedly parsed`);
      results.push({ id: scenario.id, parse: "error", diagnosticCodes: [] });
      continue;
    }

    if (!schemaValid) {
      fail(
        `scenario ${scenario.id} failed the ADR JSON Schema: ${JSON.stringify(validateAdrSchema.errors)}`,
      );
    }
    const parsed = parseAdrReferenceDocument(scenario.document);
    const first = validateAdrReferences(parsed);
    const second = validateAdrReferences(parsed);
    const diagnosticCodes = first.diagnostics.map(
      (diagnostic) => diagnostic.code,
    );
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      fail(`scenario ${scenario.id} produced non-deterministic diagnostics`);
    }
    if (
      JSON.stringify(diagnosticCodes) !==
      JSON.stringify(scenario.expected.diagnosticCodes)
    ) {
      fail(
        `scenario ${scenario.id} diagnostics drifted: expected ${JSON.stringify(scenario.expected.diagnosticCodes)}, found ${JSON.stringify(diagnosticCodes)}`,
      );
    }
    const serialized = serializeAdrReferenceDocument(parsed);
    if (serializeAdrReferenceDocument(JSON.parse(serialized)) !== serialized) {
      fail(`scenario ${scenario.id} canonical serialization drifted`);
    }
    results.push({
      id: scenario.id,
      parse: "ok",
      diagnosticCodes,
      ok: first.ok,
    });
  }

  return {
    ok: true,
    fixtureId: fixture.fixtureId,
    cases: results,
    remoteFetching: false,
  };
};

if (process.argv[2] !== "validate") {
  console.error("usage: node --import tsx scripts/adr-lifecycle.mjs validate");
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`ADR lifecycle validation failed: ${error.message}`);
  process.exit(1);
}
