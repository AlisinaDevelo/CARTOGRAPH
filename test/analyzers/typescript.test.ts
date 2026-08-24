import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseGraphSnapshot } from "../../src/core/index.js";
import { analyzeTypeScriptRepository } from "../../src/analyzers/typescript.js";
import {
  CancellationError,
  TypeScriptConfigError,
} from "../../src/analyzers/index.js";

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/typescript-express",
);
const exclusionsRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/exclusions",
);
const regressionsRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/review-regressions",
);
const outsideImportRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/outside-import/project",
);
const projectLoaderRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/project-loader",
);
const projectLoaderConfigsRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/project-loader-configs",
);
const packageResolutionRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/package-resolution",
);
const inheritedProjectRoot = resolve(projectLoaderConfigsRoot, "inherited");
const cycleProjectRoot = resolve(projectLoaderConfigsRoot, "cycle");
const missingBaseProjectRoot = resolve(
  projectLoaderConfigsRoot,
  "missing-base",
);
const unsupportedProjectRoot = resolve(projectLoaderConfigsRoot, "unsupported");

describe("TypeScript analyzer", () => {
  it("matches the manually asserted fixture relationships", () => {
    const expected = JSON.parse(
      readFileSync(resolve(fixtureRoot, "expected.json"), "utf8"),
    ) as {
      diagnostics: string[];
      edges: [string, string, string][];
    };
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: fixtureRoot }),
    );
    const edges = snapshot.edges.map(
      (edge) => [edge.kind, edge.from, edge.to] as [string, string, string],
    );

    expect(
      [...edges].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    ).toEqual(
      [...expected.edges].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    );
    expect(
      [
        ...new Set(snapshot.diagnostics.map((diagnostic) => diagnostic.code)),
      ].sort(),
    ).toEqual([...new Set(expected.diagnostics)].sort());
    expect(snapshot.diagnostics).toHaveLength(8);
  });

  it("extracts a local import and a semantically resolved call", () => {
    const snapshot = analyzeTypeScriptRepository({ rootDir: fixtureRoot });
    const edgeKeys = snapshot.edges.map(
      (edge) => `${edge.kind}:${edge.from}->${edge.to}`,
    );

    expect(edgeKeys).toContain(
      "imports:module:src/entry.ts->module:src/modules.ts",
    );
    expect(edgeKeys).toContain(
      "calls:function:src/modules.ts:loadUsers->function:src/modules.ts:makeUsers",
    );
  });

  it("emits evidence-backed re-export and literal dynamic-module edges", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: fixtureRoot }),
    );
    const expectedImports = [
      ["module:src/dynamic-literals.ts", "module:src/modules.ts"],
      ["module:src/dynamic-literals.ts", "module:src/db.ts"],
      ["module:src/reexports.ts", "module:src/modules.ts"],
      ["module:src/reexports.ts", "module:src/services.ts"],
    ];

    for (const [from, to] of expectedImports) {
      const edge = snapshot.edges.find(
        (candidate) =>
          candidate.kind === "imports" &&
          candidate.from === from &&
          candidate.to === to,
      );
      expect(edge?.evidence.length).toBeGreaterThan(0);
      expect(edge?.evidence[0]?.kind).toBe("source");
    }

    expect(
      snapshot.diagnostics.filter(
        (diagnostic) => diagnostic.code === "UNSUPPORTED_DYNAMIC_IMPORT",
      ),
    ).toHaveLength(3);
  });

  it("emits evidence-backed route and middleware registration edges", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: fixtureRoot }),
    );
    const expectedRegistrations = [
      ["endpoint:USE:*", "function:src/middleware.ts:audit"],
      ["endpoint:USE:*", "function:src/middleware.ts:authenticate"],
      ["endpoint:USE:/api", "function:src/middleware.ts:authenticate"],
      ["endpoint:USE:/api", "function:src/middleware.ts:audit"],
      ["endpoint:USE:/users", "function:src/middleware.ts:authenticate"],
    ];

    for (const [from, to] of expectedRegistrations) {
      const edge = snapshot.edges.find(
        (candidate) =>
          candidate.kind === "calls" &&
          candidate.from === from &&
          candidate.to === to,
      );
      expect(edge?.evidence.length).toBeGreaterThan(0);
      expect(edge?.evidence[0]?.kind).toBe("source");
    }

    expect(
      snapshot.diagnostics.filter(
        (diagnostic) => diagnostic.code === "UNSUPPORTED_DYNAMIC_ROUTE",
      ),
    ).toHaveLength(3);
  });

  it("keeps output deterministic", () => {
    const first = analyzeTypeScriptRepository({ rootDir: fixtureRoot });
    const second = analyzeTypeScriptRepository({ rootDir: fixtureRoot });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("fails closed before producing a snapshot when cancelled", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      analyzeTypeScriptRepository({
        rootDir: fixtureRoot,
        signal: controller.signal,
      }),
    ).toThrowError(CancellationError);
  });

  it("reports stable wall-clock ceiling diagnostics", () => {
    expect(() =>
      analyzeTypeScriptRepository({
        rootDir: fixtureRoot,
        resources: { maxWallClockMs: -1 },
      }),
    ).toThrowError("analysis exceeded the -1 ms wall-clock ceiling");
  });

  it("attaches portable, hashed evidence to every edge and diagnostic", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: fixtureRoot }),
    );

    for (const edge of snapshot.edges) {
      expect(edge.evidence.length).toBeGreaterThan(0);
      for (const evidence of edge.evidence) {
        expect(evidence.kind).toBe("source");
        expect(evidence.path).not.toMatch(/^\//u);
        expect(evidence.detector).toMatch(
          /^cartograph\.typescript-express@1\/(?:call|diagnostic|express-route|http|import|prisma)$/u,
        );
        expect(evidence.contentHash).toMatch(/^[0-9a-f]{64}$/u);
      }
    }

    for (const diagnostic of snapshot.diagnostics) {
      expect(diagnostic.location?.path).not.toMatch(/^\//u);
      expect(diagnostic.evidence[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("marks convention-based framework bindings as inferred", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: fixtureRoot }),
    );
    const routeEdge = snapshot.edges.find(
      (edge) =>
        edge.from === "endpoint:GET:/users" &&
        edge.to === "function:src/modules.ts:loadUsers",
    );
    const prismaEdge = snapshot.edges.find(
      (edge) =>
        edge.from === "function:src/services.ts:listOne" &&
        edge.kind === "reads",
    );
    const axiosEdge = snapshot.edges.find(
      (edge) =>
        edge.from === "function:src/services.ts:remoteUser" &&
        edge.kind === "requests",
    );

    expect(routeEdge?.confidence).toBe("inferred");
    expect(prismaEdge?.confidence).toBe("inferred");
    expect(axiosEdge?.confidence).toBe("inferred");
  });

  it("does not discover generated or dependency directories", () => {
    const snapshot = analyzeTypeScriptRepository({ rootDir: exclusionsRoot });
    const keys = snapshot.nodes.map((node) => node.stableKey);

    expect(keys).toContain("module:src/real.ts");
    expect(
      keys.some((key) => /(?:dist|build|coverage|node_modules)/u.test(key)),
    ).toBe(false);
  });

  it("loads project references and path aliases without executing source", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: projectLoaderRoot }),
    );
    const moduleKeys = snapshot.nodes
      .filter((node) => node.kind === "module")
      .map((node) => node.stableKey);

    expect(moduleKeys).toContain("module:packages/app/src/main.ts");
    expect(moduleKeys).toContain(
      "module:packages/app/src/throws-if-executed.ts",
    );
    expect(moduleKeys).toContain("module:packages/core/src/index.ts");
    expect(
      moduleKeys.some((key) =>
        /(?:excluded|generated|build|dist|node_modules)/u.test(key),
      ),
    ).toBe(false);
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        kind: "imports",
        from: "module:packages/app/src/main.ts",
        to: "module:packages/core/src/index.ts",
      }),
    );
  });

  it("resolves chained extends, per-project roots, inherited exclusions, and mixed composite projects", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: inheritedProjectRoot }),
    );
    const moduleKeys = snapshot.nodes
      .filter((node) => node.kind === "module")
      .map((node) => node.stableKey);

    expect(moduleKeys).toContain("module:app/src/main.ts");
    expect(moduleKeys).toContain("module:shared/src/value.ts");
    expect(moduleKeys).not.toContain(
      "module:app/src/excluded-source/ignored.ts",
    );
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        kind: "imports",
        from: "module:app/src/main.ts",
        to: "module:shared/src/value.ts",
      }),
    );

    const legacy = parseGraphSnapshot(
      analyzeTypeScriptRepository({
        rootDir: inheritedProjectRoot,
        tsconfigPath: "legacy/tsconfig.json",
      }),
    );
    expect(legacy.nodes.map((node) => node.stableKey)).toContain(
      "module:legacy/src/legacy.ts",
    );
    expect(JSON.stringify(snapshot)).toBe(
      JSON.stringify(
        parseGraphSnapshot(
          analyzeTypeScriptRepository({ rootDir: inheritedProjectRoot }),
        ),
      ),
    );
  });

  it("rejects project-reference cycles with deterministic diagnostics", () => {
    const readError = (): TypeScriptConfigError => {
      try {
        analyzeTypeScriptRepository({ rootDir: cycleProjectRoot });
      } catch (error) {
        if (error instanceof TypeScriptConfigError) return error;
        throw error;
      }
      throw new Error("expected a project-reference cycle");
    };

    const first = readError();
    const second = readError();
    expect(first.code).toBe("cycle");
    expect(first.message).toContain("project reference cycle:");
    expect(first.message).toBe(second.message);
    expect(first.configPath).toBe("a/tsconfig.json");
  });

  it("rejects missing and unsupported config inheritance explicitly", () => {
    expect(() =>
      analyzeTypeScriptRepository({ rootDir: missingBaseProjectRoot }),
    ).toThrowError(
      expect.objectContaining({
        name: "TypeScriptConfigError",
        code: "missing",
      }),
    );
    expect(() =>
      analyzeTypeScriptRepository({ rootDir: unsupportedProjectRoot }),
    ).toThrowError(
      expect.objectContaining({
        name: "TypeScriptConfigError",
        code: "unsupported",
      }),
    );
  });

  it("resolves package exports and imports conditions with evidence", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: packageResolutionRoot }),
    );
    const imports = snapshot.edges.filter(
      (edge) => edge.kind === "imports" && edge.from === "module:src/entry.ts",
    );

    expect(imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: "module:src/internal-default.ts",
        }),
        expect.objectContaining({
          to: "module:src/internal-node.ts",
        }),
        expect.objectContaining({
          to: "module:src/public-import.ts",
        }),
      ]),
    );
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        kind: "imports",
        from: "module:src/cjs-entry.cts",
        to: "module:src/public-require.cts",
      }),
    );
    for (const edge of imports) {
      expect(edge.evidence.length).toBeGreaterThan(0);
      expect(
        edge.evidence.every((evidence) => evidence.kind === "source"),
      ).toBe(true);
      expect(edge.from).toMatch(/^module:/u);
      expect(edge.to).toMatch(/^module:/u);
    }

    const conditionDiagnostics = snapshot.diagnostics.filter(
      (diagnostic) => diagnostic.code === "AMBIGUOUS_PACKAGE_CONDITION",
    );
    expect(conditionDiagnostics).toHaveLength(1);
    expect(conditionDiagnostics[0]?.message).toContain(
      "selected conditions: import, node, types",
    );
    expect(conditionDiagnostics[0]?.message).toContain(
      "available conditions: default, development, production",
    );
    expect(JSON.stringify(snapshot)).toBe(
      JSON.stringify(
        parseGraphSnapshot(
          analyzeTypeScriptRepository({ rootDir: packageResolutionRoot }),
        ),
      ),
    );
  });

  it("fails closed when selected source ceilings are exceeded", () => {
    expect(() =>
      analyzeTypeScriptRepository({
        rootDir: projectLoaderRoot,
        resources: { maxFiles: 2 },
      }),
    ).toThrowError("analysis exceeds the 2 source-file ceiling");
    expect(() =>
      analyzeTypeScriptRepository({
        rootDir: projectLoaderRoot,
        resources: { maxFileBytes: 1 },
      }),
    ).toThrowError("source file exceeds the 1 byte file ceiling");
    expect(() =>
      analyzeTypeScriptRepository({
        rootDir: projectLoaderRoot,
        resources: { maxSourceBytes: 1 },
      }),
    ).toThrowError("analysis exceeds the 1 byte source ceiling");
  });

  it("preserves ordinary local calls despite framework-like method names", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: regressionsRoot }),
    );
    const keys = snapshot.edges.map(
      (edge) => `${edge.kind}:${edge.from}->${edge.to}`,
    );

    expect(keys).toContain(
      "calls:function:src/shadowed.ts:ordinaryCalls->function:src/shadowed.ts:localFetch",
    );
    expect(keys).toContain(
      "calls:function:src/shadowed.ts:ordinaryCalls->function:src/shadowed.ts:findMany",
    );
    expect(snapshot.edges.some((edge) => edge.kind === "requests")).toBe(false);
    expect(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "UNSUPPORTED_DYNAMIC_HTTP_DESTINATION",
      ),
    ).toBe(false);
  });

  it("keeps same-name nested callables distinct by lexical scope", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: regressionsRoot }),
    );
    const keys = snapshot.nodes.map((node) => node.stableKey);

    expect(keys).toContain("function:src/shadowed.ts:outerA.duplicate");
    expect(keys).toContain("function:src/shadowed.ts:outerB.duplicate");
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        from: "function:src/shadowed.ts:outerA",
        to: "function:src/shadowed.ts:outerA.duplicate",
      }),
    );
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        from: "function:src/shadowed.ts:outerB",
        to: "function:src/shadowed.ts:outerB.duplicate",
      }),
    );
  });

  it("supports literal bracket Prisma operations and diagnoses dynamic ones", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: regressionsRoot }),
    );

    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        from: "function:src/shadowed.ts:bracketRead",
        kind: "reads",
        to: "database_table:prisma:User",
      }),
    );
    expect(
      snapshot.diagnostics.some(
        (diagnostic) => diagnostic.code === "UNSUPPORTED_DYNAMIC_PRISMA_MODEL",
      ),
    ).toBe(true);
  });

  it("recognizes constructed Prisma clients but rejects ordinary lookalikes", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: regressionsRoot }),
    );

    for (const caller of [
      "constructedPrismaRead",
      "qualifiedConstructedPrismaRead",
    ]) {
      expect(snapshot.edges).toContainEqual(
        expect.objectContaining({
          from: `function:src/shadowed.ts:${caller}`,
          kind: "reads",
          to: "database_table:prisma:User",
          confidence: "inferred",
        }),
      );
    }
    expect(
      snapshot.edges.some(
        (edge) =>
          edge.from === "function:src/shadowed.ts:ordinaryCalls" &&
          edge.kind === "reads",
      ),
    ).toBe(false);
    expect(
      snapshot.edges.some(
        (edge) =>
          edge.from === "function:src/shadowed.ts:localPrismaLookalikeRead" &&
          edge.kind === "reads",
      ),
    ).toBe(false);
  });

  it("does not resolve or serialize a relative import outside the root", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: outsideImportRoot }),
    );
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain("outside-sentinel");
    expect(serialized).not.toContain("outside-source-secret");
    expect(snapshot.nodes.map((node) => node.stableKey)).not.toContain(
      "module:../outside-sentinel.ts",
    );
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "UNRESOLVED_IMPORT",
    );
  });
});
