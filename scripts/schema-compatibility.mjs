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
      file === "schema/graph-snapshot.v0.1.schema.json" ||
      file === "schema/capability-registry.v0.1.schema.json",
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
  const snapshotSchema = readJson("schema/graph-snapshot.v0.1.schema.json");
  const capabilitySchema = readJson(
    "schema/capability-registry.v0.1.schema.json",
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

  if (
    snapshotVersion === undefined ||
    diffVersion === undefined ||
    capabilityVersion === undefined
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
