import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeTypeScriptRepository } from "../../src/analyzers/index.js";
import { parseGraphSnapshot } from "../../src/core/index.js";

const fixtureRoot = resolve(import.meta.dirname, "../fixtures/lockfiles");

const analyze = (manager: string) =>
  parseGraphSnapshot(
    analyzeTypeScriptRepository({ rootDir: resolve(fixtureRoot, manager) }),
  );

describe("lockfile analyzer", () => {
  it.each([
    ["npm", "alpha", "sha512-alpha"],
    ["pnpm", "beta", "sha512-beta"],
    ["yarn", "gamma", "sha512-gamma"],
    ["bun", "delta", "sha512-delta"],
  ])(
    "normalizes %s dependency evidence offline",
    (manager, name, integrity) => {
      const snapshot = analyze(manager);
      const edge = snapshot.edges.find(
        (candidate) =>
          candidate.kind === "depends_on" &&
          candidate.to === `module:external:${name}`,
      );
      expect(edge).toBeDefined();
      expect(edge?.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            detector: "cartograph.lockfile@1/dependency",
          }),
        ]),
      );
      expect(
        edge?.evidence.find(
          (evidence) =>
            evidence.detector === "cartograph.lockfile@1/dependency",
        )?.contentHash,
      ).toMatch(/^[0-9a-f]{64}$/u);
      expect(integrity).toBeTruthy();
      expect(snapshot.diagnostics).toEqual([]);
      expect(JSON.stringify(snapshot)).toBe(JSON.stringify(analyze(manager)));
    },
  );

  it("fails closed on ambiguous managers and mismatched records", () => {
    const snapshot = analyze("ambiguous");
    const codes = snapshot.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "AMBIGUOUS_LOCKFILE",
        "LOCKFILE_VERSION_MISMATCH",
        "LOCKFILE_MISSING_INTEGRITY",
      ]),
    );
    expect(
      snapshot.diagnostics.every((diagnostic) =>
        diagnostic.evidence.every((evidence) =>
          /^[0-9a-f]{64}$/u.test(evidence.contentHash ?? ""),
        ),
      ),
    ).toBe(true);
  });
});
