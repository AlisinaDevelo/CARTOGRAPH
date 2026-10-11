import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

const scanFiles = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "cartograph-rust-modules-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
    }
    return runAdapter(createRustAdapter(), { source: { rootDir: root } });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe("bounded Rust adapter pilot", () => {
  it.each([
    ["src/lib.rs", "src/payments/mod.rs"],
    ["src/main.rs", "src/payments/mod.rs"],
    ["src/orders.rs", "src/orders/payments/mod.rs"],
    ["src/orders/mod.rs", "src/orders/payments/mod.rs"],
  ])("resolves a directory module declared in %s", (ownerPath, targetPath) => {
    const output = scanFiles({
      [ownerPath]: "mod payments;\npub fn entry() {}\n",
      [targetPath]: "pub fn charge() {}\n",
    });

    expect(
      output.graph.edges.filter((edge) => edge.kind === "imports"),
    ).toEqual([
      expect.objectContaining({
        from: `module:${ownerPath}`,
        to: `module:${targetPath}`,
        confidence: "certain",
      }),
    ]);
    expect(output.graph.diagnostics).toEqual([]);
  });

  it("resolves a root crate import to a directory module", () => {
    const output = scanFiles({
      "src/lib.rs": "use crate::payments::charge;\npub fn entry() {}\n",
      "src/payments/mod.rs": "pub fn charge() {}\n",
    });

    expect(
      output.graph.edges.filter((edge) => edge.kind === "imports"),
    ).toEqual([
      expect.objectContaining({
        from: "module:src/lib.rs",
        to: "module:src/payments/mod.rs",
      }),
    ]);
    expect(output.graph.diagnostics).toEqual([]);
  });

  it("keeps missing directory modules unresolved", () => {
    const output = scanFiles({
      "src/lib.rs": "mod missing;\npub fn entry() {}\n",
    });

    expect(
      output.graph.edges.filter((edge) => edge.kind === "imports"),
    ).toEqual([]);
    expect(
      output.graph.diagnostics.map((diagnostic) => diagnostic.code),
    ).toEqual(["UNRESOLVED_RUST_IMPORT"]);
  });

  it.each([false, true])(
    "resolves nested crate imports from the root with decoy=%s",
    (withDecoy) => {
      const files: Record<string, string> = {
        "src/lib.rs": "mod orders;\nmod payments;\n",
        "src/orders/mod.rs":
          "use crate::payments::charge;\npub fn entry() {}\n",
        "src/payments/mod.rs": "pub fn charge() {}\n",
      };
      if (withDecoy)
        files["src/orders/payments/mod.rs"] = "pub fn charge() {}\n";
      const output = scanFiles(files);
      expect(
        output.graph.edges.filter(
          (edge) =>
            edge.kind === "imports" && edge.from === "module:src/orders/mod.rs",
        ),
      ).toEqual([
        expect.objectContaining({
          to: "module:src/payments/mod.rs",
          confidence: "certain",
        }),
      ]);
      expect(output.graph.diagnostics).toEqual([]);
    },
  );

  it("leaves crate imports unresolved when no conventional crate root is selected", () => {
    const output = scanFiles({
      "src/orders/mod.rs": "use crate::payments::charge;\npub fn entry() {}\n",
      "src/orders/payments/mod.rs": "pub fn charge() {}\n",
    });
    expect(
      output.graph.edges.filter((edge) => edge.kind === "imports"),
    ).toEqual([]);
    expect(
      output.graph.diagnostics.map((diagnostic) => diagnostic.code),
    ).toEqual(["UNRESOLVED_RUST_IMPORT"]);
  });

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
