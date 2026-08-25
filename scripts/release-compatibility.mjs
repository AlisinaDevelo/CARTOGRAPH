#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import Ajv from "ajv";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const matrixRelativePath = "schema/release-compatibility-matrix.v0.1.json";
const matrixPath = resolve(
  repositoryRoot,
  argumentValue("--matrix") ?? matrixRelativePath,
);
const matrixSchemaPath = resolve(
  repositoryRoot,
  "schema/release-compatibility-matrix.v0.1.schema.json",
);
const recordSchemaPath = resolve(
  repositoryRoot,
  "schema/release-compatibility-record.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readText = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");
const fail = (message) => {
  throw new Error(
    `cartograph.release-compatibility validation failed: ${message}`,
  );
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
const digest = (value) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const sortedJson = (values) =>
  [...values].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );

const packageJson = readJson(resolve(repositoryRoot, "package.json"));

const validate = () => {
  const matrix = readJson(matrixPath);
  const matrixSchema = readJson(matrixSchemaPath);
  const validateMatrixSchema = new Ajv({
    allErrors: true,
    strict: false,
  }).compile(matrixSchema);
  if (!validateMatrixSchema(matrix))
    fail(
      `matrix schema validation failed: ${JSON.stringify(validateMatrixSchema.errors)}`,
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
  const policySchema = readJson(
    resolve(repositoryRoot, "schema/policy.v0.1.schema.json"),
  );
  const ciWorkflow = readText(".github/workflows/ci.yml");
  const releaseWorkflow = readText(".github/workflows/release.yml");
  const action = readText("action.yml");
  const docs = readText("docs/RELEASE_COMPATIBILITY.md");
  const normalizedDocs = docs.replace(/\s+/gu, " ");
  const allActionSources = `${ciWorkflow}\n${releaseWorkflow}\n${action}`;

  equal("runtime Node lines", matrix.runtime.node, support.node.ci);
  equal("runtime OS lines", matrix.runtime.os, support.platforms.ci);
  equal(
    "snapshot contract",
    matrix.contracts.snapshot,
    compatibility.contracts.snapshot.current,
  );
  equal(
    "diff contract",
    matrix.contracts.diff,
    compatibility.contracts.diff.current,
  );
  equal(
    "policy contract",
    matrix.contracts.policy,
    compatibility.contracts.policies.current,
  );
  equal(
    "adapter API contract",
    matrix.contracts.adapterApi,
    adapterSchema.properties.apiVersion.const,
  );
  equal(
    "adapter sample API contract",
    matrix.contracts.adapterApi,
    adapterSample.apiVersion,
  );
  equal(
    "adapter compatibility contract",
    matrix.contracts.adapterCompatibility,
    adapterSchema.properties.compatibilityVersion.const,
  );
  equal(
    "adapter sample compatibility contract",
    matrix.contracts.adapterCompatibility,
    adapterSample.compatibilityVersion,
  );
  equal(
    "policy schema contract",
    matrix.contracts.policy,
    policySchema.properties.schemaVersion.const,
  );
  equal("Action package version", matrix.contracts.action, packageJson.version);

  for (const node of matrix.runtime.node)
    includes("CI Node matrix", ciWorkflow, `- "${node}"`);
  for (const os of matrix.runtime.os)
    includes("CI OS matrix", ciWorkflow, `- ${os}`);
  includes("CI runner matrix", ciWorkflow, "runs-on: ${{ matrix.os }}");
  includes(
    "CI Node setup",
    ciWorkflow,
    "node-version: ${{ matrix.node-version }}",
  );
  for (const command of [
    "npm run release-compatibility:validate",
    "npm run policy:validate",
    "npm run adapter:validate",
    "npm run action:validate",
  ])
    includes("CI compatibility coverage", ciWorkflow, command);

  includes(
    "composite Action runtime",
    action,
    `node-version: ${matrix.runtime.actionNode}`,
  );
  includes(
    "release runtime",
    releaseWorkflow,
    `node-version: ${matrix.runtime.actionNode}`,
  );
  includes(
    "release compatibility record",
    releaseWorkflow,
    matrix.release.recordFile,
  );
  includes(
    "release artifact builder",
    releaseWorkflow,
    "scripts/release-artifact.mjs",
  );
  for (const pinnedAction of matrix.actions)
    includes(
      "pinned Action reference",
      allActionSources,
      `${pinnedAction.id}@${pinnedAction.ref}`,
    );

  const expectedCombinations = [];
  for (const os of matrix.runtime.os) {
    for (const node of matrix.runtime.node) {
      expectedCombinations.push({
        os,
        node,
        snapshot: matrix.contracts.snapshot,
        diff: matrix.contracts.diff,
        policy: matrix.contracts.policy,
        adapterApi: matrix.contracts.adapterApi,
        adapterCompatibility: matrix.contracts.adapterCompatibility,
        action: matrix.contracts.action,
      });
    }
  }
  equal(
    "runtime Cartesian combinations",
    sortedJson(matrix.combinations),
    sortedJson(expectedCombinations),
  );

  const matrixDigest = digest(matrix);
  includes("compatibility documentation matrix ID", docs, matrix.matrixId);
  includes("compatibility documentation digest", docs, matrixDigest);
  for (const combination of matrix.combinations)
    includes(
      "compatibility documentation row",
      normalizedDocs,
      `| \`${combination.os}\` | \`${combination.node}\` |`,
    );
  includes(
    "compatibility documentation record",
    docs,
    matrix.release.recordFile,
  );
  includes(
    "compatibility documentation validator",
    docs,
    matrix.release.validatorCommand,
  );

  return {
    ok: true,
    contract: matrix.contract,
    schemaVersion: matrix.schemaVersion,
    matrixId: matrix.matrixId,
    matrixDigest,
    combinations: matrix.combinations.length,
    contracts: matrix.contracts,
    actions: matrix.actions.map(({ id, version }) => ({ id, version })),
    releaseRecord: matrix.release.recordFile,
  };
};

const record = () => {
  const validation = validate();
  const matrix = readJson(matrixPath);
  const tag = argumentValue("--tag") ?? `v${packageJson.version}`;
  if (tag !== `v${packageJson.version}`)
    fail(
      `release tag ${tag} does not match package version ${packageJson.version}`,
    );
  const sourceCommit =
    argumentValue("--source-commit") ??
    process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit))
    fail(`source commit must be a 40-character SHA: ${sourceCommit}`);
  const output = argumentValue("--output");
  if (!output) fail("record requires --output path");
  const npmVersion = execFileSync("npm", ["--version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const value = {
    schemaVersion: 1,
    contract: "cartograph.release-compatibility-record",
    matrixId: matrix.matrixId,
    matrixDigest: validation.matrixDigest,
    package: { name: packageJson.name, version: packageJson.version, tag },
    sourceCommit,
    testedBy: ["npm run release-compatibility:validate", "npm run check"],
    runtime: {
      node: process.version,
      npm: npmVersion,
      platform: process.platform,
      arch: process.arch,
    },
    contracts: matrix.contracts,
    actions: matrix.actions,
    testedCombinations: matrix.combinations,
    result: "passed",
  };
  const recordSchema = readJson(recordSchemaPath);
  const validateRecordSchema = new Ajv({
    allErrors: true,
    strict: false,
  }).compile(recordSchema);
  if (!validateRecordSchema(value))
    fail(
      `record schema validation failed: ${JSON.stringify(validateRecordSchema.errors)}`,
    );
  const outputPath = resolve(output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
  return {
    ...validation,
    record: relative(repositoryRoot, outputPath),
    sourceCommit,
    runtime: value.runtime,
    result: value.result,
  };
};

const command = process.argv[2];
if (command !== "validate" && command !== "record") {
  console.error(
    "usage: node scripts/release-compatibility.mjs validate|record [--root path] [--matrix path] [--output path] [--tag v0.1.0] [--source-commit sha]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(command === "record" ? record() : validate()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
