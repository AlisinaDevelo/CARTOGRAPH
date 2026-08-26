import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeTypeScriptRepository } from "../../src/analyzers/index.js";
import { parseGraphSnapshot } from "../../src/core/index.js";

const fixtureRoot = resolve(
  import.meta.dirname,
  "../fixtures/generated-provenance",
);

const analyze = () =>
  parseGraphSnapshot(
    analyzeTypeScriptRepository({
      rootDir: fixtureRoot,
      exclude: ["src/configured-output/**"],
    }),
  );

describe("generated-code provenance analyzer", () => {
  it("classifies included generated modules and maps explicit source provenance", () => {
    const snapshot = analyze();
    expect(snapshot.nodes).toContainEqual(
      expect.objectContaining({
        stableKey: "module:src/generated-output.ts",
        language: "typescript-generated",
      }),
    );
    expect(snapshot.nodes).toContainEqual(
      expect.objectContaining({
        stableKey: "module:generated/selected.ts",
        language: "typescript-generated",
      }),
    );
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        kind: "depends_on",
        from: "module:src/generated-output.ts",
        to: "module:src/source.ts",
        evidence: [
          expect.objectContaining({
            detector: "cartograph.generated@1/source",
            path: "src/generated-output.ts",
          }),
        ],
      }),
    );
  });

  it("reports every excluded generated path and its reason", () => {
    const snapshot = analyze();
    const excluded = snapshot.diagnostics.filter(
      (diagnostic) => diagnostic.code === "EXCLUDED_GENERATED_FILE",
    );
    expect(excluded.map((diagnostic) => diagnostic.location?.path)).toEqual([
      "dist/ignored.ts",
      "src/configured-output/ignored.ts",
    ]);
    expect(excluded[0]?.message).toContain(
      'Excluded generated path "dist/ignored.ts"',
    );
    expect(excluded[1]?.message).toContain(
      'configured exclusion pattern "src/configured-output/**"',
    );
    const unresolved = snapshot.diagnostics.find(
      (diagnostic) => diagnostic.code === "GENERATED_SOURCE_UNRESOLVED",
    );
    expect(unresolved?.location?.path).toBe("src/generated-unresolved.ts");
  });

  it("is deterministic across repeated scans", () => {
    expect(JSON.stringify(analyze())).toBe(JSON.stringify(analyze()));
  });
});
