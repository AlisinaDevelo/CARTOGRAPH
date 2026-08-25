import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/adapter-starter.mjs");

describe("adapter starter", () => {
  it("passes the independent package, conformance, compatibility, and security harness", () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "validate"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const report = JSON.parse(output) as {
      ok: boolean;
      package: { name: string; version: string; files: string[] };
      adapterId: string;
      compatibility: string;
      rejectedFutureCompatibility: string;
      conformance: {
        cases: number;
        deterministic: boolean;
        evidenceComplete: boolean;
      };
      security: {
        network: boolean;
        childProcess: boolean;
        repositoryCodeExecution: boolean;
      };
    };
    expect(report).toMatchObject({
      ok: true,
      package: { name: "cartograph-adapter-starter", version: "0.1.0" },
      adapterId: "cartograph.starter.example",
      compatibility: "compatible",
      rejectedFutureCompatibility: "rejected",
      conformance: { cases: 3, deterministic: true, evidenceComplete: true },
      security: {
        network: false,
        childProcess: false,
        repositoryCodeExecution: false,
      },
    });
    expect(report.package.files).toEqual(
      expect.arrayContaining([
        "adapter.mjs",
        "fixtures/cases.v0.1.json",
        "test/adapter.test.mjs",
        "README.md",
        "package.json",
      ]),
    );
  });
});
