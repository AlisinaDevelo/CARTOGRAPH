import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADAPTER_API_VERSION,
  runAdapter,
  serializeAdapterOutput,
} from "../../src/core/index.js";
import { createRustAdapter } from "../../src/adapters/rust.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = resolve(repositoryRoot, "test/fixtures/rust-adapter");
const expected = JSON.parse(
  readFileSync(resolve(fixtureRoot, "expected.json"), "utf8"),
) as {
  supportedEdgeKeys: string[];
  unsupportedDiagnosticCodes: string[];
  precisionRecall: {
    expectedEdgeCount: number;
    expectedDiagnosticCount: number;
  };
};

const input = () => ({
  apiVersion: ADAPTER_API_VERSION,
  source: {
    rootDir: fixtureRoot,
    include: ["."],
    exclude: [],
    revision: { commitSha: "rust-fixture" },
  },
  config: {},
  resources: {
    maxFiles: 32,
    maxFileBytes: 16_384,
    maxSourceBytes: 65_536,
    maxInputBytes: 16_384,
    maxOutputBytes: 2 * 1024 * 1024,
    maxMemoryBytes: 512 * 1024 * 1024,
    maxWallClockMs: 5_000,
  },
});

const edgeKey = (edge: { from: string; to: string; kind: string }) =>
  `${edge.from}|${edge.to}|${edge.kind}`;

describe("bounded Rust adapter pilot", () => {
  it("extracts the declared graph slice with exact fixture precision and recall", () => {
    const adapter = createRustAdapter();
    const output = runAdapter(adapter, input());
    const predicted = new Set(output.graph.edges.map(edgeKey));
    const expectedEdges = new Set(expected.supportedEdgeKeys);
    const truePositives = [...predicted].filter((key) =>
      expectedEdges.has(key),
    );

    expect(output.capability.id).toBe("cartograph.rust");
    expect(output.graph.nodes.every((node) => node.language === "rust")).toBe(
      true,
    );
    expect([...predicted].sort()).toEqual([...expectedEdges].sort());
    expect(
      output.graph.diagnostics.map((diagnostic) => diagnostic.code).sort(),
    ).toEqual([...expected.unsupportedDiagnosticCodes].sort());
    expect(output.evidence.length).toBeGreaterThan(0);
    expect(output.capability.execution).toEqual({
      filesystem: "source-read-only",
      network: false,
      childProcess: false,
      dynamicModuleLoading: false,
      repositoryCodeExecution: false,
    });
    expect(expected.precisionRecall).toEqual({
      expectedEdgeCount: expectedEdges.size,
      expectedDiagnosticCount: expected.unsupportedDiagnosticCodes.length,
    });
    expect(truePositives.length / predicted.size).toBe(1);
    expect(truePositives.length / expectedEdges.size).toBe(1);
    expect(output.graph.diagnostics).toHaveLength(
      expected.precisionRecall.expectedDiagnosticCount,
    );
    for (const edge of output.graph.edges)
      expect(edge.evidence.length).toBeGreaterThan(0);
  });

  it("is deterministic across repeated canonical runs", () => {
    const adapter = createRustAdapter();
    const first = runAdapter(adapter, input());
    const second = runAdapter(adapter, input());
    expect(serializeAdapterOutput(first)).toBe(serializeAdapterOutput(second));
  });
});
