import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  OwnershipResolutionError,
  parseCodeowners,
  parseOwnershipInput,
  resolveOwnership,
  serializeOwnershipReport,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/ownership-resolution/report.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/ownership-resolution.v0.1.schema.json",
);
const scriptPath = resolve(repositoryRoot, "scripts/ownership-resolution.mjs");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  request: Record<string, unknown> & {
    sources: Array<Record<string, unknown>>;
    sourceDiagnostics: Array<Record<string, unknown>>;
  };
  codeowners: Array<{
    id: string;
    repositoryId: string;
    path: string;
    revision: string;
    precedence: number;
    text: string;
  }>;
  expected: {
    summary: Record<string, number>;
    statuses: Record<string, string>;
    owners: Record<string, string[]>;
  };
};

const createInput = () => {
  const parsed = fixture.codeowners.map((entry) =>
    parseCodeowners(entry.text, entry),
  );
  return parseOwnershipInput({
    ...fixture.request,
    sources: [
      ...fixture.request.sources,
      ...parsed.map((entry) => entry.source),
    ],
    sourceDiagnostics: [
      ...fixture.request.sourceDiagnostics,
      ...parsed.flatMap((entry) => entry.diagnostics),
    ],
  });
};

describe("explicit ownership resolution", () => {
  it("validates the fixture and applies precedence, aliases, and CODEOWNERS order", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
    const validator = new Ajv({ allErrors: true }).compile(schema);
    expect(validator(JSON.parse(readFileSync(fixturePath, "utf8")))).toBe(true);

    const report = resolveOwnership(createInput());
    expect(report.summary).toEqual(fixture.expected.summary);
    const results = new Map(
      report.results.map((result) => [result.target.id, result]),
    );
    for (const [targetId, status] of Object.entries(
      fixture.expected.statuses,
    )) {
      expect(results.get(targetId)?.status).toBe(status);
      expect(results.get(targetId)?.owners).toEqual(
        fixture.expected.owners[targetId],
      );
    }
    expect(results.get("nested-file")?.matches[0]?.owners).toEqual([
      "team:service",
    ]);
    expect(results.get("renamed-file")?.matches[0]?.matchedPath).toBe(
      "previous",
    );
    expect(results.get("fallback-file")?.matches[0]?.sourceKind).toBe(
      "fallback",
    );
    expect(
      results
        .get("cross-repository")
        ?.evidence.every((entry) => entry.sourceId === "repo-b-codeowners"),
    ).toBe(true);

    const diagnosticCodes = report.diagnostics.map(
      (diagnostic) => diagnostic.code,
    );
    expect(diagnosticCodes).toContain("OWNERSHIP_ALIAS_CONFLICT");
    expect(diagnosticCodes).toContain("OWNERSHIP_RENAME_FALLBACK");
    expect(diagnosticCodes).toContain("OWNERSHIP_OWNER_UNKNOWN");
    expect(serializeOwnershipReport(report)).toBe(
      serializeOwnershipReport(JSON.parse(serializeOwnershipReport(report))),
    );
  });

  it("keeps CODEOWNERS negation and unsupported syntax explicit", () => {
    const parsed = parseCodeowners(
      "!generated/** @platform\n[ab].ts @platform\npackages/** @platform\n",
      {
        id: "unsupported-codeowners",
        repositoryId: "repo-a",
        path: ".github/CODEOWNERS",
      },
    );
    expect(parsed.source.rules).toHaveLength(1);
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "OWNERSHIP_NEGATION_UNSUPPORTED",
      "OWNERSHIP_PATTERN_UNSUPPORTED",
    ]);
  });

  it("rejects absolute paths and duplicate declarations before resolution", () => {
    const absolute = structuredClone(fixture.request) as unknown as {
      sources: Array<Record<string, unknown>>;
      targets: Array<Record<string, unknown>>;
    };
    absolute.sources[0]!.path = "/private/ownership.json";
    expect(() => parseOwnershipInput(absolute)).toThrow(
      OwnershipResolutionError,
    );

    const duplicate = structuredClone(fixture.request) as unknown as {
      sources: Array<Record<string, unknown>>;
      targets: Array<Record<string, unknown>>;
    };
    duplicate.sources.push(structuredClone(duplicate.sources[0]!));
    expect(() => parseOwnershipInput(duplicate)).toThrow(
      /duplicate ownership source ID/u,
    );

    const duplicateTarget = structuredClone(fixture.request) as unknown as {
      sources: Array<Record<string, unknown>>;
      targets: Array<Record<string, unknown>>;
    };
    duplicateTarget.targets.push(structuredClone(duplicateTarget.targets[0]!));
    expect(() => parseOwnershipInput(duplicateTarget)).toThrow(
      /duplicate ownership target ID/u,
    );
  });

  it("replays the checked-in validator without network-capable APIs", () => {
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "validate"],
        { cwd: repositoryRoot, encoding: "utf8" },
      ),
    ) as { ok: boolean; digest: string; summary: Record<string, number> };
    expect(output).toMatchObject({
      ok: true,
      summary: fixture.expected.summary,
    });
    expect(output.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const source = readFileSync(scriptPath, "utf8");
    expect(source).not.toMatch(/node:(?:http|https|net|tls)/u);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
  });
});
