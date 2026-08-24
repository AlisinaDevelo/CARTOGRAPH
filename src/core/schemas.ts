import { z } from "zod";

import { CAPABILITY_REGISTRY_VERSION } from "./capabilities.js";

export const GRAPH_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const GRAPH_DIFF_SCHEMA_VERSION = 1 as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .transform((value) => value.replaceAll("\\", "/"));
const TextSchema = z.string().trim().min(1, "must not be empty");

const NodeKindSchema = z.enum([
  "endpoint",
  "module",
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
const DiagnosticSeveritySchema = z.enum(["info", "warning", "error"]);
const DetectorSchema = TextSchema.regex(
  /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+@[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u,
  "must include an extractor identity and version",
);
const ContentHashSchema = z
  .string()
  .trim()
  .regex(/^(?:sha256:)?[0-9a-f]{64}$/i, "must be a SHA-256 content hash");

const normalizePath = (value: string): string | undefined => {
  const path = value.replaceAll("\\", "/");

  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.startsWith("~") ||
    path.startsWith("//") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(path)
  ) {
    return undefined;
  }

  const parts = path.split("/");
  if (parts.some((part) => part === "..")) {
    return undefined;
  }

  const normalized = parts
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
  return normalized.length > 0 ? normalized : undefined;
};

const PortableRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, context) => {
    const normalized = normalizePath(value);
    if (!normalized) {
      context.addIssue({
        code: "custom",
        message: "must be a portable repository-relative path",
      });
      return z.NEVER;
    }
    return normalized;
  });

const PortableReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !value.startsWith("~") &&
      !/^[A-Za-z]:/.test(value) &&
      !/^file:/i.test(value) &&
      !value.includes("\0"),
    "must not contain an absolute local path",
  );

const DateTimeSchema = z
  .string()
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "must be a parseable date-time",
  );

export const SourceLocationSchema = z
  .object({
    path: PortableRelativePathSchema,
    line: z.number().int().positive(),
    column: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    endColumn: z.number().int().positive().optional(),
  })
  .strict();

const EvidenceCommonShape = {
  id: IdentifierSchema,
  path: PortableRelativePathSchema.optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  endColumn: z.number().int().positive().optional(),
  location: SourceLocationSchema.optional(),
  revision: IdentifierSchema.optional(),
  reference: PortableReferenceSchema.optional(),
  observedAt: DateTimeSchema.optional(),
  observedCount: z.number().int().nonnegative().optional(),
  detector: DetectorSchema.optional(),
  contentHash: ContentHashSchema.optional(),
};

const SourceEvidenceInputSchema = z
  .object({
    ...EvidenceCommonShape,
    kind: z.literal("source"),
    detector: DetectorSchema,
    contentHash: ContentHashSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (!evidence.path && !evidence.location) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message:
          "source evidence requires a repository-relative path or location",
      });
    }
    if (!evidence.location && evidence.line === undefined) {
      context.addIssue({
        code: "custom",
        path: ["line"],
        message: "source evidence requires a source span",
      });
    }
  });

const NonSourceEvidenceInputSchema = z
  .object({
    ...EvidenceCommonShape,
    kind: z.enum(["runtime", "git", "user"]),
  })
  .strict();

const EvidenceInputSchema = z.discriminatedUnion("kind", [
  SourceEvidenceInputSchema,
  NonSourceEvidenceInputSchema,
]);

const evidenceKindAlias = (value: unknown): unknown => {
  if (value === "source_location") return "source";
  if (value === "runtime_trace") return "runtime";
  if (value === "git_diff") return "git";
  if (value === "human") return "user";
  return value;
};

