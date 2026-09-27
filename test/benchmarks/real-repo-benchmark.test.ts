import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  budgetFailures,
  validateManifest,
} from "../../scripts/real-repo-benchmark.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "benchmarks/real-repositories.v0.1.json"),
    "utf8",
  ),
) as { repositories: Record<string, unknown>[] };

const clone = (): typeof manifest =>
  JSON.parse(JSON.stringify(manifest)) as typeof manifest;

describe("real-repository benchmark", () => {
  it("pins a small, medium, and large permissively licensed repository", () => {
    const parsed = validateManifest(manifest);
    expect(
      parsed.repositories.map((repository) => repository.size).sort(),
    ).toEqual(["large", "medium", "small"]);
  });

  it("rejects mutable refs, unknown resources, and missing budgets", () => {
    const mutable = clone();
    (mutable.repositories[0] as { commit: string }).commit = "main";
    expect(() => validateManifest(mutable)).toThrow("full 40-character SHA");

    const resource = clone();
    (resource.repositories[0] as { resources: object }).resources = {
      maxEverything: 1,
    };
    expect(() => validateManifest(resource)).toThrow("unknown resource");

    const budget = clone();
    delete (budget.repositories[0] as { budgets: Record<string, number> })
      .budgets.maxMs;
    expect(() => validateManifest(budget)).toThrow("budget maxMs");
  });

  it("reports every missed budget", () => {
    const repository = validateManifest(manifest).repositories[0];
    if (repository === undefined) throw new Error("empty manifest");
    const within = {
      ms: 1,
      maxRssBytes: 1,
      nodes: repository.budgets.minNodes,
      edges: repository.budgets.minEdges,
      diagnostics: 0,
    };
    expect(budgetFailures(repository, within)).toEqual([]);
    const failures = budgetFailures(repository, {
      ms: repository.budgets.maxMs + 1,
      maxRssBytes: repository.budgets.maxRssBytes + 1,
      nodes: 1,
      edges: 0,
      diagnostics: 100,
    });
    expect(failures).toHaveLength(5);
    expect(failures.join("\n")).toMatch(/took .* ms/u);
    expect(failures.join("\n")).toMatch(/diagnostics per node/u);
  });
});
