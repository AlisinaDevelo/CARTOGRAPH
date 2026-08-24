#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const bundleRelativePath = "schema/policy-bundle.v0.1.json";
const schemaRelativePath = "schema/policy-bundle.v0.1.schema.json";

const readJson = (filePath) => {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read JSON ${filePath}: ${detail}`, {
      cause: error,
    });
  }
};

const validate = async () => {
  const bundlePath = resolve(
    repositoryRoot,
    argumentValue("--bundle") ?? bundleRelativePath,
  );
  const schemaPath = resolve(
    repositoryRoot,
    argumentValue("--schema") ?? schemaRelativePath,
  );
  const bundle = readJson(bundlePath);
  const schema = readJson(schemaPath);
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(bundle)) {
    throw new Error(
      `policy bundle schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }

  const { importPolicyBundle, policySourceDigest, serializePolicyBundle } =
    await import("../src/core/policy-bundles.ts");
  const now =
    argumentValue("--as-of") ?? process.env.CARTOGRAPH_POLICY_BUNDLE_AS_OF;
  const imported = importPolicyBundle(bundle, now ? { now } : {});
  if (serializePolicyBundle(imported) !== serializePolicyBundle(bundle)) {
    throw new Error("policy bundle serialization is not canonical");
  }

  const result = {
    ok: true,
    schemaVersion: imported.schemaVersion,
    bundleId: imported.bundleId,
    policyId: imported.policy.id,
    policyVersion: imported.policy.version,
    digest: policySourceDigest(imported.policy.source.rules),
    compatibility: imported.compatibility,
    authority: imported.authority,
    expiresAt: imported.expiresAt,
  };
  console.log(JSON.stringify(result));
  return result;
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/policy-bundle.mjs validate [--as-of ISO_DATE]",
  );
  process.exit(2);
}

try {
  await validate();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`policy bundle validation failed: ${message}`);
  process.exit(1);
}
