import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Ajv from "ajv";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(
  repositoryRoot,
  "scripts/runtime-reconciliation-corpus.mjs",
);
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/runtime-reconciliation-corpus/scenarios.v0.1.json",
);
const reportPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-corpus.v0.1.json",
);
const reportSchemaPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-corpus.v0.1.schema.json",
);

const run = (path = fixturePath) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "validate", "--fixture", path],
      { cwd: repositoryRoot, encoding: "utf8" },
    ),
  ) as {
    cases: number;
    families: string[];
    classificationCounts: Record<string, number>;
    redactedCases: number;
    network: boolean;
    exporter: boolean;
    fixtureDigest: string;
    reportDigest: string;
  };

const withMutatedFixture = (
  mutate: (fixture: Record<string, unknown>) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(join(tmpdir(), "cartograph-runtime-corpus-"));
  const path = join(directory, "fixture.json");
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

describe("runtime reconciliation corpus", () => {
  it("validates the digest-only report and all required fixture families", () => {
    const schema = JSON.parse(readFileSync(reportSchemaPath, "utf8")) as object;
    const sample = JSON.parse(readFileSync(reportPath, "utf8")) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(sample)).toBe(true);
    expect(validate.errors).toBeNull();

    expect(run()).toMatchObject({
      cases: 8,
      families: [
        "http",
        "database",
        "messaging",
        "errors",
        "missing-parents",
        "sampling",
        "redaction",
        "static-runtime-disagreement",
      ],
      classificationCounts: {
        observedAndModeled: 4,
        modeledNotObserved: 3,
        observedButUnmodeled: 2,
        ambiguous: 2,
      },
      redactedCases: 1,
      network: false,
      exporter: false,
    });
  });

  it("is invariant to case ordering", () => {
    const baseline = run();
    withMutatedFixture(
      (fixture) => {
        const cases = fixture.cases as Array<Record<string, unknown>>;
        fixture.cases = cases.reverse();
      },
      (path) => {
        expect(run(path)).toEqual(baseline);
      },
    );
  });

  it("fails when an expected classification drifts", () => {
    withMutatedFixture(
      (fixture) => {
        const cases = fixture.cases as Array<Record<string, unknown>>;
        const first = cases[0];
        if (!first) throw new Error("corpus case missing");
        const expected = first.expected as Record<string, unknown>;
        const records = expected.records as Array<Record<string, unknown>>;
        const record = records[0];
        if (!record) throw new Error("expected record missing");
        record.classification = "observed-and-modeled";
      },
      (path) => {
        expect(() => run(path)).toThrow(/classification .*drifted/u);
      },
    );
  });

  it("keeps the validator offline and redaction explicit", () => {
    const validator = readFileSync(scriptPath, "utf8");
    expect(validator).not.toMatch(/node:(?:http|https|net|tls|child_process)/u);
    expect(validator).not.toMatch(/\bfetch\s*\(/u);

    withMutatedFixture(
      (fixture) => {
        const cases = fixture.cases as Array<Record<string, unknown>>;
        const redacted = cases.find(
          (scenario) => scenario.id === "redacted-http",
        );
        if (!redacted) throw new Error("redacted case missing");
        const redaction = redacted.redaction as Record<string, unknown>;
        redaction.enabled = false;
      },
      (path) => {
        expect(() => run(path)).toThrow(/redaction family/u);
      },
    );
  });
});
