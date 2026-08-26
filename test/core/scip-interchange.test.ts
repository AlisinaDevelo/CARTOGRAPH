import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  ScipInterchangeValidationError,
  exportScipIndex,
  importScipIndex,
  parseScipIndex,
  serializeScipIndex,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/scip-interchange/round-trip.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/scip-interchange.v0.1.schema.json",
);
const scriptPath = resolve(repositoryRoot, "scripts/scip-interchange.mjs");

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  index: Record<string, unknown>;
  expected: {
    stableKeys: string[];
    evidenceReferences: string[];
    unsupportedCodes: string[];
  };
};

describe("SCIP interchange contract", () => {
  it("validates and round-trips stable identities and evidence references", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
    const validator = new Ajv({ allErrors: true }).compile(schema);
    expect(validator(fixture)).toBe(true);

    const imported = importScipIndex(fixture.index);
    const exported = exportScipIndex(imported.snapshot, {
      toolName: "cartograph-scip-test",
      toolVersion: "0.1.0",
    });
    const roundTrip = importScipIndex(exported.index);
    const stableKeys = (snapshot: typeof imported.snapshot) =>
      snapshot.nodes.map((node) => node.stableKey).sort();
    const references = (snapshot: typeof imported.snapshot) =>
      snapshot.edges
        .flatMap((edge) => edge.evidence.map((evidence) => evidence.reference))
        .filter((reference): reference is string => reference !== undefined);

    expect(stableKeys(imported.snapshot)).toEqual(
      [...fixture.expected.stableKeys].sort(),
    );
    expect(stableKeys(roundTrip.snapshot)).toEqual(
      [...fixture.expected.stableKeys].sort(),
    );
    for (const reference of fixture.expected.evidenceReferences) {
      expect(references(imported.snapshot)).toContain(reference);
      expect(references(roundTrip.snapshot)).toContain(reference);
    }
    expect(
      fixture.expected.unsupportedCodes.every((code) =>
        imported.unsupported.some((record) => record.code === code),
      ),
    ).toBe(true);
    expect(exported.provenance.sourceBodiesIncluded).toBe(false);
    expect(serializeScipIndex(fixture.index)).toBe(
      serializeScipIndex(JSON.parse(serializeScipIndex(fixture.index))),
    );
  });

  it("rejects source bodies, local roots, and duplicate declarations", () => {
    const withText = structuredClone(fixture.index) as {
      documents: Array<Record<string, unknown>>;
    };
    const textDocument = withText.documents.at(0);
    if (!textDocument) throw new Error("SCIP fixture test setup");
    textDocument.text = "source body must never cross this boundary";
    expect(() => parseScipIndex(withText)).toThrow(
      ScipInterchangeValidationError,
    );

    const withLocalRoot = structuredClone(fixture.index) as {
      metadata: Record<string, unknown>;
    };
    withLocalRoot.metadata.projectRoot = "/Users/example/project";
    expect(() => parseScipIndex(withLocalRoot)).toThrow(
      ScipInterchangeValidationError,
    );

    const withDuplicateDocument = structuredClone(fixture.index) as {
      documents: Array<Record<string, unknown>>;
    };
    const firstDocument = withDuplicateDocument.documents.at(0);
    if (!firstDocument) throw new Error("SCIP fixture test setup");
    withDuplicateDocument.documents.push(firstDocument);
    expect(() => parseScipIndex(withDuplicateDocument)).toThrow(
      /duplicate document path/u,
    );
  });

  it("rejects unsafe export roots and keeps the validator offline", () => {
    const imported = importScipIndex(fixture.index);
    expect(() =>
      exportScipIndex(imported.snapshot, {
        toolName: "cartograph-scip-test",
        toolVersion: "0.1.0",
        projectRoot: "/private/project",
      }),
    ).toThrow(/projectRoot/u);

    const validatorSource = readFileSync(scriptPath, "utf8");
    expect(validatorSource).not.toMatch(/node:(?:http|https|net|tls)/u);
    expect(validatorSource).not.toMatch(/\bfetch\s*\(/u);
  });

  it("replays the checked-in contract validator", () => {
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "validate"],
        { cwd: repositoryRoot, encoding: "utf8" },
      ),
    ) as { ok: boolean; digest: string; importedEdges: number };
    expect(output).toMatchObject({ ok: true, importedEdges: 3 });
    expect(output.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});
