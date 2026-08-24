#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  LOCAL_POLICY_SCHEMA_VERSION,
  parsePolicyConfig,
  serializePolicyConfig,
} from "../src/core/policy.ts";

const repositoryRoot = resolve(process.cwd());
const readJson = (relativePath) =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));

const validate = () => {
  const schema = readJson("schema/policy.v0.1.schema.json");
  const sample = readJson("schema/policy.v0.1.json");
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(sample)) {
    throw new Error(
      `policy JSON Schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }
  const parsed = parsePolicyConfig(sample);
  const serialized = serializePolicyConfig(parsed);
  const canonical = JSON.parse(serialized);
  if (serializePolicyConfig(canonical) !== serialized) {
    throw new Error(
      "policy canonical serialization drifted from runtime output",
    );
  }
  return {
    ok: true,
    schemaVersion: LOCAL_POLICY_SCHEMA_VERSION,
    policyId: parsed.policyId,
    mode: parsed.mode,
    rules: parsed.rules.length,
    targets: [...new Set(parsed.rules.map((rule) => rule.target))].sort(),
    remoteFetching: false,
  };
};

if (process.argv[2] !== "validate") {
  console.error("usage: node --import tsx scripts/policy.mjs validate");
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`policy validation failed: ${error.message}`);
  process.exit(1);
}
