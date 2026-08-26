import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { z, ZodError } from "zod";

import {
  canonicalizeGraphSnapshot,
  GraphContractError,
  GraphValidationError,
  stableStringify,
} from "./canonical.js";
import { CAPABILITY_REGISTRY_VERSION } from "./capabilities.js";
import {
  EvidenceSchema,
  GraphEdgeSchema,
  GraphNodeSchema,
  GraphSnapshotSchema,
  DiagnosticSchema,
  RevisionSchema,
  SourceLocationSchema,
  type Diagnostic,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
} from "./schemas.js";

export const GRAPH_INTERCHANGE_SCHEMA_VERSION = 1 as const;
export const GRAPH_INTERCHANGE_CONTRACT =
  "cartograph.graph-interchange" as const;
export const GRAPH_INTERCHANGE_JSON_MEDIA_TYPE =
  "application/vnd.cartograph.graph-interchange+json" as const;
export const GRAPH_INTERCHANGE_JSON_LD_MEDIA_TYPE =
  "application/ld+json" as const;
export const GRAPH_INTERCHANGE_EDGE_LIST_MEDIA_TYPE =
  "application/vnd.cartograph.edge-list+json" as const;
export const GRAPH_INTERCHANGE_MAX_NODES = 100_000 as const;
export const GRAPH_INTERCHANGE_MAX_EDGES = 200_000 as const;
export const GRAPH_INTERCHANGE_MAX_DIAGNOSTICS = 50_000 as const;
export const GRAPH_INTERCHANGE_MAX_BYTES = 16 * 1024 * 1024;

const GRAPH_INTERCHANGE_JSON_LD_VOCABULARY =
  "https://github.com/AlisinaDevelo/CARTOGRAPH/graph-interchange#";

export const GRAPH_INTERCHANGE_JSON_LD_CONTEXT = {
  "@vocab": GRAPH_INTERCHANGE_JSON_LD_VOCABULARY,
  cartograph: GRAPH_INTERCHANGE_JSON_LD_VOCABULARY,
  from: { "@id": "cartograph:from", "@type": "@id" },
  to: { "@id": "cartograph:to", "@type": "@id" },
  nodeId: { "@id": "cartograph:nodeId", "@type": "@id" },
} as const;

const IdentifierSchema = z.string().trim().min(1).max(4_096);
const TextSchema = z.string().trim().min(1).max(16_384);
const DigestIdentifierSchema = z
  .string()
  .regex(/^cartograph:(?:snapshot|edge):sha256:[0-9a-f]{64}$/u);
const NodeKindSchema = z.enum([
  "endpoint",
  "module",
  "package",
  "service",
  "function",
  "database_table",
  "queue",
  "external_service",
  "file",
  "unknown",
]);
const EdgeKindSchema = z.enum([
  "calls",
  "imports",
  "reads",
  "writes",
  "publishes",
  "subscribes",
  "requests",
  "contains",
  "routes_to",
  "depends_on",
  "implements",
  "unknown",
]);
const ConfidenceSchema = z.enum([
  "certain",
  "inferred",
  "observed",
  "user_confirmed",
]);

const JsonLdContextSchema = z
  .object({
    "@vocab": z.literal(GRAPH_INTERCHANGE_JSON_LD_VOCABULARY),
    cartograph: z.literal(GRAPH_INTERCHANGE_JSON_LD_VOCABULARY),
    from: z
      .object({
        "@id": z.literal("cartograph:from"),
        "@type": z.literal("@id"),
      })
      .strict(),
    to: z
      .object({ "@id": z.literal("cartograph:to"), "@type": z.literal("@id") })
      .strict(),
    nodeId: z
      .object({
        "@id": z.literal("cartograph:nodeId"),
        "@type": z.literal("@id"),
      })
      .strict(),
  })
  .strict();

const JsonLdNodeSchema = z
  .object({
    "@id": IdentifierSchema,
    "@type": z.literal("cartograph:Node"),
    stableKey: IdentifierSchema,
    kind: NodeKindSchema,
    name: TextSchema,
    language: IdentifierSchema.optional(),
    location: SourceLocationSchema.optional(),
  })
  .strict();

const JsonLdEdgeSchema = z
  .object({
    "@id": DigestIdentifierSchema,
    "@type": z.literal("cartograph:Edge"),
    from: IdentifierSchema,
    to: IdentifierSchema,
    kind: EdgeKindSchema,
    confidence: ConfidenceSchema,
    evidence: z.array(EvidenceSchema),
    unresolvedReason: TextSchema.optional(),
  })
  .strict();

