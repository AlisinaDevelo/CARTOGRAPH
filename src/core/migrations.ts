import { z } from "zod";

import { CAPABILITY_REGISTRY_VERSION } from "./capabilities.js";
import { canonicalizeGraphSnapshot, stableStringify } from "./canonical.js";
import {
  EvidenceSchema,
  GraphSnapshotSchema,
  type Evidence,
  type GraphSnapshot,
} from "./schemas.js";

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

const SeveritySchema = z.enum(["info", "warning", "error"]);

const LegacyRevisionSchema = z
  .object({
    commit: z.string().trim().min(1),
    branch: z.string().trim().min(1).optional(),
    authoredAt: z.string().trim().min(1).optional(),
  })
  .strict();

const LegacyNodeSchema = z
  .object({
    id: z.string().trim().min(1),
    kind: NodeKindSchema,
    displayName: z.string().trim().min(1),
    language: z.string().trim().min(1).optional(),
    sourceLocation: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const LegacyEvidenceSchema = z
  .object({
    id: z.string().trim().min(1),
  })
  .passthrough();

const LegacyEdgeSchema = z
  .object({
    source: z.string().trim().min(1),
    target: z.string().trim().min(1),
    relation: EdgeKindSchema,
    confidence: ConfidenceSchema,
    evidence: z.array(LegacyEvidenceSchema).default([]),
    unresolvedReason: z.string().trim().min(1).optional(),
  })
  .strict();

const LegacyDiagnosticSchema = z
  .object({
    id: z.string().trim().min(1),
    code: z.string().trim().min(1),
    severity: SeveritySchema,
    message: z.string().trim().min(1),
    nodeId: z.string().trim().min(1).optional(),
    sourceLocation: z.record(z.string(), z.unknown()).optional(),
    evidence: z.array(LegacyEvidenceSchema).default([]),
  })
  .strict();

const LegacySnapshotSchema = z
  .object({
    schemaVersion: z.literal(0),
    revision: LegacyRevisionSchema,
    nodes: z.array(LegacyNodeSchema).default([]),
    edges: z.array(LegacyEdgeSchema).default([]),
    diagnostics: z.array(LegacyDiagnosticSchema).default([]),
  })
  .strict();

export type IdentityMigrationRecord = {
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
};

export type SnapshotMigrationReport = {
  readonly contract: "GraphSnapshot";
  readonly migration: "snapshot-v0-to-v1";
  readonly fromVersion: 0;
  readonly toVersion: 1;
  readonly automatic: true;
  readonly manualReview: "required";
  readonly nodeIdentities: readonly IdentityMigrationRecord[];
  readonly edgeIdentities: readonly IdentityMigrationRecord[];
  readonly changedNodeIdentities: readonly IdentityMigrationRecord[];
  readonly changedEdgeIdentities: readonly IdentityMigrationRecord[];
  readonly synthesizedFields: readonly string[];
  readonly evidenceLoss: readonly string[];
};

export type SnapshotMigrationResult = {
  readonly snapshot: GraphSnapshot;
  readonly report: SnapshotMigrationReport;
};

export class SnapshotMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotMigrationError";
  }
}

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const canonicalNodeIdentity = (
  node: z.infer<typeof LegacyNodeSchema>,
): string => {
  if (node.kind === "function") {
    const delimiter = node.id.lastIndexOf("#");
    if (delimiter > 0 && delimiter < node.id.length - 1) {
      return `${node.id.slice(0, delimiter)}:${node.id.slice(delimiter + 1)}`;
    }
  }
  return node.id;
};

const edgeIdentity = (from: string, to: string, kind: string): string =>
  stableStringify([from, to, kind]);

const evidenceKind = (value: unknown): unknown => {
  if (value === "source_location") return "source";
  if (value === "runtime_trace") return "runtime";
  if (value === "git_diff") return "git";
  if (value === "human") return "user";
  return value;
};

const evidenceAliases = new Set([
  "id",
  "kind",
  "sourceType",
  "path",
  "line",
  "column",
  "endLine",
  "endColumn",
  "location",
  "revision",
  "reference",
  "observedAt",
  "observedCount",
  "detector",
  "extractor",
  "extractorId",
  "extractorVersion",
  "contentHash",
  "sourceHash",
  "sourceReference",
]);

const normalizeEvidence = (
  input: z.infer<typeof LegacyEvidenceSchema>,
  evidenceLoss: string[],
): Evidence => {
  const record = input as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...record };
  if (!("kind" in normalized) && "sourceType" in normalized)
    normalized.kind = evidenceKind(normalized.sourceType);
  if (!("reference" in normalized) && "sourceReference" in normalized)
    normalized.reference = normalized.sourceReference;
  if (!("contentHash" in normalized) && "sourceHash" in normalized)
    normalized.contentHash = normalized.sourceHash;
  if (!("detector" in normalized) && "extractor" in normalized)
    normalized.detector = normalized.extractor;
  if (!("detector" in normalized) && "extractorId" in normalized) {
    const id = normalized.extractorId;
    const version = normalized.extractorVersion;
    if (typeof id === "string")
      normalized.detector =
        typeof version === "string" ? `${id}@${version}` : id;
  }
  for (const key of [
    "sourceType",
    "sourceReference",
    "sourceHash",
    "extractor",
    "extractorId",
    "extractorVersion",
  ])
    delete normalized[key];

  const dropped = Object.keys(record)
    .filter((key) => !evidenceAliases.has(key))
    .sort(compareStrings);
  if (dropped.length > 0)
    evidenceLoss.push(
      `evidence ${input.id}: dropped unsupported fields ${dropped.join(", ")}`,
    );

  try {
    return EvidenceSchema.parse(normalized);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SnapshotMigrationError(
      `snapshot-v0-to-v1 rejected evidence ${input.id}: ${detail}`,
    );
  }
};

