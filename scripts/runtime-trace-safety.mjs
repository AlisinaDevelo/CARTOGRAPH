#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  parseRuntimeTrace,
  serializeRuntimeTrace,
} from "../src/core/runtime-traces.ts";
import { reconcileRuntimeTrace } from "../src/core/runtime-reconciliation.ts";
import {
  DEFAULT_RUNTIME_TRACE_SAFETY_POLICY,
  redactRuntimeTrace,
  RUNTIME_TRACE_SAFETY_SCHEMA_VERSION,
  RuntimeTraceRetentionStore,
  RuntimeTraceSafetyError,
  RuntimeTraceSafetyPolicySchema,
  serializeRuntimeTraceSafetyPolicy,
} from "../src/core/runtime-trace-safety.ts";

const repositoryRoot = resolve(process.cwd());
const readJson = (relativePath) =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

const expectError = (operation, code) => {
  try {
    operation();
    throw new Error(`expected ${code} safety error`);
  } catch (error) {
    if (!(error instanceof RuntimeTraceSafetyError) || error.code !== code) {
      throw error;
    }
  }
};

const validate = () => {
  const schema = readJson("schema/runtime-trace-safety.v0.1.schema.json");
  const sample = readJson("schema/runtime-trace-safety.v0.1.json");
  const otlp = readJson("schema/runtime-traces-otlp.v0.1.json");
  const reconciliationFixture = readJson(
    "schema/runtime-reconciliation-fixture.v0.1.json",
  );
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(sample)) {
    throw new Error(
      `runtime trace safety JSON Schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }

  const policy = RuntimeTraceSafetyPolicySchema.parse(sample);
  const policySerialization = serializeRuntimeTraceSafetyPolicy(policy);
  if (
    policySerialization !==
    serializeRuntimeTraceSafetyPolicy(JSON.parse(policySerialization))
  ) {
    throw new Error("runtime trace safety policy serialization drifted");
  }

  const sensitive = clone(otlp);
  const secret = "TOP-SECRET-BEARER-VALUE";
  const resourceAttributes = sensitive.resourceSpans[0].resource.attributes;
  resourceAttributes[0].value.stringValue = `service-${secret}`;
  sensitive.resourceSpans[0].scopeSpans[0].spans[0].name = `GET /accounts?token=${secret}`;
  const normalized = parseRuntimeTrace(sensitive);
  if (!serializeRuntimeTrace(normalized).includes(secret)) {
    throw new Error("sensitive fixture did not reach the redaction boundary");
  }
  const redacted = redactRuntimeTrace(normalized, policy.redaction);
  const redactedSerialization = serializeRuntimeTrace(redacted);
  if (redactedSerialization.includes(secret)) {
    throw new Error("redacted runtime trace retained a sensitive value");
  }

  const reconciliationInput = clone(reconciliationFixture);
  reconciliationInput.runtimeTrace.spans[0].name = `root-${secret}`;
  reconciliationInput.runtimeTrace.spans[0].serviceName = `service-${secret}`;
  const reconciliation = reconcileRuntimeTrace(reconciliationInput);
  if (JSON.stringify(reconciliation).includes(secret)) {
    throw new Error("runtime reconciliation emitted a sensitive value");
  }

  let now = 0;
  const store = new RuntimeTraceRetentionStore(policy, () => now);
  store.put("read-once", normalized, now);
  if (store.size !== 1 || store.bytes <= 0) {
    throw new Error("retention store did not retain a bounded redacted trace");
  }
  if (!store.get("read-once", now) || store.size !== 0) {
    throw new Error("discard-after-read retention was not enforced");
  }
  store.put("expires", normalized, now);
  now = policy.retention.ttlMs;
  if (store.get("expires", now) !== undefined || store.size !== 0) {
    throw new Error("retention TTL was not enforced");
  }

  const boundedPolicy = {
    ...policy,
    retention: { ...policy.retention, mode: "memory-only", maxTraces: 1 },
  };
  const boundedStore = new RuntimeTraceRetentionStore(boundedPolicy, () => 0);
  boundedStore.put("oldest", normalized, 0);
  boundedStore.put("newest", normalized, 1);
  if (
    boundedStore.size !== 1 ||
    boundedStore.get("oldest", 1) !== undefined ||
    !boundedStore.get("newest", 1)
  ) {
    throw new Error("maxTraces retention bound was not enforced");
  }

  expectError(
    () =>
      new RuntimeTraceRetentionStore(
        {
          ...DEFAULT_RUNTIME_TRACE_SAFETY_POLICY,
          retention: {
            ...DEFAULT_RUNTIME_TRACE_SAFETY_POLICY.retention,
            maxBytes: 1,
          },
        },
        () => 0,
      ).put("too-large", normalized, 0),
    "limit-exceeded",
  );

  return {
    ok: true,
    schemaVersion: RUNTIME_TRACE_SAFETY_SCHEMA_VERSION,
    redactedFields: policy.redaction.fields.length,
    retentionMode: policy.retention.mode,
    maxTraces: policy.retention.maxTraces,
    ttlMs: policy.retention.ttlMs,
    sensitiveValueRetained: false,
    diskPersistence: false,
    network: false,
    collector: false,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/runtime-trace-safety.mjs validate",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`runtime trace safety validation failed: ${error.message}`);
  process.exit(1);
}
