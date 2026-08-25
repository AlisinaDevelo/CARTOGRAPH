import { z } from "zod";

import { CAPABILITY_REGISTRY_VERSION } from "./capabilities.js";
import { GRAPH_SNAPSHOT_SCHEMA_VERSION } from "./schemas.js";

export const ADAPTER_COMPATIBILITY_SCHEMA_VERSION = 1 as const;
export const ADAPTER_COMPATIBILITY_CONTRACT =
  "cartograph.adapter-compatibility" as const;
export const ADAPTER_COMPATIBILITY_MEDIA_TYPE =
  "application/vnd.cartograph.adapter-compatibility+json" as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(
    /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u,
    "must be a portable lower-case identifier",
  );

const TextSchema = z.string().trim().min(1).max(2_048);
const SemverSchema = z
  .string()
  .trim()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "must be a semantic version",
  );
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const AdapterStabilitySchema = z.enum(["stable", "experimental"]);

export const AdapterCompatibilityTupleSchema = z
  .object({
    apiVersion: z.number().int().nonnegative(),
    compatibilityVersion: z.number().int().nonnegative(),
    capabilityRegistryVersion: z.number().int().nonnegative(),
    graphSchemaVersion: z.number().int().nonnegative(),
  })
  .strict();

export const AdapterCompatibilityContextSchema =
  AdapterCompatibilityTupleSchema.extend({
    allowExperimental: z.boolean().default(false),
  })
    .strict()
    .default({
      apiVersion: 1,
      compatibilityVersion: 1,
      capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
      graphSchemaVersion: GRAPH_SNAPSHOT_SCHEMA_VERSION,
      allowExperimental: false,
    });

export const AdapterCompatibilityMigrationSchema = z
  .object({
    id: IdentifierSchema,
    from: AdapterCompatibilityTupleSchema,
    to: AdapterCompatibilityTupleSchema,
    status: z.enum(["active", "deprecated"]),
    expiresOn: DateSchema,
    guidance: TextSchema,
  })
  .strict();

export const AdapterCompatibilityRegistrySchema = z
  .object({
    schemaVersion: z.literal(ADAPTER_COMPATIBILITY_SCHEMA_VERSION),
    contract: z.literal(ADAPTER_COMPATIBILITY_CONTRACT),
    mediaType: z.literal(ADAPTER_COMPATIBILITY_MEDIA_TYPE),
    current: AdapterCompatibilityTupleSchema,
    migrations: z.array(AdapterCompatibilityMigrationSchema).max(64),
  })
  .strict();

export const ADAPTER_COMPATIBILITY_REGISTRY =
  AdapterCompatibilityRegistrySchema.parse({
    schemaVersion: ADAPTER_COMPATIBILITY_SCHEMA_VERSION,
    contract: ADAPTER_COMPATIBILITY_CONTRACT,
    mediaType: ADAPTER_COMPATIBILITY_MEDIA_TYPE,
    current: {
      apiVersion: 1,
      compatibilityVersion: 1,
      capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
      graphSchemaVersion: GRAPH_SNAPSHOT_SCHEMA_VERSION,
    },
    migrations: [
      {
        id: "cartograph.adapter.compatibility.v0-to-v1",
        from: {
          apiVersion: 1,
          compatibilityVersion: 0,
          capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
          graphSchemaVersion: GRAPH_SNAPSHOT_SCHEMA_VERSION,
        },
        to: {
          apiVersion: 1,
          compatibilityVersion: 1,
          capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
          graphSchemaVersion: GRAPH_SNAPSHOT_SCHEMA_VERSION,
        },
        status: "deprecated",
        expiresOn: "2027-06-30",
        guidance:
          "Upgrade the adapter manifest and output to compatibilityVersion 1 before the migration window closes.",
      },
    ],
  });

export const AdapterCompatibilityStateSchema = z.enum([
  "compatible",
  "migratable",
  "experimental",
  "rejected",
]);

export const AdapterCompatibilityResultSchema = z
  .object({
    schemaVersion: z.literal(ADAPTER_COMPATIBILITY_SCHEMA_VERSION),
    contract: z.literal(ADAPTER_COMPATIBILITY_CONTRACT),
    adapterId: TextSchema,
    adapterVersion: TextSchema,
    state: AdapterCompatibilityStateSchema,
    stability: AdapterStabilitySchema,
    offered: AdapterCompatibilityTupleSchema,
    target: AdapterCompatibilityTupleSchema,
    migrationId: IdentifierSchema.optional(),
    migrationExpiresOn: DateSchema.optional(),
    requiresOptIn: z.boolean(),
    reasons: z.array(TextSchema).min(1).max(32),
    guidance: z.array(TextSchema).min(1).max(32),
  })
  .strict();

