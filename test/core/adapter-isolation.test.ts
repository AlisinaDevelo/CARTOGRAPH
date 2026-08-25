import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AdapterValidationError,
  parseAdapterInput,
  runAdapterIsolated,
  supportsAdapterIsolation,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const adapterModule = resolve(
  repositoryRoot,
  "test/fixtures/adapter-isolation/adapter.mjs",
);
const input = (fixture: string, overrides: Record<string, unknown> = {}) => ({
  apiVersion: 1,
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

describe("isolated adapter host", () => {
  it("publishes and validates the bounded request schema", () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "schema/adapter-input.v0.1.schema.json"),
        "utf8",
      ),
    ) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(input("empty"))).toBe(true);
    expect(
      validate({
        ...input("empty"),
        resources: { ...input("empty").resources, maxOutputBytes: 0 },
      }),
    ).toBe(false);
  });

  it("runs a module in the permissioned process boundary", async () => {
    if (!supportsAdapterIsolation()) {
      await expect(
        runAdapterIsolated({ adapterModule, input: input("empty") }),
      ).rejects.toMatchObject({ code: "unsupported-runtime" });
      return;
    }
    const output = await runAdapterIsolated({
      adapterModule,
      input: input("empty"),
    });

    expect(output).toMatchObject({
      apiVersion: 1,
      graph: { nodes: [], edges: [], diagnostics: [] },
      evidence: [],
      diagnostics: [],
      capability: {
        id: "cartograph.isolation-fixture",
        execution: {
          filesystem: "none",
          network: false,
          childProcess: false,
          dynamicModuleLoading: false,
          repositoryCodeExecution: false,
        },
      },
    });
  });

  it("terminates a hung adapter and waits for child cleanup", async () => {
    if (!supportsAdapterIsolation()) return;
    await expect(
      runAdapterIsolated({
        adapterModule,
        input: input("hang", { maxWallClockMs: 500 }),
      }),
    ).rejects.toMatchObject({
      name: "AdapterIsolationError",
      code: "wall-clock-limit",
    });
  });

  it("kills an adapter that exceeds the response ceiling", async () => {
    if (!supportsAdapterIsolation()) return;
    await expect(
      runAdapterIsolated({
        adapterModule,
        input: input("oversized", { maxOutputBytes: 1_024 }),
      }),
    ).rejects.toMatchObject({
      name: "AdapterIsolationError",
      code: "output-limit",
    });
  });

  it("rejects malformed evidence at the process boundary", async () => {
    if (!supportsAdapterIsolation()) return;
    await expect(
      runAdapterIsolated({
        adapterModule,
        input: input("malformed-evidence"),
      }),
    ).rejects.toMatchObject({
      name: "AdapterValidationError",
      code: "invalid-output",
    });
  });

  it("denies network authority instead of allowing a best-effort request", async () => {
    if (!supportsAdapterIsolation()) return;
    await expect(
      runAdapterIsolated({
        adapterModule,
        input: input("network"),
      }),
    ).rejects.toMatchObject({
      name: "AdapterIsolationError",
      code: "authority-denied",
    });
  });

  it("denies child-process authority instead of running a command", async () => {
    if (!supportsAdapterIsolation()) return;
    await expect(
      runAdapterIsolated({
        adapterModule,
        input: input("child-process"),
      }),
    ).rejects.toMatchObject({
      name: "AdapterIsolationError",
      code: "authority-denied",
    });
  });

  it("rejects path escapes before starting an adapter process", async () => {
    await expect(
      runAdapterIsolated({
        adapterModule,
        input: {
          ...input("empty"),
          source: { ...input("empty").source, include: ["../outside"] },
        },
      }),
    ).rejects.toBeInstanceOf(AdapterValidationError);
  });

  it("fails closed for an unusable memory budget", () => {
    expect(() =>
      parseAdapterInput(input("empty", { maxMemoryBytes: 1 })),
    ).toThrow(AdapterValidationError);
  });
});
