#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  resolveWorkspaceBoundaries,
  serializeWorkspaceBoundaryComposition,
} from "../src/core/index.ts";

const repositoryRoot = resolve(process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/workspace-boundaries/request.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/workspace-boundaries.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(`workspace boundary validation failed: ${message}`);
};

const validate = () => {
  const input = readJson(fixturePath);
  const before = JSON.stringify(input);
  const composition = resolveWorkspaceBoundaries(input);
  if (JSON.stringify(input) !== before) fail("resolution mutated the request");

  const validator = new Ajv({ allErrors: true }).compile(readJson(schemaPath));
  if (!validator(composition)) {
    fail(
      `published schema rejected composition: ${JSON.stringify(validator.errors)}`,
    );
  }

  const statuses = new Set(
    composition.resolutions.map((resolution) => resolution.status),
  );
  for (const required of [
    "resolved",
    "ambiguous",
    "external",
    "unavailable",
    "unsupported",
  ]) {
    if (!statuses.has(required))
      fail(`fixture is missing ${required} status evidence`);
  }
  for (const edge of composition.edges) {
    if (edge.scope !== "cross-repository") continue;
    if (edge.provenance.from.length === 0 || edge.provenance.to.length === 0) {
      fail(`cross-repository edge lacks both-side provenance: ${edge.id}`);
    }
  }
  if (composition.cycles.length === 0)
    fail("fixture is missing cycle evidence");

  const reversed = JSON.parse(JSON.stringify(input));
  reversed.repositories.reverse();
  reversed.evidenceSources.reverse();
  reversed.references.reverse();
  for (const repository of reversed.repositories) {
    repository.declarations.reverse();
  }
  if (
    serializeWorkspaceBoundaryComposition(composition) !==
    serializeWorkspaceBoundaryComposition(resolveWorkspaceBoundaries(reversed))
  ) {
    fail("input ordering changed the serialized composition");
  }

  return {
    ok: true,
    repositories: composition.repositories.length,
    references: composition.resolutions.length,
    edges: composition.edges.length,
    cycles: composition.cycles.length,
    statuses: [...statuses].sort(),
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/workspace-boundaries.mjs validate",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