const withEvidenceAliases = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const record = { ...(value as Record<string, unknown>) };
  if (!("kind" in record) && "sourceType" in record) {
    record.kind = evidenceKindAlias(record.sourceType);
  }
  if (!("kind" in record) && "source_type" in record) {
    record.kind = evidenceKindAlias(record.source_type);
  }
  if (!("reference" in record) && "sourceReference" in record) {
    record.reference = record.sourceReference;
  }
  if (!("reference" in record) && "source_reference" in record) {
    record.reference = record.source_reference;
  }
  if (!("contentHash" in record) && "sourceHash" in record) {
    record.contentHash = record.sourceHash;
  }
  if (!("contentHash" in record) && "source_hash" in record) {
    record.contentHash = record.source_hash;
  }
  if (!("detector" in record) && "extractor" in record) {
    const extractor = record.extractor;
    if (typeof extractor === "string") {
      record.detector = extractor;
    } else if (extractor && typeof extractor === "object") {
      const extractorRecord = extractor as Record<string, unknown>;
      const id = extractorRecord.id ?? extractorRecord.name;
      const version = extractorRecord.version;
      if (typeof id === "string") {
        record.detector = typeof version === "string" ? `${id}@${version}` : id;
      }
    }
  }
  if (!("detector" in record) && "extractorId" in record) {
    const id = record.extractorId;
    const version = record.extractorVersion;
    if (typeof id === "string") {
      record.detector = typeof version === "string" ? `${id}@${version}` : id;
    }
  }
  delete record.sourceType;
  delete record.source_type;
  delete record.sourceReference;
  delete record.source_reference;
  delete record.sourceHash;
  delete record.source_hash;
  delete record.extractor;
  delete record.extractorId;
  delete record.extractorVersion;
  return record;
};

export const EvidenceSchema = z.preprocess(
  withEvidenceAliases,
  EvidenceInputSchema,
);

const RevisionInputSchema = z
  .object({
    commitSha: IdentifierSchema,
    parentSha: IdentifierSchema.optional(),
    branch: IdentifierSchema.optional(),
    authoredAt: DateTimeSchema.optional(),
  })
  .strict();

const withRevisionAliases = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const record = { ...(value as Record<string, unknown>) };
  if (!("commitSha" in record) && "commit" in record)
    record.commitSha = record.commit;
  if (!("parentSha" in record) && "parent" in record)
    record.parentSha = record.parent;
  delete record.commit;
  delete record.parent;
  return record;
};

export const RevisionSchema = z.preprocess(
  withRevisionAliases,
  RevisionInputSchema,
);

const GraphNodeInputSchema = z
  .object({
    id: IdentifierSchema,
    stableKey: IdentifierSchema.optional(),
    kind: NodeKindSchema,
    name: TextSchema,
    language: IdentifierSchema.optional(),
    location: SourceLocationSchema.optional(),
  })
  .strict();

const withNodeAliases = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const record = { ...(value as Record<string, unknown>) };
  if (!("stableKey" in record)) record.stableKey = record.id;
  if (!("name" in record) && "displayName" in record)
    record.name = record.displayName;
  if (!("location" in record) && "sourceLocation" in record)
    record.location = record.sourceLocation;
  delete record.displayName;
  delete record.sourceLocation;
  return record;
};

export const GraphNodeSchema = z
  .preprocess(withNodeAliases, GraphNodeInputSchema)
  .transform((node) => ({
    ...node,
    stableKey: node.stableKey ?? node.id,
  }));

export const IdentityMatchMethodSchema = z.enum([
  "stable-key",
  "same-name",
  "path-history",
  "neighborhood",
]);
export const IdentityMatchConfidenceSchema = z.enum(["exact", "strong"]);
export const IdentitySignalSchema = z.enum([
  "stable-key",
  "path-history",
  "same-kind",
  "same-language",
  "same-name",
  "same-neighborhood",
  "neighborhood-overlap",
]);

export const IdentityCandidateSchema = z
  .object({
    beforeStableKey: IdentifierSchema,
    afterStableKey: IdentifierSchema,
    score: z.number().finite(),
    signals: z.array(IdentitySignalSchema).min(1),
  })
  .strict();

export const IdentityMatchSchema = z
  .object({
    ...IdentityCandidateSchema.shape,
    before: GraphNodeSchema,
    after: GraphNodeSchema,
    method: IdentityMatchMethodSchema,
    confidence: IdentityMatchConfidenceSchema,
  })
  .strict();

export const IdentityAmbiguitySchema = z
  .object({
    before: GraphNodeSchema,
    candidates: z.array(IdentityCandidateSchema),
    reason: z.enum(["equal-score", "non-mutual-best"]),
  })
  .strict();

export const IdentityUnsupportedSchema = z
  .object({
    before: GraphNodeSchema,
    after: GraphNodeSchema,
    score: z.number().finite(),
    signals: z.array(IdentitySignalSchema).min(1),
    reason: z.literal("unsupported-rename"),
  })
  .strict();

export const GraphDiffIdentitySchema = z
  .object({
    matches: z.array(IdentityMatchSchema).default([]),
    ambiguous: z.array(IdentityAmbiguitySchema).default([]),
    unsupported: z.array(IdentityUnsupportedSchema).default([]),
  })
  .strict();

