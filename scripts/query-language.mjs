#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  GraphQueryLanguageParseError,
  parseGraphQueryLanguage,
  serializeGraphQuery,
} from "../src/core/query-language.ts";

const repositoryRoot = resolve(process.cwd());
const readJson = (relativePath) =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
const fail = (message) => {
  throw new Error(`graph query language validation failed: ${message}`);
};

const validate = () => {
  const fixture = readJson("test/fixtures/query-language/scenarios.v0.1.json");
  const schema = readJson(
    "schema/graph-query-language-fixtures.v0.1.schema.json",
  );
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(fixture)) fail(JSON.stringify(validateSchema.errors));
  for (const scenario of fixture.cases) {
    if (scenario.expected.status === "error") {
      try {
        parseGraphQueryLanguage(scenario.query);
        fail(`${scenario.id} unexpectedly parsed`);
      } catch (error) {
        if (!(error instanceof GraphQueryLanguageParseError)) throw error;
        if (error.code !== scenario.expected.errorCode)
          fail(
            `${scenario.id} expected ${scenario.expected.errorCode}, found ${error.code}`,
          );
      }
      continue;
    }
    const query = parseGraphQueryLanguage(scenario.query);
    if (query.target !== scenario.expected.target)
      fail(`${scenario.id} target drift`);
    if (
      scenario.expected.predicateCount !== undefined &&
      query.predicates.length !== scenario.expected.predicateCount
    )
      fail(`${scenario.id} predicate count drift`);
    if (
      scenario.expected.traversal !== undefined &&
      query.traversal.enabled !== scenario.expected.traversal
    )
      fail(`${scenario.id} traversal flag drift`);
    if (scenario.equivalentQuery !== undefined) {
      const equivalent = parseGraphQueryLanguage(scenario.equivalentQuery);
      if (serializeGraphQuery(query) !== serializeGraphQuery(equivalent))
        fail(`${scenario.id} equivalent queries did not normalize identically`);
    }
  }
  return { ok: true, fixture: fixture.fixtureId, cases: fixture.cases.length };
};

if (process.argv[2] !== "validate") {
  console.error("usage: node scripts/query-language.mjs validate");
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
