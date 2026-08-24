import { z } from "zod";

export const CAPABILITY_REGISTRY_VERSION = 1 as const;

const CapabilityConfidenceSchema = z.enum([
  "certain",
  "inferred",
  "observed",
  "user_confirmed",
]);

const CapabilitySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
    diagnosticCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u)).min(1),
    confidence: z.array(CapabilityConfidenceSchema).min(1),
    examples: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

const ExtractorCapabilitySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
    version: z.string().regex(/^\d+(?:\.\d+)*$/u),
    capabilities: z.array(CapabilitySchema).min(1),
  })
  .strict();

export const CapabilityRegistrySchema = z
  .object({
    registryVersion: z.literal(CAPABILITY_REGISTRY_VERSION),
    extractors: z.array(ExtractorCapabilitySchema).min(1),
  })
  .strict();

export type CapabilityConfidence = z.infer<typeof CapabilityConfidenceSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type ExtractorCapability = z.infer<typeof ExtractorCapabilitySchema>;
export type CapabilityRegistry = z.infer<typeof CapabilityRegistrySchema>;

export const CAPABILITY_REGISTRY: CapabilityRegistry =
  CapabilityRegistrySchema.parse({
    registryVersion: CAPABILITY_REGISTRY_VERSION,
    extractors: [
      {
        id: "cartograph.typescript-express",
        version: "1",
        capabilities: [
          {
            id: "typescript.imports",
            diagnosticCodes: [
              "AMBIGUOUS_PACKAGE_CONDITION",
              "UNRESOLVED_IMPORT",
              "UNSUPPORTED_DYNAMIC_IMPORT",
            ],
            confidence: ["certain", "inferred"],
            examples: [
              "Static relative imports and re-exports carry source evidence.",
              "Package exports and imports conditions record selected and available branches.",
              "Dynamic import expressions remain diagnostics unless the specifier is a literal.",
            ],
          },
          {
            id: "typescript.calls",
            diagnosticCodes: ["UNRESOLVED_CALL"],
            confidence: ["certain", "inferred"],
            examples: [
              "Calls resolved through a local declaration become call edges.",
              "Unresolved or computed call targets remain diagnostics.",
            ],
          },
          {
            id: "express.routes",
            diagnosticCodes: [
              "UNRESOLVED_ROUTE_HANDLER",
              "UNSUPPORTED_DYNAMIC_ROUTE",
            ],
            confidence: ["inferred"],
            examples: [
              "Literal app and router methods plus bounded use middleware produce endpoint relationships.",
              "Computed route methods or handlers remain unsupported diagnostics.",
            ],
          },
          {
            id: "http.requests",
            diagnosticCodes: ["UNSUPPORTED_DYNAMIC_HTTP_DESTINATION"],
            confidence: ["certain", "inferred"],
            examples: [
              "Literal fetch and Axios destinations produce request edges.",
              "Computed destinations never become confident external-service edges.",
            ],
          },
          {
            id: "prisma.models",
            diagnosticCodes: ["UNSUPPORTED_DYNAMIC_PRISMA_MODEL"],
            confidence: ["inferred"],
            examples: [
              "Statically named Prisma model operations produce read/write edges.",
              "Computed model or operation names remain unsupported diagnostics.",
            ],
          },
        ],
      },
    ],
  });

export class CapabilityRegistryVersionError extends Error {
  readonly requestedVersion: unknown;
  readonly supportedVersion: number;

  constructor(requestedVersion: unknown) {
    super(
      `unsupported capability registry version ${JSON.stringify(requestedVersion)}; supported version is ${CAPABILITY_REGISTRY_VERSION}. Regenerate the artifact with a compatible extractor registry.`,
    );
    this.name = "CapabilityRegistryVersionError";
    this.requestedVersion = requestedVersion;
    this.supportedVersion = CAPABILITY_REGISTRY_VERSION;
  }
}

export const assertSupportedCapabilityRegistryVersion = (
  input: unknown,
): void => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const requestedVersion = (input as Record<string, unknown>)[
    "capabilityRegistryVersion"
  ];
  if (
    requestedVersion !== undefined &&
    requestedVersion !== CAPABILITY_REGISTRY_VERSION
  ) {
    throw new CapabilityRegistryVersionError(requestedVersion);
  }
};

export const assertCompatibleCapabilityRegistryVersion = (
  before: number,
  after: number,
): void => {
  if (before !== after) {
    throw new CapabilityRegistryVersionError(`${before} -> ${after}`);
  }
};
