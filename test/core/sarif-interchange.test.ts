import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  SarifInterchangeValidationError,
  exportSarifPolicyEvaluation,
  importSarifPolicyEvaluation,
  parseSarifLog,
  serializeSarifLog,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/sarif-interchange/round-trip.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/sarif-interchange.v0.1.schema.json",
);
const scriptPath = resolve(repositoryRoot, "scripts/sarif-interchange.mjs");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  evaluation: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  expected: {
    mappedViolationIds: string[];
    unsupportedViolationIds: string[];
  };
};

const exportFixture = () =>
  exportSarifPolicyEvaluation(
    fixture.evaluation,
    { kind: "snapshot", snapshot: fixture.snapshot },
    { toolName: "cartograph-sarif-test", toolVersion: "0.1.0" },
  );

describe("SARIF policy-result bridge", () => {
  it("maps only line-local violations and preserves canonical references", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
    const validator = new Ajv({ allErrors: true }).compile(schema);
    expect(validator(JSON.parse(readFileSync(fixturePath, "utf8")))).toBe(true);

    const exported = exportFixture();
    expect(exported.mappings.map((mapping) => mapping.violationId)).toEqual(
      fixture.expected.mappedViolationIds,
    );
    expect(exported.unsupported.map((record) => record.violationId)).toEqual(
      fixture.expected.unsupportedViolationIds,
    );
    expect(exported.log.runs[0]?.results).toHaveLength(1);
    expect(exported.log.runs[0]?.results[0]?.kind).toBe("fail");
    expect(
      exported.log.runs[0]?.results[0]?.partialFingerprints,
    ).toHaveProperty("cartographFingerprint");
    expect(
      exported.log.runs[0]?.results[0]?.properties.cartograph.graphIds,
    ).toEqual(["node:module:payments"]);
    expect(
      exported.log.runs[0]?.results[0]?.properties.cartograph.evidenceRefs,
    ).toContain("source:src/payments.ts:42");
    expect(exported.provenance.sourceBodiesIncluded).toBe(false);
    expect(exported.provenance.lineLocalOnly).toBe(true);
  });

  it("round-trips deterministic SARIF and rejects unsupported or unsafe fields", () => {
    const exported = exportFixture();
    const imported = importSarifPolicyEvaluation(exported.log);
    expect(imported.mappings).toEqual(exported.mappings);
    expect(serializeSarifLog(exported.log)).toBe(
      serializeSarifLog(JSON.parse(serializeSarifLog(exported.log))),
    );

    const unsupportedKind = structuredClone(exported.log) as unknown as {
      runs: Array<{ results: Array<Record<string, unknown>> }>;
    };
    unsupportedKind.runs[0]!.results[0]!.kind = "pass";
    expect(() => parseSarifLog(unsupportedKind)).toThrow(
      SarifInterchangeValidationError,
    );

    const sourceBody = structuredClone(exported.log) as unknown as {
      runs: Array<{
        results: Array<{
          locations: Array<{
            physicalLocation: { region: Record<string, unknown> };
          }>;
        }>;
      }>;
    };
    sourceBody.runs[0]!.results[0]!.locations[0]!.physicalLocation.region.snippet =
      {
        text: "source body must never cross this boundary",
      };
    expect(() => parseSarifLog(sourceBody)).toThrow(
      SarifInterchangeValidationError,
    );

    const missingFingerprint = structuredClone(exported.log) as unknown as {
      runs: Array<{
        results: Array<{
          partialFingerprints: Record<string, unknown>;
        }>;
      }>;
    };
    delete missingFingerprint.runs[0]!.results[0]!.partialFingerprints
      .cartographFingerprint;
    expect(() => parseSarifLog(missingFingerprint)).toThrow(
      SarifInterchangeValidationError,
    );

    const absolutePath = structuredClone(exported.log) as unknown as {
      runs: Array<{
        results: Array<{
          locations: Array<{
            physicalLocation: {
              artifactLocation: Record<string, unknown>;
            };
          }>;
        }>;
      }>;
    };
    absolutePath.runs[0]!.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri =
      "/private/project/src/payments.ts";
    expect(() => parseSarifLog(absolutePath)).toThrow(
      SarifInterchangeValidationError,
    );
  });

  it("replays the offline fixture validator and keeps it network-free", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).not.toMatch(/node:(?:http|https|net|tls)/u);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "validate"],
        { cwd: repositoryRoot, encoding: "utf8" },
      ),
    ) as { ok: boolean; mappedResults: number; digest: string };
    expect(output).toMatchObject({ ok: true, mappedResults: 1 });
    expect(output.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});
