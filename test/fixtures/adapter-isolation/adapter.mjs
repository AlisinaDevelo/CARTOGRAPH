/* global process */

const manifest = {
  apiVersion: 1,
  contract: "cartograph.adapter",
  mediaType: "application/vnd.cartograph.adapter+json",
  id: "cartograph.isolation-fixture",
  version: "0.1.0",
  compatibilityVersion: 1,
  capabilityRegistryVersion: 1,
  graphSchemaVersion: 1,
  stability: "stable",
  capabilities: [
    {
      id: "isolation.fixture",
      description: "Adversarial fixtures for the isolated adapter host.",
      diagnosticCodes: ["ISOLATION_FIXTURE_DIAGNOSTIC"],
      confidence: ["certain"],
      examples: ["A bounded empty graph used for process-boundary tests."],
    },
  ],
  execution: {
    filesystem: "none",
    network: false,
    childProcess: false,
    dynamicModuleLoading: false,
    repositoryCodeExecution: false,
  },
};

const evidence = {
  id: "isolation:fixture:source",
  kind: "source",
  path: "fixtures/isolation.ts",
  line: 1,
  detector: "cartograph.isolation-fixture@0.1.0",
  contentHash:
    "0000000000000000000000000000000000000000000000000000000000000000",
};

const nodes = [
  {
    id: "module:isolation",
    stableKey: "module:isolation",
    kind: "module",
    name: "isolation",
    language: "typescript",
    location: { path: "fixtures/isolation.ts", line: 1 },
  },
  {
    id: "function:isolation:entry",
    stableKey: "function:isolation:entry",
    kind: "function",
    name: "entry",
    language: "typescript",
    location: { path: "fixtures/isolation.ts", line: 2 },
  },
];

const baseOutput = (revision) => ({
  apiVersion: 1,
  graph: {
    schemaVersion: 1,
    capabilityRegistryVersion: 1,
    revision,
    nodes: [],
    edges: [],
    diagnostics: [],
  },
  evidence: [],
  diagnostics: [],
  capability: manifest,
});

export default {
  manifest,
  async analyze(input) {
    const revision = input.source.revision ?? { commitSha: "isolation" };
    const fixture = input.config.fixture;
    if (fixture === "hang") {
      while (true) {
        // The host must terminate this non-cooperative adapter.
        continue;
      }
    }
    if (fixture === "network") {
      try {
        await globalThis.fetch("http://example.com/cartograph-isolation");
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} ${error?.cause?.code ?? ""}`,
          { cause: error },
        );
      }
    }
    if (fixture === "child-process") {
      const childProcess = process.getBuiltinModule?.("node:child_process");
      if (!childProcess) throw new Error("child-process API is unavailable");
      try {
        childProcess.execFileSync(process.execPath, ["-e", "process.exit(0)"]);
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} ${error?.code ?? ""}`,
          { cause: error },
        );
      }
    }
    if (fixture === "oversized") {
      return {
        ...baseOutput(revision),
        graph: {
          ...baseOutput(revision).graph,
          nodes: [
            {
              ...nodes[0],
              name: "oversized-".concat("x".repeat(12_000)),
            },
          ],
        },
      };
    }
    if (fixture === "malformed-evidence") {
      return {
        ...baseOutput(revision),
        graph: {
          ...baseOutput(revision).graph,
          nodes,
          edges: [
            {
              from: nodes[0].id,
              to: nodes[1].id,
              kind: "contains",
              confidence: "certain",
              evidence: [evidence],
            },
          ],
        },
      };
    }
    return baseOutput(revision);
  },
};
