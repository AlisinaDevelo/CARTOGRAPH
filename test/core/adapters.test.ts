import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADAPTER_API_VERSION,
  ADAPTER_CONTRACT,
  ADAPTER_MEDIA_TYPE,
  AdapterValidationError,
  parseAdapterInput,
  parseAdapterManifest,
  parseAdapterOutput,
  runAdapter,
  runAdapterConformance,
  serializeAdapterManifest,
  serializeAdapterOutput,
  type AdapterCapabilityManifest,
  type CartographAdapter,
} from "../../src/core/index.js";
import {
  createSampleAdapter,
  SAMPLE_ADAPTER_MANIFEST,
} from "../../src/adapters/index.js";
import { createFastifyAdapter } from "../../src/adapters/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fastifyFixtureRoot = resolve(
  repositoryRoot,
  "test/fixtures/typescript-fastify",
);
const schema = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/adapter.v0.1.schema.json"),
    "utf8",
  ),
) as object;
const sample = JSON.parse(
  readFileSync(resolve(repositoryRoot, "schema/adapter.v0.1.json"), "utf8"),
) as unknown;

const request = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: ADAPTER_API_VERSION,
  source: {
    rootDir: repositoryRoot,
    include: ["."],
    exclude: [],
    revision: { commitSha: "adapter-fixture" },
  },
  config: { fixture: "empty" },
  resources: {
    maxFiles: 1,
    maxFileBytes: 1_024,
    maxSourceBytes: 1_024,
    maxWallClockMs: 1_000,
  },
  ...overrides,
});

const fastifyRequest = (overrides: Record<string, unknown> = {}) => ({
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
    maxMemoryBytes: 512 * 1024 * 1024,
    maxWallClockMs: 30_000,
  },
  ...overrides,
});

