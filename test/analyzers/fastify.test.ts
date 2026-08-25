import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseGraphSnapshot,
  serializeGraphSnapshot,
} from "../../src/core/index.js";
import { analyzeTypeScriptRepository } from "../../src/analyzers/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = resolve(repositoryRoot, "test/fixtures/typescript-fastify");
const expected = JSON.parse(
  readFileSync(resolve(fixtureRoot, "expected.json"), "utf8"),
) as {
  routes: [string, string, string][];
  unsupportedDiagnostics: string[];
  unresolvedDiagnostics: string[];
};

describe("Fastify extractor", () => {
  it("emits bounded literal and object-form route edges", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({
        rootDir: fixtureRoot,
        extractors: ["typescript", "fastify"],
      }),
    );

    const routes = snapshot.edges
      .filter((edge) => edge.from.startsWith("endpoint:"))
      .map((edge): [string, string, string] => [
        edge.from.slice("endpoint:".length).split(":")[0] ?? "",
        edge.from.slice("endpoint:".length).split(":").slice(1).join(":"),
        edge.to,
      ])
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
    expect(routes).toEqual(
      [...expected.routes].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    );
    for (const edge of snapshot.edges.filter((candidate) =>
      candidate.from.startsWith("endpoint:"),
    )) {
      expect(edge.confidence).toBe("inferred");
      expect(edge.evidence[0]?.detector).toMatch(
        /^cartograph\.typescript-fastify@1\/fastify-route$/u,
      );
    }
  });

  it("reports dynamic registration and unresolved handlers without guesses", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({
        rootDir: fixtureRoot,
        extractors: ["typescript", "fastify"],
      }),
    );
    const codes = snapshot.diagnostics
      .map((diagnostic) => diagnostic.code)
      .sort();
    expect(codes).toEqual(
      [
        ...expected.unsupportedDiagnostics,
        ...expected.unresolvedDiagnostics,
      ].sort(),
    );
    expect(
      snapshot.diagnostics.every(
        (diagnostic) => diagnostic.evidence.length > 0,
      ),
    ).toBe(true);
  });

  it("is deterministic and opt-in when the fastify extractor is omitted", () => {
    const options = {
      rootDir: fixtureRoot,
      extractors: ["typescript", "fastify"] as const,
    };
    expect(serializeGraphSnapshot(analyzeTypeScriptRepository(options))).toBe(
      serializeGraphSnapshot(analyzeTypeScriptRepository(options)),
    );
    const baseline = parseGraphSnapshot(
      analyzeTypeScriptRepository({
        rootDir: fixtureRoot,
        extractors: ["typescript"],
      }),
    );
    expect(baseline.nodes.some((node) => node.kind === "endpoint")).toBe(false);
  });
});
