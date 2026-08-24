import { z } from "zod";

import { CAPABILITY_REGISTRY_VERSION } from "./capabilities.js";
import { canonicalizeGraphSnapshot, stableStringify } from "./canonical.js";
import {
  DiagnosticSchema,
  EvidenceSchema,
  GraphSnapshotSchema,
  RevisionSchema,
  type Diagnostic,
  type Evidence,
  type Revision,
} from "./schemas.js";

export const ADAPTER_API_VERSION = 1 as const;
export const ADAPTER_CONTRACT = "cartograph.adapter" as const;
export const ADAPTER_MEDIA_TYPE = "application/vnd.cartograph.adapter+json";

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
const DiagnosticCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]*$/u);
const ConfidenceSchema = z.enum([
  "certain",
  "inferred",
  "observed",
  "user_confirmed",
]);

const PortablePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .transform((value, context) => {
    const normalized = value.replaceAll("\\", "/");
    const parts = normalized.split("/");
    if (
      normalized.startsWith("/") ||
      normalized.startsWith("~") ||
      normalized.includes("\0") ||
      /^[A-Za-z][A-Za-z\d+.-]*:/.test(normalized) ||
      parts.some((part) => part === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "must be a portable repository-relative path",
      });
      return z.NEVER;
    }
    const compact = parts.filter((part) => part.length > 0 && part !== ".");
    return compact.length === 0 ? "." : compact.join("/");
  });

const RootPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !/^[A-Za-z][A-Za-z\d+.-]*:/.test(value) &&
      !value.startsWith("~"),
    "must be a local filesystem path, not a URI or home shortcut",
  );

const SemverSchema = z
  .string()
  .trim()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "must be a semantic version",
  );

export const AdapterExecutionPolicySchema = z
  .object({
    filesystem: z.enum(["source-read-only", "none"]),
    network: z.literal(false),
    childProcess: z.literal(false),
    dynamicModuleLoading: z.literal(false),
    repositoryCodeExecution: z.literal(false),
  })
  .strict();

export const AdapterCapabilityDeclarationSchema = z
  .object({
    id: IdentifierSchema,
    description: TextSchema,
    diagnosticCodes: z.array(DiagnosticCodeSchema).max(256),
    confidence: z.array(ConfidenceSchema).min(1),
    examples: z.array(TextSchema).min(1).max(256),
  })
  .strict();

export const AdapterCapabilityManifestSchema = z
  .object({
    apiVersion: z.literal(ADAPTER_API_VERSION),
    contract: z.literal(ADAPTER_CONTRACT),
    mediaType: z.literal(ADAPTER_MEDIA_TYPE),
    id: IdentifierSchema,
    version: SemverSchema,
    compatibilityVersion: z.literal(ADAPTER_API_VERSION),
    capabilityRegistryVersion: z.literal(CAPABILITY_REGISTRY_VERSION),
    capabilities: z.array(AdapterCapabilityDeclarationSchema).min(1).max(256),
    execution: AdapterExecutionPolicySchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    manifest.capabilities.forEach((capability, index) => {
      if (ids.has(capability.id)) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", index, "id"],
          message: `duplicate capability ID: ${capability.id}`,
        });
      }
      ids.add(capability.id);
    });
  });

export type AdapterJsonValue =
  | null
  | boolean
  | number
  | string
  | AdapterJsonValue[]
  | { [key: string]: AdapterJsonValue };

const forbiddenConfigKey =
  /^(?:command|cwd|exec|execute|hook|import|loader|module|require|script)$/iu;

const AdapterJsonValueSchema: z.ZodType<AdapterJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(1_024),
    z.array(AdapterJsonValueSchema).max(256),
    z
      .record(z.string().min(1).max(128), AdapterJsonValueSchema)
      .superRefine((record, context) => {
        for (const key of Object.keys(record)) {
          if (forbiddenConfigKey.test(key)) {
            context.addIssue({
              code: "custom",
              path: [key],
              message: "configuration cannot contain executable fields",
            });
          }
        }
      }),
  ]),
);

export const AdapterConfigSchema = z
  .record(z.string().min(1).max(128), AdapterJsonValueSchema)
  .superRefine((record, context) => {
    for (const key of Object.keys(record)) {
      if (forbiddenConfigKey.test(key)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "configuration cannot contain executable fields",
        });
      }
    }
  });

export const AdapterSourceInputSchema = z
  .object({
    rootDir: RootPathSchema,
    include: z.array(PortablePathSchema).max(10_000).default(["."]),
    exclude: z.array(PortablePathSchema).max(10_000).default([]),
    revision: RevisionSchema.optional(),
  })
  .strict();

