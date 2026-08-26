import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { z, ZodError } from "zod";

import { canonicalizeGraphSnapshot, stableStringify } from "./canonical.js";
import { CAPABILITY_REGISTRY_VERSION } from "./capabilities.js";
import {
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
} from "./schemas.js";

export const SCIP_INTERCHANGE_SCHEMA_VERSION = 1 as const;
export const SCIP_INTERCHANGE_CONTRACT = "cartograph.scip-interchange" as const;
export const SCIP_INTERCHANGE_MEDIA_TYPE =
  "application/vnd.cartograph.scip-interchange+json" as const;
export const SCIP_INTERCHANGE_MAX_DOCUMENTS = 256 as const;
export const SCIP_INTERCHANGE_MAX_SYMBOLS = 20_000 as const;
export const SCIP_INTERCHANGE_MAX_OCCURRENCES = 100_000 as const;
export const SCIP_INTERCHANGE_MAX_RELATIONSHIPS = 50_000 as const;

const TextSchema = z.string().trim().min(1).max(4_096);
const SymbolTextSchema = z.string().trim().min(1).max(8_192);
const StableKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.startsWith("/") &&
      !value.startsWith("~") &&
      !/^file:/iu.test(value),
    "must be a portable canonical reference",
  );
const EvidenceReferenceSchema = TextSchema.refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !/^file:/iu.test(value) &&
    !value.includes("\0"),
  "must be a portable evidence reference",
);
const RelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .transform((value, context) => {
    const normalized = value.normalize("NFC").replaceAll("\\", "/");
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
    return compact.length > 0 ? compact.join("/") : z.NEVER;
  });
const ProtocolVersionSchema = z.number().int().min(0).max(255);
const RangeSchema = z
  .array(z.number().int().nonnegative())
  .refine((range) => range.length === 3 || range.length === 4, {
    message: "must contain three or four half-open range values",
  })
  .superRefine((range, context) => {
    const endLine = range.length === 3 ? range[0] : range[2];
    const startLine = range[0];
    const startCharacter = range[1];
    const endCharacter = range.length === 3 ? range[2] : range[3];
    if (
      endLine === undefined ||
      startLine === undefined ||
      startCharacter === undefined ||
      endCharacter === undefined ||
      endLine < startLine ||
      (endLine === startLine && endCharacter < startCharacter)
    ) {
      context.addIssue({
        code: "custom",
        message: "range must be ordered and half-open",
      });
    }
  });

export const ScipToolInfoSchema = z
  .object({
    name: TextSchema,
    version: TextSchema,
    arguments: z.array(TextSchema).max(128).default([]),
  })
  .strict();

export const ScipMetadataSchema = z
  .object({
    version: ProtocolVersionSchema,
    toolInfo: ScipToolInfoSchema,
    projectRoot: z
      .string()
      .trim()
      .min(1)
      .max(2_048)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.startsWith("~") &&
          !/^file:/iu.test(value) &&
          !value.includes("\0"),
        "absolute project roots and file URIs are not accepted",
      )
      .optional(),
    textDocumentEncoding: z.enum(["UTF8", "UTF16", "UTF32"]).default("UTF8"),
  })
  .strict();

export const ScipRelationshipSchema = z
  .object({
    symbol: SymbolTextSchema,
    isDefinition: z.boolean().default(false),
    isImplementation: z.boolean().default(false),
    isTypeDefinition: z.boolean().default(false),
    isReference: z.boolean().default(false),
    isExternalOverride: z.boolean().default(false),
    cartographEvidenceRefs: z
      .array(EvidenceReferenceSchema)
      .max(64)
      .default([]),
  })
  .strict();

export const ScipSymbolInformationSchema = z
  .object({
    symbol: SymbolTextSchema,
    kind: TextSchema,
    documentation: z.array(TextSchema).max(64).default([]),
    relationships: z
      .array(ScipRelationshipSchema)
      .max(SCIP_INTERCHANGE_MAX_RELATIONSHIPS),
    cartographStableKey: StableKeySchema.optional(),
  })
  .strict();

export const ScipOccurrenceSchema = z
  .object({
    symbol: SymbolTextSchema.optional(),
    range: RangeSchema,
    symbolRoles: z.number().int().nonnegative().max(0xffff).default(0),
    enclosingRange: RangeSchema.optional(),
    cartographEvidenceRefs: z
      .array(EvidenceReferenceSchema)
      .max(64)
      .default([]),
  })
  .strict();

