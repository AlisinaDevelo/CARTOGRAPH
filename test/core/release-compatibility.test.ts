import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/release-compatibility.mjs");
const matrixPath = resolve(
  repositoryRoot,
  "schema/release-compatibility-matrix.v0.1.json",
);

const run = (path = matrixPath) =>
  JSON.parse(
    execFileSync(process.execPath, [scriptPath, "validate", "--matrix", path], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }),
  ) as {
    ok: boolean;
    contract: string;
    matrixId: string;
    matrixDigest: string;
    combinations: number;
  };

const withMutatedMatrix = (
  mutate: (matrix: Record<string, unknown>) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(join(tmpdir(), "cartograph-release-matrix-"));
  const path = join(directory, "matrix.json");
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as Record<
    string,
    unknown
  >;
  mutate(matrix);
  writeFileSync(path, JSON.stringify(matrix));
  try {
    callback(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("release compatibility matrix", () => {
  it("cross-checks the runtime, contract, Action, and documentation surfaces", () => {
    expect(run()).toMatchObject({
      ok: true,
      contract: "cartograph.release-compatibility-matrix",
      matrixId: "cartograph-release-compatibility-v0.1",
      combinations: 4,
    });
  });

  it("rejects a runtime row that is not the declared Cartesian product", () => {
    withMutatedMatrix(
      (matrix) => {
        const combinations = matrix.combinations as Array<
          Record<string, unknown>
        >;
        combinations.pop();
      },
      (path) => {
        expect(() => run(path)).toThrow(/runtime Cartesian combinations/u);
      },
    );
  });

  it("rejects an Action reference drift", () => {
    withMutatedMatrix(
      (matrix) => {
        const actions = matrix.actions as Array<Record<string, unknown>>;
        const first = actions[0];
        if (first === undefined) throw new Error("matrix has no actions");
        first.ref = "0000000000000000000000000000000000000000";
      },
      (path) => {
        expect(() => run(path)).toThrow(/pinned Action reference/u);
      },
    );
  });
});
