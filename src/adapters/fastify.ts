import {
  ADAPTER_API_VERSION,
  ADAPTER_CONTRACT,
  ADAPTER_MEDIA_TYPE,
  CAPABILITY_REGISTRY_VERSION,
  parseAdapterManifest,
  parseAdapterOutput,
  type AdapterInput,
  type CartographAdapter,
} from "../core/index.js";
import type { Evidence } from "../core/schemas.js";
import { analyzeTypeScriptRepository } from "../analyzers/typescript.js";

const FASTIFY_DIAGNOSTIC_CODES = [
  "UNRESOLVED_CALL",
  "UNRESOLVED_IMPORT",
  "AMBIGUOUS_PACKAGE_CONDITION",
  "UNSUPPORTED_DYNAMIC_IMPORT",
  "UNSUPPORTED_DYNAMIC_HTTP_DESTINATION",
  "UNSUPPORTED_DYNAMIC_PRISMA_MODEL",
  "UNRESOLVED_FASTIFY_HANDLER",
  "UNSUPPORTED_DYNAMIC_FASTIFY_ROUTE",
] as const;

export const FASTIFY_ADAPTER_MANIFEST = parseAdapterManifest({
  apiVersion: ADAPTER_API_VERSION,
  contract: ADAPTER_CONTRACT,
  mediaType: ADAPTER_MEDIA_TYPE,
  id: "cartograph.fastify",
  version: "0.1.0",
  compatibilityVersion: ADAPTER_API_VERSION,
  capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
  capabilities: [
    {
      id: "fastify.routes",
      description:
        "Extracts a bounded, evidence-backed subset of statically registered Fastify routes.",
      diagnosticCodes: [
        "UNRESOLVED_FASTIFY_HANDLER",
        "UNSUPPORTED_DYNAMIC_FASTIFY_ROUTE",
      ],
      confidence: ["inferred"],
      examples: [
        "Literal Fastify methods and object-form route declarations produce endpoint relationships.",
        "Dynamic methods, URLs, and unresolved handlers remain explicit diagnostics.",
      ],
    },
    {
      id: "typescript.graph",
      description:
        "Retains the existing TypeScript module, call, HTTP, and data-access graph context.",
      diagnosticCodes: [...FASTIFY_DIAGNOSTIC_CODES],
      confidence: ["certain", "inferred"],
      examples: [
        "Local imports and calls remain evidence-backed context for Fastify endpoints.",
        "Unsupported generic TypeScript constructs remain diagnostics rather than guessed edges.",
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

const collectEvidence = (output: {
  edges: readonly { evidence: readonly Evidence[] }[];
  diagnostics: readonly { evidence: readonly Evidence[] }[];
}): Evidence[] => {
  const evidence = new Map<string, Evidence>();
  for (const edge of output.edges)
    for (const item of edge.evidence) evidence.set(item.id, item);
  for (const diagnostic of output.diagnostics)
    for (const item of diagnostic.evidence) evidence.set(item.id, item);
  return [...evidence.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
};

const analyzerResources = (input: AdapterInput) => ({
  maxFiles: input.resources.maxFiles,
  maxFileBytes: input.resources.maxFileBytes,
  maxSourceBytes: input.resources.maxSourceBytes,
  maxMemoryBytes: input.resources.maxMemoryBytes,
  maxWallClockMs: input.resources.maxWallClockMs,
});

export const createFastifyAdapter = (): CartographAdapter => ({
  manifest: FASTIFY_ADAPTER_MANIFEST,
  analyze(input) {
    const tsconfigPath =
      typeof input.config.tsconfigPath === "string"
        ? input.config.tsconfigPath
        : undefined;
    const graph = analyzeTypeScriptRepository({
      rootDir: input.source.rootDir,
      include: input.source.include,
      exclude: input.source.exclude,
      ...(tsconfigPath ? { tsconfigPath } : {}),
      ...(input.source.revision ? { revision: input.source.revision } : {}),
      extractors: ["typescript", "fastify"],
      resources: analyzerResources(input),
    });
    return parseAdapterOutput({
      apiVersion: ADAPTER_API_VERSION,
      graph,
      evidence: collectEvidence(graph),
      diagnostics: [],
      capability: FASTIFY_ADAPTER_MANIFEST,
    });
  },
});