export const ScipDocumentSchema = z
  .object({
    relativePath: RelativePathSchema,
    language: TextSchema.optional(),
    occurrences: z
      .array(ScipOccurrenceSchema)
      .max(SCIP_INTERCHANGE_MAX_OCCURRENCES),
    symbols: z
      .array(ScipSymbolInformationSchema)
      .max(SCIP_INTERCHANGE_MAX_SYMBOLS),
    cartographStableKey: StableKeySchema.optional(),
  })
  .strict();

export const ScipIndexSchema = z
  .object({
    metadata: ScipMetadataSchema,
    documents: z
      .array(ScipDocumentSchema)
      .min(1)
      .max(SCIP_INTERCHANGE_MAX_DOCUMENTS),
    externalSymbols: z
      .array(ScipSymbolInformationSchema)
      .max(SCIP_INTERCHANGE_MAX_SYMBOLS)
      .default([]),
  })
  .strict()
  .superRefine((index, context) => {
    const documentPaths = new Set<string>();
    const symbolNames = new Set<string>();
    let occurrenceCount = 0;
    let relationshipCount = 0;
    for (const [documentIndex, document] of index.documents.entries()) {
      if (documentPaths.has(document.relativePath)) {
        context.addIssue({
          code: "custom",
          path: ["documents", documentIndex, "relativePath"],
          message: `duplicate document path: ${document.relativePath}`,
        });
      }
      documentPaths.add(document.relativePath);
      occurrenceCount += document.occurrences.length;
      for (const symbol of document.symbols) {
        if (symbolNames.has(symbol.symbol)) {
          context.addIssue({
            code: "custom",
            path: ["documents", documentIndex, "symbols"],
            message: `duplicate symbol declaration: ${symbol.symbol}`,
          });
        }
        symbolNames.add(symbol.symbol);
        relationshipCount += symbol.relationships.length;
      }
    }
    for (const symbol of index.externalSymbols) {
      if (symbolNames.has(symbol.symbol)) {
        context.addIssue({
          code: "custom",
          path: ["externalSymbols"],
          message: `duplicate external symbol declaration: ${symbol.symbol}`,
        });
      }
      symbolNames.add(symbol.symbol);
      relationshipCount += symbol.relationships.length;
    }
    if (occurrenceCount > SCIP_INTERCHANGE_MAX_OCCURRENCES) {
      context.addIssue({
        code: "custom",
        path: ["documents"],
        message: `occurrences exceed the ${SCIP_INTERCHANGE_MAX_OCCURRENCES} record ceiling`,
      });
    }
    if (relationshipCount > SCIP_INTERCHANGE_MAX_RELATIONSHIPS) {
      context.addIssue({
        code: "custom",
        path: ["documents"],
        message: `relationships exceed the ${SCIP_INTERCHANGE_MAX_RELATIONSHIPS} record ceiling`,
      });
    }
  });

export const ScipProvenanceSchema = z
  .object({
    protocolVersion: ProtocolVersionSchema,
    toolName: TextSchema,
    toolVersion: TextSchema,
    graphSchemaVersion: z.literal(1),
    capabilityRegistryVersion: z.literal(CAPABILITY_REGISTRY_VERSION),
    sourceBodiesIncluded: z.literal(false),
  })
  .strict();

export const ScipUnsupportedFieldSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^SCIP_[A-Z0-9_]+$/u),
    path: TextSchema,
    detail: TextSchema,
    preservedAs: TextSchema.optional(),
  })
  .strict();

export const ScipSymbolMappingSchema = z
  .object({
    scipSymbol: SymbolTextSchema,
    stableKey: StableKeySchema,
    canonicalKind: z.string().trim().min(1).max(64),
    external: z.boolean(),
  })
  .strict();

export const ScipDocumentMappingSchema = z
  .object({
    relativePath: RelativePathSchema,
    stableKey: StableKeySchema,
  })
  .strict();

export const ScipRelationshipMappingSchema = z
  .object({
    fromSymbol: SymbolTextSchema,
    toSymbol: SymbolTextSchema,
    edgeKind: z.string().trim().min(1).max(64),
    evidenceRefs: z.array(TextSchema).max(64),
  })
  .strict();

