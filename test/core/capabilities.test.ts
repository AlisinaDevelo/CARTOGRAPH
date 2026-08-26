import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertCompatibleCapabilityRegistryVersion,
  CAPABILITY_REGISTRY,
  CapabilityRegistrySchema,
  CapabilityRegistryVersionError,
  createGraphSnapshot,
  diffGraphSnapshots,
} from "../../src/core/index.js";
import { analyzeTypeScriptRepository } from "../../src/analyzers/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = resolve(repositoryRoot, "test/fixtures/typescript-express");

describe("capability and unknown-semantics registry", () => {
  it("matches the published JSON data and Schema", () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "schema/capability-registry.v0.1.schema.json"),
        "utf8",
      ),
    ) as object;
    const data = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "schema/capability-registry.v0.1.json"),
        "utf8",
      ),
    ) as unknown;
    const validate = new Ajv({ allErrors: true }).compile(schema);

    expect(validate(data)).toBe(true);
    expect(CapabilityRegistrySchema.safeParse(data).success).toBe(true);
    expect(data).toEqual(CAPABILITY_REGISTRY);
    expect(CAPABILITY_REGISTRY.extractors[0]?.capabilities).toHaveLength(10);
  });

  it("exposes the registry version on analyzer snapshots", () => {
    const snapshot = analyzeTypeScriptRepository({ rootDir: fixtureRoot });
    expect(snapshot.capabilityRegistryVersion).toBe(1);
  });

  it("fails closed for unsupported or mismatched registry versions", () => {
    expect(() =>
      createGraphSnapshot({
        schemaVersion: 1,
        capabilityRegistryVersion: 2,
        revision: { commitSha: "test" },
        nodes: [],
        edges: [],
        diagnostics: [],
      }),
    ).toThrowError(CapabilityRegistryVersionError);

    expect(() => assertCompatibleCapabilityRegistryVersion(1, 2)).toThrow(
      /unsupported capability registry version/u,
    );

    const snapshot = createGraphSnapshot({
      schemaVersion: 1,
      revision: { commitSha: "test" },
      nodes: [],
      edges: [],
      diagnostics: [],
    });
    expect(() =>
      diffGraphSnapshots(snapshot, {
        ...snapshot,
        capabilityRegistryVersion: 2,
      }),
    ).toThrowError(CapabilityRegistryVersionError);
  });
});
