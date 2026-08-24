#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  parseRuntimeTraceJson,
  RUNTIME_TRACE_SCHEMA_VERSION,
  RuntimeTraceSchema,
  RuntimeTraceValidationError,
  serializeRuntimeTrace,
} from "../src/core/runtime-traces.ts";

const repositoryRoot = resolve(process.cwd());
const readJson = (relativePath) =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));

const validate = () => {
  const schema = readJson("schema/runtime-traces.v0.1.schema.json");
  const sample = readJson("schema/runtime-traces.v0.1.json");
  const otlp = readJson("schema/runtime-traces-otlp.v0.1.json");
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(sample)) {
    throw new Error(
      `runtime trace JSON Schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }
  const parsedSample = RuntimeTraceSchema.parse(sample);
  const normalized = parseRuntimeTraceJson(JSON.stringify(otlp));
  if (
    normalized.summary.discardedAttributes !== 5 ||
    normalized.spans[0]?.serviceName !== "sample-service" ||
    normalized.spans[0]?.status !== "ok"
  ) {
    throw new Error(
      `runtime trace fixture normalized unexpectedly: ${JSON.stringify(normalized)}`,
    );
  }
  const serialized = serializeRuntimeTrace(normalized);
  if (serialized.includes("discard-me")) {
    throw new Error(
      "runtime trace normalization retained a discarded attribute or status message",
    );
  }
  if (
    serializeRuntimeTrace(parsedSample) !==
    serializeRuntimeTrace(JSON.parse(serializeRuntimeTrace(parsedSample)))
  ) {
    throw new Error("runtime trace canonical serialization drifted");
  }
  try {
    parseRuntimeTraceJson("{");
    throw new Error("invalid JSON was accepted");
  } catch (error) {
    if (
      !(error instanceof RuntimeTraceValidationError) ||
      error.code !== "invalid-json"
    ) {
      throw error;
    }
  }
  try {
    parseRuntimeTraceJson(JSON.stringify(otlp), { maxSpans: 0 });
    throw new Error("invalid runtime limit was accepted");
  } catch (error) {
    if (
      !(error instanceof RuntimeTraceValidationError) ||
      error.code !== "invalid-input"
    ) {
      throw error;
    }
  }
  return {
    ok: true,
    schemaVersion: RUNTIME_TRACE_SCHEMA_VERSION,
    format: normalized.format,
    spans: normalized.spans.length,
    discardedAttributes: normalized.summary.discardedAttributes,
    network: false,
    collector: false,
  };
};

if (process.argv[2] !== "validate") {
  console.error("usage: node --import tsx scripts/runtime-traces.mjs validate");
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`runtime trace validation failed: ${error.message}`);
  process.exit(1);
}
