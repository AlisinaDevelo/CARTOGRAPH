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
const policyPath = resolve(
  repositoryRoot,
  argumentValue("--policy") ?? "schema/upgrade-policy.v0.1.json",
);

const readJson = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));
const readText = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");
const fail = (message) => {
  throw new Error(`cartograph.upgrade-policy validation failed: ${message}`);
};
const equal = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(
      `${label}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
    );
};
const includes = (label, text, value) => {
  if (!text.includes(value)) fail(`${label} is missing ${value}`);
};

const validate = () => {
  const policy = readJson(policyPath);
  const policySchema = readJson(
    resolve(repositoryRoot, "schema/upgrade-policy.v0.1.schema.json"),
  );
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(
    policySchema,
  );
  if (!validateSchema(policy))
    fail(
      `policy schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );

  const support = readJson(
    resolve(repositoryRoot, "schema/support-matrix.v0.1.json"),
  );
  const compatibility = readJson(
    resolve(repositoryRoot, "schema/compatibility.json"),
  );
  const adapterSchema = readJson(
    resolve(repositoryRoot, "schema/adapter.v0.1.schema.json"),
  );
  const adapterSample = readJson(
    resolve(repositoryRoot, "schema/adapter.v0.1.json"),
  );
  const packageJson = readJson(resolve(repositoryRoot, "package.json"));
  const lockfile = readJson(resolve(repositoryRoot, "package-lock.json"));
  const workflow = readText(".github/workflows/ci.yml");
  const guide = readText("docs/UPGRADING.md");
  const checks = [];

  equal(
    "support node minimum",
    policy.support.nodeMinimum,
    support.node.minimum,
  );
  checks.push("support.nodeMinimum");
  equal("support Node LTS", policy.support.nodeLts, support.node.lts);
  checks.push("support.nodeLts");
  equal(
    "support platforms",
    policy.support.platforms,
    support.platforms.supported,
  );
  checks.push("support.platforms");
  equal(
    "support CI platforms",
    policy.support.ciPlatforms,
    support.platforms.ci,
  );
  checks.push("support.ciPlatforms");
  equal(
    "support TypeScript",
    policy.support.typescript,
    support.toolchain.typescript,
  );
  equal(
    "locked TypeScript",
    lockfile.packages?.["node_modules/typescript"]?.version,
    policy.support.typescript,
  );
  checks.push("support.typescript");
  equal("support ts-morph", policy.support.tsMorph, support.toolchain.tsMorph);
  equal(
    "locked ts-morph",
    lockfile.packages?.["node_modules/ts-morph"]?.version,
    policy.support.tsMorph,
  );
  checks.push("support.tsMorph");

  if (!packageJson.engines?.node?.includes(policy.support.nodeMinimum))
    fail(`package engines.node must include ${policy.support.nodeMinimum}`);
  checks.push("package.engines.node");
  for (const version of policy.support.nodeLts) {
    includes("CI Node matrix", workflow, version);
    checks.push(`workflow.node.${version}`);
  }
  for (const platform of policy.support.ciPlatforms) {
    includes("CI OS matrix", workflow, platform);
    checks.push(`workflow.os.${platform}`);
  }

  const compatibilityMap = {
    snapshot: "snapshot",
    diff: "diff",
    capabilities: "capabilities",
    diagnostics: "diagnostics",
    adapters: "adapters",
    adapterCompatibilityNegotiation: "adapterCompatibilityNegotiation",
  };
  for (const [policyKey, manifestKey] of Object.entries(compatibilityMap)) {
    equal(
      `compatibility.${policyKey}`,
      policy.compatibility[policyKey],
      compatibility.contracts[manifestKey]?.current,
    );
    checks.push(`compatibility.${policyKey}`);
  }
  equal(
    "adapter schema apiVersion",
    policy.compatibility.adapterApi,
    adapterSchema.properties.apiVersion.const,
  );
  equal(
    "adapter sample apiVersion",
    policy.compatibility.adapterApi,
    adapterSample.apiVersion,
  );
  equal(
    "adapter schema compatibilityVersion",
    policy.compatibility.adapterCompatibility,
    adapterSchema.properties.compatibilityVersion.const,
  );
  equal(
    "adapter sample compatibilityVersion",
    policy.compatibility.adapterCompatibility,
    adapterSample.compatibilityVersion,
  );
  checks.push("adapter.apiVersion", "adapter.compatibilityVersion");

  includes("upgrade guide", guide, "schema/upgrade-policy.v0.1.json");
  includes("upgrade guide", guide, "Semantic-versioning rules");
  includes("upgrade guide", guide, "Deprecation");
  includes("upgrade guide", guide, policy.maintenance.owner);
  includes("upgrade guide", guide, policy.support.nodeMinimum);
  includes("upgrade guide", guide, "npm run upgrade:validate");
  checks.push("upgrade-guide");

  return {
    ok: true,
    contract: policy.contract,
    schemaVersion: policy.schemaVersion,
    policyId: policy.policyId,
    checks: checks.length,
    support: policy.support,
    compatibility: policy.compatibility,
    owner: policy.maintenance.owner,
    releaseGating: false,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node scripts/upgrade-policy.mjs validate [--root path] [--policy path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
