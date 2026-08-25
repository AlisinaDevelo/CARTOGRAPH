import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/community-feedback.mjs");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/community-feedback/summary.v0.1.json",
);

const run = (path = fixturePath) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [scriptPath, "validate", "--fixture", path],
      { cwd: repositoryRoot, encoding: "utf8" },
    ),
  ) as {
    ok: boolean;
    triageCategories: number;
    records: number;
    externalRecords: number;
    decisions: number;
    backlogDecisions: number;
    privateTelemetry: boolean;
    sourcePayloads: boolean;
    digest: string;
  };

const withMutatedFixture = (
  mutate: (fixture: Record<string, unknown>) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(
    join(tmpdir(), "cartograph-community-feedback-"),
  );
  const path = join(directory, "summary.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<
    string,
    unknown
  >;
  mutate(fixture);
  writeFileSync(path, JSON.stringify(fixture));
  try {
    callback(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("community feedback contract", () => {
  it("validates the public process and explicit backlog decisions", () => {
    expect(run()).toMatchObject({
      ok: true,
      triageCategories: 11,
      records: 1,
      externalRecords: 0,
      decisions: 2,
      backlogDecisions: 2,
      privateTelemetry: false,
      sourcePayloads: false,
    });
    expect(run().digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("fails closed if private telemetry is enabled", () => {
    withMutatedFixture(
      (fixture) => {
        const scope = fixture.scope as Record<string, unknown>;
        scope.privateTelemetry = true;
      },
      (path) => {
        expect(() => run(path)).toThrow(/schema validation failed/u);
      },
    );
  });

  it("fails closed when a record references an unknown decision", () => {
    withMutatedFixture(
      (fixture) => {
        const records = fixture.records as Array<Record<string, unknown>>;
        const first = records.at(0);
        if (!first) throw new Error("community feedback test setup");
        first.decisionId = "missing-decision";
      },
      (path) => {
        expect(() => run(path)).toThrow(/no explicit backlog decision/u);
      },
    );
  });

  it("fails closed when summary counts drift", () => {
    withMutatedFixture(
      (fixture) => {
        const summary = fixture.summary as Record<string, unknown>;
        summary.recordCount = 0;
      },
      (path) => {
        expect(() => run(path)).toThrow(/summary counts drifted/u);
      },
    );
  });

  it("keeps the validator free of network and telemetry access", () => {
    const validator = readFileSync(scriptPath, "utf8");
    expect(validator).not.toMatch(/node:(?:http|https|net|tls)/u);
    expect(validator).not.toMatch(/\bfetch\s*\(/u);
    expect(validator).not.toMatch(/telemetry\.send|navigator\.sendBeacon/u);
  });
});
