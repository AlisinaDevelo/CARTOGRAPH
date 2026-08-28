#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  ADAPTER_API_VERSION,
  AdapterCapabilityManifestSchema,
  AdapterIsolationError,
  AdapterValidationError,
  parseAdapterManifest,
  parseAdapterInput,
  runAdapter,
  runAdapterIsolated,
  runAdapterConformance,
  supportsAdapterIsolation,
  serializeAdapterInput,
  serializeAdapterOutput,
} from "../src/core/index.ts";
import {
  createSampleAdapter,
  SAMPLE_ADAPTER_MANIFEST,
} from "../src/adapters/sample.ts";
import { createFastifyAdapter } from "../src/adapters/fastify.ts";
import {
  createRustAdapter,
  RUST_ADAPTER_MANIFEST,
} from "../src/adapters/rust.ts";

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
    maxInputBytes: 8_192,
    maxOutputBytes: 32_768,
    maxMemoryBytes: 256 * 1024 * 1024,
    maxWallClockMs: 1_000,
  },
});

const fastifyFixtureRoot = resolve(
  repositoryRoot,
  "test/fixtures/typescript-fastify",
);
const fastifyInput = () => ({
  apiVersion: ADAPTER_API_VERSION,
  source: {
    rootDir: fastifyFixtureRoot,
    include: ["."],
    exclude: [],
    revision: { commitSha: "fastify-fixture" },
  },
  config: {},
  resources: {
    maxFiles: 32,
    maxFileBytes: 16_384,
    maxSourceBytes: 65_536,
    maxInputBytes: 16_384,
    maxOutputBytes: 2 * 1024 * 1024,
    // The TypeScript compiler host can exceed 512 MiB on hosted Node 24
    // runners even for this deliberately small Fastify fixture.
    maxMemoryBytes: 1024 * 1024 * 1024,
    maxWallClockMs: 5_000,
  },
});

const rustFixtureRoot = resolve(repositoryRoot, "test/fixtures/rust-adapter");
const rustInput = () => ({
  apiVersion: ADAPTER_API_VERSION,
  source: {
    rootDir: rustFixtureRoot,
    include: ["."],
    exclude: [],
    revision: { commitSha: "rust-fixture" },
  },
  config: {},
  resources: {
    maxFiles: 32,
    maxFileBytes: 16_384,
    maxSourceBytes: 65_536,
    maxInputBytes: 16_384,
    maxOutputBytes: 2 * 1024 * 1024,
    maxMemoryBytes: 512 * 1024 * 1024,
    maxWallClockMs: 5_000,
  },
});

const graphEdgeKey = (edge) => `${edge.from}|${edge.to}|${edge.kind}`;

const validateRustQuality = (output) => {
  const expected = readJson("test/fixtures/rust-adapter/expected.json");
  const predicted = new Set(output.graph.edges.map(graphEdgeKey));
  const expectedEdges = new Set(expected.supportedEdgeKeys);
  const truePositives = [...predicted].filter((key) => expectedEdges.has(key));
  if (
    JSON.stringify([...predicted].sort()) !==
    JSON.stringify([...expectedEdges].sort())
  )
    throw new Error(
      "Rust fixture edge set drifted from expected bounded slice",
    );
  const diagnosticCodes = output.graph.diagnostics
    .map((diagnostic) => diagnostic.code)
    .sort();
  if (
    JSON.stringify(diagnosticCodes) !==
    JSON.stringify([...expected.unsupportedDiagnosticCodes].sort())
  )
    throw new Error("Rust fixture unsupported diagnostic set drifted");
  return {
    expectedEdges: expectedEdges.size,
    predictedEdges: predicted.size,
    truePositives: truePositives.length,
    precision: truePositives.length / predicted.size,
    recall: truePositives.length / expectedEdges.size,
    unsupportedDiagnostics: diagnosticCodes,
  };
};

const isolationInput = (fixture, overrides = {}) => ({
  apiVersion: ADAPTER_API_VERSION,
  source: {
    rootDir: repositoryRoot,
    include: ["."],
    exclude: [],
    revision: { commitSha: `isolation-${fixture}` },
  },
  config: { fixture },
  resources: {
    maxFiles: 128,
    maxFileBytes: 16_384,
    maxSourceBytes: 65_536,
    maxInputBytes: 8_192,
    maxOutputBytes: 32_768,
    maxMemoryBytes: 256 * 1024 * 1024,
    maxWallClockMs: 2_000,
    ...overrides,
  },
});