export const ScipMappingsSchema = z
  .object({
    documents: z.array(ScipDocumentMappingSchema),
    symbols: z.array(ScipSymbolMappingSchema),
    relationships: z.array(ScipRelationshipMappingSchema),
  })
  .strict();

export const ScipInterchangeReportSchema = z
  .object({
    schemaVersion: z.literal(SCIP_INTERCHANGE_SCHEMA_VERSION),
    contract: z.literal(SCIP_INTERCHANGE_CONTRACT),
    mediaType: z.literal(SCIP_INTERCHANGE_MEDIA_TYPE),
    direction: z.enum(["import", "export"]),
    provenance: ScipProvenanceSchema,
    mappings: ScipMappingsSchema,
    unsupported: z.array(ScipUnsupportedFieldSchema),
  })
  .strict();

export type ScipToolInfo = z.infer<typeof ScipToolInfoSchema>;
export type ScipMetadata = z.infer<typeof ScipMetadataSchema>;
export type ScipRelationship = z.infer<typeof ScipRelationshipSchema>;
export type ScipSymbolInformation = z.infer<typeof ScipSymbolInformationSchema>;
export type ScipOccurrence = z.infer<typeof ScipOccurrenceSchema>;
export type ScipDocument = z.infer<typeof ScipDocumentSchema>;
export type ScipIndex = z.infer<typeof ScipIndexSchema>;
export type ScipProvenance = z.infer<typeof ScipProvenanceSchema>;
export type ScipUnsupportedField = z.infer<typeof ScipUnsupportedFieldSchema>;
export type ScipMappings = z.infer<typeof ScipMappingsSchema>;
export type ScipInterchangeReport = z.infer<typeof ScipInterchangeReportSchema>;

export type ScipImportResult = ScipInterchangeReport & {
  readonly direction: "import";
  readonly snapshot: GraphSnapshot;
};

export type ScipExportOptions = {
  readonly toolName: string;
  readonly toolVersion: string;
  readonly protocolVersion?: number;
  readonly projectRoot?: string;
};

export type ScipExportResult = ScipInterchangeReport & {
  readonly direction: "export";
  readonly index: ScipIndex;
};

export class ScipInterchangeValidationError extends Error {
  readonly issues: readonly z.ZodIssue[];

  constructor(message: string, issues: readonly z.ZodIssue[] = []) {
    super(message);
    this.name = "ScipInterchangeValidationError";
    this.issues = issues;
  }
}

const issueText = (issues: readonly z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "index";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

const parseWith = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T => {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ScipInterchangeValidationError(
        `${label} validation failed: ${issueText(error.issues)}`,
        error.issues,
      );
    }
    throw error;
  }
};

export const parseScipIndex = (value: unknown): ScipIndex =>
  parseWith(ScipIndexSchema, value, "SCIP index");

export const serializeScipIndex = (value: unknown): string =>
  stableStringify(parseScipIndex(value));

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const token = (prefix: string, value: string): string =>
  `${prefix}${digest(value).slice(0, 32)}`;

const encodeStableKey = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64url");

const exportedSymbol = (stableKey: string): string =>
  `local cartograph_${encodeStableKey(stableKey)}`;

const nodeKindForScip = (kind: string): GraphNode["kind"] => {
  switch (kind.trim().toLowerCase()) {
    case "file":
      return "file";
    case "namespace":
    case "package":
    case "module":
      return "package";
    case "function":
    case "method":
    case "constructor":
    case "accessor":
      return "function";
    case "class":
    case "interface":
    case "struct":
    case "enum":
    case "type":
      return "module";
    default:
      return "unknown";
  }
};

const scipKindForNode = (kind: GraphNode["kind"]): string => {
  switch (kind) {
    case "file":
      return "File";
    case "package":
      return "Package";
    case "module":
      return "Namespace";
    case "function":
      return "Function";
    case "service":
      return "Service";
    case "endpoint":
      return "Method";
    case "database_table":
      return "Type";
    case "queue":
      return "Event";
    case "external_service":
      return "Package";
    default:
      return "UnspecifiedKind";
  }
};

const relationshipKind = (relationship: ScipRelationship): GraphEdge["kind"] =>
  relationship.isImplementation
    ? "implements"
    : relationship.isTypeDefinition
      ? "contains"
      : "depends_on";

