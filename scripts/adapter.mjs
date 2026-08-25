#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  ADAPTER_API_VERSION,
  AdapterCapabilityManifestSchema,
  AdapterValidationError,
  parseAdapterManifest,
  runAdapter,
  runAdapterConformance,
  serializeAdapterInput,
  serializeAdapterOutput,
} from "../src/core/index.ts";
import {
  createSampleAdapter,
  SAMPLE_ADAPTER_MANIFEST,
} from "../src/adapters/sample.ts";

const repositoryRoot = resolve(process.cwd());
const readJson = (relativePath) =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));

const adapterInput = (fixture, commitSha = "sample-fixture") => ({
  apiVersion: ADAPTER_API_VERSION,
  source: {
    rootDir: repositoryRoot,
    include: ["."],
    exclude: [],
    revision: { commitSha },
  },
  config: { fixture },
  resources: {
    maxFiles: 1,
    maxFileBytes: 1_024,
    maxSourceBytes: 1_024,
    maxWallClockMs: 1_000,
  },
});

const validate = () => {
  const schema = readJson("schema/adapter.v0.1.schema.json");
  const sample = readJson("schema/adapter.v0.1.json");
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(sample)) {
    throw new Error(
      `adapter JSON Schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }

  const parsedSample = parseAdapterManifest(sample);
  if (
    serializeAdapterInput({
      apiVersion: ADAPTER_API_VERSION,
      source: { rootDir: repositoryRoot, include: ["."], exclude: [] },
      config: { fixture: "empty" },
      resources: {
        maxFiles: 1,
        maxFileBytes: 1_024,
        maxSourceBytes: 1_024,
        maxWallClockMs: 1_000,
      },
    }).length === 0
  ) {
    throw new Error(
      "adapter input serialization unexpectedly produced no data",
    );
  }

  const output = runAdapter(createSampleAdapter(), adapterInput("empty"));
  if (
    output.graph.nodes.length !== 0 ||
    output.graph.edges.length !== 0 ||
    output.capability.id !== parsedSample.id ||
    output.capability.execution.network !== false ||
    output.capability.execution.repositoryCodeExecution !== false
  ) {
    throw new Error(
      `sample adapter produced an unexpected output: ${JSON.stringify(output)}`,
    );
  }

  const parsedManifest = AdapterCapabilityManifestSchema.parse(
    SAMPLE_ADAPTER_MANIFEST,
  );
  if (
    serializeAdapterOutput(output) !==
    serializeAdapterOutput(JSON.parse(serializeAdapterOutput(output)))
  ) {
    throw new Error("adapter output canonical serialization drifted");
  }

  try {
    parseAdapterManifest({
      ...parsedManifest,
      execution: { ...parsedManifest.execution, network: true },
    });
    throw new Error("unsafe adapter execution policy was accepted");
  } catch (error) {
    if (!(error instanceof AdapterValidationError)) throw error;
  }

  const conformance = runAdapterConformance(createSampleAdapter(), {
    cases: [
      { id: "empty", input: adapterInput("empty") },
      {
        id: "supported",
        input: adapterInput("supported"),
        expect: { minNodes: 2, minEdges: 1 },
      },
      {
        id: "unsupported",
        input: adapterInput("unsupported"),
        expect: {
          minNodes: 2,
          minEdges: 1,
          unsupportedDiagnosticCodes: ["UNSUPPORTED_SAMPLE_CONSTRUCT"],
        },
      },
    ],
    identity: {
      before: adapterInput("identity-before", "identity-before"),
      after: adapterInput("identity-after", "identity-after"),
      expectedMatches: 1,
      maxAdded: 0,
      maxRemoved: 0,
    },
    repetitions: 2,
    maxDurationMs: 1_000,
  });

  return {
    ok: true,
    apiVersion: ADAPTER_API_VERSION,
    adapterId: parsedSample.id,
    capabilities: parsedSample.capabilities.length,
    graphNodes: output.graph.nodes.length,
    graphEdges: output.graph.edges.length,
    network: output.capability.execution.network,
    repositoryCodeExecution:
      output.capability.execution.repositoryCodeExecution,
    conformance: {
      cases: conformance.cases.length,
      deterministic: conformance.deterministic,
      evidenceComplete: conformance.evidenceComplete,
      identity: conformance.identity,
      performance: conformance.performance,
    },
  };
};

if (process.argv[2] !== "validate") {
  console.error("usage: node --import tsx scripts/adapter.mjs validate");
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`adapter validation failed: ${error.message}`);
  process.exit(1);
}
