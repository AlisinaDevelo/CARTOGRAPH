import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const benchmarkScript = resolve(repositoryRoot, "scripts/benchmark-diff.mjs");
const gateScript = resolve(repositoryRoot, "scripts/benchmark-diff-gate.mjs");
const manifestPath = resolve(
  repositoryRoot,
  "benchmarks/diff-workloads.v0.1.json",
);
const baselinePath = resolve(
  repositoryRoot,
  "benchmarks/diff-baseline.v0.1.json",
);

const run = (script: string, args: string[]) =>
  execFileSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

describe("bounded revision-diff benchmark", () => {
  it("validates digest-only tiered baseline evidence", () => {
    const output = JSON.parse(run(benchmarkScript, ["validate"])) as {
      ok: boolean;
      workloads: number;
      digest: string;
    };
    expect(output).toMatchObject({ ok: true, workloads: 3 });
    expect(output.digest).toMatch(/^[0-9a-f]{64}$/u);

    const artifact = readFileSync(baselinePath, "utf8");
    expect(artifact).not.toMatch(/"(?:nodes|edges|evidence|source)"\s*:\s*\[/u);
    expect(artifact).not.toMatch(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)/u);
  });

  it("runs all declared tiers and applies the correctness gate", () => {
    const directory = mkdtempSync(join(tmpdir(), "cartograph-diff-test-"));
    const candidatePath = join(directory, "candidate.json");
    try {
      const output = JSON.parse(
        run(benchmarkScript, [
          "run",
          "--cold-runs",
          "1",
          "--warm-runs",
          "1",
          "--output",
          candidatePath,
        ]),
      ) as { ok: boolean; workloads: number };
      expect(output).toMatchObject({ ok: true, workloads: 3 });
      const gateOutput = JSON.parse(
        run(gateScript, [
          "--candidate",
          candidatePath,
          "--explain",
          "test-runner variance",
        ]),
      ) as { ok: boolean; warnings: number };
      expect(gateOutput.ok).toBe(true);
      expect(gateOutput.warnings).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a workload exceeds its declared tier", () => {
    const directory = mkdtempSync(join(tmpdir(), "cartograph-diff-budget-"));
    const mutatedManifest = join(directory, "manifest.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        workloads: Array<{ before: { nodes: number } }>;
      };
      const first = manifest.workloads[0];
      if (first === undefined) throw new Error("small workload is missing");
      first.before.nodes = 129;
      writeFileSync(mutatedManifest, `${JSON.stringify(manifest)}\n`, "utf8");
      expect(() =>
        run(benchmarkScript, [
          "validate",
          "--manifest",
          mutatedManifest,
          "--artifact",
          baselinePath,
        ]),
      ).toThrow(/exceeding supported small tier/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