const roleKinds = (roles: number): GraphEdge["kind"][] => {
  const kinds: GraphEdge["kind"][] = [];
  if ((roles & 0x1) !== 0) kinds.push("contains");
  if ((roles & 0x2) !== 0) kinds.push("depends_on");
  if ((roles & 0x4) !== 0) kinds.push("writes");
  if ((roles & 0x8) !== 0) kinds.push("reads");
  return kinds.length > 0 ? kinds : ["depends_on"];
};

const evidenceFor = (
  reference: string,
  protocolVersion: number,
  salt: string,
): Evidence => ({
  kind: "user",
  id: token("scip:evidence:", `${protocolVersion}\0${salt}\0${reference}`),
  reference,
  revision: `scip-protocol-${protocolVersion}`,
});

const provenanceFor = (metadata: ScipMetadata): ScipProvenance => ({
  protocolVersion: metadata.version,
  toolName: metadata.toolInfo.name,
  toolVersion: metadata.toolInfo.version,
  graphSchemaVersion: 1,
  capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
  sourceBodiesIncluded: false,
});

const unsupported = (
  records: ScipUnsupportedField[],
  code: string,
  path: string,
  detail: string,
  preservedAs?: string,
): void => {
  const record: ScipUnsupportedField = {
    code,
    path,
    detail,
    ...(preservedAs === undefined ? {} : { preservedAs }),
  };
  if (
    !records.some(
      (existing) =>
        existing.code === record.code &&
        existing.path === record.path &&
        existing.detail === record.detail,
    )
  )
    records.push(record);
};

const canonicalizeMappings = (mappings: ScipMappings): ScipMappings => ({
  documents: [...mappings.documents].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  ),
  symbols: [...mappings.symbols].sort((left, right) =>
    left.scipSymbol.localeCompare(right.scipSymbol),
  ),
  relationships: [...mappings.relationships].sort((left, right) =>
    stableStringify(left).localeCompare(stableStringify(right)),
  ),
});

const canonicalizeUnsupported = (
  records: readonly ScipUnsupportedField[],
): ScipUnsupportedField[] =>
  [...records].sort((left, right) =>
    stableStringify(left).localeCompare(stableStringify(right)),
  );