export const AdapterResourceLimitsSchema = z
  .object({
    maxFiles: z.number().int().positive().max(1_000_000).default(20_000),
    maxFileBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024)
      .default(2 * 1024 * 1024),
    maxSourceBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024 * 1024)
      .default(64 * 1024 * 1024),
    maxWallClockMs: z.number().int().positive().max(86_400_000).default(30_000),
  })
  .strict()
  .default({
    maxFiles: 20_000,
    maxFileBytes: 2 * 1024 * 1024,
    maxSourceBytes: 64 * 1024 * 1024,
    maxWallClockMs: 30_000,
  });

export const AdapterInputSchema = z
  .object({
    apiVersion: z.literal(ADAPTER_API_VERSION).default(ADAPTER_API_VERSION),
    source: AdapterSourceInputSchema,
    config: AdapterConfigSchema.default({}),
    resources: AdapterResourceLimitsSchema,
  })
  .strict();

export const AdapterOutputSchema = z
  .object({
    apiVersion: z.literal(ADAPTER_API_VERSION),
    graph: GraphSnapshotSchema,
    evidence: z.array(EvidenceSchema).max(100_000),
    diagnostics: z.array(DiagnosticSchema).max(100_000),
    capability: AdapterCapabilityManifestSchema,
  })
  .strict();

export type AdapterExecutionPolicy = z.infer<
  typeof AdapterExecutionPolicySchema
>;
export type AdapterCapabilityDeclaration = z.infer<
  typeof AdapterCapabilityDeclarationSchema
>;
export type AdapterCapabilityManifest = z.infer<
  typeof AdapterCapabilityManifestSchema
>;
export type AdapterSourceInput = z.infer<typeof AdapterSourceInputSchema>;
export type AdapterResourceLimits = z.infer<typeof AdapterResourceLimitsSchema>;
export type AdapterInput = z.infer<typeof AdapterInputSchema>;
export type AdapterOutput = z.infer<typeof AdapterOutputSchema>;
export type AdapterConfig = z.infer<typeof AdapterConfigSchema>;

export class AdapterValidationError extends Error {
  readonly code:
    | "invalid-input"
    | "invalid-manifest"
    | "invalid-output"
    | "manifest-mismatch";

  constructor(
    code:
      | "invalid-input"
      | "invalid-manifest"
      | "invalid-output"
      | "manifest-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "AdapterValidationError";
    this.code = code;
  }
}

const issueText = (issues: z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "adapter";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

export const parseAdapterManifest = (
  value: unknown,
): AdapterCapabilityManifest => {
  const parsed = AdapterCapabilityManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AdapterValidationError(
      "invalid-manifest",
      issueText(parsed.error.issues),
    );
  }
  return parsed.data;
};

export const parseAdapterInput = (value: unknown): AdapterInput => {
  const parsed = AdapterInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new AdapterValidationError(
      "invalid-input",
      issueText(parsed.error.issues),
    );
  }
  return parsed.data;
};

export const parseAdapterOutput = (value: unknown): AdapterOutput => {
  const parsed = AdapterOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new AdapterValidationError(
      "invalid-output",
      issueText(parsed.error.issues),
    );
  }
  return {
    ...parsed.data,
    graph: canonicalizeGraphSnapshot(parsed.data.graph),
  };
};

export interface CartographAdapter {
  readonly manifest: AdapterCapabilityManifest;
  analyze(input: AdapterInput): AdapterOutput;
}

export const runAdapter = (
  adapter: CartographAdapter,
  input: unknown,
): AdapterOutput => {
  const manifest = parseAdapterManifest(adapter.manifest);
  const parsedInput = parseAdapterInput(input);
  const output = parseAdapterOutput(adapter.analyze(parsedInput));
  const outputCapability = parseAdapterManifest(output.capability);
  if (
    outputCapability.id !== manifest.id ||
    outputCapability.version !== manifest.version
  ) {
    throw new AdapterValidationError(
      "manifest-mismatch",
      `adapter output capability ${outputCapability.id}@${outputCapability.version} does not match ${manifest.id}@${manifest.version}`,
    );
  }
  return output;
};

export const serializeAdapterManifest = (value: unknown): string =>
  stableStringify(parseAdapterManifest(value));

export const serializeAdapterInput = (value: unknown): string =>
  stableStringify(parseAdapterInput(value));

export const serializeAdapterOutput = (value: unknown): string =>
  stableStringify(parseAdapterOutput(value));

export type AdapterRevision = Revision;
export type AdapterEvidence = Evidence;
export type AdapterDiagnostic = Diagnostic;
