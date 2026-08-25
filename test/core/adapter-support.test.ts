import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/adapter-support.mjs");
const matrixPath = resolve(
  repositoryRoot,
  "schema/adapter-support-matrix.v0.1.json",
);

const runValidator = (alternateMatrixPath?: string) =>
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      scriptPath,
      "validate",
      ...(alternateMatrixPath ? ["--matrix", alternateMatrixPath] : []),
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

describe("adapter support matrix", () => {
  it("reports every support status, current adapter, and selection criterion", () => {
    const report = JSON.parse(runValidator()) as {
      ok: boolean;
      matrixId: string;
      matrixDigest: string;
      criteria: number;
      statuses: string[];
      entries: Array<{ id: string; status: string }>;
      entriesByStatus: Record<string, string[]>;
    };

    expect(report).toMatchObject({
      ok: true,
      matrixId: "cartograph-adapter-support-v0.1",
      criteria: 8,
      statuses: ["implemented", "experimental", "deferred", "unsupported"],
      entriesByStatus: {
        implemented: ["cartograph.sample", "cartograph.fastify"],
        experimental: ["cartograph.starter.example"],
        deferred: ["language.rust"],
        unsupported: ["language.python"],
      },
    });
    expect(report.matrixDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(report.entries.map((entry) => entry.id)).toEqual([
      "cartograph.sample",
      "cartograph.fastify",
      "cartograph.starter.example",
      "language.rust",
      "language.python",
    ]);
  });

  it("reports the adapter and status context for a missing matrix reference", () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "cartograph-adapter-support-"),
    );
    const temporaryMatrixPath = join(temporaryDirectory, "matrix.json");
    try {
      const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as {
        entries: Array<{ id: string; references: string[] }>;
      };
      const sample = matrix.entries.find(
        (entry) => entry.id === "cartograph.sample",
      );
      if (!sample) throw new Error("sample matrix entry is missing");
      sample.references = ["docs/does-not-exist.md"];
      writeFileSync(
        temporaryMatrixPath,
        `${JSON.stringify(matrix, null, 2)}\n`,
      );

      expect(() => runValidator(temporaryMatrixPath)).toThrow(
        /adapter=cartograph\.sample capability=<matrix> fixture=<matrix> compatibility=<matrix> status=implemented/u,
      );
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