const JsonLdDiagnosticSchema = z
  .object({
    "@id": IdentifierSchema,
    "@type": z.literal("cartograph:Diagnostic"),
    code: IdentifierSchema,
    severity: z.enum(["info", "warning", "error"]),
    message: TextSchema,
    remediation: TextSchema.optional(),
    nodeId: IdentifierSchema.optional(),
    edge: z
      .object({
        from: IdentifierSchema,
        to: IdentifierSchema,
        kind: EdgeKindSchema,
      })
      .strict()
      .optional(),
    location: SourceLocationSchema.optional(),
    evidence: z.array(EvidenceSchema),
  })
  .strict();

export const GraphInterchangeJsonSchema = z
  .object({
    schemaVersion: z.literal(GRAPH_INTERCHANGE_SCHEMA_VERSION),
    contract: z.literal(GRAPH_INTERCHANGE_CONTRACT),
    mediaType: z.literal(GRAPH_INTERCHANGE_JSON_MEDIA_TYPE),
    format: z.literal("json"),
    snapshot: GraphSnapshotSchema,
  })
  .strict();

export const GraphInterchangeJsonLdSchema = z
  .object({
    "@context": JsonLdContextSchema,
    "@id": z.string().regex(/^cartograph:snapshot:sha256:[0-9a-f]{64}$/u),
    "@type": z.literal("cartograph:GraphSnapshot"),
    schemaVersion: z.literal(GRAPH_INTERCHANGE_SCHEMA_VERSION),
    contract: z.literal(GRAPH_INTERCHANGE_CONTRACT),
    mediaType: z.literal(GRAPH_INTERCHANGE_JSON_LD_MEDIA_TYPE),
    format: z.literal("json-ld"),
    capabilityRegistryVersion: z.literal(CAPABILITY_REGISTRY_VERSION),
    revision: RevisionSchema,
    nodes: z.array(JsonLdNodeSchema).max(GRAPH_INTERCHANGE_MAX_NODES),
    edges: z.array(JsonLdEdgeSchema).max(GRAPH_INTERCHANGE_MAX_EDGES),
    diagnostics: z
      .array(JsonLdDiagnosticSchema)
      .max(GRAPH_INTERCHANGE_MAX_DIAGNOSTICS),
  })
  .strict();

export const GraphInterchangeEdgeListMetaSchema = z
  .object({
    type: z.literal("meta"),
    schemaVersion: z.literal(GRAPH_INTERCHANGE_SCHEMA_VERSION),
    contract: z.literal(GRAPH_INTERCHANGE_CONTRACT),
    mediaType: z.literal(GRAPH_INTERCHANGE_EDGE_LIST_MEDIA_TYPE),
    format: z.literal("edge-list"),
    capabilityRegistryVersion: z.literal(CAPABILITY_REGISTRY_VERSION),
    revision: RevisionSchema,
  })
  .strict();

const GraphInterchangeEdgeListNodeSchema = z
  .object({ type: z.literal("node"), node: GraphNodeSchema })
  .strict();

const GraphInterchangeEdgeListEdgeSchema = z
  .object({ type: z.literal("edge"), edge: GraphEdgeSchema })
  .strict();

const GraphInterchangeEdgeListDiagnosticSchema = z
  .object({
    type: z.literal("diagnostic"),
    diagnostic: DiagnosticSchema,
  })
  .strict();

export const GraphInterchangeEdgeListLineSchema = z.discriminatedUnion("type", [
  GraphInterchangeEdgeListMetaSchema,
  GraphInterchangeEdgeListNodeSchema,
  GraphInterchangeEdgeListEdgeSchema,
  GraphInterchangeEdgeListDiagnosticSchema,
]);

export type GraphInterchangeFormat = "json" | "json-ld" | "edge-list";
export type GraphInterchangeJson = z.infer<typeof GraphInterchangeJsonSchema>;
export type GraphInterchangeJsonLd = z.infer<
  typeof GraphInterchangeJsonLdSchema
>;
export type GraphInterchangeEdgeListMeta = z.infer<
  typeof GraphInterchangeEdgeListMetaSchema
>;
export type GraphInterchangeEdgeListLine = z.infer<
  typeof GraphInterchangeEdgeListLineSchema
>;
export type GraphInterchangeErrorCode =
  "invalid-input" | "unsupported-format" | "resource-limit";

export class GraphInterchangeValidationError extends Error {
  readonly code: GraphInterchangeErrorCode;
  readonly format: GraphInterchangeFormat | undefined;
  readonly issues: readonly {
    readonly path: readonly (string | number)[];
    readonly message: string;
  }[];

