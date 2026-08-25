const ADAPTER_API_VERSION = 1;
const CAPABILITY_REGISTRY_VERSION = 1;
const GRAPH_SCHEMA_VERSION = 1;

export const manifest = {
  apiVersion: ADAPTER_API_VERSION,
  contract: "cartograph.adapter",
  mediaType: "application/vnd.cartograph.adapter+json",
  id: "cartograph.starter.example",
  version: "0.1.0",
  compatibilityVersion: ADAPTER_API_VERSION,
  capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
  graphSchemaVersion: GRAPH_SCHEMA_VERSION,
  stability: "stable",
  capabilities: [
    {
      id: "starter.example",
      description:
        "Demonstrates a deterministic, evidence-backed adapter contribution boundary.",
      diagnosticCodes: ["UNSUPPORTED_STARTER_CONSTRUCT"],
      confidence: ["certain", "inferred"],
      examples: [
        "A supported starter fixture emits one evidence-backed contains edge.",
        "An unsupported starter fixture emits an explicit warning diagnostic.",
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
};

const evidenceFor = (fixture) => ({
  id: `starter:source:${fixture}`,
  kind: "source",
  path: "fixtures/starter.ts",
  line: 1,
  detector: "cartograph.starter.example@0.1.0",
  contentHash: "2".repeat(64),
});

const graphFor = (input, fixture) => {
  const revision = input.source.revision ?? { commitSha: "starter-fixture" };
  const evidence = evidenceFor(fixture);
  const nodes = [
    {
      id: "module:starter",
      stableKey: "module:starter",
      kind: "module",
      name: "starter",
      language: "typescript",
      location: { path: "fixtures/starter.ts", line: 1 },
    },
    {
      id: "function:starter:entry",
      stableKey: "function:starter:entry",
      kind: "function",
      name: "entry",
      language: "typescript",
      location: { path: "fixtures/starter.ts", line: 3 },
    },
  ];
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    revision,
    nodes: fixture === "empty" ? [] : nodes,
    edges:
      fixture === "empty"
        ? []
        : [
            {
              from: "module:starter",
              to: "function:starter:entry",
              kind: "contains",
              confidence: "certain",
              evidence: [evidence],
            },
          ],
    diagnostics:
      fixture === "unsupported"
        ? [
            {
              id: "diagnostic:starter:unsupported",
              code: "UNSUPPORTED_STARTER_CONSTRUCT",
              severity: "warning",
              message:
                "the starter intentionally leaves an unsupported construct explicit",
              nodeId: "function:starter:entry",
              evidence: [evidence],
            },
          ]
        : [],
  };
};

const adapter = {
  manifest,
  analyze(input) {
    const fixture =
      typeof input.config.fixture === "string" ? input.config.fixture : "empty";
    const graph = graphFor(input, fixture);
    const evidence = graph.edges.flatMap((edge) => edge.evidence);
    return {
      apiVersion: ADAPTER_API_VERSION,
      graph,
      evidence,
      diagnostics: [],
      capability: manifest,
    };
  },
};

export default adapter;
