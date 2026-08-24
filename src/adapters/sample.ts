import {
  ADAPTER_API_VERSION,
  ADAPTER_CONTRACT,
  ADAPTER_MEDIA_TYPE,
  CAPABILITY_REGISTRY_VERSION,
  type CartographAdapter,
  parseAdapterManifest,
  parseAdapterOutput,
} from "../core/index.js";

export const SAMPLE_ADAPTER_MANIFEST = parseAdapterManifest({
  apiVersion: ADAPTER_API_VERSION,
  contract: ADAPTER_CONTRACT,
  mediaType: ADAPTER_MEDIA_TYPE,
  id: "cartograph.sample",
  version: "0.1.0",
  compatibilityVersion: ADAPTER_API_VERSION,
  capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
  capabilities: [
    {
      id: "sample.noop",
      description: "Produces an empty graph for an explicit local fixture.",
      diagnosticCodes: [],
      confidence: ["certain"],
      examples: ["An explicit fixture with no source extraction."],
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
    return parseAdapterOutput({
      apiVersion: ADAPTER_API_VERSION,
      graph: {
        schemaVersion: 1,
        capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
        revision: input.source.revision ?? { commitSha: "sample-fixture" },
        nodes: [],
        edges: [],
        diagnostics: [],
      },
      evidence: [],
      diagnostics: [],
      capability: SAMPLE_ADAPTER_MANIFEST,
    });
  },
});