export const importScipIndex = (value: unknown): ScipImportResult => {
  const index = parseScipIndex(value);
  const provenance = provenanceFor(index.metadata);
  const unsupportedFields: ScipUnsupportedField[] = [];
  const nodes: GraphNode[] = [];
  const edges = new Map<string, GraphEdge>();
  const mappings: ScipMappings = {
    documents: [],
    symbols: [],
    relationships: [],
  };
  const symbolNodes = new Map<string, GraphNode>();
  const documentNodes = new Map<string, GraphNode>();
  const allSymbols = [
    ...index.documents.flatMap((document) => document.symbols),
    ...index.externalSymbols,
  ];

  for (const document of index.documents) {
    const stableKey =
      document.cartographStableKey ?? `scip:document:${document.relativePath}`;
    const node: GraphNode = {
      id: stableKey,
      stableKey,
      kind: "module",
      name: document.relativePath,
      ...(document.language === undefined
        ? {}
        : { language: document.language }),
      location: { path: document.relativePath, line: 1, column: 1 },
    };
    nodes.push(node);
    documentNodes.set(document.relativePath, node);
    mappings.documents.push({ relativePath: document.relativePath, stableKey });
  }

  for (const symbol of allSymbols) {
    const stableKey =
      symbol.cartographStableKey ?? `scip:symbol:${digest(symbol.symbol)}`;
    const external = index.externalSymbols.some(
      (candidate) => candidate.symbol === symbol.symbol,
    );
    const node: GraphNode = {
      id: stableKey,
      stableKey,
      kind: external ? "external_service" : nodeKindForScip(symbol.kind),
      name: symbol.symbol,
    };
    nodes.push(node);
    symbolNodes.set(symbol.symbol, node);
    mappings.symbols.push({
      scipSymbol: symbol.symbol,
      stableKey,
      canonicalKind: node.kind,
      external,
    });
    if (symbol.documentation.length > 0) {
      unsupported(
        unsupportedFields,
        "SCIP_SYMBOL_DOCUMENTATION",
        `symbols[${symbol.symbol}].documentation`,
        "SCIP documentation has no GraphSnapshot field",
        "report-only-unsupported-field",
      );
    }
  }

  const addEdge = (
    from: GraphNode,
    to: GraphNode,
    kind: GraphEdge["kind"],
    evidence: Evidence,
  ): void => {
    const key = `${from.id}\0${to.id}\0${kind}`;
    const existing = edges.get(key);
    if (existing) {
      if (!existing.evidence.some((candidate) => candidate.id === evidence.id))
        existing.evidence.push(evidence);
      return;
    }
    edges.set(key, {
      from: from.id,
      to: to.id,
      kind,
      confidence: "observed",
      evidence: [evidence],
    });
  };

  for (const [documentIndex, document] of index.documents.entries()) {
    const documentNode = documentNodes.get(document.relativePath);
    if (!documentNode) continue;
    for (const [symbolIndex, symbol] of document.symbols.entries()) {
      const source = symbolNodes.get(symbol.symbol);
      if (!source) continue;
      for (const relationship of symbol.relationships) {
        const target = symbolNodes.get(relationship.symbol);
        if (!target) {
          unsupported(
            unsupportedFields,
            "SCIP_RELATIONSHIP_TARGET",
            `documents[${documentIndex}].symbols[${symbolIndex}].relationships`,
            `relationship target is not declared: ${relationship.symbol}`,
            "external-symbol-node",
          );
          continue;
        }
        const kind = relationshipKind(relationship);
        const generatedReference = `scip://symbol/${encodeURIComponent(symbol.symbol)}#${encodeURIComponent(relationship.symbol)}`;
        const evidenceRefs = [
          ...new Set([
            ...relationship.cartographEvidenceRefs,
            generatedReference,
          ]),
        ];
        for (const [referenceIndex, reference] of evidenceRefs.entries()) {
          addEdge(
            source,
            target,
            kind,
            evidenceFor(
              reference,
              index.metadata.version,
              `${document.relativePath}\0${symbol.symbol}\0${relationship.symbol}\0${referenceIndex}`,
            ),
          );
        }
        mappings.relationships.push({
          fromSymbol: symbol.symbol,
          toSymbol: relationship.symbol,
          edgeKind: kind,
          evidenceRefs,
        });
        if (relationship.isExternalOverride) {
          unsupported(
            unsupportedFields,
            "SCIP_EXTERNAL_OVERRIDE",
            `documents[${documentIndex}].symbols[${symbolIndex}].relationships`,
            "external override semantics are retained as relationship provenance only",
            "relationship-mapping",
          );
        }
      }
    }
    for (const [
      occurrenceIndex,
      occurrence,
    ] of document.occurrences.entries()) {
      if (occurrence.symbol === undefined) continue;
      const target = symbolNodes.get(occurrence.symbol);
      if (!target) {
        unsupported(
          unsupportedFields,
          "SCIP_OCCURRENCE_TARGET",
          `documents[${documentIndex}].occurrences[${occurrenceIndex}]`,
          `occurrence target is not declared: ${occurrence.symbol}`,
          "external-symbol-node",
        );
        continue;
      }
      const [line, startCharacter, maybeEndLine, maybeEndCharacter] =
        occurrence.range;
      const endLine = maybeEndCharacter === undefined ? line : maybeEndLine;
      const endCharacter =
        maybeEndCharacter === undefined ? maybeEndLine : maybeEndCharacter;
      const generatedReference = `scip://${encodeURIComponent(document.relativePath)}#${encodeURIComponent(occurrence.symbol)}@${line}:${startCharacter}-${endLine}:${endCharacter}`;
      const evidenceRefs = [
        ...new Set([...occurrence.cartographEvidenceRefs, generatedReference]),
      ];
      for (const kind of roleKinds(occurrence.symbolRoles)) {
        for (const [referenceIndex, reference] of evidenceRefs.entries()) {
          addEdge(
            documentNode,
            target,
            kind,
            evidenceFor(
              reference,
              index.metadata.version,
              `${document.relativePath}\0${occurrenceIndex}\0${kind}\0${referenceIndex}`,
            ),
          );
        }
      }
      if (occurrence.enclosingRange !== undefined) {
        unsupported(
          unsupportedFields,
          "SCIP_ENCLOSING_RANGE",
          `documents[${documentIndex}].occurrences[${occurrenceIndex}].enclosingRange`,
          "enclosing range has no canonical GraphSnapshot field",
          "occurrence-mapping",
        );
      }
    }
  }

  for (const [symbolIndex, symbol] of index.externalSymbols.entries()) {
    const source = symbolNodes.get(symbol.symbol);
    if (!source) continue;
    for (const relationship of symbol.relationships) {
      const target = symbolNodes.get(relationship.symbol);
      if (!target) {
        unsupported(
          unsupportedFields,
          "SCIP_RELATIONSHIP_TARGET",
          `externalSymbols[${symbolIndex}].relationships`,
          `relationship target is not declared: ${relationship.symbol}`,
          "external-symbol-node",
        );
        continue;
      }
      const kind = relationshipKind(relationship);
      const generatedReference = `scip://symbol/${encodeURIComponent(symbol.symbol)}#${encodeURIComponent(relationship.symbol)}`;
      const evidenceRefs = [
        ...new Set([
          ...relationship.cartographEvidenceRefs,
          generatedReference,
        ]),
      ];
      for (const [referenceIndex, reference] of evidenceRefs.entries()) {
        addEdge(
          source,
          target,
          kind,
          evidenceFor(
            reference,
            index.metadata.version,
            `external\0${symbol.symbol}\0${relationship.symbol}\0${referenceIndex}`,
          ),
        );
      }
      mappings.relationships.push({
        fromSymbol: symbol.symbol,
        toSymbol: relationship.symbol,
        edgeKind: kind,
        evidenceRefs,
      });
      if (relationship.isExternalOverride) {
        unsupported(
          unsupportedFields,
          "SCIP_EXTERNAL_OVERRIDE",
          `externalSymbols[${symbolIndex}].relationships`,
          "external override semantics are retained as relationship provenance only",
          "relationship-mapping",
        );
      }
    }
  }

  const revisionDigest = digest(serializeScipIndex(index));
  const snapshot = canonicalizeGraphSnapshot({
    schemaVersion: 1,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    revision: { commitSha: `scip-index-${revisionDigest}` },
    nodes,
    edges: [...edges.values()],
    diagnostics: unsupportedFields.map((record) => ({
      id: `scip:diagnostic:${digest(stableStringify(record))}`,
      code: record.code,
      severity: "info" as const,
      message: record.detail,
      remediation:
        "Review the SCIP mapping report before promoting this field.",
    })),
  });
  return {
    schemaVersion: SCIP_INTERCHANGE_SCHEMA_VERSION,
    contract: SCIP_INTERCHANGE_CONTRACT,
    mediaType: SCIP_INTERCHANGE_MEDIA_TYPE,
    direction: "import",
    provenance,
    mappings: canonicalizeMappings(mappings),
    unsupported: canonicalizeUnsupported(unsupportedFields),
    snapshot,
  };
};

