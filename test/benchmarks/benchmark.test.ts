import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/benchmark.mjs");

describe("benchmark corpus and artifact governance", () => {
  it("validates the checked-in corpus and sanitized baseline", () => {
    const output = execFileSync(process.execPath, [scriptPath, "validate"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      corpusVersion: "0.1",
      fixtures: 4,
      artifact: "benchmarks/baseline.v0.1.json",
    });
  });

  it("keeps source bodies out of the checked-in artifact", () => {
    const artifact = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "benchmarks/baseline.v0.1.json"),
        "utf8",
      ),
    ) as unknown;
    const serialized = JSON.stringify(artifact).toLowerCase();
    expect(serialized).not.toMatch(
      /"(?:sourcebody|sourcecode|sourcetext|snippet|excerpt)"/u,
    );
    expect(serialized).not.toMatch(/"(?:telemetry|network)"/u);
    expect(serialized).not.toMatch(/(?:\/users\/|\/private\/|[a-z]:\\)/u);
  });
});