describe("adapter contract", () => {
  it("validates the published manifest and canonicalizes it deterministically", () => {
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(sample)).toBe(true);
    expect(validate.errors).toBeNull();

    const manifest = parseAdapterManifest(sample);
    expect(manifest).toEqual(SAMPLE_ADAPTER_MANIFEST);
    expect(serializeAdapterManifest(manifest)).toBe(
      serializeAdapterManifest(JSON.parse(serializeAdapterManifest(manifest))),
    );
  });

  it("runs the sample adapter without granting execution authority", () => {
    const output = runAdapter(createSampleAdapter(), request());

    expect(output).toMatchObject({
      apiVersion: 1,
      graph: {
        revision: { commitSha: "adapter-fixture" },
        nodes: [],
        edges: [],
      },
      evidence: [],
      diagnostics: [],
      capability: {
        id: "cartograph.sample",
        execution: {
          filesystem: "source-read-only",
          network: false,
          childProcess: false,
          dynamicModuleLoading: false,
          repositoryCodeExecution: false,
        },
      },
    });
    expect(serializeAdapterOutput(output)).toBe(
      serializeAdapterOutput(JSON.parse(serializeAdapterOutput(output))),
    );
  });

  it("runs the reference adapter through every conformance gate", () => {
    const input = (fixture: string, commitSha = "adapter-fixture") =>
      request({
        config: { fixture },
        source: { ...request().source, revision: { commitSha } },
      });
    const report = runAdapterConformance(createSampleAdapter(), {
      cases: [
        { id: "empty", input: input("empty") },
        {
          id: "supported",
          input: input("supported"),
          expect: { minNodes: 2, minEdges: 1 },
        },
        {
          id: "unsupported",
          input: input("unsupported"),
          expect: {
            minNodes: 2,
            minEdges: 1,
            unsupportedDiagnosticCodes: ["UNSUPPORTED_SAMPLE_CONSTRUCT"],
          },
        },
      ],
      identity: {
        before: input("identity-before", "identity-before"),
        after: input("identity-after", "identity-after"),
        expectedMatches: 1,
        maxAdded: 0,
        maxRemoved: 0,
      },
      repetitions: 2,
      maxDurationMs: 1_000,
    });

    expect(report).toMatchObject({
      ok: true,
      adapterId: "cartograph.sample",
      deterministic: true,
      evidenceComplete: true,
      identity: { matches: 1, ambiguous: 0, added: 0, removed: 0 },
      performance: { repetitions: 2, maxDurationMs: 1_000 },
    });
    expect(report.cases).toHaveLength(3);
    expect(
      report.cases.find((testCase) => testCase.id === "unsupported"),
    ).toMatchObject({
      diagnosticCodes: ["UNSUPPORTED_SAMPLE_CONSTRUCT"],
      evidenceComplete: true,
    });
  });

  it("fails closed when an adapter drops referenced evidence", () => {
    const adapter = createSampleAdapter();
    const invalid: CartographAdapter = {
      manifest: adapter.manifest,
      analyze(input) {
        const output = adapter.analyze(input);
        return { ...output, evidence: [] };
      },
    };

    expect(() =>
      runAdapterConformance(invalid, {
        cases: [
          {
            id: "missing-evidence",
            input: request({ config: { fixture: "supported" } }),
          },
        ],
      }),
    ).toThrow(/referenced but not declared/u);
  });

  it("rejects unsafe authority declarations and executable configuration", () => {
    expect(() =>
      parseAdapterManifest({
        ...SAMPLE_ADAPTER_MANIFEST,
        execution: { ...SAMPLE_ADAPTER_MANIFEST.execution, network: true },
      }),
    ).toThrow(AdapterValidationError);
    expect(() =>
      parseAdapterInput(request({ config: { command: "node" } })),
    ).toThrow(AdapterValidationError);
    expect(() =>
      parseAdapterInput(
        request({
          source: { ...request().source, include: ["../outside"] },
        }),
      ),
    ).toThrow(AdapterValidationError);
    expect(() =>
      parseAdapterInput(
        request({
          source: { ...request().source, include: ["file:///outside"] },
        }),
      ),
    ).toThrow(AdapterValidationError);
  });

  it("fails closed when an adapter returns a different capability manifest", () => {
    const mismatchedManifest: AdapterCapabilityManifest = parseAdapterManifest({
      ...SAMPLE_ADAPTER_MANIFEST,
      id: "cartograph.other",
    });
    const adapter: CartographAdapter = {
      manifest: SAMPLE_ADAPTER_MANIFEST,
      analyze(input) {
        return parseAdapterOutput({
          apiVersion: ADAPTER_API_VERSION,
          graph: {
            schemaVersion: 1,
            capabilityRegistryVersion: 1,
            revision: input.source.revision ?? { commitSha: "fixture" },
            nodes: [],
            edges: [],
            diagnostics: [],
          },
          evidence: [],
          diagnostics: [],
          capability: mismatchedManifest,
        });
      },
    };

    expect(() => runAdapter(adapter, request())).toThrow(
      AdapterValidationError,
    );
    expect(() => runAdapter(adapter, request())).toThrow(
      /does not match cartograph\.sample@0\.1\.0/u,
    );
  });

  it("rejects a manifest with an incompatible API version", () => {
    expect(() =>
      parseAdapterManifest({
        ...SAMPLE_ADAPTER_MANIFEST,
        contract: ADAPTER_CONTRACT,
        mediaType: ADAPTER_MEDIA_TYPE,
        apiVersion: 2,
      }),
    ).toThrow(AdapterValidationError);
  });

  it("runs the bounded Fastify adapter and publishes unsupported metrics", () => {
    const adapter = createFastifyAdapter();
    const output = runAdapter(adapter, fastifyRequest());
    const routeEdges = output.graph.edges.filter((edge) =>
      edge.from.startsWith("endpoint:"),
    );
    expect(adapter.manifest.id).toBe("cartograph.fastify");
    expect(routeEdges).toHaveLength(5);
    expect(
      output.graph.diagnostics.filter(
        (diagnostic) => diagnostic.code === "UNSUPPORTED_DYNAMIC_FASTIFY_ROUTE",
      ),
    ).toHaveLength(3);
    expect(
      output.graph.diagnostics.filter(
        (diagnostic) => diagnostic.code === "UNRESOLVED_FASTIFY_HANDLER",
      ),
    ).toHaveLength(1);

    const report = runAdapterConformance(adapter, {
      cases: [
        {
          id: "fastify-bounded-routes",
          input: fastifyRequest(),
          expect: {
            minNodes: 8,
            minEdges: 5,
            unsupportedDiagnosticCodes: ["UNSUPPORTED_DYNAMIC_FASTIFY_ROUTE"],
          },
        },
      ],
      repetitions: 2,
      maxDurationMs: 30_000,
    });
    expect(report).toMatchObject({
      ok: true,
      adapterId: "cartograph.fastify",
      deterministic: true,
      evidenceComplete: true,
      performance: { repetitions: 2, maxDurationMs: 30_000 },
    });
    expect(report.cases[0]?.diagnosticCodes).toContain(
      "UNSUPPORTED_DYNAMIC_FASTIFY_ROUTE",
    );
  });
});
