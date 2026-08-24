import Ajv from "ajv";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ConfigValidationError,
  defaultCartographConfig,
  parseCartographConfig,
  readCartographConfig,
} from "../../src/core/index.js";
import { ResourceLimitError } from "../../src/analyzers/index.js";
import { scanRepository } from "../../src/commands.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = resolve(repositoryRoot, "test/fixtures/typescript-express");
const schema = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/cartograph-config.v0.1.schema.json"),
    "utf8",
  ),
) as object;

describe("configuration contract", () => {
  it("validates the machine-readable contract and deterministic defaults", () => {
    const validate = new Ajv({ allErrors: true }).compile(schema);
    const input = {
      schemaVersion: 1,
      include: ["src/**"],
      exclude: ["src/generated/**"],
      extractors: ["typescript", "express"],
      resources: { maxFiles: 50 },
      policyRefs: [".cartograph/policy.json"],
      unknownFields: "error",
    };

    expect(validate(input)).toBe(true);
    expect(defaultCartographConfig()).toMatchObject({
      schemaVersion: 1,
      include: ["."],
      extractors: ["typescript", "express"],
      output: { mode: "snapshot", format: "json" },
      resources: {
        maxFiles: 20_000,
        maxFileBytes: 2 * 1024 * 1024,
        maxSourceBytes: 64 * 1024 * 1024,
        maxWallClockMs: 30_000,
      },
      unknownFields: "error",
    });
  });

  it("fails unknown fields by default and reports them in explicit warn mode", () => {
    expect(() =>
      parseCartographConfig({ schemaVersion: 1, typo: true }),
    ).toThrowError(/unknown configuration field\(s\): typo/u);

    const parsed = parseCartographConfig({
      schemaVersion: 1,
      unknownFields: "warn",
      resources: { maxFiles: 12, typo: true },
      typo: true,
    });
    expect(parsed.config.resources.maxFiles).toBe(12);
    expect(parsed.warnings).toEqual([
      "ignored unknown configuration field: resources.typo",
      "ignored unknown configuration field: typo",
    ]);
  });

  it("rejects absolute and escaping path values", () => {
    for (const key of ["include", "exclude", "policyRefs"]) {
      expect(() =>
        parseCartographConfig({ schemaVersion: 1, [key]: ["../outside"] }),
      ).toThrowError(ConfigValidationError);
    }
    expect(() =>
      parseCartographConfig({ schemaVersion: 1, tsconfigPath: "/etc/passwd" }),
    ).toThrowError(/repository-relative/u);
  });

  it("loads a repository-local config and applies selectors and ceilings", () => {
    const root = mkdtempSync(join(tmpdir(), "cartograph-config-test-"));
    try {
      writeFileSync(
        join(root, "cartograph.json"),
        JSON.stringify({
          schemaVersion: 1,
          include: ["src/**"],
          exclude: ["src/modules.ts"],
        }),
        "utf8",
      );
      const loaded = readCartographConfig(root, "cartograph.json");
      expect(loaded.config.include).toEqual(["src/**"]);
      expect(
        scanRepository({ root: fixtureRoot, config: loaded.config }).nodes.some(
          (node) => node.stableKey.includes("src/modules"),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const selected = scanRepository({
      root: fixtureRoot,
      config: parseCartographConfig({
        schemaVersion: 1,
        include: ["src/**"],
        exclude: ["src/modules.ts"],
        resources: { maxFiles: 100 },
      }).config,
    });
    expect(
      selected.nodes.some((node) => node.stableKey.includes("src/modules")),
    ).toBe(false);

    expect(() =>
      scanRepository({
        root: fixtureRoot,
        config: parseCartographConfig({
          schemaVersion: 1,
          resources: { maxFiles: 1 },
        }).config,
      }),
    ).toThrowError(ResourceLimitError);
  });
});
