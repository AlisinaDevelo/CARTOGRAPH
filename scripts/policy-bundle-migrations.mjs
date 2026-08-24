#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import Ajv from "ajv";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  argumentValue("--fixture") ??
    "test/fixtures/policy-bundles/migrations.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/policy-bundle-migration-fixtures.v0.1.schema.json",
);
const reportSchemaPath = resolve(
  repositoryRoot,
  "schema/policy-bundle-migration.v0.1.schema.json",
);

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

const contained = (candidate) => {
  const resolved = resolve(repositoryRoot, candidate);
  const relativePath = relative(repositoryRoot, resolved);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  )
    throw new Error(`fixture path escapes repository: ${candidate}`);
  return resolved;
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const applyCase = (baseBundle, scenario) => {
  const bundle = clone(baseBundle);
  if (scenario.createdAt) bundle.createdAt = scenario.createdAt;
  if (scenario.expiresAt) bundle.expiresAt = scenario.expiresAt;
  if (scenario.selector) {
    if (!bundle.policy?.source?.rules?.[0])
      throw new Error("base policy bundle has no rule to mutate");
    bundle.policy.source.rules[0].selector = scenario.selector;
    bundle.policy.source.digest = undefined;
  }
  if (scenario.ownerPresent === false) delete bundle.owner;
  return bundle;
};

const validate = async () => {
  const fixture = readJson(fixturePath);
  const fixtureSchema = readJson(fixtureSchemaPath);
  const reportSchema = readJson(reportSchemaPath);
  const validateFixture = new Ajv({ allErrors: true }).compile(fixtureSchema);
  if (!validateFixture(fixture))
    throw new Error(
      `migration fixture schema validation failed: ${JSON.stringify(validateFixture.errors)}`,
    );
  const baseBundle = readJson(contained(fixture.baseBundlePath));
  const validateReport = new Ajv({ allErrors: true }).compile(reportSchema);
  const {
    evaluatePolicyBundleMigration,
    policySourceDigest,
    serializePolicyBundleMigrationReport,
  } = await import("../src/core/index.ts");

  const results = [];
  for (const scenario of fixture.cases) {
    const bundle = applyCase(baseBundle, scenario);
    if (scenario.selector)
      bundle.policy.source.digest = policySourceDigest(
        bundle.policy.source.rules,
      );
    const report = evaluatePolicyBundleMigration(bundle, {
      targetPolicyVersion: scenario.targetPolicyVersion,
      now: scenario.now,
      revokedDigests: scenario.revokedDigests,
    });
    if (!validateReport(report))
      throw new Error(
        `migration report schema validation failed for ${scenario.id}: ${JSON.stringify(validateReport.errors)}`,
      );
    const actualCodes = report.findings.map((finding) => finding.code).sort();
    const expectedCodes = [...scenario.expectedCodes].sort();
    if (JSON.stringify(actualCodes) !== JSON.stringify(expectedCodes))
      throw new Error(
        `migration fixture ${scenario.id} expected ${expectedCodes.join(",")}, found ${actualCodes.join(",")}`,
      );
    if (serializePolicyBundleMigrationReport(report).includes("policy.json"))
      throw new Error(`migration report ${scenario.id} leaked a source path`);
    results.push({
      id: scenario.id,
      status: report.status,
      findings: actualCodes,
      digest: report.bundleDigest,
    });
  }

  const result = {
    ok: true,
    schemaVersion: 1,
    contract: "cartograph.policy-bundle-migration",
    cases: results,
  };
  console.log(JSON.stringify(result));
  return result;
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/policy-bundle-migrations.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  await validate();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`policy-bundle migration validation failed: ${message}`);
  process.exit(1);
}