const locationForDocument = (
  node: GraphNode,
  unsupportedFields: ScipUnsupportedField[],
): string => {
  if (node.location?.path !== undefined) return node.location.path;
  const fallback = `cartograph/${token("virtual-", node.stableKey)}.scip.ts`;
  unsupported(
    unsupportedFields,
    "SCIP_DOCUMENT_PATH_SYNTHESIZED",
    `nodes[${node.stableKey}].location`,
    "node has no repository-relative location; an inert document path was synthesized",
    "synthetic-document-path",
  );
  return fallback;
};

export const exportScipIndex = (
  snapshotInput: unknown,
  options: ScipExportOptions,
): ScipExportResult => {
  const snapshot = canonicalizeGraphSnapshot(snapshotInput);
  const protocolVersion = options.protocolVersion ?? 0;
  const toolName = TextSchema.parse(options.toolName);
  const toolVersion = TextSchema.parse(options.toolVersion);
  const projectRoot = options.projectRoot;
  if (
    projectRoot !== undefined &&
    (projectRoot.startsWith("/") ||
      projectRoot.startsWith("~") ||
      /^file:/iu.test(projectRoot))
  ) {
    throw new ScipInterchangeValidationError(
      "SCIP export projectRoot must be a redacted or relative reference",
    );
  }
  const unsupportedFields: ScipUnsupportedField[] = [];
  const mappings: ScipMappings = {
    documents: [],
    symbols: [],
    relationships: [],
  };
  const symbolByNodeId = new Map<string, string>();
  const documentByNodeId = new Map<string, ScipDocument>();
  const documents = new Map<string, ScipDocument>();
  const symbolInfos = new Map<string, ScipSymbolInformation>();

  for (const node of snapshot.nodes) {
    const isDocument = node.kind === "module" || node.kind === "file";
    if (isDocument) {
      const relativePath = locationForDocument(node, unsupportedFields);
      const document: ScipDocument = {
        relativePath,
        ...(node.language === undefined ? {} : { language: node.language }),
        occurrences: [],
        symbols: [],
        cartographStableKey: node.stableKey,
      };
      documents.set(relativePath, document);
      documentByNodeId.set(node.id, document);
      mappings.documents.push({ relativePath, stableKey: node.stableKey });
      continue;
    }
    const scipSymbol = exportedSymbol(node.stableKey);
    symbolByNodeId.set(node.id, scipSymbol);
    const symbolInfo: ScipSymbolInformation = {
      symbol: scipSymbol,
      kind: scipKindForNode(node.kind),
      documentation: [],
      relationships: [],
      cartographStableKey: node.stableKey,
    };
    symbolInfos.set(node.id, symbolInfo);
    mappings.symbols.push({
      scipSymbol,
      stableKey: node.stableKey,
      canonicalKind: node.kind,
      external: node.kind === "external_service",
    });
    if (node.kind === "unknown") {
      unsupported(
        unsupportedFields,
        "SCIP_NODE_KIND",
        `nodes[${node.stableKey}].kind`,
        "GraphSnapshot unknown node kind is not representable as a SCIP kind",
        "UnspecifiedKind",
      );
    }
  }

  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  for (const edge of snapshot.edges) {
    const fromSymbol = symbolByNodeId.get(edge.from);
    const toSymbol = symbolByNodeId.get(edge.to);
    const evidenceRefs = edge.evidence
      .map((evidence) => evidence.reference)
      .filter((reference): reference is string => reference !== undefined);
    if (edge.evidence.some((evidence) => evidence.kind !== "user")) {
      unsupported(
        unsupportedFields,
        "SCIP_EVIDENCE_KIND",
        `edges[${edge.from}->${edge.to}].evidence`,
        "non-user GraphSnapshot evidence has no native SCIP field",
        "cartographEvidenceRefs",
      );
    }
    if (edge.confidence !== "certain") {
      unsupported(
        unsupportedFields,
        "SCIP_EDGE_CONFIDENCE",
        `edges[${edge.from}->${edge.to}].confidence`,
        "GraphSnapshot edge confidence is not represented by native SCIP relationships",
        "relationship-mapping",
      );
    }
    if (edge.unresolvedReason !== undefined) {
      unsupported(
        unsupportedFields,
        "SCIP_UNRESOLVED_REASON",
        `edges[${edge.from}->${edge.to}].unresolvedReason`,
        "GraphSnapshot unresolved reasons have no native SCIP field",
        "relationship-mapping",
      );
    }
    if (fromSymbol !== undefined && toSymbol !== undefined) {
      if (!["contains", "depends_on", "implements"].includes(edge.kind)) {
        unsupported(
          unsupportedFields,
          "SCIP_EDGE_KIND",
          `edges[${edge.from}->${edge.to}].kind`,
          `edge ${edge.kind} has no native SCIP symbol relationship mapping`,
          "unsupported-field-report",
        );
      } else {
        const relationship: ScipRelationship = {
          symbol: toSymbol,
          isDefinition: false,
          isImplementation: edge.kind === "implements",
          isTypeDefinition: edge.kind === "contains",
          isReference: edge.kind === "depends_on",
          isExternalOverride: false,
          cartographEvidenceRefs: evidenceRefs,
        };
        const sourceInfo = symbolInfos.get(edge.from);
        if (sourceInfo) sourceInfo.relationships.push(relationship);
        mappings.relationships.push({
          fromSymbol,
          toSymbol,
          edgeKind: edge.kind,
          evidenceRefs,
        });
      }
    } else if (documentByNodeId.has(edge.from) && toSymbol !== undefined) {
      const document = documentByNodeId.get(edge.from);
      if (document) {
        const symbolRoles =
          edge.kind === "contains"
            ? 0x1
            : edge.kind === "imports" || edge.kind === "depends_on"
              ? 0x2
              : edge.kind === "reads"
                ? 0x8
                : edge.kind === "writes"
                  ? 0x4
                  : undefined;
        if (symbolRoles === undefined) {
          unsupported(
            unsupportedFields,
            "SCIP_EDGE_KIND",
            `edges[${edge.from}->${edge.to}].kind`,
            `edge ${edge.kind} has no native SCIP occurrence role mapping`,
            "unsupported-field-report",
          );
          continue;
        }
        document.occurrences.push({
          symbol: toSymbol,
          range: [0, 0, 1],
          symbolRoles,
          cartographEvidenceRefs: evidenceRefs,
        });
      }
    } else if (fromSymbol !== undefined) {
      const sourceInfo = symbolInfos.get(edge.from);
      if (sourceInfo) {
        unsupported(
          unsupportedFields,
          "SCIP_EDGE_KIND",
          `edges[${edge.from}->${edge.to}].kind`,
          `edge ${edge.kind} cannot be represented as a SCIP relationship`,
          "unsupported-field-report",
        );
      }
    } else if (toSymbol !== undefined) {
      unsupported(
        unsupportedFields,
        "SCIP_EDGE_SOURCE",
        `edges[${edge.from}->${edge.to}]`,
        "edge source is a document or unsupported node and cannot be a SCIP relationship",
        "occurrence-mapping",
      );
    }
    if (evidenceRefs.length === 0 && edge.evidence.length > 0) {
      unsupported(
        unsupportedFields,
        "SCIP_EVIDENCE_REFERENCE",
        `edges[${edge.from}->${edge.to}].evidence`,
        "evidence has no portable reference to retain in the SCIP extension",
        "evidence-count-only",
      );
    }
  }

  for (const diagnostic of snapshot.diagnostics) {
    unsupported(
      unsupportedFields,
      "SCIP_DIAGNOSTIC",
      `diagnostics[${diagnostic.id}]`,
      `GraphSnapshot diagnostic ${diagnostic.code} has no native SCIP field`,
      "unsupported-field-report",
    );
  }

  for (const [nodeId, symbolInfo] of symbolInfos) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const documentPath = node.location?.path;
    if (documentPath !== undefined) {
      const document = documents.get(documentPath);
      if (document) document.symbols.push(symbolInfo);
      else
        unsupported(
          unsupportedFields,
          "SCIP_DOCUMENT_MAPPING",
          `nodes[${node.stableKey}].location.path`,
          `document ${documentPath} was not created for the symbol`,
          "external-symbols",
        );
    }
  }

  const externalSymbols = [...symbolInfos.entries()]
    .filter(([nodeId]) => {
      const node = nodeById.get(nodeId);
      return node?.kind === "external_service" || node?.location === undefined;
    })
    .map(([, symbolInfo]) => symbolInfo);
  const index: ScipIndex = {
    metadata: {
      version: protocolVersion,
      toolInfo: { name: toolName, version: toolVersion, arguments: [] },
      ...(projectRoot === undefined
        ? { projectRoot: "redacted://project-root" }
        : { projectRoot }),
      textDocumentEncoding: "UTF16",
    },
    documents: [...documents.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
    externalSymbols: externalSymbols.sort((left, right) =>
      left.symbol.localeCompare(right.symbol),
    ),
  };
  const provenance: ScipProvenance = {
    protocolVersion,
    toolName,
    toolVersion,
    graphSchemaVersion: 1,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    sourceBodiesIncluded: false,
  };
  return {
    schemaVersion: SCIP_INTERCHANGE_SCHEMA_VERSION,
    contract: SCIP_INTERCHANGE_CONTRACT,
    mediaType: SCIP_INTERCHANGE_MEDIA_TYPE,
    direction: "export",
    provenance,
    mappings: canonicalizeMappings(mappings),
    unsupported: canonicalizeUnsupported(unsupportedFields),
    index: parseScipIndex(index),
  };
};

export const serializeScipExport = (value: ScipExportResult): string =>
  stableStringify({
    schemaVersion: value.schemaVersion,
    contract: value.contract,
    mediaType: value.mediaType,
    direction: value.direction,
    provenance: value.provenance,
    mappings: value.mappings,
    unsupported: value.unsupported,
    index: value.index,
  });