const parseLegacySnapshot = (
  input: unknown,
): z.infer<typeof LegacySnapshotSchema> => {
  const parsed = LegacySnapshotSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "snapshot"}: ${issue.message}`)
      .join("; ");
    throw new SnapshotMigrationError(`invalid GraphSnapshot v0: ${detail}`);
  }
  return parsed.data;
};

export const migrateGraphSnapshot = (
  input: unknown,
): SnapshotMigrationResult => {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  if (record?.schemaVersion !== 0)
    throw new SnapshotMigrationError(
      `snapshot migration requires schemaVersion 0; found ${JSON.stringify(record?.schemaVersion)}`,
    );

  const legacy = parseLegacySnapshot(input);
  const nodeIdentities = legacy.nodes
    .map((node) => {
      const after = canonicalNodeIdentity(node);
      return { before: node.id, after, changed: node.id !== after };
    })
    .sort((left, right) => compareStrings(left.before, right.before));
  const nodeMap = new Map(
    nodeIdentities.map((identity) => [identity.before, identity.after]),
  );
  const evidenceLoss: string[] = [];

  const nodes = legacy.nodes.map((node) => {
    const id = nodeMap.get(node.id);
    if (!id)
      throw new SnapshotMigrationError(
        `missing migrated identity for node ${node.id}`,
      );
    return {
      id,
      stableKey: id,
      kind: node.kind,
      name: node.displayName,
      ...(node.language === undefined ? {} : { language: node.language }),
      ...(node.sourceLocation === undefined
        ? {}
        : { location: node.sourceLocation }),
    };
  });

  const edgeIdentities = legacy.edges
    .map((edge) => {
      const from = nodeMap.get(edge.source);
      const to = nodeMap.get(edge.target);
      if (!from || !to)
        throw new SnapshotMigrationError(
          `edge references an unknown legacy node: ${edge.source} -> ${edge.target}`,
        );
      const before = edgeIdentity(edge.source, edge.target, edge.relation);
      const after = edgeIdentity(from, to, edge.relation);
      return { before, after, changed: before !== after };
    })
    .sort((left, right) => compareStrings(left.before, right.before));

  const edges = legacy.edges.map((edge) => {
    const from = nodeMap.get(edge.source);
    const to = nodeMap.get(edge.target);
    if (!from || !to)
      throw new SnapshotMigrationError(
        `edge references an unknown legacy node: ${edge.source} -> ${edge.target}`,
      );
    return {
      from,
      to,
      kind: edge.relation,
      confidence: edge.confidence,
      evidence: edge.evidence.map((item) =>
        normalizeEvidence(item, evidenceLoss),
      ),
      ...(edge.unresolvedReason === undefined
        ? {}
        : { unresolvedReason: edge.unresolvedReason }),
    };
  });

  const diagnostics = legacy.diagnostics.map((diagnostic) => ({
    id: diagnostic.id,
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.nodeId === undefined
      ? {}
      : { nodeId: nodeMap.get(diagnostic.nodeId) ?? diagnostic.nodeId }),
    ...(diagnostic.sourceLocation === undefined
      ? {}
      : { location: diagnostic.sourceLocation }),
    evidence: diagnostic.evidence.map((item) =>
      normalizeEvidence(item, evidenceLoss),
    ),
  }));

  const snapshot = canonicalizeGraphSnapshot({
    schemaVersion: 1,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    revision: {
      commitSha: legacy.revision.commit,
      ...(legacy.revision.branch === undefined
        ? {}
        : { branch: legacy.revision.branch }),
      ...(legacy.revision.authoredAt === undefined
        ? {}
        : { authoredAt: legacy.revision.authoredAt }),
    },
    nodes,
    edges,
    diagnostics,
  });

  const synthesizedFields = [
    "capabilityRegistryVersion=1",
    "node.stableKey=canonical node identity",
  ];
  const report: SnapshotMigrationReport = {
    contract: "GraphSnapshot",
    migration: "snapshot-v0-to-v1",
    fromVersion: 0,
    toVersion: 1,
    automatic: true,
    manualReview: "required",
    nodeIdentities,
    edgeIdentities,
    changedNodeIdentities: nodeIdentities.filter(
      (identity) => identity.changed,
    ),
    changedEdgeIdentities: edgeIdentities.filter(
      (identity) => identity.changed,
    ),
    synthesizedFields,
    evidenceLoss: [...new Set(evidenceLoss)].sort(compareStrings),
  };

  return { snapshot, report };
};

export const serializeMigrationReport = (
  report: SnapshotMigrationReport,
): string => `${stableStringify(report)}\n`;

export const validateMigrationOutput = (
  result: SnapshotMigrationResult,
): void => {
  GraphSnapshotSchema.parse(result.snapshot);
  if (result.report.fromVersion !== 0 || result.report.toVersion !== 1)
    throw new SnapshotMigrationError(
      "migration report has an unsupported version transition",
    );
};