const GraphEdgeInputSchema = z
  .object({
    from: IdentifierSchema,
    to: IdentifierSchema,
    kind: EdgeKindSchema,
    confidence: ConfidenceSchema,
    evidence: z.array(EvidenceSchema),
    unresolvedReason: TextSchema.optional(),
  })
  .strict()
  .superRefine((edge, context) => {
    if (edge.evidence.length === 0 && !edge.unresolvedReason) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "edge requires evidence or an explicit unresolved reason",
      });
    }
  });

export const GraphEdgeSchema = GraphEdgeInputSchema;

const DiagnosticInputSchema = z
  .object({
    id: IdentifierSchema,
    code: IdentifierSchema,
    severity: DiagnosticSeveritySchema,
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
    evidence: z.array(EvidenceSchema).default([]),
  })
  .strict();

export const DiagnosticSchema = DiagnosticInputSchema;

const GraphSnapshotInputSchema = z
  .object({
    schemaVersion: z
      .literal(GRAPH_SNAPSHOT_SCHEMA_VERSION)
      .default(GRAPH_SNAPSHOT_SCHEMA_VERSION),
    capabilityRegistryVersion: z
      .literal(CAPABILITY_REGISTRY_VERSION)
      .default(CAPABILITY_REGISTRY_VERSION),
    revision: RevisionSchema,
    nodes: z.array(GraphNodeSchema).default([]),
    edges: z.array(GraphEdgeSchema).default([]),
    diagnostics: z.array(DiagnosticSchema).default([]),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const nodeIds = new Set(snapshot.nodes.map((node) => node.id));

    snapshot.edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.from)) {
        context.addIssue({
          code: "custom",
          path: ["edges", index, "from"],
          message: `edge source node is not declared: ${edge.from}`,
        });
      }
      if (!nodeIds.has(edge.to)) {
        context.addIssue({
          code: "custom",
          path: ["edges", index, "to"],
          message: `edge target node is not declared: ${edge.to}`,
        });
      }
    });

    snapshot.diagnostics.forEach((diagnostic, index) => {
      if (diagnostic.nodeId && !nodeIds.has(diagnostic.nodeId)) {
        context.addIssue({
          code: "custom",
          path: ["diagnostics", index, "nodeId"],
          message: `diagnostic node is not declared: ${diagnostic.nodeId}`,
        });
      }
    });
  });

const withSnapshotAliases = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const record = { ...(value as Record<string, unknown>) };
  if (!("schemaVersion" in record) && "version" in record)
    record.schemaVersion = record.version;
  delete record.version;
  return record;
};

export const GraphSnapshotSchema = z.preprocess(
  withSnapshotAliases,
  GraphSnapshotInputSchema,
);

const FieldChangeSchema = z
  .object({
    path: IdentifierSchema,
    before: z.unknown(),
    after: z.unknown(),
  })
  .strict();

const ChangedNodeSchema = z
  .object({
    stableKey: IdentifierSchema,
    before: GraphNodeSchema,
    after: GraphNodeSchema,
    changes: z.array(FieldChangeSchema),
    classification: z.literal("node-changed").default("node-changed"),
  })
  .strict();

export const EdgeChangeClassificationSchema = z.enum([
  "edge-changed",
  "evidence-only",
  "confidence-changed",
]);

const ChangedEdgeSchema = z
  .object({
    from: IdentifierSchema,
    to: IdentifierSchema,
    kind: EdgeKindSchema,
    before: GraphEdgeSchema,
    after: GraphEdgeSchema,
    changes: z.array(FieldChangeSchema),
    classification: EdgeChangeClassificationSchema.default("edge-changed"),
  })
  .strict();

export const RewiredEdgeSchema = z
  .object({
    before: GraphEdgeSchema,
    after: GraphEdgeSchema,
    changes: z.array(FieldChangeSchema),
    classification: z.literal("endpoint-rewired").default("endpoint-rewired"),
  })
  .strict();

const ChangedDiagnosticSchema = z
  .object({
    id: IdentifierSchema,
    before: DiagnosticSchema,
    after: DiagnosticSchema,
    changes: z.array(FieldChangeSchema),
    classification: z
      .literal("diagnostic-changed")
      .default("diagnostic-changed"),
  })
  .strict();

const DiffCountSchema = z.number().int().nonnegative();