  constructor(
    message: string,
    code: GraphInterchangeErrorCode = "invalid-input",
    format: GraphInterchangeFormat | undefined = undefined,
    issues: readonly {
      readonly path: readonly (string | number)[];
      readonly message: string;
    }[] = [],
  ) {
    super(message);
    this.name = "GraphInterchangeValidationError";
    this.code = code;
    this.format = format;
    this.issues = issues;
  }
}

const issueText = (
  issues: readonly {
    readonly path: readonly (string | number)[];
    readonly message: string;
  }[],
): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "document";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

const parseSchema = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
  format: GraphInterchangeFormat,
): T => {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => ({
        path: issue.path.map((part) =>
          typeof part === "symbol" ? part.toString() : part,
        ),
        message: issue.message,
      }));
      throw new GraphInterchangeValidationError(
        `${label} validation failed: ${issueText(issues)}`,
        "invalid-input",
        format,
        issues,
      );
    }
    throw error;
  }
};

const parseJsonInput = (
  input: unknown,
  format: GraphInterchangeFormat,
): unknown => {
  if (typeof input !== "string") return input;
  assertSerializedSize(input, format);
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    throw new GraphInterchangeValidationError(
      `${format} interchange JSON is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "invalid-input",
      format,
    );
  }
};

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const snapshotIdentifier = (snapshot: GraphSnapshot): string =>
  `cartograph:snapshot:sha256:${digest(stableStringify(snapshot))}`;

const edgeIdentifier = (
  edge: Pick<GraphEdge, "from" | "to" | "kind">,
): string =>
  `cartograph:edge:sha256:${digest(
    stableStringify([edge.from, edge.kind, edge.to]),
  )}`;

const assertSnapshotLimits = (
  snapshot: GraphSnapshot,
  format: GraphInterchangeFormat,
): void => {
  const limits = [
    [snapshot.nodes.length, GRAPH_INTERCHANGE_MAX_NODES, "nodes"],
    [snapshot.edges.length, GRAPH_INTERCHANGE_MAX_EDGES, "edges"],
    [
      snapshot.diagnostics.length,
      GRAPH_INTERCHANGE_MAX_DIAGNOSTICS,
      "diagnostics",
    ],
  ] as const;
  for (const [count, maximum, label] of limits) {
    if (count > maximum) {
      throw new GraphInterchangeValidationError(
        `${format} interchange exceeds the ${maximum.toLocaleString("en-US")} ${label} limit`,
        "resource-limit",
        format,
      );
    }
  }
};

const assertSerializedSize = (
  value: string,
  format: GraphInterchangeFormat,
): void => {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > GRAPH_INTERCHANGE_MAX_BYTES) {
    throw new GraphInterchangeValidationError(
      `${format} interchange exceeds the ${(GRAPH_INTERCHANGE_MAX_BYTES / (1024 * 1024)).toLocaleString("en-US")} MiB output limit`,
      "resource-limit",
      format,
    );
  }
};

const canonicalizeForInterchange = (
  input: unknown,
  format: GraphInterchangeFormat,
): GraphSnapshot => {
  try {
    const snapshot = canonicalizeGraphSnapshot(input);
    assertSnapshotLimits(snapshot, format);
    return snapshot;
  } catch (error) {
    if (error instanceof GraphInterchangeValidationError) throw error;
    if (
      error instanceof GraphValidationError ||
      error instanceof GraphContractError
    ) {
      throw new GraphInterchangeValidationError(
        error.message,
        "invalid-input",
        format,
      );
    }
    throw error;
  }
};

export const createGraphInterchangeJson = (
  snapshotInput: unknown,
): GraphInterchangeJson => {
  const snapshot = canonicalizeForInterchange(snapshotInput, "json");
  return {
    schemaVersion: GRAPH_INTERCHANGE_SCHEMA_VERSION,
    contract: GRAPH_INTERCHANGE_CONTRACT,
    mediaType: GRAPH_INTERCHANGE_JSON_MEDIA_TYPE,
    format: "json",
    snapshot,
  };
};

export const serializeGraphInterchangeJson = (
  snapshotInput: unknown,
): string => {
  const serialized = stableStringify(createGraphInterchangeJson(snapshotInput));
  assertSerializedSize(serialized, "json");
  return serialized;
};

export const parseGraphInterchangeJson = (input: unknown): GraphSnapshot => {
  const envelope = parseSchema(
    GraphInterchangeJsonSchema,
    parseJsonInput(input, "json"),
    "graph interchange JSON",
    "json",
  );
  return canonicalizeForInterchange(envelope.snapshot, "json");
};

const withoutJsonLdMetadata = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const result = { ...value };
  delete result["@id"];
  delete result["@type"];
  return result;
};

const jsonLdNode = (node: GraphNode): Record<string, unknown> => {
  const { id, ...body } = node;
  return { "@id": id, "@type": "cartograph:Node", ...body };
};

const jsonLdEdge = (edge: GraphEdge): Record<string, unknown> => ({
  "@id": edgeIdentifier(edge),
  "@type": "cartograph:Edge",
  from: edge.from,
  to: edge.to,
  kind: edge.kind,
  confidence: edge.confidence,
  evidence: edge.evidence,
  ...(edge.unresolvedReason === undefined
    ? {}
    : { unresolvedReason: edge.unresolvedReason }),
});

const jsonLdDiagnostic = (diagnostic: Diagnostic): Record<string, unknown> => {
  const { id, ...body } = diagnostic;
  return { "@id": id, "@type": "cartograph:Diagnostic", ...body };
};

export const createGraphInterchangeJsonLd = (
  snapshotInput: unknown,
): GraphInterchangeJsonLd => {
  const snapshot = canonicalizeForInterchange(snapshotInput, "json-ld");
  const document = {
    "@context": GRAPH_INTERCHANGE_JSON_LD_CONTEXT,
    "@id": snapshotIdentifier(snapshot),
    "@type": "cartograph:GraphSnapshot",
    schemaVersion: GRAPH_INTERCHANGE_SCHEMA_VERSION,
    contract: GRAPH_INTERCHANGE_CONTRACT,
    mediaType: GRAPH_INTERCHANGE_JSON_LD_MEDIA_TYPE,
    format: "json-ld",
    capabilityRegistryVersion: snapshot.capabilityRegistryVersion,
    revision: snapshot.revision,
    nodes: snapshot.nodes.map(jsonLdNode),
    edges: snapshot.edges.map(jsonLdEdge),
    diagnostics: snapshot.diagnostics.map(jsonLdDiagnostic),
  };
  return parseSchema(
    GraphInterchangeJsonLdSchema,
    document,
    "graph interchange JSON-LD",
    "json-ld",
  );
};

export const serializeGraphInterchangeJsonLd = (
  snapshotInput: unknown,
): string => {
  const serialized = stableStringify(
    createGraphInterchangeJsonLd(snapshotInput),
  );
  assertSerializedSize(serialized, "json-ld");
  return serialized;
};

export const parseGraphInterchangeJsonLd = (input: unknown): GraphSnapshot => {
  const document = parseSchema(
    GraphInterchangeJsonLdSchema,
    parseJsonInput(input, "json-ld"),
    "graph interchange JSON-LD",
    "json-ld",
  );
  const nodes = document.nodes.map((node) => ({
    ...withoutJsonLdMetadata(node),
    id: node["@id"],
  }));
  const edges = document.edges.map((edge) => {
    const candidate = {
      ...withoutJsonLdMetadata(edge),
    } as GraphEdge;
    if (edge["@id"] !== edgeIdentifier(candidate)) {
      throw new GraphInterchangeValidationError(
        `graph interchange JSON-LD edge identity does not match ${edge.from}|${edge.kind}|${edge.to}`,
        "invalid-input",
        "json-ld",
      );
    }
    return candidate;
  });
  const diagnostics = document.diagnostics.map((diagnostic) => ({
    ...withoutJsonLdMetadata(diagnostic),
    id: diagnostic["@id"],
  }));
  const snapshot = canonicalizeForInterchange(
    {
      schemaVersion: document.schemaVersion,
      capabilityRegistryVersion: document.capabilityRegistryVersion,
      revision: document.revision,
      nodes,
      edges,
      diagnostics,
    },
    "json-ld",
  );
  if (document["@id"] !== snapshotIdentifier(snapshot)) {
    throw new GraphInterchangeValidationError(
      "graph interchange JSON-LD snapshot identity digest does not match its records",
      "invalid-input",
      "json-ld",
    );
  }
  return snapshot;
};

export const createGraphInterchangeEdgeList = (
  snapshotInput: unknown,
): GraphInterchangeEdgeListLine[] => {
  const snapshot = canonicalizeForInterchange(snapshotInput, "edge-list");
  return [
    {
      type: "meta",
      schemaVersion: GRAPH_INTERCHANGE_SCHEMA_VERSION,
      contract: GRAPH_INTERCHANGE_CONTRACT,
      mediaType: GRAPH_INTERCHANGE_EDGE_LIST_MEDIA_TYPE,
      format: "edge-list",
      capabilityRegistryVersion: snapshot.capabilityRegistryVersion,
      revision: snapshot.revision,
    },
    ...snapshot.nodes.map((node) => ({ type: "node" as const, node })),
    ...snapshot.edges.map((edge) => ({ type: "edge" as const, edge })),
    ...snapshot.diagnostics.map((diagnostic) => ({
      type: "diagnostic" as const,
      diagnostic,
    })),
  ];
};

export const serializeGraphInterchangeEdgeList = (
  snapshotInput: unknown,
): string => {
  const serialized = `${createGraphInterchangeEdgeList(snapshotInput)
    .map((line) => stableStringify(line))
    .join("\n")}\n`;
  assertSerializedSize(serialized, "edge-list");
  return serialized;
};

export const parseGraphInterchangeEdgeList = (
  input: unknown,
): GraphSnapshot => {
  if (typeof input !== "string") {
    throw new GraphInterchangeValidationError(
      "graph interchange edge-list input must be UTF-8 text",
      "invalid-input",
      "edge-list",
    );
  }
  assertSerializedSize(input, "edge-list");
  const normalized = input.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) {
    throw new GraphInterchangeValidationError(
      "graph interchange edge-list contains unsupported carriage returns",
      "invalid-input",
      "edge-list",
    );
  }
  if (!normalized.endsWith("\n")) {
    throw new GraphInterchangeValidationError(
      "graph interchange edge-list must end with a newline",
      "invalid-input",
      "edge-list",
    );
  }
  const rawLines = normalized.slice(0, -1).split("\n");
  if (rawLines.length === 0 || rawLines.some((line) => line.length === 0)) {
    throw new GraphInterchangeValidationError(
      "graph interchange edge-list contains an empty record",
      "invalid-input",
      "edge-list",
    );
  }
  const lines = rawLines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new GraphInterchangeValidationError(
        `graph interchange edge-list record ${index + 1} is invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "invalid-input",
        "edge-list",
      );
    }
    return parseSchema(
      GraphInterchangeEdgeListLineSchema,
      value,
      `graph interchange edge-list record ${index + 1}`,
      "edge-list",
    );
  });
  const first = lines[0];
  if (!first || first.type !== "meta") {
    throw new GraphInterchangeValidationError(
      "graph interchange edge-list must begin with one meta record",
      "invalid-input",
      "edge-list",
    );
  }
  const metaCount = lines.filter((line) => line.type === "meta").length;
  if (metaCount !== 1) {
    throw new GraphInterchangeValidationError(
      "graph interchange edge-list must contain exactly one meta record",
      "invalid-input",
      "edge-list",
    );
  }
  const snapshot = canonicalizeForInterchange(
    {
      schemaVersion: first.schemaVersion,
      capabilityRegistryVersion: first.capabilityRegistryVersion,
      revision: first.revision,
      nodes: lines
        .filter(
          (
            line,
          ): line is Extract<GraphInterchangeEdgeListLine, { type: "node" }> =>
            line.type === "node",
        )
        .map((line) => line.node),
      edges: lines
        .filter(
          (
            line,
          ): line is Extract<GraphInterchangeEdgeListLine, { type: "edge" }> =>
            line.type === "edge",
        )
        .map((line) => line.edge),
      diagnostics: lines
        .filter(
          (
            line,
          ): line is Extract<
            GraphInterchangeEdgeListLine,
            { type: "diagnostic" }
          > => line.type === "diagnostic",
        )
        .map((line) => line.diagnostic),
    },
    "edge-list",
  );
  return snapshot;
};

export const serializeGraphInterchange = (
  snapshotInput: unknown,
  format: GraphInterchangeFormat,
): string => {
  switch (format) {
    case "json":
      return serializeGraphInterchangeJson(snapshotInput);
    case "json-ld":
      return serializeGraphInterchangeJsonLd(snapshotInput);
    case "edge-list":
      return serializeGraphInterchangeEdgeList(snapshotInput);
    default:
      throw new GraphInterchangeValidationError(
        `unsupported graph interchange format: ${String(format)}`,
        "unsupported-format",
      );
  }
};

export const parseGraphInterchange = (
  input: unknown,
  format: GraphInterchangeFormat,
): GraphSnapshot => {
  switch (format) {
    case "json":
      return parseGraphInterchangeJson(input);
    case "json-ld":
      return parseGraphInterchangeJsonLd(input);
    case "edge-list":
      return parseGraphInterchangeEdgeList(input);
    default:
      throw new GraphInterchangeValidationError(
        `unsupported graph interchange format: ${String(format)}`,
        "unsupported-format",
      );
  }
};
