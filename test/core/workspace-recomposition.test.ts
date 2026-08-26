import Ajv from "ajv";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  WorkspaceRecompositionCacheError,
  WorkspaceRecompositionValidationError,
  cleanupWorkspaceRecompositionCache,
  createWorkspaceRecompositionKey,
  parseWorkspaceRecompositionCache,
  parseWorkspaceRecompositionRequest,
  recomposeWorkspace,
  readWorkspaceRecompositionCache,
  serializeWorkspaceRecompositionCache,
  serializeWorkspaceRecompositionPlan,
  writeWorkspaceRecompositionCacheAtomic,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixture = JSON.parse(
  readFileSync(
    join(
      repositoryRoot,
      "test/fixtures/workspace-recomposition/request.v0.1.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;
const jsonSchema = JSON.parse(
  readFileSync(
    join(repositoryRoot, "schema/workspace-recomposition.v0.1.schema.json"),
    "utf8",
  ),
) as object;

const cloneFixture = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;

const removeResults = (
  value: Record<string, unknown>,
): Record<string, unknown> => ({
  ...value,
  units: (value.units as Record<string, unknown>[]).map(
    ({ result: _result, ...unit }) => unit,
  ),
});

describe("provenance-aware incremental workspace recomposition", () => {
  it("covers all cache-key dimensions and validates the request schema", () => {
    const request = parseWorkspaceRecompositionRequest(fixture);
    const validate = new Ajv({ allErrors: true }).compile(jsonSchema);
    expect(validate(request)).toBe(true);
    expect(validate.errors).toBeNull();

    const key = createWorkspaceRecompositionKey(request.inputs);
    expect(key.content).toHaveLength(2);
    expect(key.contract).toHaveLength(1);
    expect(key.adapter).toHaveLength(1);
    expect(key.policy).toHaveLength(1);
    expect(key.workspace).toHaveLength(1);
    expect(key.tool).toHaveLength(1);
    expect(key.keyDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("reuses a warm cache and invalidates only proven dependents", () => {
    const request = parseWorkspaceRecompositionRequest(fixture);
    const cold = recomposeWorkspace(request);
    expect(cold.stats).toEqual({
      hits: 0,
      misses: 0,
      invalidated: 0,
      recomputed: 3,
    });

    const warm = recomposeWorkspace(removeResults(cloneFixture()), cold.cache);
    expect(warm.stats).toEqual({
      hits: 3,
      misses: 0,
      invalidated: 0,
      recomputed: 0,
    });
    expect(serializeWorkspaceRecompositionCache(warm.cache)).toBe(
      serializeWorkspaceRecompositionCache(cold.cache),
    );

    const partial = cloneFixture();
    partial.inputs = (partial.inputs as Record<string, unknown>[]).map(
      (input) =>
        input.id === "alpha-content"
          ? {
              ...input,
              digest:
                "sha256:9999999999999999999999999999999999999999999999999999999999999999",
            }
          : input,
    );
    const plan = recomposeWorkspace(partial, cold.cache);
    expect(plan.changedInputIds).toEqual(["alpha-content"]);
    expect(plan.units.map((unit) => [unit.id, unit.status])).toEqual([
      ["alpha-snapshot", "recomputed"],
      ["beta-snapshot", "hit"],
      ["boundary-composition", "recomputed"],
    ]);

    const topologyChange = removeResults(cloneFixture());
    const boundary = (topologyChange.units as Record<string, unknown>[]).find(
      (unit) => unit.id === "boundary-composition",
    );
    if (!boundary) throw new Error("fixture boundary unit missing");
    boundary.dependsOn = ["alpha-snapshot"];
    const topologyPlan = recomposeWorkspace(topologyChange, cold.cache);
    expect(
      topologyPlan.units.find((unit) => unit.id === "boundary-composition")
        ?.status,
    ).toBe("invalidated");
  });

  it("rejects dependency cycles and forged cache contents", () => {
    const cyclic = cloneFixture();
    const units = cyclic.units as Record<string, unknown>[];
    units[0] = { ...units[0], dependsOn: ["boundary-composition"] };
    expect(() => parseWorkspaceRecompositionRequest(cyclic)).toThrow(
      WorkspaceRecompositionValidationError,
    );

    const cold = recomposeWorkspace(
      parseWorkspaceRecompositionRequest(fixture),
    );
    const forged = JSON.parse(JSON.stringify(cold.cache)) as Record<
      string,
      unknown
    >;
    const entries = forged.entries as Record<string, unknown>[];
    entries[0] = {
      ...entries[0],
      resultDigest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    };
    expect(() => parseWorkspaceRecompositionCache(forged)).toThrow(
      WorkspaceRecompositionValidationError,
    );
  });

  it("keeps the prior cache on interrupted atomic writes and rejects corruption", () => {
    const cold = recomposeWorkspace(
      parseWorkspaceRecompositionRequest(fixture),
    );
    const root = mkdtempSync(join(tmpdir(), "cartograph-recomposition-test-"));
    const cachePath = join(root, "cache.json");
    try {
      writeWorkspaceRecompositionCacheAtomic(cachePath, cold.cache);
      const before = serializeWorkspaceRecompositionCache(
        readWorkspaceRecompositionCache(cachePath),
      );
      expect(() =>
        writeWorkspaceRecompositionCacheAtomic(cachePath, cold.cache, {
          beforeCommit: () => {
            throw new Error("interrupt");
          },
        }),
      ).toThrow(WorkspaceRecompositionCacheError);
      expect(
        serializeWorkspaceRecompositionCache(
          readWorkspaceRecompositionCache(cachePath),
        ),
      ).toBe(before);

      // A malformed target is fail-closed rather than treated as a cache miss.
      rmSync(cachePath);
      writeFileSync(cachePath, "{not-json", "utf8");
      expect(() => readWorkspaceRecompositionCache(cachePath)).toThrow(
        WorkspaceRecompositionCacheError,
      );
      expect(cleanupWorkspaceRecompositionCache(cachePath)).toBe(0);
      expect(serializeWorkspaceRecompositionPlan(cold)).toContain(
        "cartograph.workspace-recomposition",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