const validateIsolation = async () => {
  if (!supportsAdapterIsolation()) {
    try {
      await runAdapterIsolated({
        adapterModule: resolve(
          repositoryRoot,
          "test/fixtures/adapter-isolation/adapter.mjs",
        ),
        input: isolationInput("empty"),
      });
      throw new Error("unsupported isolation runtime unexpectedly succeeded");
    } catch (error) {
      if (
        !(error instanceof AdapterIsolationError) ||
        error.code !== "unsupported-runtime"
      )
        throw error;
    }
    return { available: false, cases: 0, terminated: 0, denied: 0 };
  }
  const adapterModule = resolve(
    repositoryRoot,
    "test/fixtures/adapter-isolation/adapter.mjs",
  );
  const output = await runAdapterIsolated({
    adapterModule,
    input: isolationInput("empty"),
  });
  if (output.graph.nodes.length !== 0 || output.graph.edges.length !== 0)
    throw new Error("isolated adapter produced a non-empty empty fixture");

  const expectIsolationFailure = async (fixture, overrides, code) => {
    try {
      await runAdapterIsolated({
        adapterModule,
        input: isolationInput(fixture, overrides),
      });
      throw new Error(`isolated ${fixture} fixture unexpectedly succeeded`);
    } catch (error) {
      if (!(error instanceof AdapterIsolationError) || error.code !== code)
        throw error;
    }
  };
  await expectIsolationFailure(
    "hang",
    { maxWallClockMs: 500 },
    "wall-clock-limit",
  );
  await expectIsolationFailure(
    "oversized",
    { maxOutputBytes: 1_024 },
    "output-limit",
  );
  await expectIsolationFailure("network", {}, "authority-denied");
  await expectIsolationFailure("child-process", {}, "authority-denied");

  try {
    await runAdapterIsolated({
      adapterModule,
      input: isolationInput("malformed-evidence"),
    });
    throw new Error(
      "isolated malformed-evidence fixture unexpectedly succeeded",
    );
  } catch (error) {
    if (
      !(error instanceof AdapterValidationError) ||
      error.code !== "invalid-output"
    )
      throw error;
  }

  try {
    parseAdapterInput({
      ...isolationInput("empty"),
      source: { ...isolationInput("empty").source, include: ["../outside"] },
    });
    throw new Error("isolated path escape fixture unexpectedly succeeded");
  } catch (error) {
    if (!(error instanceof AdapterValidationError)) throw error;
  }
  return { available: true, cases: 7, terminated: 2, denied: 2 };
};

const validate = async () => {
  const schema = readJson("schema/adapter.v0.1.schema.json");
  const inputSchema = readJson("schema/adapter-input.v0.1.schema.json");
  const sample = readJson("schema/adapter.v0.1.json");
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  const validateInputSchema = new Ajv({ allErrors: true }).compile(inputSchema);
  if (!validateSchema(sample)) {
    throw new Error(
      `adapter JSON Schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }
  if (!validateInputSchema(adapterInput("empty"))) {
    throw new Error(
      `adapter input JSON Schema validation failed: ${JSON.stringify(validateInputSchema.errors)}`,
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
  const rustAdapter = createRustAdapter();
  const rustOutput = runAdapter(rustAdapter, rustInput());
  const rustQuality = validateRustQuality(rustOutput);
  const rustConformance = runAdapterConformance(rustAdapter, {
    cases: [
      {
        id: "rust-bounded",
        input: rustInput(),
        expect: {
          minNodes: 8,
          minEdges: 9,
          unsupportedDiagnosticCodes: [
            "UNSUPPORTED_RUST_DYNAMIC_HTTP_DESTINATION",
            "UNSUPPORTED_RUST_DYNAMIC_QUERY",
          ],
        },
      },
    ],
    repetitions: 2,
    maxDurationMs: 5_000,
  });
  const fastifyAdapter = createFastifyAdapter();
  const fastifyOutput = runAdapter(fastifyAdapter, fastifyInput());
  const fastifyConformance = runAdapterConformance(fastifyAdapter, {
    cases: [
      {
        id: "fastify-bounded-routes",
        input: fastifyInput(),
        expect: {
          minNodes: 8,
          minEdges: 5,
          unsupportedDiagnosticCodes: ["UNSUPPORTED_DYNAMIC_FASTIFY_ROUTE"],
        },
      },
    ],
    repetitions: 2,
    maxDurationMs: 5_000,
  });
  const isolation = await validateIsolation();

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
    compatibility: output.compatibility?.state,
    conformance: {
      cases: conformance.cases.length,
      deterministic: conformance.deterministic,
      evidenceComplete: conformance.evidenceComplete,
      identity: conformance.identity,
      performance: conformance.performance,
    },
    fastify: {
      adapterId: fastifyAdapter.manifest.id,
      compatibility: fastifyOutput.compatibility?.state,
      cases: fastifyConformance.cases.length,
      deterministic: fastifyConformance.deterministic,
      evidenceComplete: fastifyConformance.evidenceComplete,
      routeEdges: fastifyOutput.graph.edges.filter((edge) =>
        edge.from.startsWith("endpoint:"),
      ).length,
      unknownDiagnostics: fastifyOutput.graph.diagnostics.length,
      unsupportedDiagnostics: fastifyOutput.graph.diagnostics.filter(
        (diagnostic) => diagnostic.code === "UNSUPPORTED_DYNAMIC_FASTIFY_ROUTE",
      ).length,
      unresolvedHandlers: fastifyOutput.graph.diagnostics.filter(
        (diagnostic) => diagnostic.code === "UNRESOLVED_FASTIFY_HANDLER",
      ).length,
      performance: fastifyConformance.performance,
    },
    rust: {
      adapterId: RUST_ADAPTER_MANIFEST.id,
      compatibility: rustOutput.compatibility?.state,
      cases: rustConformance.cases.length,
      deterministic: rustConformance.deterministic,
      evidenceComplete: rustConformance.evidenceComplete,
      nodes: rustOutput.graph.nodes.length,
      edges: rustOutput.graph.edges.length,
      diagnostics: rustOutput.graph.diagnostics.length,
      quality: rustQuality,
      performance: rustConformance.performance,
    },
    isolation,
  };
};

if (process.argv[2] !== "validate") {
  console.error("usage: node --import tsx scripts/adapter.mjs validate");
  process.exit(2);
}

validate()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(`adapter validation failed: ${error.message}`);
    process.exit(1);
  });