export const GraphDiffSummarySchema = z
  .object({
    nodesAdded: DiffCountSchema,
    nodesRemoved: DiffCountSchema,
    nodesChanged: DiffCountSchema,
    edgesAdded: DiffCountSchema,
    edgesRemoved: DiffCountSchema,
    edgesChanged: DiffCountSchema,
    diagnosticsAdded: DiffCountSchema,
    diagnosticsRemoved: DiffCountSchema,
    diagnosticsChanged: DiffCountSchema,
  })
  .strict();

export const DiffComparisonModeSchema = z.enum(["direct", "merge-base"]);

export const DiffComparisonSchema = z
  .object({
    mode: DiffComparisonModeSchema,
    baseRef: PortableReferenceSchema,
    headRef: PortableReferenceSchema,
    baseCommitSha: IdentifierSchema,
    headCommitSha: IdentifierSchema,
    mergeBaseSha: IdentifierSchema.optional(),
  })
  .strict()
  .superRefine((comparison, context) => {
    if (
      comparison.mode === "merge-base" &&
      comparison.mergeBaseSha === undefined
    )
      context.addIssue({
        code: "custom",
        path: ["mergeBaseSha"],
        message: "merge-base comparisons require the resolved merge base",
      });
    if (comparison.mode === "direct" && comparison.mergeBaseSha !== undefined)
      context.addIssue({
        code: "custom",
        path: ["mergeBaseSha"],
        message: "direct comparisons must not claim a merge base",
      });
  });

export const GraphDiffSchema = z
  .object({
    schemaVersion: z.literal(GRAPH_DIFF_SCHEMA_VERSION),
    capabilityRegistryVersion: z
      .literal(CAPABILITY_REGISTRY_VERSION)
      .default(CAPABILITY_REGISTRY_VERSION),
    summary: GraphDiffSummarySchema,
    comparison: DiffComparisonSchema.optional(),
    fromRevision: RevisionSchema,
    toRevision: RevisionSchema,
    nodes: z
      .object({
        added: z.array(GraphNodeSchema),
        removed: z.array(GraphNodeSchema),
        changed: z.array(ChangedNodeSchema),
      })
      .strict(),
    identity: GraphDiffIdentitySchema.default({
      matches: [],
      ambiguous: [],
      unsupported: [],
    }),
    edges: z
      .object({
        added: z.array(GraphEdgeSchema),
        removed: z.array(GraphEdgeSchema),
        changed: z.array(ChangedEdgeSchema),
        rewired: z.array(RewiredEdgeSchema).default([]),
      })
      .strict(),
    diagnostics: z
      .object({
        added: z.array(DiagnosticSchema),
        removed: z.array(DiagnosticSchema),
        changed: z.array(ChangedDiagnosticSchema),
      })
      .strict(),
  })
  .strict();

export type SourceLocation = z.infer<typeof SourceLocationSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Revision = z.infer<typeof RevisionSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type IdentityMatchMethod = z.infer<typeof IdentityMatchMethodSchema>;
export type IdentityMatchConfidence = z.infer<
  typeof IdentityMatchConfidenceSchema
>;
export type IdentitySignal = z.infer<typeof IdentitySignalSchema>;
export type IdentityCandidate = z.infer<typeof IdentityCandidateSchema>;
export type IdentityMatch = z.infer<typeof IdentityMatchSchema>;
export type IdentityAmbiguity = z.infer<typeof IdentityAmbiguitySchema>;
export type IdentityUnsupported = z.infer<typeof IdentityUnsupportedSchema>;
export type GraphDiffIdentity = z.infer<typeof GraphDiffIdentitySchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;
export type FieldChange = z.infer<typeof FieldChangeSchema>;
export type ChangedNode = z.infer<typeof ChangedNodeSchema>;
export type EdgeChangeClassification = z.infer<
  typeof EdgeChangeClassificationSchema
>;
export type ChangedEdge = z.infer<typeof ChangedEdgeSchema>;
export type RewiredEdge = z.infer<typeof RewiredEdgeSchema>;
export type ChangedDiagnostic = z.infer<typeof ChangedDiagnosticSchema>;
export type GraphDiffSummary = z.infer<typeof GraphDiffSummarySchema>;
export type DiffComparisonMode = z.infer<typeof DiffComparisonModeSchema>;
export type DiffComparison = z.infer<typeof DiffComparisonSchema>;
export type GraphDiff = z.infer<typeof GraphDiffSchema>;
