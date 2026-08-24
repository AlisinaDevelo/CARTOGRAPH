import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { z } from "zod";

export const CARTOGRAPH_CONFIG_SCHEMA_VERSION = 1 as const;
export const CONFIG_MAX_BYTES = 1024 * 1024;

const portablePattern = (value: string): string | undefined => {
  const normalized = value.replaceAll("\\", "/").trim();
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    normalized.startsWith("//") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(normalized)
  ) {
    return undefined;
  }

  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) return undefined;
  const compact = parts.filter((part) => part.length > 0 && part !== ".");
  return compact.length === 0 ? "." : compact.join("/");
};

const ConfigPathSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, context) => {
    const normalized = portablePattern(value);
    if (!normalized) {
      context.addIssue({
        code: "custom",
        message: "must be a repository-relative path or pattern",
      });
      return z.NEVER;
    }
    return normalized;
  });

const ResourceLimitsSchema = z
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
    maxArchiveBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024 * 1024)
      .default(64 * 1024 * 1024),
    maxMemoryBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024 * 1024)
      .default(1024 * 1024 * 1024),
    maxWallClockMs: z.number().int().positive().max(86_400_000).default(30_000),
    maxReportItems: z.number().int().positive().max(1_000_000).default(10_000),
  })
  .strict()
  .default({
    maxFiles: 20_000,
    maxFileBytes: 2 * 1024 * 1024,
    maxSourceBytes: 64 * 1024 * 1024,
    maxArchiveBytes: 64 * 1024 * 1024,
    maxMemoryBytes: 1024 * 1024 * 1024,
    maxWallClockMs: 30_000,
    maxReportItems: 10_000,
  });

const OutputSchema = z
  .object({
    mode: z.enum(["snapshot", "diff"]).default("snapshot"),
    format: z.enum(["json", "markdown", "html"]).default("json"),
  })
  .strict()
  .default({ mode: "snapshot", format: "json" });

const CartographConfigInputSchema = z
  .object({
    schemaVersion: z
      .literal(CARTOGRAPH_CONFIG_SCHEMA_VERSION)
      .default(CARTOGRAPH_CONFIG_SCHEMA_VERSION),
    include: z.array(ConfigPathSchema).min(1).default(["."]),
    exclude: z.array(ConfigPathSchema).default([]),
    tsconfigPath: ConfigPathSchema.optional(),
    extractors: z
      .array(z.enum(["typescript", "express"]))
      .min(1)
      .refine(
        (values) => new Set(values).size === values.length,
        "must not contain duplicate extractors",
      )
      .default(["typescript", "express"]),
    output: OutputSchema,
    resources: ResourceLimitsSchema,
    policyRefs: z.array(ConfigPathSchema).default([]),
    unknownFields: z.enum(["error", "warn"]).default("error"),
  })
  .strict();

export const CartographConfigSchema = CartographConfigInputSchema;

export type CartographConfig = z.infer<typeof CartographConfigSchema>;
export type ResourceLimits = CartographConfig["resources"];
export type ConfigUnknownFieldMode = CartographConfig["unknownFields"];

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

type Shape = { readonly [key: string]: Shape | null };

const CONFIG_SHAPE: Shape = {
  schemaVersion: null,
  include: null,
  exclude: null,
  tsconfigPath: null,
  extractors: null,
  output: { mode: null, format: null },
  resources: {
    maxFiles: null,
    maxFileBytes: null,
    maxSourceBytes: null,
    maxArchiveBytes: null,
    maxMemoryBytes: null,
    maxWallClockMs: null,
    maxReportItems: null,
  },
  policyRefs: null,
  unknownFields: null,
};

const collectUnknownFields = (
  value: unknown,
  shape: Shape,
  prefix = "",
): string[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const unknown: string[] = [];
  for (const [key, child] of Object.entries(record)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (!(key in shape)) {
      unknown.push(path);
      continue;
    }
    const childShape = shape[key];
    if (childShape)
      unknown.push(...collectUnknownFields(child, childShape, path));
  }
  return unknown;
};

const stripUnknownFields = (value: unknown, shape: Shape): unknown => {
  if (Array.isArray(value))
    return value.map((item) => stripUnknownFields(item, {}));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key in shape)
      .map(([key, child]) => {
        const childShape = shape[key];
        return [
          key,
          childShape ? stripUnknownFields(child, childShape) : child,
        ];
      }),
  );
};

const issueText = (issues: z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "config";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

export type ParsedCartographConfig = {
  config: CartographConfig;
  warnings: string[];
};

export const parseCartographConfig = (
  value: unknown,
): ParsedCartographConfig => {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const requestedMode: ConfigUnknownFieldMode =
    record?.unknownFields === "warn" ? "warn" : "error";
  const unknown = collectUnknownFields(value, CONFIG_SHAPE);
  if (unknown.length > 0 && requestedMode === "error") {
    throw new ConfigValidationError(
      `unknown configuration field(s): ${unknown.sort().join(", ")}; set unknownFields to "warn" to continue with warnings`,
    );
  }

  const candidate =
    requestedMode === "warn" ? stripUnknownFields(value, CONFIG_SHAPE) : value;
  const parsed = CartographConfigSchema.safeParse(candidate);
  if (!parsed.success)
    throw new ConfigValidationError(issueText(parsed.error.issues));
  return {
    config: parsed.data,
    warnings: unknown
      .sort()
      .map((field) => `ignored unknown configuration field: ${field}`),
  };
};

const containedPath = (
  root: string,
  candidate: string,
  label: string,
): string => {
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(resolve(realRoot, candidate));
  const relativePath = relative(realRoot, realCandidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  ) {
    throw new ConfigValidationError(
      `${label} must stay inside the analyzed repository`,
    );
  }
  return realCandidate;
};

export const readCartographConfig = (
  root: string,
  configPath: string,
): ParsedCartographConfig => {
  const inputPath = containedPath(root, configPath, "config");
  const metadata = lstatSync(inputPath);
  if (!metadata.isFile())
    throw new ConfigValidationError(
      `config is not a regular file: ${configPath}`,
    );
  if (metadata.size > CONFIG_MAX_BYTES)
    throw new ConfigValidationError(
      `config exceeds the 1 MiB input limit: ${configPath}`,
    );
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new ConfigValidationError(
      `could not parse config ${configPath}: ${detail}`,
    );
  }
  return parseCartographConfig(value);
};

export const defaultCartographConfig = (): CartographConfig =>
  parseCartographConfig({}).config;
