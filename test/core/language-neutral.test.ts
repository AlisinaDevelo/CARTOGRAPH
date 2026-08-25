import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADAPTER_API_VERSION,
  createFastifyAdapter,
  createSampleAdapter,
  parseGraphSnapshot,
  reconcileGraphNodeIdentities,
  runAdapter,
} from "../../src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/language-neutral/compatibility.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/language-neutral-compatibility.v0.1.schema.json",
);
const graphSchemaPath = resolve(
  repositoryRoot,
  "schema/graph-snapshot.v0.1.schema.json",
);

type CompatibilityFixture = {
  cases: Array<{
    id: string;
    language: string;
    snapshot: unknown;
  }>;
};

const fixture = JSON.parse(
  readFileSync(fixturePath, "utf8"),
) as CompatibilityFixture;

const adapterRequest = (rootDir: string, config: Record<string, unknown>) => ({
  apiVersion: ADAPTER_API_VERSION,
  source: {
    rootDir,
    include: ["."],
    exclude: [],
    revision: { commitSha: "language-neutral-adapter-fixture" },
  },
  config,
  resources: {
    maxFiles: 32,
    maxFileBytes: 16_384,
    maxSourceBytes: 65_536,
    maxInputBytes: 16_384,
    maxOutputBytes: 2 * 1024 * 1024,
    maxMemoryBytes: 512 * 1024 * 1024,
    maxWallClockMs: 30_000,
  },
});

const portableLocation = (location: {
  path: string;
  line: number;
  column?: number | undefined;
  endLine?: number | undefined;
  endColumn?: number | undefined;
}) => {
  expect(location.path).not.toMatch(/^\//u);
  expect(location.path).not.toMatch(/(?:^|\/)\.\.(?:\/|$)/u);
  expect(location.path).not.toMatch(/[\\:\0]/u);
  expect(location.line).toBeGreaterThan(0);
  if (location.column !== undefined) expect(location.column).toBeGreaterThan(0);
  if (location.endLine !== undefined)
    expect(location.endLine).toBeGreaterThan(0);
  if (location.endColumn !== undefined)
    expect(location.endColumn).toBeGreaterThan(0);
};

describe("language-neutral graph semantics", () => {
  it("validates non-TypeScript snapshots against the published fixture and graph schemas", () => {
    const fixtureSchema = JSON.parse(
      readFileSync(fixtureSchemaPath, "utf8"),
    ) as object;
    const graphSchema = JSON.parse(
      readFileSync(graphSchemaPath, "utf8"),
    ) as object;
    const ajv = new Ajv({ allErrors: true });
    ajv.addSchema(graphSchema);
    const validate = ajv.compile(fixtureSchema);
    const value = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;

    expect(validate(value)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(fixture.cases).toHaveLength(2);
    expect(fixture.cases.map((entry) => entry.language).sort()).toEqual([
      "python",
      "rust",
    ]);

    for (const entry of fixture.cases) {
      const snapshot = parseGraphSnapshot(entry.snapshot);
      expect(snapshot.nodes.length).toBeGreaterThan(0);
      expect(
        snapshot.nodes.every((node) => node.language === entry.language),
      ).toBe(true);
      for (const node of snapshot.nodes) {
        expect(node.stableKey).toBeTruthy();
        if (node.location) portableLocation(node.location);
      }
      for (const edge of snapshot.edges) {
        expect(edge.from).toBeTruthy();
        expect(edge.to).toBeTruthy();
        if (edge.evidence.length === 0)
          expect(edge.unresolvedReason).toBeTruthy();
        for (const evidence of edge.evidence) {
          expect(evidence.kind).toBe("source");
          expect(evidence.detector).toMatch(/@1$/u);
          expect(evidence.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
          if (evidence.location) portableLocation(evidence.location);
          if (evidence.path && evidence.line !== undefined)
            portableLocation({ path: evidence.path, line: evidence.line });
        }
      }
      for (const diagnostic of snapshot.diagnostics) {
        expect(diagnostic.code).toMatch(/^[A-Z][A-Z0-9_]*$/u);
        expect(diagnostic.evidence.length).toBeGreaterThan(0);
        if (diagnostic.location) portableLocation(diagnostic.location);
      }
    }
  });

  it("keeps identity matching language-agnostic and conservative", () => {
    const rustSnapshot = parseGraphSnapshot(fixture.cases[0]?.snapshot);
    const rustNode = rustSnapshot.nodes.find((node) => node.kind === "service");
    if (!rustNode?.location) throw new Error("rust service fixture is missing");

    const before = {
      schemaVersion: 1,
      capabilityRegistryVersion: 1,
      revision: { commitSha: "identity-before" },
      nodes: [rustNode],
      edges: [],
      diagnostics: [],
    };
    const after = {
      schemaVersion: 1,
      capabilityRegistryVersion: 1,
      revision: { commitSha: "identity-after" },
      nodes: [
        {
          ...rustNode,
          id: "service:src/new.py:orders",
          stableKey: "service:src/new.py:orders",
          language: "python",
          location: { path: "src/new.py", line: 10, column: 1 },
        },
      ],
      edges: [],
      diagnostics: [],
    };

    const reconciliation = reconcileGraphNodeIdentities(before, after, {
      pathHistory: [{ beforePath: "src/lib.rs", afterPath: "src/new.py" }],
    });
    expect(reconciliation.matches).toHaveLength(1);
    expect(reconciliation.matches[0]?.method).toBe("same-name");
    expect(reconciliation.matches[0]?.signals).toEqual(
      expect.arrayContaining(["same-kind", "same-name", "path-history"]),
    );
    expect(reconciliation.matches[0]?.signals).not.toContain("same-language");
    expect(reconciliation.ambiguous).toHaveLength(0);
    expect(reconciliation.unsupported).toHaveLength(0);
  });

  it("keeps existing TypeScript adapters inside the same portable contract", () => {
    const sampleOutput = runAdapter(
      createSampleAdapter(),
      adapterRequest(repositoryRoot, { fixture: "supported" }),
    );
    expect(sampleOutput.graph.nodes.length).toBeGreaterThan(0);
    expect(
      sampleOutput.graph.nodes.every((node) => node.language === "typescript"),
    ).toBe(true);
    expect(
      sampleOutput.graph.nodes.some((node) =>
        node.location?.path.startsWith("fixtures/"),
      ),
    ).toBe(true);

    const fastifyRoot = resolve(
      repositoryRoot,
      "test/fixtures/typescript-fastify",
    );
    const fastifyOutput = runAdapter(
      createFastifyAdapter(),
      adapterRequest(fastifyRoot, {}),
    );
    expect(
      fastifyOutput.graph.nodes.some((node) => node.language === "typescript"),
    ).toBe(true);
    expect(fastifyOutput.graph.edges.length).toBeGreaterThan(0);
    expect(
      fastifyOutput.graph.diagnostics.some(
        (diagnostic) => diagnostic.code === "UNSUPPORTED_DYNAMIC_FASTIFY_ROUTE",
      ),
    ).toBe(true);
  });
});
