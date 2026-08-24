#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  reconcileRuntimeTrace,
  RUNTIME_RECONCILIATION_SCHEMA_VERSION,
  RuntimeReconciliationError,
  RuntimeReconciliationSchema,
  serializeRuntimeReconciliation,
} from "../src/core/runtime-reconciliation.ts";

const repositoryRoot = resolve(process.cwd());
const readJson = (relativePath) =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

const expectError = (operation, code) => {
  try {
    operation();
    throw new Error(`expected ${code} validation error`);
  } catch (error) {
    if (!(error instanceof RuntimeReconciliationError) || error.code !== code) {
      throw error;
    }
  }
};

const validate = () => {
  const schema = readJson("schema/runtime-reconciliation.v0.1.schema.json");
  const sample = readJson("schema/runtime-reconciliation.v0.1.json");
  const fixture = readJson("schema/runtime-reconciliation-fixture.v0.1.json");
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(sample)) {
    throw new Error(
      `runtime reconciliation JSON Schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }

  const parsedSample = RuntimeReconciliationSchema.parse(sample);
  const result = reconcileRuntimeTrace(fixture);
  if (
    result.summary.staticEdges !== 4 ||
    result.summary.runtimeSpanEdges !== 3 ||
    result.summary.mappedSpans !== 5 ||
    result.summary.observedAndModeled !== 1 ||
    result.summary.modeledNotObserved !== 1 ||
    result.summary.observedButUnmodeled !== 1 ||
    result.summary.ambiguous !== 1
  ) {
    throw new Error(
      `runtime reconciliation fixture normalized unexpectedly: ${JSON.stringify(result.summary)}`,
    );
  }
  if (
    serializeRuntimeReconciliation(result) !==
    serializeRuntimeReconciliation(parsedSample)
  ) {
    throw new Error(
      "runtime reconciliation sample does not match deterministic fixture output",
    );
  }
  if (
    serializeRuntimeReconciliation(result) !==
    serializeRuntimeReconciliation(
      JSON.parse(serializeRuntimeReconciliation(result)),
    )
  ) {
    throw new Error("runtime reconciliation canonical serialization drifted");
  }

  const unknownNode = clone(fixture);
  unknownNode.bindings[0].nodeId = "missing-node";
  expectError(() => reconcileRuntimeTrace(unknownNode), "unknown-binding-node");

  const unknownSpan = clone(fixture);
  unknownSpan.bindings[0].spanId = "ffffffffffffffff";
  expectError(() => reconcileRuntimeTrace(unknownSpan), "unknown-binding-span");

  const duplicateBinding = clone(fixture);
  duplicateBinding.bindings.push(duplicateBinding.bindings[0]);
  expectError(
    () => reconcileRuntimeTrace(duplicateBinding),
    "duplicate-binding",
  );

  return {
    ok: true,
    schemaVersion: RUNTIME_RECONCILIATION_SCHEMA_VERSION,
    records: result.records.length,
    classifications: {
      observedAndModeled: result.summary.observedAndModeled,
      modeledNotObserved: result.summary.modeledNotObserved,
      observedButUnmodeled: result.summary.observedButUnmodeled,
      ambiguous: result.summary.ambiguous,
    },
    network: false,
    collector: false,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/runtime-reconciliation.mjs validate",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`runtime reconciliation validation failed: ${error.message}`);
  process.exit(1);
}
