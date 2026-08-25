#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertSupportedEnvironment,
  currentSupportEnvironment,
  SUPPORT_MATRIX_CONTRACT,
  SUPPORT_MATRIX_DIAGNOSTIC_CODE,
  SUPPORT_MATRIX_SCHEMA_VERSION,
  SUPPORTED_NODE_LTS,
  SUPPORTED_NODE_MINIMUM,
  SUPPORTED_PLATFORMS,
  UnsupportedEnvironmentError,
} from "../src/core/support.ts";

const repositoryRoot = resolve(process.cwd());
const readJson = (relativePath) =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
const readText = (relativePath) =>
  readFileSync(resolve(repositoryRoot, relativePath), "utf8");

const fail = (message) => {
  throw new Error(`${SUPPORT_MATRIX_CONTRACT} validation failed: ${message}`);
};

const requireEqual = (label, actual, expected) => {
  if (actual !== expected)
    fail(`${label}: expected ${expected}, found ${actual}`);
};

const requireIncludes = (label, values, expected) => {
  if (!values.includes(expected)) fail(`${label} does not include ${expected}`);
};

const requireWorkflowValue = (workflow, label, value) => {
  if (!workflow.includes(value))
    fail(`CI workflow is missing ${label}: ${value}`);
};

const validate = () => {
  const matrix = readJson("schema/support-matrix.v0.1.json");
  const schema = readJson("schema/support-matrix.v0.1.schema.json");
  const packageJson = readJson("package.json");
  const lockfile = readJson("package-lock.json");
  const workflow = readText(".github/workflows/ci.yml");

  requireEqual(
    "matrix schemaVersion",
    matrix.schemaVersion,
    SUPPORT_MATRIX_SCHEMA_VERSION,
  );
  requireEqual("matrix contract", matrix.contract, SUPPORT_MATRIX_CONTRACT);
  requireEqual(
    "diagnostic code",
    matrix.diagnosticCode,
    SUPPORT_MATRIX_DIAGNOSTIC_CODE,
  );
  requireEqual(
    "JSON Schema version",
    schema.properties.schemaVersion.const,
    SUPPORT_MATRIX_SCHEMA_VERSION,
  );
  requireEqual(
    "JSON Schema contract",
    schema.properties.contract.const,
    SUPPORT_MATRIX_CONTRACT,
  );
  requireEqual(
    "minimum Node version",
    matrix.node.minimum,
    SUPPORTED_NODE_MINIMUM,
  );
  for (const version of SUPPORTED_NODE_LTS)
    requireIncludes("declared Node LTS", matrix.node.lts, version);
  for (const platform of SUPPORTED_PLATFORMS)
    requireIncludes("supported platform", matrix.platforms.supported, platform);

  const typescriptVersion =
    lockfile.packages?.["node_modules/typescript"]?.version;
  const tsMorphVersion = lockfile.packages?.["node_modules/ts-morph"]?.version;
  requireEqual(
    "locked TypeScript version",
    typescriptVersion,
    matrix.toolchain.typescript,
  );
  requireEqual(
    "locked ts-morph version",
    tsMorphVersion,
    matrix.toolchain.tsMorph,
  );
  if (
    typeof packageJson.engines?.node !== "string" ||
    !packageJson.engines.node.includes(matrix.node.minimum)
  )
    fail(`package engines.node must include ${matrix.node.minimum}`);

  for (const version of matrix.node.ci)
    requireWorkflowValue(workflow, "Node CI version", version);
  for (const platform of matrix.platforms.ci)
    requireWorkflowValue(workflow, "OS CI runner", platform);
  requireWorkflowValue(
    workflow,
    "matrix OS runner",
    "runs-on: ${{ matrix.os }}",
  );
  requireWorkflowValue(
    workflow,
    "matrix Node setup",
    "node-version: ${{ matrix.node-version }}",
  );

  let runtime;
  try {
    runtime = assertSupportedEnvironment(currentSupportEnvironment());
  } catch (error) {
    if (error instanceof UnsupportedEnvironmentError) throw error;
    throw error;
  }
  return {
    ok: true,
    contract: SUPPORT_MATRIX_CONTRACT,
    schemaVersion: SUPPORT_MATRIX_SCHEMA_VERSION,
    runtime,
    matrix: {
      node: matrix.node,
      platforms: matrix.platforms,
      toolchain: matrix.toolchain,
    },
    diagnosticCode: matrix.diagnosticCode,
  };
};

if (process.argv[2] !== "validate") {
  console.error("usage: node scripts/support-matrix.mjs validate");
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
