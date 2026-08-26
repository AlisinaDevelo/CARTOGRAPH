import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  FindingLifecycleValidationError,
  findingLifecycleEventDigest,
  parseFindingLifecycleInput,
  replayFindingLifecycle,
  serializeFindingLifecycleReport,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/finding-lifecycle/replay.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/finding-lifecycle.v0.1.schema.json",
);
const scriptPath = resolve(repositoryRoot, "scripts/finding-lifecycle.mjs");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  input: Record<string, unknown> & {
    events: Array<Record<string, unknown>>;
  };
  expected: {
    summary: Record<string, unknown>;
    states: Record<string, string>;
    eventIds: Record<string, string[]>;
    diagnosticCodes: string[];
    tamperDiagnostic: string;
  };
};

describe("auditable finding lifecycle", () => {
  it("replays the append-only fixture deterministically", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
    const validator = new Ajv({ allErrors: true }).compile(schema);
    expect(validator(JSON.parse(readFileSync(fixturePath, "utf8")))).toBe(true);

    const input = parseFindingLifecycleInput(fixture.input);
    const report = replayFindingLifecycle(input);
    expect(report.summary).toEqual(fixture.expected.summary);
    expect(
      Object.fromEntries(
        report.findings.map((finding) => [finding.findingId, finding.state]),
      ),
    ).toEqual(fixture.expected.states);
    expect(
      Object.fromEntries(
        report.findings.map((finding) => [finding.findingId, finding.eventIds]),
      ),
    ).toEqual(fixture.expected.eventIds);
    expect(
      report.diagnostics.map((diagnostic) => diagnostic.code).sort(),
    ).toEqual(fixture.expected.diagnosticCodes);
    expect(report.migrations).toHaveLength(1);
    expect(
      report.findings.find(
        (finding) => finding.findingId === "finding-superseder",
      )?.supersededFindingIds,
    ).toEqual(["finding-superseded"]);
    expect(serializeFindingLifecycleReport(report)).toBe(
      serializeFindingLifecycleReport(
        JSON.parse(serializeFindingLifecycleReport(report)),
      ),
    );
  });

  it("rejects tampered and invalid events without applying them", () => {
    const input = parseFindingLifecycleInput(fixture.input);
    const tampered = structuredClone(input);
    tampered.events.find((event) => event.id === "event-api-ack")!.digest =
      `sha256:${"f".repeat(64)}`;
    const tamperedReport = replayFindingLifecycle(tampered);
    expect(
      tamperedReport.diagnostics.map((diagnostic) => diagnostic.code),
    ).toContain(fixture.expected.tamperDiagnostic);
    expect(
      tamperedReport.findings.find(
        (finding) => finding.findingId === "finding-api",
      )?.eventIds,
    ).toEqual([]);

    const invalid = structuredClone(input);
    const event = invalid.events.find(
      (candidate) => candidate.id === "event-api-remediate",
    )!;
    event.from = "open";
    event.digest = findingLifecycleEventDigest(event);
    const invalidReport = replayFindingLifecycle(invalid);
    expect(
      invalidReport.diagnostics.map((diagnostic) => diagnostic.code),
    ).toContain("LIFECYCLE_INVALID_TRANSITION");
  });

  it("rejects duplicate declarations before replay and keeps the validator offline", () => {
    const duplicate = structuredClone(fixture.input) as unknown as {
      findings: Array<Record<string, unknown>>;
      events: Array<Record<string, unknown>>;
    };
    duplicate.findings.push(structuredClone(duplicate.findings[0]!));
    expect(() => parseFindingLifecycleInput(duplicate)).toThrow(
      FindingLifecycleValidationError,
    );
    const empty = structuredClone(fixture.input) as unknown as {
      findings: Array<Record<string, unknown>>;
    };
    empty.findings = [];
    expect(() => parseFindingLifecycleInput(empty)).toThrow(
      FindingLifecycleValidationError,
    );

    const source = readFileSync(scriptPath, "utf8");
    expect(source).not.toMatch(/node:(?:http|https|net|tls)/u);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "validate"],
        { cwd: repositoryRoot, encoding: "utf8" },
      ),
    ) as { ok: boolean; digest: string };
    expect(output.ok).toBe(true);
    expect(output.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });
});
