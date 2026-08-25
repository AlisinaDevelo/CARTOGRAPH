import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/adapter-compatibility-matrix.mjs",
);
const matrixPath = resolve(
  repositoryRoot,
  "schema/adapter-compatibility-matrix.v0.1.json",
);

const runValidator = (
  environment: NodeJS.ProcessEnv = process.env,
  alternateMatrixPath?: string,
) =>
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      scriptPath,
      "validate",
      ...(alternateMatrixPath ? ["--matrix", alternateMatrixPath] : []),
    ],
    { cwd: repositoryRoot, encoding: "utf8", env: environment },
  );

describe("adapter compatibility matrix", () => {
  it("runs every declared adapter, capability fixture, negotiation state, and schema subcheck", () => {
    const environment = { ...process.env };
    delete environment.CARTOGRAPH_MATRIX_NODE;
    const report = JSON.parse(runValidator(environment)) as {
      ok: boolean;
      matrixId: string;
      runtime: { status: string };
      adapters: Array<{
        id: string;
        capabilities: string[];
        cases: Array<{ id: string; capabilities: string[] }>;
        conformance: {
          deterministic: boolean;
          evidenceComplete: boolean;
          repetitions: number;
        };
      }>;
      compatibility: {
        fixtureCases: number;
        states: string[];
        adapters: string[];
      };
      schemaChecks: Array<{ name: string; ok: boolean }>;
    };

    expect(report).toMatchObject({
      ok: true,
      matrixId: "cartograph-adapter-compatibility-v0.1",
      compatibility: {
        fixtureCases: 5,
        states: ["compatible", "experimental", "migratable", "rejected"],
        adapters: ["cartograph.fastify", "cartograph.sample"],
      },
    });
    expect(["matched", "matched-local", "unlisted-local"]).toContain(
      report.runtime.status,
    );
    expect(report.adapters.map((adapter) => adapter.id)).toEqual([
      "cartograph.sample",
      "cartograph.fastify",
    ]);
    const sample = report.adapters.find(
      (adapter) => adapter.id === "cartograph.sample",
    );
    const fastify = report.adapters.find(
      (adapter) => adapter.id === "cartograph.fastify",
    );
    if (!sample || !fastify)
      throw new Error("matrix adapter report is incomplete");
    expect(sample.capabilities).toEqual(["sample.fixture"]);
    expect(sample.conformance).toMatchObject({
      deterministic: true,
      evidenceComplete: true,
      repetitions: 2,
    });
    expect(fastify.capabilities).toEqual([
      "fastify.routes",
      "typescript.graph",
    ]);
    expect(fastify.conformance).toMatchObject({
      deterministic: true,
      evidenceComplete: true,
      repetitions: 2,
    });
    expect(
      report.adapters.flatMap((adapter) =>
        adapter.cases.flatMap((testCase) => testCase.capabilities),
      ),
    ).toEqual(
      expect.arrayContaining([
        "sample.fixture",
        "fastify.routes",
        "typescript.graph",
      ]),
    );
    expect(report.schemaChecks).toEqual([
      expect.objectContaining({ name: "schema-compatibility", ok: true }),
      expect.objectContaining({ name: "upgrade-policy", ok: true }),
    ]);
  });

  it("reports adapter, capability, fixture, and compatibility context on a failed case", () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "cartograph-adapter-matrix-"),
    );
    const temporaryMatrixPath = join(temporaryDirectory, "matrix.json");
    try {
      const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as {
        adapters: Array<{
          cases: Array<{
            id: string;
            minNodes: number;
            unsupportedDiagnosticCodes: string[];
          }>;
        }>;
      };
      const sampleAdapter = matrix.adapters.find((adapter) =>
        adapter.cases.some((testCase) => testCase.id === "unsupported"),
      );
      if (!sampleAdapter) throw new Error("sample matrix adapter is missing");
      const unsupportedCase = sampleAdapter.cases.find(
        (testCase) => testCase.id === "unsupported",
      );
      if (!unsupportedCase)
        throw new Error("unsupported matrix case is missing");
      unsupportedCase.minNodes = 3;
      writeFileSync(
        temporaryMatrixPath,
        `${JSON.stringify(matrix, null, 2)}\n`,
      );

      expect(() =>
        runValidator({ ...process.env }, temporaryMatrixPath),
      ).toThrow(
        /adapter=cartograph\.sample capability=sample\.fixture fixture=sample\/unsupported compatibility=adapter-conformance/u,
      );
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