const AdapterManifestHeaderSchema = z
  .object({
    apiVersion: z.number().int().nonnegative(),
    contract: z.string().trim().min(1).max(256),
    id: z.string().trim().min(1).max(512),
    version: SemverSchema,
    compatibilityVersion: z.number().int().nonnegative(),
    capabilityRegistryVersion: z.number().int().nonnegative(),
    graphSchemaVersion: z.number().int().nonnegative().default(1),
    stability: AdapterStabilitySchema.default("stable"),
  })
  .passthrough();

export type AdapterStability = z.infer<typeof AdapterStabilitySchema>;
export type AdapterCompatibilityTuple = z.infer<
  typeof AdapterCompatibilityTupleSchema
>;
export type AdapterCompatibilityContext = z.infer<
  typeof AdapterCompatibilityContextSchema
>;
export type AdapterCompatibilityMigration = z.infer<
  typeof AdapterCompatibilityMigrationSchema
>;
export type AdapterCompatibilityRegistry = z.infer<
  typeof AdapterCompatibilityRegistrySchema
>;
export type AdapterCompatibilityState = z.infer<
  typeof AdapterCompatibilityStateSchema
>;
export type AdapterCompatibilityResult = z.infer<
  typeof AdapterCompatibilityResultSchema
>;

const CURRENT_CONTEXT: AdapterCompatibilityContext = {
  ...ADAPTER_COMPATIBILITY_REGISTRY.current,
  allowExperimental: false,
};

const sameTuple = (
  left: AdapterCompatibilityTuple,
  right: AdapterCompatibilityTuple,
): boolean =>
  left.apiVersion === right.apiVersion &&
  left.compatibilityVersion === right.compatibilityVersion &&
  left.capabilityRegistryVersion === right.capabilityRegistryVersion &&
  left.graphSchemaVersion === right.graphSchemaVersion;

const tupleMismatches = (
  offered: AdapterCompatibilityTuple,
  target: AdapterCompatibilityTuple,
): string[] => {
  const mismatches: string[] = [];
  for (const key of [
    "apiVersion",
    "compatibilityVersion",
    "capabilityRegistryVersion",
    "graphSchemaVersion",
  ] as const) {
    if (offered[key] !== target[key])
      mismatches.push(
        `${key} ${offered[key]} is not compatible with target ${target[key]}`,
      );
  }
  return mismatches;
};

const rejectedResult = (
  target: AdapterCompatibilityTuple,
  adapterId: string,
  adapterVersion: string,
  offered: AdapterCompatibilityTuple,
  stability: AdapterStability,
  reasons: string[],
): AdapterCompatibilityResult =>
  AdapterCompatibilityResultSchema.parse({
    schemaVersion: ADAPTER_COMPATIBILITY_SCHEMA_VERSION,
    contract: ADAPTER_COMPATIBILITY_CONTRACT,
    adapterId,
    adapterVersion,
    state: "rejected",
    stability,
    offered,
    target,
    requiresOptIn: false,
    reasons,
    guidance: [
      "Use a supported adapter API, graph schema, capability registry, and compatibility version, or install a reviewed migration.",
    ],
  });

const zeroTuple = (): AdapterCompatibilityTuple => ({
  apiVersion: 0,
  compatibilityVersion: 0,
  capabilityRegistryVersion: 0,
  graphSchemaVersion: 0,
});

/**
 * Negotiate adapter and core contract versions without running adapter code.
 * The result is a report, not an authority grant: experimental and rejected
 * states must still be handled by the caller before analysis begins.
 */
