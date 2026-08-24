#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());

const readText = (relativePath) =>
  readFileSync(resolve(repositoryRoot, relativePath), "utf8");

const readJson = (relativePath) => JSON.parse(readText(relativePath));

const sourceVersion = (source, constant) => {
  const match = source.match(new RegExp(`${constant}\\s*=\\s*(\\d+)`, "u"));
  return match ? Number(match[1]) : undefined;
};

const requireEqual = (label, actual, expected) => {
  if (actual !== expected) {
    throw new Error(`${label} drift: expected ${expected}, found ${actual}`);
  }
};

const requireReviewed = (label, contract) => {
  if (typeof contract.current === "number") {
    if (!contract.supportedReaders.includes(contract.current)) {
      throw new Error(
        `${label} current version ${contract.current} is not in supportedReaders`,
      );
    }
    if (!contract.reviewedVersions.includes(contract.current)) {
      throw new Error(
        `${label} current version ${contract.current} is not reviewed`,
      );
    }
    return;
  }

  if (contract.reviewed !== true) {
    throw new Error(`${label} unversioned boundary is not reviewed`);
  }
};

const checkHostedVersionChange = () => {
  const baseRef = process.env.GITHUB_BASE_REF;
  if (!process.env.GITHUB_ACTIONS || !baseRef) return;

  const changed = execFileSync(
    "git",
    ["diff", "--name-only", `origin/${baseRef}...HEAD`],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const versionChanged = changed.some(
    (file) =>
      file === "src/core/schemas.ts" ||
      file === "src/core/capabilities.ts" ||
      file === "src/core/policy-bundles.ts" ||
      file === "src/core/policy-bundle-migrations.ts" ||
      file === "src/core/assurance-signing.ts" ||
      file === "src/core/remediation-suggestions.ts" ||
      file === "src/core/remediation-rules.ts" ||
      file === "schema/graph-snapshot.v0.1.schema.json" ||
      file === "schema/capability-registry.v0.1.schema.json" ||
      file === "schema/policy-bundle.v0.1.schema.json" ||
      file === "schema/policy-bundle-migration.v0.1.schema.json" ||
      file === "schema/policy-bundle-revocation.v0.1.schema.json" ||
      file === "schema/assurance-signing.v0.1.schema.json" ||
      file === "schema/assurance-signing-key.v0.1.schema.json" ||
      file === "schema/assurance-signing-keyring.v0.1.schema.json" ||
      file === "schema/assurance-signing-verification.v0.1.schema.json" ||
      file === "schema/remediation-suggestion.v0.1.schema.json" ||
      file === "schema/remediation-suggestion-report.v0.1.schema.json" ||
      file === "schema/remediation-rules.v0.1.schema.json",
  );
  const reviewRecorded = changed.some(
    (file) =>
      file === "schema/compatibility.json" ||
      file === "docs/COMPATIBILITY.md" ||
      file.startsWith("schema/migrations/"),
  );
  if (versionChanged && !reviewRecorded) {
    throw new Error(
      "schema version source changed without a compatibility manifest, policy, or migration review record",
    );
  }
};

const checkCompatibility = () => {
  const policy = readJson("schema/compatibility.json");
  const source = readText("src/core/schemas.ts");
  const capabilitySource = readText("src/core/capabilities.ts");
  const policyBundleSource = readText("src/core/policy-bundles.ts");
  const policyBundleMigrationSource = readText(
    "src/core/policy-bundle-migrations.ts",
  );
  const assuranceSigningSource = readText("src/core/assurance-signing.ts");
  const remediationSuggestionSource = readText(
    "src/core/remediation-suggestions.ts",
  );
  const remediationRulesSource = readText("src/core/remediation-rules.ts");
  const snapshotSchema = readJson("schema/graph-snapshot.v0.1.schema.json");
  const capabilitySchema = readJson(
    "schema/capability-registry.v0.1.schema.json",
  );
  const policyBundleSchema = readJson("schema/policy-bundle.v0.1.schema.json");
  const policyBundleMigrationSchema = readJson(
    "schema/policy-bundle-migration.v0.1.schema.json",
  );
  const assuranceSigningSchema = readJson(
    "schema/assurance-signing.v0.1.schema.json",
  );
  const assuranceSigningVerificationSchema = readJson(
    "schema/assurance-signing-verification.v0.1.schema.json",
  );
  const remediationSuggestionSchema = readJson(
    "schema/remediation-suggestion.v0.1.schema.json",
  );
  const remediationSuggestionReportSchema = readJson(
    "schema/remediation-suggestion-report.v0.1.schema.json",
  );
  const remediationRulesSchema = readJson(
    "schema/remediation-rules.v0.1.schema.json",
  );
  const contracts = policy.contracts;
  const snapshotVersion = sourceVersion(
    source,
    "GRAPH_SNAPSHOT_SCHEMA_VERSION",
  );
  const diffVersion = sourceVersion(source, "GRAPH_DIFF_SCHEMA_VERSION");
  const capabilityVersion = sourceVersion(
    capabilitySource,
    "CAPABILITY_REGISTRY_VERSION",
  );
  const policyBundleVersion = sourceVersion(
    policyBundleSource,
    "POLICY_BUNDLE_SCHEMA_VERSION",
  );
  const policyBundleMigrationVersion = sourceVersion(
    policyBundleMigrationSource,
    "POLICY_BUNDLE_MIGRATION_SCHEMA_VERSION",
  );
  const assuranceSigningVersion = sourceVersion(
    assuranceSigningSource,
    "ASSURANCE_SIGNING_SCHEMA_VERSION",
  );
  const remediationSuggestionVersion = sourceVersion(
    remediationSuggestionSource,
    "REMEDIATION_SUGGESTION_SCHEMA_VERSION",
  );
  const remediationRulesVersion = sourceVersion(
    remediationRulesSource,
    "REMEDIATION_RULESET_SCHEMA_VERSION",
  );

  if (
    snapshotVersion === undefined ||
    diffVersion === undefined ||
    capabilityVersion === undefined ||
    policyBundleVersion === undefined ||
    policyBundleMigrationVersion === undefined ||
    assuranceSigningVersion === undefined ||
    remediationSuggestionVersion === undefined ||
    remediationRulesVersion === undefined
  ) {
    throw new Error("runtime schema version constants are missing");
  }
  requireEqual(
    "snapshot runtime/policy",
    snapshotVersion,
    contracts.snapshot.current,
  );
  requireEqual("diff runtime/policy", diffVersion, contracts.diff.current);
  requireEqual(
    "GraphSnapshot JSON Schema/runtime",
    snapshotSchema.properties.schemaVersion.const,
    snapshotVersion,
  );
  requireEqual(
    "capability registry runtime/policy",
    capabilityVersion,
    contracts.capabilities.current,
  );
  requireEqual(
    "capability registry JSON Schema/runtime",
    capabilitySchema.properties.registryVersion.const,
    capabilityVersion,
  );
  requireEqual(
    "policy bundle runtime/policy",
    policyBundleVersion,
    contracts.policyBundles.current,
  );
  requireEqual(
    "policy bundle JSON Schema/runtime",
    policyBundleSchema.properties.schemaVersion.const,
    policyBundleVersion,
  );
  requireEqual(
    "policy bundle migration runtime/policy",
    policyBundleMigrationVersion,
    contracts.policyBundleMigrations.current,
  );
  requireEqual(
    "policy bundle migration JSON Schema/runtime",
    policyBundleMigrationSchema.properties.schemaVersion.const,
    policyBundleMigrationVersion,
  );
  requireEqual(
    "assurance signing runtime/policy",
    assuranceSigningVersion,
    contracts.assuranceSigning.current,
  );
  requireEqual(
    "assurance signing JSON Schema/runtime",
    assuranceSigningSchema.properties.schemaVersion.const,
    assuranceSigningVersion,
  );
  requireEqual(
    "assurance signing verification JSON Schema/runtime",
    assuranceSigningVerificationSchema.properties.schemaVersion.const,
    assuranceSigningVersion,
  );
  requireEqual(
    "remediation suggestion runtime/policy",
    remediationSuggestionVersion,
    contracts.remediationSuggestions.current,
  );
  requireEqual(
    "remediation suggestion JSON Schema/runtime",
    remediationSuggestionSchema.properties.schemaVersion.const,
    remediationSuggestionVersion,
  );
  requireEqual(
    "remediation suggestion report JSON Schema/runtime",
    remediationSuggestionReportSchema.properties.schemaVersion.const,
    remediationSuggestionVersion,
  );
  requireEqual(
    "remediation rules runtime/policy",
    remediationRulesVersion,
    contracts.remediationRules.current,
  );
  requireEqual(
    "remediation rules JSON Schema/runtime",
    remediationRulesSchema.properties.schemaVersion.const,
    remediationRulesVersion,
  );

  for (const [label, contract] of Object.entries(contracts)) {
    requireReviewed(label, contract);
  }
  checkHostedVersionChange();

  return {
    ok: true,
    policyVersion: policy.policyVersion,
    snapshotVersion,
    diffVersion,
    capabilityVersion,
    policyBundleVersion,
    policyBundleMigrationVersion,
    assuranceSigningVersion,
    remediationSuggestionVersion,
    remediationRulesVersion,
  };
};

if (process.argv[2] !== "check") {
  console.error(
    "usage: node scripts/schema-compatibility.mjs check [--root path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(checkCompatibility()));
} catch (error) {
  console.error(`schema compatibility check failed: ${error.message}`);
  process.exit(1);
}
