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
    "\uFEFF",
    "\v",
    "\f",
    "\r",
    "\u0085",
    "\u200e",
    "\u200f",
    "\u2028",
    "\u2029",
  ])(
    "preserves declarations and imports after Rust whitespace %j",
    (prefix) => {
      const output = scanFiles({
        "src/lib.rs": `${prefix}mod payments;\n${prefix === "\uFEFF" ? "" : prefix}use crate::payments::charge;\npub fn entry() { charge(); }\n`,
        "src/payments.rs": `${prefix}pub fn charge() {}\n`,
      });
      expect(output.graph.nodes.some((node) => node.name === "charge")).toBe(
        true,
      );
      expect(
        output.graph.edges.filter((edge) => edge.kind === "imports"),
      ).toHaveLength(1);
      expect(
        output.graph.edges.filter((edge) => edge.kind === "calls"),
      ).toHaveLength(1);
      expect(output.graph.diagnostics).toEqual([]);
    },
  );

  it.each([
    ["line comment", "// target();"],
    ["nested block comment", "/* outer /* target(); */ target(); */"],
    ["escaped string", 'let text = "\\" target() // }";'],
    ["raw string", 'let text = r##"target() "# } /*"##;'],
    ["byte string", 'let text = b"target() }";'],
    ["raw byte string", 'let text = br#"target() }"#;'],
    ["C string", 'let text = c"target() }";'],
    ["raw C string", 'let text = cr#"target() }"#;'],
  ])("excludes calls inside a %s", (_label, nonCode) => {
    const output = scanFiles({
      "src/lib.rs": `pub fn target() {}\npub fn entry() {\n  ${nonCode}\n}\n`,
    });
    expect(output.graph.edges.filter((edge) => edge.kind === "calls")).toEqual(
      [],
    );
    expect(output.graph.diagnostics).toEqual([]);
  });

  it.each([
    "/*\npub fn ghost() {}\nmod missing;\nuse crate::missing;\n*/",
    'const TEXT: &str = r#"\npub fn ghost() {}\nmod missing;\nuse crate::missing;\n"#;',
  ])("excludes declarations and imports inside non-code", (nonCode) => {
    const output = scanFiles({
      "src/lib.rs": `${nonCode}\npub fn entry() {}\n`,
    });
    expect(
      output.graph.nodes.filter((node) => node.kind === "function"),
    ).toEqual([expect.objectContaining({ name: "entry" })]);
    expect(
      output.graph.edges.filter((edge) => edge.kind === "imports"),
    ).toEqual([]);
    expect(output.graph.diagnostics).toEqual([]);
  });

  it.each([
    "// }",
    "/* } /* { */ } */",
    'let text = r#"" }"#;',
    "let character = '}'; let byte = b'{';",
  ])("preserves real call spans after non-code braces", (nonCode) => {
    const output = scanFiles({
      "src/lib.rs": `pub fn target() {}\npub fn entry() {\n  ${nonCode}\n  target();\n}\n`,
    });
    expect(output.graph.edges.filter((edge) => edge.kind === "calls")).toEqual([
      expect.objectContaining({
        from: "function:src/lib.rs:entry",
        to: "function:src/lib.rs:target",
        evidence: [expect.objectContaining({ line: 4, column: 3 })],
      }),
    ]);
  });

  it("keeps lifetimes distinct from character literals and bounds each body", () => {
    const output = scanFiles({
      "src/lib.rs":
        'pub fn target() {}\npub fn entry() {\n  let text: &\'static str = "text";\n}\npub fn next() { target(); }\n',
    });
    expect(output.graph.edges.filter((edge) => edge.kind === "calls")).toEqual([
      expect.objectContaining({
        from: "function:src/lib.rs:next",
        to: "function:src/lib.rs:target",
      }),
    ]);
  });

  it("preserves UTF-16 columns and declaration lines after masked text", () => {
    const body = 'pub fn entry() { let text = "😀"; target(); }';
    const output = scanFiles({
      "src/lib.rs": `/* heading\n\n*/\npub fn target() {}\n${body}\n`,
    });
    expect(
      output.graph.nodes.find((node) => node.name === "target")?.location,
    ).toEqual({ path: "src/lib.rs", line: 4, column: 1 });
    expect(output.graph.edges.filter((edge) => edge.kind === "calls")).toEqual([
      expect.objectContaining({
        evidence: [
          expect.objectContaining({
            line: 5,
            column: body.indexOf("target()") + 1,
          }),
        ],
      }),
    ]);
  });

  it("retains literal HTTP and SQL while excluding boundary text in comments and strings", () => {
    const output = scanFiles({
      "src/lib.rs": [
        "pub fn entry() {",
        '  // reqwest::get("https://ignored.example"); reqwest::get(dynamic);',
        '  let text = r#"sqlx::query("SELECT * FROM ignored")"#;',
        '  reqwest::get("https://api.example/path");',
        '  sqlx::query("SELECT * FROM orders");',
        "}",
      ].join("\n"),
    });
    expect(
      output.graph.edges.filter((edge) => edge.kind !== "contains"),
    ).toEqual([
      expect.objectContaining({
        to: "database_table:orders",
        kind: "reads",
        evidence: [expect.objectContaining({ line: 5, column: 3 })],
      }),
      expect.objectContaining({
        to: "external_service:https://api.example",
        kind: "requests",
        evidence: [expect.objectContaining({ line: 4, column: 3 })],
      }),
    ]);
    expect(output.graph.diagnostics).toEqual([]);
  });

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
