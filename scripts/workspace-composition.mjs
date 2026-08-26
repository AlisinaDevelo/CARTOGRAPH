#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  parseWorkspaceCompositionManifest,
  serializeWorkspaceCompositionManifest,
} from "../src/core/index.ts";

const repositoryRoot = resolve(process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/workspace-composition/manifest.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/workspace-composition.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const validate = () => {
  const input = readJson(fixturePath);
  const schema = readJson(schemaPath);
  const manifest = parseWorkspaceCompositionManifest(input);
  const validator = new Ajv({ allErrors: true }).compile(schema);
  if (!validator(manifest)) {
    throw new Error(
      `workspace schema validation failed: ${JSON.stringify(validator.errors)}`,
    );
  }
  const repeated = parseWorkspaceCompositionManifest(
    JSON.parse(serializeWorkspaceCompositionManifest(input)),
  );
  if (
    serializeWorkspaceCompositionManifest(manifest) !==
    serializeWorkspaceCompositionManifest(repeated)
  ) {
    throw new Error("workspace manifest serialization is not byte-stable");
  }
  return {
    ok: true,
    fixture: fixturePath,
    repositories: manifest.repositories.length,
    omissions: manifest.omissions.length,
    boundaries: manifest.boundaries.length,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/workspace-composition.mjs validate",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`workspace composition validation failed: ${error.message}`);
  process.exit(1);
}
