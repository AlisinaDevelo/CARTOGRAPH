import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_REGISTRY,
  DiagnosticRegistrySchema,
  getDiagnosticDefinition,
} from "../../src/index.js";
import { analyzeTypeScriptRepository } from "../../src/analyzers/typescript.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const fixtureRoot = resolve(repositoryRoot, "test/fixtures/typescript-express");

describe("diagnostic registry", () => {
  it("matches the published JSON data and Schema", () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "schema/diagnostic-registry.v0.1.schema.json"),
        "utf8",
      ),
    ) as object;
    const data = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "schema/diagnostic-registry.v0.1.json"),
        "utf8",
      ),
    ) as unknown;
    const validate = new Ajv({ allErrors: true }).compile(schema);

    expect(validate(data)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(DiagnosticRegistrySchema.safeParse(data).success).toBe(true);
    expect(data).toEqual(DIAGNOSTIC_REGISTRY);
    expect(
      new Set(
        DIAGNOSTIC_REGISTRY.diagnostics.map((diagnostic) => diagnostic.code),
      ).size,
    ).toBe(DIAGNOSTIC_REGISTRY.diagnostics.length);
  });

  it("requires every analyzer diagnostic to use registered guidance", () => {
    const snapshot = analyzeTypeScriptRepository({ rootDir: fixtureRoot });

    expect(snapshot.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of snapshot.diagnostics) {
      const definition = getDiagnosticDefinition(diagnostic.code);
      expect(definition).toBeDefined();
      expect(diagnostic.severity).toBe(definition?.severity);
      expect(diagnostic.message).toBe(definition?.message);
      expect(diagnostic.remediation).toBe(definition?.remediation);
      expect(diagnostic.evidence[0]?.kind).toBe("source");
      expect(diagnostic.location?.path).not.toMatch(/^\//u);
    }
  });

  it("fails closed for unknown diagnostic codes", () => {
    expect(getDiagnosticDefinition("UNKNOWN_DIAGNOSTIC")).toBeUndefined();
  });
});
