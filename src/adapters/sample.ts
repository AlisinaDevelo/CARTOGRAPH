import {
  ADAPTER_API_VERSION,
  ADAPTER_CONTRACT,
  ADAPTER_MEDIA_TYPE,
  CAPABILITY_REGISTRY_VERSION,
  type CartographAdapter,
  parseAdapterManifest,
  parseAdapterOutput,
} from "../core/index.js";

const SAMPLE_EVIDENCE = {
  id: "sample:source:entry",
  kind: "source" as const,
  path: "fixtures/sample.ts",
  line: 1,
  detector: "cartograph.sample@0.1.0",
  contentHash: "0".repeat(64),
};

export const SAMPLE_ADAPTER_MANIFEST = parseAdapterManifest({
  apiVersion: ADAPTER_API_VERSION,
  contract: ADAPTER_CONTRACT,
  mediaType: ADAPTER_MEDIA_TYPE,
  id: "cartograph.sample",
  version: "0.1.0",
  compatibilityVersion: ADAPTER_API_VERSION,
  capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
  graphSchemaVersion: 1,
  stability: "stable",
  capabilities: [
    {
      id: "sample.fixture",
      description:
        "Produces deterministic graph, evidence, identity, and unsupported-diagnostic fixtures.",
      diagnosticCodes: ["UNSUPPORTED_SAMPLE_CONSTRUCT"],
      confidence: ["certain", "inferred"],
      examples: [
        "A supported fixture with one evidence-backed edge.",
        "An unsupported fixture with a reviewable diagnostic.",
      ],
    },
  ],
  execution: {
    filesystem: "source-read-only",
    network: false,
    childProcess: false,
    dynamicModuleLoading: false,
    repositoryCodeExecution: false,
  },
});

export const createSampleAdapter = (): CartographAdapter => ({
  manifest: SAMPLE_ADAPTER_MANIFEST,
  analyze(input) {
    const fixture =
      typeof input.config.fixture === "string" ? input.config.fixture : "empty";
    const revision = input.source.revision ?? { commitSha: "sample-fixture" };
    const nodes = [
      {
        id: "module:sample",
        stableKey: "module:sample",
        kind: "module" as const,
        name: "sample",
        language: "typescript",
        location: { path: "fixtures/sample.ts", line: 1 },
      },
      {
        id: "function:sample:entry",
        stableKey: "function:sample:entry",
        kind: "function" as const,
        name: "entry",
        language: "typescript",
        location: { path: "fixtures/sample.ts", line: 3 },
      },
    ];
    const graph = {
      schemaVersion: 1,
      capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
      revision,
      nodes,
      edges: [
        {
          from: "module:sample",
          to: "function:sample:entry",
          kind: "contains" as const,
          confidence: "certain" as const,
          evidence: [SAMPLE_EVIDENCE],
        },
      ],
      diagnostics: [],
    };

    if (fixture === "identity-before" || fixture === "identity-after") {
      const path = fixture === "identity-before" ? "old.ts" : "new.ts";
      return parseAdapterOutput({
        apiVersion: ADAPTER_API_VERSION,
        graph: {
          schemaVersion: 1,
          capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
          revision,
          nodes: [
            {
              id: `function:sample/${path}:load`,
              stableKey: `function:sample/${path}:load`,
              kind: "function",
              name: "load",
              language: "typescript",
              location: { path: `fixtures/${path}`, line: 1 },
            },
          ],
          edges: [],
          diagnostics: [],
        },
        evidence: [],
        diagnostics: [],
        capability: SAMPLE_ADAPTER_MANIFEST,
      });
    }

    return parseAdapterOutput({
      apiVersion: ADAPTER_API_VERSION,
      graph: fixture === "empty" ? { ...graph, nodes: [], edges: [] } : graph,
      evidence: fixture === "empty" ? [] : [SAMPLE_EVIDENCE],
      diagnostics:
        fixture === "unsupported"
          ? [
              {
                id: "diagnostic:sample:unsupported",
                code: "UNSUPPORTED_SAMPLE_CONSTRUCT",
                severity: "warning",
                message:
                  "the sample adapter intentionally preserved an unsupported construct for review",
                nodeId: "function:sample:entry",
                evidence: [SAMPLE_EVIDENCE],
              },
            ]
          : [],
      capability: SAMPLE_ADAPTER_MANIFEST,
    });
  },
});
