import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADAPTER_API_VERSION,
  ADAPTER_COMPATIBILITY_REGISTRY,
  ADAPTER_COMPATIBILITY_SCHEMA_VERSION,
  AdapterValidationError,
  createFastifyAdapter,
  createSampleAdapter,
  negotiateAdapterCompatibility,
  runAdapter,
  type CartographAdapter,
} from "../../src/index.js";
import {
  FASTIFY_ADAPTER_MANIFEST,
  SAMPLE_ADAPTER_MANIFEST,
} from "../../src/adapters/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const registrySchemaPath = resolve(
  repositoryRoot,
  "schema/adapter-compatibility.v0.1.schema.json",
);
const registryPath = resolve(
  repositoryRoot,
  "schema/adapter-compatibility.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/adapter-compatibility-fixtures.v0.1.schema.json",
);
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/adapter-compatibility/scenarios.v0.1.json",
);

const request = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: ADAPTER_API_VERSION,
  source: {
    rootDir: repositoryRoot,
    include: ["."],
    exclude: [],
    revision: { commitSha: "adapter-compatibility-fixture" },
  },
  config: { fixture: "supported" },
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

const manifestFor = (
  base: typeof SAMPLE_ADAPTER_MANIFEST,
  scenario: {
    adapterId: string;
    adapterVersion: string;
    stability: "stable" | "experimental";
    offered: {
      apiVersion: number;
      compatibilityVersion: number;
      capabilityRegistryVersion: number;
      graphSchemaVersion: number;
    };
  },
) => ({
  ...base,
  id: scenario.adapterId,
  version: scenario.adapterVersion,
  stability: scenario.stability,
  ...scenario.offered,
});

describe("adapter compatibility negotiation", () => {
  it("keeps the runtime registry and published schema/data aligned", () => {
    const schema = JSON.parse(
      readFileSync(registrySchemaPath, "utf8"),
    ) as object;
    const data = JSON.parse(readFileSync(registryPath, "utf8")) as unknown;
    const validate = new Ajv({ allErrors: true }).compile(schema);

    expect(validate(data)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(data).toEqual(ADAPTER_COMPATIBILITY_REGISTRY);
    expect(ADAPTER_COMPATIBILITY_SCHEMA_VERSION).toBe(1);
    expect(ADAPTER_COMPATIBILITY_REGISTRY.migrations).toHaveLength(1);
  });

  it("covers current, migratable, experimental, and rejected combinations", () => {
    const schema = JSON.parse(
      readFileSync(fixtureSchemaPath, "utf8"),
    ) as object;
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      target: {
        apiVersion: number;
        compatibilityVersion: number;
        capabilityRegistryVersion: number;
        graphSchemaVersion: number;
      };
      cases: Array<{
        adapterId: string;
        adapterVersion: string;
        stability: "stable" | "experimental";
        offered: {
          apiVersion: number;
          compatibilityVersion: number;
          capabilityRegistryVersion: number;
          graphSchemaVersion: number;
        };
        allowExperimental: boolean;
        expectedState: string;
        expectedGuidance?: string;
      }>;
    };
    const validate = new Ajv({ allErrors: true }).compile(schema);
    const value = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;

    expect(validate(value)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(fixture.cases).toHaveLength(5);
    expect(new Set(fixture.cases.map((entry) => entry.adapterId))).toEqual(
      new Set(["cartograph.sample", "cartograph.fastify"]),
    );
    expect(new Set(fixture.cases.map((entry) => entry.expectedState))).toEqual(
      new Set(["compatible", "migratable", "experimental", "rejected"]),
    );

    for (const scenario of fixture.cases) {
      const base =
        scenario.adapterId === FASTIFY_ADAPTER_MANIFEST.id
          ? FASTIFY_ADAPTER_MANIFEST
          : SAMPLE_ADAPTER_MANIFEST;
      const result = negotiateAdapterCompatibility(
        manifestFor(base, scenario),
        { ...fixture.target, allowExperimental: scenario.allowExperimental },
      );
      expect(result.state).toBe(scenario.expectedState);
      if (scenario.expectedGuidance)
        expect(result.guidance.join(" ")).toContain(scenario.expectedGuidance);
      if (result.state === "migratable") {
        expect(result.migrationId).toBe(
          "cartograph.adapter.compatibility.v0-to-v1",
        );
        expect(result.migrationExpiresOn).toBe("2027-06-30");
      }
    }
  });

  it("negotiates before analysis and applies only the reviewed migration", () => {
    const base = createSampleAdapter();
    let calls = 0;
    const legacy: CartographAdapter = {
      manifest: {
        ...base.manifest,
        compatibilityVersion: 0,
      } as unknown as CartographAdapter["manifest"],
      analyze(input) {
        calls += 1;
        const output = base.analyze(input);
        return {
          ...output,
          capability: { ...output.capability, compatibilityVersion: 0 },
        } as unknown as ReturnType<CartographAdapter["analyze"]>;
      },
    };

    const output = runAdapter(legacy, request());
    expect(calls).toBe(1);
    expect(output.compatibility?.state).toBe("migratable");
    expect(output.capability.compatibilityVersion).toBe(1);
    expect(output.compatibility?.migrationId).toBe(
      "cartograph.adapter.compatibility.v0-to-v1",
    );
  });

  it("rejects incompatible and non-opted-in experimental adapters before analysis", () => {
    const base = createSampleAdapter();
    let incompatibleCalls = 0;
    const incompatible: CartographAdapter = {
      manifest: {
        ...base.manifest,
        capabilityRegistryVersion: 2,
      } as unknown as CartographAdapter["manifest"],
      analyze(input) {
        incompatibleCalls += 1;
        return base.analyze(input);
      },
    };
    expect(() => runAdapter(incompatible, request())).toThrow(
      AdapterValidationError,
    );
    expect(() => runAdapter(incompatible, request())).toThrow(
      /compatibility rejected/u,
    );
    expect(incompatibleCalls).toBe(0);

    let experimentalCalls = 0;
    const experimental: CartographAdapter = {
      manifest: {
        ...base.manifest,
        stability: "experimental",
      },
      analyze(input) {
        experimentalCalls += 1;
        return base.analyze(input);
      },
    };
    expect(() => runAdapter(experimental, request())).toThrow(
      /experimental adapter requires explicit compatibility opt-in/u,
    );
    expect(experimentalCalls).toBe(0);

    const optedIn = runAdapter(
      experimental,
      request({
        compatibility: {
          ...ADAPTER_COMPATIBILITY_REGISTRY.current,
          allowExperimental: true,
        },
      }),
    );
    expect(experimentalCalls).toBe(1);
    expect(optedIn.compatibility?.state).toBe("experimental");
    expect(optedIn.compatibility?.requiresOptIn).toBe(false);
  });

  it("keeps both shipped adapters stable under the negotiated contract", () => {
    const sample = runAdapter(createSampleAdapter(), request());
    expect(sample.compatibility?.state).toBe("compatible");
    expect(sample.capability.stability).toBe("stable");

    const fastifyRoot = resolve(
      repositoryRoot,
      "test/fixtures/typescript-fastify",
    );
    const fastify = runAdapter(createFastifyAdapter(), {
      ...request(),
      source: {
        ...request().source,
        rootDir: fastifyRoot,
      },
      config: {},
    });
    expect(fastify.compatibility?.state).toBe("compatible");
    expect(fastify.capability.stability).toBe("stable");
  });
});