export const negotiateAdapterCompatibility = (
  manifestInput: unknown,
  contextInput: unknown = CURRENT_CONTEXT,
): AdapterCompatibilityResult => {
  const context = AdapterCompatibilityContextSchema.safeParse(contextInput);
  const target = context.success
    ? {
        apiVersion: context.data.apiVersion,
        compatibilityVersion: context.data.compatibilityVersion,
        capabilityRegistryVersion: context.data.capabilityRegistryVersion,
        graphSchemaVersion: context.data.graphSchemaVersion,
      }
    : ADAPTER_COMPATIBILITY_REGISTRY.current;
  if (!context.success) {
    return rejectedResult(target, "unknown", "unknown", zeroTuple(), "stable", [
      "compatibility context is malformed",
    ]);
  }

  const header = AdapterManifestHeaderSchema.safeParse(manifestInput);
  if (!header.success) {
    return rejectedResult(target, "unknown", "unknown", zeroTuple(), "stable", [
      "adapter manifest compatibility header is malformed",
    ]);
  }

  const offered: AdapterCompatibilityTuple = {
    apiVersion: header.data.apiVersion,
    compatibilityVersion: header.data.compatibilityVersion,
    capabilityRegistryVersion: header.data.capabilityRegistryVersion,
    graphSchemaVersion: header.data.graphSchemaVersion,
  };
  const mismatches = tupleMismatches(offered, target);
  if (mismatches.length === 0) {
    const experimental = header.data.stability === "experimental";
    return AdapterCompatibilityResultSchema.parse({
      schemaVersion: ADAPTER_COMPATIBILITY_SCHEMA_VERSION,
      contract: ADAPTER_COMPATIBILITY_CONTRACT,
      adapterId: header.data.id,
      adapterVersion: header.data.version,
      state: experimental ? "experimental" : "compatible",
      stability: header.data.stability,
      offered,
      target,
      requiresOptIn: experimental && !context.data.allowExperimental,
      reasons: [
        experimental
          ? "all contract dimensions match, but the adapter is marked experimental"
          : "all adapter and core contract dimensions match",
      ],
      guidance: [
        experimental
          ? "Set allowExperimental to true only after reviewing the adapter's bounded support and ownership."
          : "The adapter may be analyzed under the requested contract.",
      ],
    });
  }

  const migration = ADAPTER_COMPATIBILITY_REGISTRY.migrations.find(
    (candidate) =>
      sameTuple(candidate.from, offered) && sameTuple(candidate.to, target),
  );
  if (migration !== undefined) {
    return AdapterCompatibilityResultSchema.parse({
      schemaVersion: ADAPTER_COMPATIBILITY_SCHEMA_VERSION,
      contract: ADAPTER_COMPATIBILITY_CONTRACT,
      adapterId: header.data.id,
      adapterVersion: header.data.version,
      state: "migratable",
      stability: header.data.stability,
      offered,
      target,
      migrationId: migration.id,
      migrationExpiresOn: migration.expiresOn,
      requiresOptIn: false,
      reasons: [
        `adapter compatibility requires reviewed migration ${migration.id}`,
      ],
      guidance: [migration.guidance],
    });
  }

  return rejectedResult(
    target,
    header.data.id,
    header.data.version,
    offered,
    header.data.stability,
    mismatches,
  );
};

export const migrateAdapterManifest = (
  manifestInput: unknown,
  negotiation: AdapterCompatibilityResult,
): unknown => {
  if (negotiation.state !== "migratable" || !manifestInput)
    return manifestInput;
  if (typeof manifestInput !== "object" || Array.isArray(manifestInput))
    return manifestInput;
  return {
    ...(manifestInput as Record<string, unknown>),
    apiVersion: negotiation.target.apiVersion,
    compatibilityVersion: negotiation.target.compatibilityVersion,
    capabilityRegistryVersion: negotiation.target.capabilityRegistryVersion,
    graphSchemaVersion: negotiation.target.graphSchemaVersion,
  };
};

export const migrateAdapterOutput = (
  outputInput: unknown,
  negotiation: AdapterCompatibilityResult,
): unknown => {
  if (negotiation.state !== "migratable" || !outputInput) return outputInput;
  if (typeof outputInput !== "object" || Array.isArray(outputInput))
    return outputInput;
  const output = outputInput as Record<string, unknown>;
  if (!output.capability || typeof output.capability !== "object")
    return outputInput;
  return {
    ...output,
    capability: {
      ...(output.capability as Record<string, unknown>),
      apiVersion: negotiation.target.apiVersion,
      compatibilityVersion: negotiation.target.compatibilityVersion,
      capabilityRegistryVersion: negotiation.target.capabilityRegistryVersion,
      graphSchemaVersion: negotiation.target.graphSchemaVersion,
    },
  };
};
