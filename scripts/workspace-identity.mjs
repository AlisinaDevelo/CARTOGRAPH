#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  composeWorkspaceIdentities,
  serializeWorkspaceIdentityComposition,
} from "../src/core/index.ts";

const repositoryRoot = resolve(process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/workspace-identity/composition.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/workspace-identity.v0.1.schema.json",
);
const graphSchemaPath = resolve(
  repositoryRoot,
  "schema/graph-snapshot.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(`workspace identity validation failed: ${message}`);
};

const validate = () => {
  const input = readJson(fixturePath);
  if (!Array.isArray(input.repositories))
    fail("fixture repositories are missing");
  const before = JSON.stringify(input);
  const composition = composeWorkspaceIdentities(input.repositories);
  if (JSON.stringify(input) !== before)
    fail("composition mutated an input repository or snapshot");

  const ajv = new Ajv({ allErrors: true });
  ajv.addSchema(readJson(graphSchemaPath));
  const validator = ajv.compile(readJson(schemaPath));
  if (!validator(composition))
    fail(
      `published schema rejected composition: ${JSON.stringify(validator.errors)}`,
    );

  const reversed = JSON.parse(JSON.stringify(input.repositories)).reverse();
  for (const repository of reversed) {
    if (repository.origin?.aliases)
      repository.origin.aliases = [...repository.origin.aliases].reverse();
  }
  if (
    serializeWorkspaceIdentityComposition(
      composeWorkspaceIdentities(input.repositories),
    ) !==
    serializeWorkspaceIdentityComposition(composeWorkspaceIdentities(reversed))
  ) {
    fail(
      "repository or alias order changed the serialized identity composition",
    );
  }

  const composedKeys = new Set(
    composition.identities.map((identity) => identity.composedStableKey),
  );
  if (composedKeys.size !== composition.identities.length)
    fail("composed identity keys are not unique");
  const kinds = new Set(
    composition.ambiguities.map((ambiguity) => ambiguity.kind),
  );
  for (const required of [
    "alias-collision",
    "duplicate-origin",
    "logical-name-collision",
    "origin-unavailable",
  ]) {
    if (!kinds.has(required)) fail(`fixture is missing ${required} evidence`);
  }

  return {
    ok: true,
    repositories: composition.namespaces.length,
    identities: composition.identities.length,
    ambiguities: composition.ambiguities.length,
    originUnavailable: composition.ambiguities.filter(
      (ambiguity) => ambiguity.kind === "origin-unavailable",
    ).length,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/workspace-identity.mjs validate",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
