import { z, type ZodIssue } from "zod";

import { canonicalizeGraphSnapshot, stableStringify } from "./canonical.js";
import { type GraphNode, type GraphSnapshot } from "./schemas.js";
import { WorkspaceLocalPathSchema } from "./workspace-composition.js";

export const WORKSPACE_BOUNDARY_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_BOUNDARY_CONTRACT =
  "cartograph.workspace-boundaries" as const;
export const WORKSPACE_BOUNDARY_MAX_REPOSITORIES = 64 as const;
export const WORKSPACE_BOUNDARY_MAX_OMISSIONS = 64 as const;
export const WORKSPACE_BOUNDARY_MAX_DECLARATIONS = 2_048 as const;
export const WORKSPACE_BOUNDARY_MAX_REFERENCES = 4_096 as const;
export const WORKSPACE_BOUNDARY_MAX_EVIDENCE_SOURCES = 8_192 as const;
export const WORKSPACE_BOUNDARY_MAX_CANDIDATES = 8_192 as const;
export const WORKSPACE_BOUNDARY_MAX_EDGES = 4_096 as const;
export const WORKSPACE_BOUNDARY_MAX_CYCLES = 256 as const;
export const WORKSPACE_BOUNDARY_MAX_NODES = 200_000 as const;
export const WORKSPACE_BOUNDARY_MAX_SNAPSHOT_EDGES = 400_000 as const;
export const WORKSPACE_BOUNDARY_MAX_DIAGNOSTICS = 64_000 as const;
export const WORKSPACE_BOUNDARY_MAX_EVIDENCE_PER_RECORD = 16 as const;

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u,
    "must be a portable lower-case identifier",
  )
  .transform((value) => value.normalize("NFC"));

const NoControlTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .transform((value) => value.normalize("NFC"))
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );

const BoundaryNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .transform((value) => value.normalize("NFC"))
  .refine(
    (value) => !value.includes("\0") && !/\s/u.test(value),
    "must not contain whitespace or control characters",
  );

const NodeIdSchema = NoControlTextSchema;

const SemverSchema = z
  .string()
  .trim()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "must be a semantic version",
  );

const ContentHashSchema = z
  .string()
  .trim()
  .regex(/^(?:sha256:)?[0-9a-f]{64}$/iu, "must be a SHA-256 content hash");

const EvidenceKindSchema = z.enum([
  "manifest",
  "source",
  "lockfile",
  "service-catalog",
  "runtime",
  "user",
]);

const BoundaryKindSchema = z.enum(["package", "service"]);
const BoundaryTargetKindSchema = z.enum([
  "package",
  "service",
  "schema",
  "runtime",
]);
const BoundaryRelationSchema = z.enum([
  "depends-on",
  "references",
  "calls",
  "requests",
  "contains",
  "unknown",
]);
const BoundaryStatusSchema = z.enum([
  "resolved",
  "ambiguous",
  "external",
  "unavailable",
  "unsupported",
]);

export const WorkspaceBoundaryEvidenceSourceSchema = z
  .object({
    id: IdentifierSchema,
    repositoryId: IdentifierSchema,
    kind: EvidenceKindSchema,
    path: WorkspaceLocalPathSchema.optional(),
    reference: NoControlTextSchema.optional(),
    revision: IdentifierSchema,
    contentHash: ContentHashSchema.optional(),
    nodeId: NodeIdSchema.optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if (!source.path && !source.reference) {
      context.addIssue({
        code: "custom",
        path: ["path"],
        message:
          "evidence source requires a repository-relative path or reference",
      });
    }
  });
export type WorkspaceBoundaryEvidenceSource = z.infer<
  typeof WorkspaceBoundaryEvidenceSourceSchema
>;

export const WorkspaceBoundaryDeclarationSchema = z
  .object({
    id: IdentifierSchema,
    kind: BoundaryKindSchema,
    name: BoundaryNameSchema,
    aliases: z.array(BoundaryNameSchema).max(32).default([]),
    version: SemverSchema.optional(),
    nodeId: NodeIdSchema,
    workspacePath: WorkspaceLocalPathSchema.optional(),
    evidenceSourceIds: z
      .array(IdentifierSchema)
      .min(1)
      .max(WORKSPACE_BOUNDARY_MAX_EVIDENCE_PER_RECORD),
  })
  .strict();
export type WorkspaceBoundaryDeclaration = z.infer<
  typeof WorkspaceBoundaryDeclarationSchema
>;

export const WorkspaceBoundaryRepositorySchema = z
  .object({
    repositoryId: IdentifierSchema,
    logicalName: BoundaryNameSchema,
    namespace: NoControlTextSchema,
    aliases: z.array(IdentifierSchema).max(32).default([]),
    snapshot: z.unknown(),
    declarations: z
      .array(WorkspaceBoundaryDeclarationSchema)
      .max(WORKSPACE_BOUNDARY_MAX_DECLARATIONS),
  })
  .strict();
export type WorkspaceBoundaryRepository = z.infer<
  typeof WorkspaceBoundaryRepositorySchema
>;

export const WorkspaceBoundaryOmissionSchema = z
  .object({
    repositoryId: IdentifierSchema,
    logicalName: BoundaryNameSchema,
    aliases: z.array(IdentifierSchema).max(32).default([]),
    reason: NoControlTextSchema.refine(
      (value) => value.length <= 1_024,
      "must be no longer than 1024 characters",
    ),
  })
  .strict();
export type WorkspaceBoundaryOmission = z.infer<
  typeof WorkspaceBoundaryOmissionSchema
>;

export const WorkspaceBoundaryTargetSchema = z
  .object({
    kind: BoundaryTargetKindSchema,
    name: BoundaryNameSchema,
    aliases: z.array(BoundaryNameSchema).max(32).default([]),
    repositoryId: IdentifierSchema.optional(),
    version: SemverSchema.optional(),
    external: z.boolean().default(false),
    externalReference: NoControlTextSchema.optional(),
  })
  .strict()
  .superRefine((target, context) => {
    if (target.external && target.repositoryId) {
      context.addIssue({
        code: "custom",
        path: ["repositoryId"],
        message: "an external target cannot name a workspace repository",
      });
    }
    if (target.externalReference && !target.external) {
      context.addIssue({
        code: "custom",
        path: ["externalReference"],
        message: "externalReference requires external=true",
      });
    }
  });
export type WorkspaceBoundaryTarget = z.infer<
  typeof WorkspaceBoundaryTargetSchema
>;

export const WorkspaceBoundaryReferenceSchema = z
  .object({
    id: IdentifierSchema,
    fromRepository: IdentifierSchema,
    fromDeclarationId: IdentifierSchema,
    relation: BoundaryRelationSchema,
    target: WorkspaceBoundaryTargetSchema,
    evidenceSourceIds: z
      .array(IdentifierSchema)
      .min(1)
      .max(WORKSPACE_BOUNDARY_MAX_EVIDENCE_PER_RECORD),
  })
  .strict();
export type WorkspaceBoundaryReference = z.infer<
  typeof WorkspaceBoundaryReferenceSchema
>;

export const WorkspaceBoundaryRequestSchema = z
  .object({
    $schema: z.string().trim().max(512).optional(),
    schemaVersion: z.literal(WORKSPACE_BOUNDARY_SCHEMA_VERSION),
    contract: z.literal(WORKSPACE_BOUNDARY_CONTRACT),
    repositories: z
      .array(WorkspaceBoundaryRepositorySchema)
      .min(1)
      .max(WORKSPACE_BOUNDARY_MAX_REPOSITORIES),
    omissions: z
      .array(WorkspaceBoundaryOmissionSchema)
      .max(WORKSPACE_BOUNDARY_MAX_OMISSIONS)
      .default([]),
    evidenceSources: z
      .array(WorkspaceBoundaryEvidenceSourceSchema)
      .max(WORKSPACE_BOUNDARY_MAX_EVIDENCE_SOURCES),
    references: z
      .array(WorkspaceBoundaryReferenceSchema)
      .max(WORKSPACE_BOUNDARY_MAX_REFERENCES),
  })
  .strict();
export type WorkspaceBoundaryRequest = z.infer<
  typeof WorkspaceBoundaryRequestSchema
>;

export const WorkspaceBoundaryRepositorySummarySchema = z
  .object({
    repositoryId: IdentifierSchema,
    logicalName: BoundaryNameSchema,
    namespace: NoControlTextSchema.optional(),
    aliases: z.array(IdentifierSchema).max(32),
    revision: IdentifierSchema.optional(),
    availability: z.enum(["available", "unavailable"]),
    omissionReason: NoControlTextSchema.refine(
      (value) => value.length <= 1_024,
      "must be no longer than 1024 characters",
    ).optional(),
  })
  .strict()
  .superRefine((repository, context) => {
    if (repository.availability === "available" && !repository.revision) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "available repositories require a snapshot revision",
      });
    }
    if (
      repository.availability === "unavailable" &&
      !repository.omissionReason
    ) {
      context.addIssue({
        code: "custom",
        path: ["omissionReason"],
        message: "unavailable repositories require an omission reason",
      });
    }
  });
export type WorkspaceBoundaryRepositorySummary = z.infer<
  typeof WorkspaceBoundaryRepositorySummarySchema
>;

export const WorkspaceBoundaryCandidateSchema = z
  .object({
    repositoryId: IdentifierSchema,
    logicalName: BoundaryNameSchema,
    declarationId: IdentifierSchema,
    kind: BoundaryKindSchema,
    name: BoundaryNameSchema,
    aliases: z.array(BoundaryNameSchema).max(32),
    version: SemverSchema.optional(),
    nodeId: NodeIdSchema,
    workspacePath: WorkspaceLocalPathSchema.optional(),
    matchedBy: z.enum(["name", "alias"]),
    evidence: z
      .array(WorkspaceBoundaryEvidenceSourceSchema)
      .min(1)
      .max(WORKSPACE_BOUNDARY_MAX_EVIDENCE_PER_RECORD),
  })
  .strict();
export type WorkspaceBoundaryCandidate = z.infer<
  typeof WorkspaceBoundaryCandidateSchema
>;

export const WorkspaceBoundaryProvenanceSchema = z
  .object({
    from: z
      .array(WorkspaceBoundaryEvidenceSourceSchema)
      .min(1)
      .max(WORKSPACE_BOUNDARY_MAX_EVIDENCE_PER_RECORD),
    to: z
      .array(WorkspaceBoundaryEvidenceSourceSchema)
      .min(1)
      .max(WORKSPACE_BOUNDARY_MAX_EVIDENCE_PER_RECORD),
  })
  .strict();
export type WorkspaceBoundaryProvenance = z.infer<
  typeof WorkspaceBoundaryProvenanceSchema
>;

export const WorkspaceBoundaryEdgeSchema = z
  .object({
    id: IdentifierSchema,
    referenceId: IdentifierSchema,
    scope: z.enum(["local", "cross-repository"]),
    fromRepository: IdentifierSchema,
    toRepository: IdentifierSchema,
    fromDeclarationId: IdentifierSchema,
    toDeclarationId: IdentifierSchema,
    relation: BoundaryRelationSchema,
    fromNodeId: NodeIdSchema,
    toNodeId: NodeIdSchema,
    provenance: WorkspaceBoundaryProvenanceSchema,
  })
  .strict()
  .superRefine((edge, context) => {
    if (
      edge.scope === "cross-repository" &&
      edge.fromRepository === edge.toRepository
    ) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message:
          "cross-repository edges must have different repository endpoints",
      });
    }
    if (edge.scope === "local" && edge.fromRepository !== edge.toRepository) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "local edges must have the same repository endpoint",
      });
    }
  });
export type WorkspaceBoundaryEdge = z.infer<typeof WorkspaceBoundaryEdgeSchema>;

export const WorkspaceBoundaryResolutionSchema = z
  .object({
    id: IdentifierSchema,
    fromRepository: IdentifierSchema,
    fromDeclarationId: IdentifierSchema,
    relation: BoundaryRelationSchema,
    target: WorkspaceBoundaryTargetSchema,
    status: BoundaryStatusSchema,
    sourceEvidence: z
      .array(WorkspaceBoundaryEvidenceSourceSchema)
      .min(1)
      .max(WORKSPACE_BOUNDARY_MAX_EVIDENCE_PER_RECORD),
    candidates: z
      .array(WorkspaceBoundaryCandidateSchema)
      .max(WORKSPACE_BOUNDARY_MAX_CANDIDATES),
    edge: WorkspaceBoundaryEdgeSchema.optional(),
    unresolvedReason: NoControlTextSchema.refine(
      (value) => value.length <= 1_024,
      "must be no longer than 1024 characters",
    ).optional(),
  })
  .strict()
  .superRefine((resolution, context) => {
    if (resolution.status === "resolved" && !resolution.edge) {
      context.addIssue({
        code: "custom",
        path: ["edge"],
        message: "resolved boundaries require a composed edge",
      });
    }
    if (resolution.status === "resolved" && resolution.unresolvedReason) {
      context.addIssue({
        code: "custom",
        path: ["unresolvedReason"],
        message: "resolved boundaries cannot contain an unresolved reason",
      });
    }
    if (resolution.status !== "resolved" && !resolution.unresolvedReason) {
      context.addIssue({
        code: "custom",
        path: ["unresolvedReason"],
        message: "unresolved boundaries require an explicit reason",
      });
    }
    if (resolution.status !== "resolved" && resolution.edge) {
      context.addIssue({
        code: "custom",
        path: ["edge"],
        message: "only resolved boundaries may contain a composed edge",
      });
    }
    if (resolution.status === "ambiguous" && resolution.candidates.length < 2) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "ambiguous boundaries require at least two candidates",
      });
    }
  });
export type WorkspaceBoundaryResolution = z.infer<
  typeof WorkspaceBoundaryResolutionSchema
>;

export const WorkspaceBoundaryCycleSchema = z
  .object({
    id: IdentifierSchema,
    repositoryIds: z
      .array(IdentifierSchema)
      .min(1)
      .max(WORKSPACE_BOUNDARY_MAX_REPOSITORIES),
    nodeIds: z
      .array(NodeIdSchema)
      .min(2)
      .max(WORKSPACE_BOUNDARY_MAX_CANDIDATES),
    edgeIds: z.array(IdentifierSchema).min(1).max(WORKSPACE_BOUNDARY_MAX_EDGES),
  })
  .strict();
export type WorkspaceBoundaryCycle = z.infer<
  typeof WorkspaceBoundaryCycleSchema
>;

export const WorkspaceBoundaryCompositionSchema = z
  .object({
    schemaVersion: z.literal(WORKSPACE_BOUNDARY_SCHEMA_VERSION),
    contract: z.literal(WORKSPACE_BOUNDARY_CONTRACT),
    repositories: z
      .array(WorkspaceBoundaryRepositorySummarySchema)
      .min(1)
      .max(WORKSPACE_BOUNDARY_MAX_REPOSITORIES),
    evidenceSources: z
      .array(WorkspaceBoundaryEvidenceSourceSchema)
      .max(WORKSPACE_BOUNDARY_MAX_EVIDENCE_SOURCES),
    resolutions: z
      .array(WorkspaceBoundaryResolutionSchema)
      .max(WORKSPACE_BOUNDARY_MAX_REFERENCES),
    edges: z
      .array(WorkspaceBoundaryEdgeSchema)
      .max(WORKSPACE_BOUNDARY_MAX_EDGES),
    cycles: z
      .array(WorkspaceBoundaryCycleSchema)
      .max(WORKSPACE_BOUNDARY_MAX_CYCLES),
  })
  .strict()
  .superRefine((composition, context) => {
    const evidenceIds = new Set<string>();
    for (const [index, source] of composition.evidenceSources.entries()) {
      if (evidenceIds.has(source.id)) {
        context.addIssue({
          code: "custom",
          path: ["evidenceSources", index, "id"],
          message: `duplicate evidence source identity: ${source.id}`,
        });
      }
      evidenceIds.add(source.id);
    }
    const resolutionIds = new Set<string>();
    for (const [index, resolution] of composition.resolutions.entries()) {
      if (resolutionIds.has(resolution.id)) {
        context.addIssue({
          code: "custom",
          path: ["resolutions", index, "id"],
          message: `duplicate boundary resolution identity: ${resolution.id}`,
        });
      }
      resolutionIds.add(resolution.id);
      for (const source of resolution.sourceEvidence) {
        if (source.repositoryId !== resolution.fromRepository) {
          context.addIssue({
            code: "custom",
            path: ["resolutions", index, "sourceEvidence"],
            message: `resolution ${resolution.id} contains provenance from ${source.repositoryId}, not ${resolution.fromRepository}`,
          });
        }
      }
      for (const candidate of resolution.candidates) {
        for (const source of candidate.evidence) {
          if (source.repositoryId !== candidate.repositoryId) {
            context.addIssue({
              code: "custom",
              path: ["resolutions", index, "candidates"],
              message: `candidate ${candidate.declarationId} contains provenance from ${source.repositoryId}, not ${candidate.repositoryId}`,
            });
          }
        }
      }
    }
    const edgeIds = new Set<string>();
    for (const [index, edge] of composition.edges.entries()) {
      if (edgeIds.has(edge.id)) {
        context.addIssue({
          code: "custom",
          path: ["edges", index, "id"],
          message: `duplicate composed edge identity: ${edge.id}`,
        });
      }
      edgeIds.add(edge.id);
      if (!resolutionIds.has(edge.referenceId)) {
        context.addIssue({
          code: "custom",
          path: ["edges", index, "referenceId"],
          message: `edge references unknown boundary resolution: ${edge.referenceId}`,
        });
      }
      for (const source of edge.provenance.from) {
        if (source.repositoryId !== edge.fromRepository) {
          context.addIssue({
            code: "custom",
            path: ["edges", index, "provenance", "from"],
            message: `edge ${edge.id} contains declaring provenance from ${source.repositoryId}, not ${edge.fromRepository}`,
          });
        }
      }
      for (const source of edge.provenance.to) {
        if (source.repositoryId !== edge.toRepository) {
          context.addIssue({
            code: "custom",
            path: ["edges", index, "provenance", "to"],
            message: `edge ${edge.id} contains target provenance from ${source.repositoryId}, not ${edge.toRepository}`,
          });
        }
      }
      const matchingResolution = composition.resolutions.find(
        (resolution) => resolution.id === edge.referenceId,
      );
      if (matchingResolution?.status !== "resolved") {
        context.addIssue({
          code: "custom",
          path: ["edges", index, "referenceId"],
          message: `edge ${edge.id} must reference a resolved boundary`,
        });
      } else if (
        !matchingResolution.edge ||
        stableStringify(matchingResolution.edge) !== stableStringify(edge)
      ) {
        context.addIssue({
          code: "custom",
          path: ["edges", index],
          message: `edge ${edge.id} disagrees with its resolution record`,
        });
      }
    }
    for (const [index, cycle] of composition.cycles.entries()) {
      for (const edgeId of cycle.edgeIds) {
        if (!edgeIds.has(edgeId)) {
          context.addIssue({
            code: "custom",
            path: ["cycles", index, "edgeIds"],
            message: `cycle references unknown edge: ${edgeId}`,
          });
        }
      }
    }
  });
export type WorkspaceBoundaryComposition = z.infer<
  typeof WorkspaceBoundaryCompositionSchema
>;

export type WorkspaceBoundaryErrorCode = "invalid-input" | "resource-limit";

const issueText = (issues: readonly ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

export class WorkspaceBoundaryValidationError extends Error {
  readonly code: WorkspaceBoundaryErrorCode;
  readonly issues: readonly ZodIssue[];

  constructor(
    code: WorkspaceBoundaryErrorCode,
    message: string,
    issues: readonly ZodIssue[] = [],
  ) {
    super(message);
    this.name = "WorkspaceBoundaryValidationError";
    this.code = code;
    this.issues = issues;
  }
}

type ParsedDeclaration = WorkspaceBoundaryDeclaration & {
  repositoryId: string;
  logicalName: string;
  node: GraphNode;
  evidence: WorkspaceBoundaryEvidenceSource[];
};

type ParsedRepository = {
  data: WorkspaceBoundaryRepository;
  snapshot: GraphSnapshot;
  declarations: ParsedDeclaration[];
};

const normalizeToken = (value: string): string =>
  value.normalize("NFC").toLowerCase();

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const evidenceSort = (
  left: WorkspaceBoundaryEvidenceSource,
  right: WorkspaceBoundaryEvidenceSource,
): number => compareStrings(left.id, right.id);

const canonicalizeEvidence = (
  values: readonly WorkspaceBoundaryEvidenceSource[],
): WorkspaceBoundaryEvidenceSource[] =>
  [...new Map(values.map((value) => [value.id, value])).values()].sort(
    evidenceSort,
  );

const canonicalizeTarget = (
  target: WorkspaceBoundaryTarget,
): WorkspaceBoundaryTarget => ({
  ...target,
  aliases: uniqueSorted(target.aliases),
});

const canonicalizeCandidate = (
  candidate: WorkspaceBoundaryCandidate,
): WorkspaceBoundaryCandidate => ({
  ...candidate,
  aliases: uniqueSorted(candidate.aliases),
  evidence: canonicalizeEvidence(candidate.evidence),
});

const canonicalizeEdge = (
  edge: WorkspaceBoundaryEdge,
): WorkspaceBoundaryEdge => ({
  ...edge,
  provenance: {
    from: canonicalizeEvidence(edge.provenance.from),
    to: canonicalizeEvidence(edge.provenance.to),
  },
});

const canonicalizeResolution = (
  resolution: WorkspaceBoundaryResolution,
): WorkspaceBoundaryResolution => ({
  ...resolution,
  target: canonicalizeTarget(resolution.target),
  sourceEvidence: canonicalizeEvidence(resolution.sourceEvidence),
  candidates: resolution.candidates
    .map(canonicalizeCandidate)
    .sort((left, right) => {
      const repository = compareStrings(left.repositoryId, right.repositoryId);
      return repository !== 0
        ? repository
        : compareStrings(left.declarationId, right.declarationId);
    }),
  ...(resolution.edge ? { edge: canonicalizeEdge(resolution.edge) } : {}),
});

const canonicalizeComposition = (
  composition: WorkspaceBoundaryComposition,
): WorkspaceBoundaryComposition => ({
  ...composition,
  repositories: [...composition.repositories]
    .map((repository) => ({
      ...repository,
      aliases: uniqueSorted(repository.aliases),
    }))
    .sort((left, right) =>
      compareStrings(left.repositoryId, right.repositoryId),
    ),
  evidenceSources: canonicalizeEvidence(composition.evidenceSources),
  resolutions: [...composition.resolutions]
    .map(canonicalizeResolution)
    .sort((left, right) => compareStrings(left.id, right.id)),
  edges: [...composition.edges]
    .map(canonicalizeEdge)
    .sort((left, right) => compareStrings(left.id, right.id)),
  cycles: [...composition.cycles].sort((left, right) =>
    compareStrings(left.id, right.id),
  ),
});

const parseRequest = (value: unknown): WorkspaceBoundaryRequest => {
  const parsed = WorkspaceBoundaryRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkspaceBoundaryValidationError(
      "invalid-input",
      `workspace boundary request validation failed: ${issueText(parsed.error.issues)}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
};

const resourceError = (message: string): never => {
  throw new WorkspaceBoundaryValidationError("resource-limit", message);
};

const invalidError = (message: string): never => {
  throw new WorkspaceBoundaryValidationError("invalid-input", message);
};

const parseRepositories = (
  request: WorkspaceBoundaryRequest,
): {
  repositories: ParsedRepository[];
  evidenceById: Map<string, WorkspaceBoundaryEvidenceSource>;
  omissionByToken: Map<string, WorkspaceBoundaryOmission[]>;
} => {
  const repositoryIds = new Set<string>();
  const evidenceById = new Map<string, WorkspaceBoundaryEvidenceSource>();
  for (const source of request.evidenceSources) {
    if (evidenceById.has(source.id))
      invalidError(`duplicate evidence source identity: ${source.id}`);
    evidenceById.set(source.id, source);
  }
  const omissionIds = new Set<string>();
  const omissionByToken = new Map<string, WorkspaceBoundaryOmission[]>();
  for (const omission of request.omissions) {
    if (omissionIds.has(omission.repositoryId)) {
      invalidError(
        `duplicate omitted repository identity: ${omission.repositoryId}`,
      );
    }
    omissionIds.add(omission.repositoryId);
    for (const token of [omission.repositoryId, ...omission.aliases]) {
      const key = normalizeToken(token);
      const entries = omissionByToken.get(key) ?? [];
      entries.push(omission);
      omissionByToken.set(key, entries);
    }
  }

  const totalDeclarations = request.repositories.reduce(
    (total, repository) => total + repository.declarations.length,
    0,
  );
  if (totalDeclarations > WORKSPACE_BOUNDARY_MAX_DECLARATIONS) {
    resourceError(
      `workspace boundary request declares ${totalDeclarations} declarations but the limit is ${WORKSPACE_BOUNDARY_MAX_DECLARATIONS}`,
    );
  }

  const repositories: ParsedRepository[] = [];
  let totalSnapshotNodes = 0;
  for (const repository of request.repositories) {
    if (repositoryIds.has(repository.repositoryId)) {
      invalidError(`duplicate repository identity: ${repository.repositoryId}`);
    }
    if (omissionIds.has(repository.repositoryId)) {
      invalidError(
        `repository identity is both available and omitted: ${repository.repositoryId}`,
      );
    }
    repositoryIds.add(repository.repositoryId);
    const snapshot: GraphSnapshot = (() => {
      try {
        return canonicalizeGraphSnapshot(repository.snapshot);
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "invalid graph snapshot";
        return invalidError(
          `repository ${repository.repositoryId} has an invalid graph snapshot: ${detail}`,
        );
      }
    })();
    if (snapshot.nodes.length > WORKSPACE_BOUNDARY_MAX_NODES) {
      resourceError(
        `repository ${repository.repositoryId} snapshot contains ${snapshot.nodes.length} nodes but the limit is ${WORKSPACE_BOUNDARY_MAX_NODES}`,
      );
    }
    totalSnapshotNodes += snapshot.nodes.length;
    if (totalSnapshotNodes > WORKSPACE_BOUNDARY_MAX_NODES) {
      resourceError(
        `workspace boundary request contains more than ${WORKSPACE_BOUNDARY_MAX_NODES} snapshot nodes in total`,
      );
    }
    if (snapshot.edges.length > WORKSPACE_BOUNDARY_MAX_SNAPSHOT_EDGES) {
      resourceError(
        `repository ${repository.repositoryId} snapshot contains ${snapshot.edges.length} edges but the limit is ${WORKSPACE_BOUNDARY_MAX_SNAPSHOT_EDGES}`,
      );
    }
    if (snapshot.diagnostics.length > WORKSPACE_BOUNDARY_MAX_DIAGNOSTICS) {
      resourceError(
        `repository ${repository.repositoryId} snapshot contains ${snapshot.diagnostics.length} diagnostics but the limit is ${WORKSPACE_BOUNDARY_MAX_DIAGNOSTICS}`,
      );
    }
    const nodesById = new Map<string, GraphNode>();
    for (const node of snapshot.nodes) {
      nodesById.set(node.id, node);
      nodesById.set(node.stableKey, node);
    }
    const declarationIds = new Set<string>();
    const declarations: ParsedDeclaration[] = [];
    for (const declaration of repository.declarations) {
      if (declarationIds.has(declaration.id)) {
        invalidError(
          `repository ${repository.repositoryId} has duplicate declaration identity: ${declaration.id}`,
        );
      }
      declarationIds.add(declaration.id);
      const node = nodesById.get(declaration.nodeId);
      if (!node) {
        throw new WorkspaceBoundaryValidationError(
          "invalid-input",
          `declaration ${repository.repositoryId}/${declaration.id} references an unknown graph node: ${declaration.nodeId}`,
        );
      }
      const compatibleKinds =
        declaration.kind === "package"
          ? new Set(["package", "module"])
          : new Set(["service", "endpoint"]);
      if (!compatibleKinds.has(node.kind)) {
        invalidError(
          `declaration ${repository.repositoryId}/${declaration.id} kind ${declaration.kind} does not match graph node kind ${node.kind}`,
        );
      }
      const evidence = declaration.evidenceSourceIds.map((id) => {
        const source = evidenceById.get(id);
        if (!source) {
          throw new WorkspaceBoundaryValidationError(
            "invalid-input",
            `declaration ${declaration.id} references unknown evidence source: ${id}`,
          );
        }
        if (source.repositoryId !== repository.repositoryId) {
          invalidError(
            `declaration ${declaration.id} selects evidence from another repository: ${id}`,
          );
        }
        return source;
      });
      declarations.push({
        ...declaration,
        aliases: uniqueSorted(declaration.aliases),
        repositoryId: repository.repositoryId,
        logicalName: repository.logicalName,
        node,
        evidence: canonicalizeEvidence(evidence),
      });
    }
    repositories.push({ data: repository, snapshot, declarations });
  }
  const knownRepositoryIds = new Set([
    ...repositories.map((repository) => repository.data.repositoryId),
    ...request.omissions.map((omission) => omission.repositoryId),
  ]);
  for (const source of request.evidenceSources) {
    if (!knownRepositoryIds.has(source.repositoryId)) {
      invalidError(
        `evidence source ${source.id} names an unknown repository: ${source.repositoryId}`,
      );
    }
  }
  if (repositories.length > WORKSPACE_BOUNDARY_MAX_REPOSITORIES) {
    resourceError(
      `workspace boundary request contains ${repositories.length} repositories but the limit is ${WORKSPACE_BOUNDARY_MAX_REPOSITORIES}`,
    );
  }
  if (request.references.length > WORKSPACE_BOUNDARY_MAX_REFERENCES) {
    resourceError(
      `workspace boundary request contains ${request.references.length} references but the limit is ${WORKSPACE_BOUNDARY_MAX_REFERENCES}`,
    );
  }
  if (
    request.evidenceSources.length > WORKSPACE_BOUNDARY_MAX_EVIDENCE_SOURCES
  ) {
    resourceError(
      `workspace boundary request contains ${request.evidenceSources.length} evidence sources but the limit is ${WORKSPACE_BOUNDARY_MAX_EVIDENCE_SOURCES}`,
    );
  }
  if (
    repositories.length + request.omissions.length >
    WORKSPACE_BOUNDARY_MAX_REPOSITORIES
  ) {
    resourceError(
      `workspace boundary request contains ${repositories.length + request.omissions.length} available and omitted repositories but the limit is ${WORKSPACE_BOUNDARY_MAX_REPOSITORIES}`,
    );
  }
  return { repositories, evidenceById, omissionByToken };
};

const repositorySummary = (
  parsed: ParsedRepository,
): WorkspaceBoundaryRepositorySummary => ({
  repositoryId: parsed.data.repositoryId,
  logicalName: parsed.data.logicalName,
  namespace: parsed.data.namespace,
  aliases: uniqueSorted(parsed.data.aliases),
  revision: parsed.snapshot.revision.commitSha,
  availability: "available",
});

const omissionSummary = (
  omission: WorkspaceBoundaryOmission,
): WorkspaceBoundaryRepositorySummary => ({
  repositoryId: omission.repositoryId,
  logicalName: omission.logicalName,
  aliases: uniqueSorted(omission.aliases),
  availability: "unavailable",
  omissionReason: omission.reason,
});

const nameKeys = (name: string, aliases: readonly string[]): Set<string> =>
  new Set([name, ...aliases].map(normalizeToken));

const matchedBy = (
  target: WorkspaceBoundaryTarget,
  declaration: WorkspaceBoundaryDeclaration,
): "name" | "alias" =>
  normalizeToken(target.name) === normalizeToken(declaration.name)
    ? "name"
    : "alias";

const candidateFor = (
  declaration: ParsedDeclaration,
  match: "name" | "alias",
): WorkspaceBoundaryCandidate => ({
  repositoryId: declaration.repositoryId,
  logicalName: declaration.logicalName,
  declarationId: declaration.id,
  kind: declaration.kind,
  name: declaration.name,
  aliases: [...declaration.aliases],
  ...(declaration.version ? { version: declaration.version } : {}),
  nodeId: declaration.node.id,
  ...(declaration.workspacePath
    ? { workspacePath: declaration.workspacePath }
    : {}),
  matchedBy: match,
  evidence: declaration.evidence,
});

const sourceEvidenceFor = (
  reference: WorkspaceBoundaryReference,
  declaration: ParsedDeclaration,
  evidenceById: Map<string, WorkspaceBoundaryEvidenceSource>,
): WorkspaceBoundaryEvidenceSource[] => {
  const ids = [
    ...declaration.evidenceSourceIds,
    ...reference.evidenceSourceIds,
  ];
  return canonicalizeEvidence(
    ids.map((id) => {
      const source = evidenceById.get(id);
      if (!source) {
        throw new WorkspaceBoundaryValidationError(
          "invalid-input",
          `reference ${reference.id} selects unknown evidence source: ${id}`,
        );
      }
      return source;
    }),
  );
};

const resolutionReason = (
  status: Exclude<z.infer<typeof BoundaryStatusSchema>, "resolved">,
  detail: string,
): string => `${status}: ${detail}`;

const tarjanCycles = (
  edges: readonly WorkspaceBoundaryEdge[],
): WorkspaceBoundaryCycle[] => {
  const adjacency = new Map<string, { to: string; edgeId: string }[]>();
  const allNodes = new Set<string>();
  for (const edge of edges) {
    const from = `${edge.fromRepository}::${edge.fromNodeId}`;
    const to = `${edge.toRepository}::${edge.toNodeId}`;
    allNodes.add(from);
    allNodes.add(to);
    const values = adjacency.get(from) ?? [];
    values.push({ to, edgeId: edge.id });
    adjacency.set(from, values);
  }
  for (const values of adjacency.values()) {
    values.sort((left, right) => {
      const to = compareStrings(left.to, right.to);
      return to !== 0 ? to : compareStrings(left.edgeId, right.edgeId);
    });
  }
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (node: string): void => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const neighbor of adjacency.get(node) ?? []) {
      if (!indices.has(neighbor.to)) {
        visit(neighbor.to);
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node)!, lowLinks.get(neighbor.to)!),
        );
      } else if (onStack.has(neighbor.to)) {
        lowLinks.set(
          node,
          Math.min(lowLinks.get(node)!, indices.get(neighbor.to)!),
        );
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    components.push(component.sort(compareStrings));
  };
  for (const node of [...allNodes].sort(compareStrings)) {
    if (!indices.has(node)) visit(node);
  }
  const cycles = components
    .filter((component) => {
      if (component.length > 1) return true;
      const node = component[0];
      return edges.some(
        (edge) =>
          `${edge.fromRepository}::${edge.fromNodeId}` === node &&
          `${edge.toRepository}::${edge.toNodeId}` === node,
      );
    })
    .sort((left, right) => compareStrings(left[0]!, right[0]!));
  return cycles.map((component, index) => {
    const members = new Set(component);
    const cycleEdges = edges
      .filter((edge) => {
        const from = `${edge.fromRepository}::${edge.fromNodeId}`;
        const to = `${edge.toRepository}::${edge.toNodeId}`;
        return members.has(from) && members.has(to);
      })
      .map((edge) => edge.id)
      .sort(compareStrings);
    return {
      id: `cycle/${index + 1}`,
      repositoryIds: uniqueSorted(
        component.map((node) => node.slice(0, node.indexOf("::"))),
      ),
      nodeIds: component,
      edgeIds: cycleEdges,
    };
  });
};

export type WorkspaceBoundaryResolutionOptions = {
  maxCandidates?: number;
  maxEdges?: number;
  maxCycles?: number;
};

export const resolveWorkspaceBoundaries = (
  input: unknown,
  options: WorkspaceBoundaryResolutionOptions = {},
): WorkspaceBoundaryComposition => {
  const request = parseRequest(input);
  const maxCandidates =
    options.maxCandidates ?? WORKSPACE_BOUNDARY_MAX_CANDIDATES;
  const maxEdges = options.maxEdges ?? WORKSPACE_BOUNDARY_MAX_EDGES;
  const maxCycles = options.maxCycles ?? WORKSPACE_BOUNDARY_MAX_CYCLES;
  if (
    !Number.isSafeInteger(maxCandidates) ||
    maxCandidates < 1 ||
    maxCandidates > WORKSPACE_BOUNDARY_MAX_CANDIDATES
  ) {
    invalidError(
      `maxCandidates must be a positive integer no greater than ${WORKSPACE_BOUNDARY_MAX_CANDIDATES}`,
    );
  }
  if (
    !Number.isSafeInteger(maxEdges) ||
    maxEdges < 1 ||
    maxEdges > WORKSPACE_BOUNDARY_MAX_EDGES
  ) {
    invalidError(
      `maxEdges must be a positive integer no greater than ${WORKSPACE_BOUNDARY_MAX_EDGES}`,
    );
  }
  if (
    !Number.isSafeInteger(maxCycles) ||
    maxCycles < 1 ||
    maxCycles > WORKSPACE_BOUNDARY_MAX_CYCLES
  ) {
    invalidError(
      `maxCycles must be a positive integer no greater than ${WORKSPACE_BOUNDARY_MAX_CYCLES}`,
    );
  }
  const { repositories, evidenceById, omissionByToken } =
    parseRepositories(request);
  const repositoryById = new Map(
    repositories.map((repository) => [
      repository.data.repositoryId,
      repository,
    ]),
  );
  const repositoryTokens = new Map<string, string[]>();
  const addRepositoryToken = (token: string, repositoryId: string): void => {
    const key = normalizeToken(token);
    const ids = repositoryTokens.get(key) ?? [];
    if (!ids.includes(repositoryId)) ids.push(repositoryId);
    ids.sort(compareStrings);
    repositoryTokens.set(key, ids);
  };
  const declarationById = new Map<string, ParsedDeclaration>();
  for (const repository of repositories) {
    addRepositoryToken(
      repository.data.repositoryId,
      repository.data.repositoryId,
    );
    for (const alias of repository.data.aliases)
      addRepositoryToken(alias, repository.data.repositoryId);
    for (const declaration of repository.declarations) {
      declarationById.set(
        `${repository.data.repositoryId}/${declaration.id}`,
        declaration,
      );
    }
  }
  const allDeclarations = repositories.flatMap(
    (repository) => repository.declarations,
  );
  const resolutions: WorkspaceBoundaryResolution[] = [];
  const edges: WorkspaceBoundaryEdge[] = [];
  let candidateCount = 0;
  for (const reference of request.references) {
    const fromRepository = repositoryById.get(reference.fromRepository);
    if (!fromRepository) {
      throw new WorkspaceBoundaryValidationError(
        "invalid-input",
        `reference ${reference.id} names an unknown source repository: ${reference.fromRepository}`,
      );
    }
    const fromDeclaration = declarationById.get(
      `${reference.fromRepository}/${reference.fromDeclarationId}`,
    );
    if (!fromDeclaration) {
      throw new WorkspaceBoundaryValidationError(
        "invalid-input",
        `reference ${reference.id} names an unknown source declaration: ${reference.fromDeclarationId}`,
      );
    }
    const sourceEvidence = sourceEvidenceFor(
      reference,
      fromDeclaration,
      evidenceById,
    );
    const target = canonicalizeTarget(reference.target);
    let status: z.infer<typeof BoundaryStatusSchema>;
    let candidates: WorkspaceBoundaryCandidate[] = [];
    let edge: WorkspaceBoundaryEdge | undefined;
    let unresolvedReason: string | undefined;
    if (target.external) {
      status = "external";
      unresolvedReason = resolutionReason(
        "external",
        "the target is explicitly outside the materialized workspace",
      );
    } else if (target.kind !== "package" && target.kind !== "service") {
      status = "unsupported";
      unresolvedReason = resolutionReason(
        "unsupported",
        `target kind ${target.kind} is not supported by the v1 package/service resolver`,
      );
    } else if (reference.relation === "unknown") {
      status = "unsupported";
      unresolvedReason = resolutionReason(
        "unsupported",
        "the relationship kind is unknown and cannot be composed conservatively",
      );
    } else {
      let candidateRepositoryIds: string[];
      let repositoryTokenAmbiguous = false;
      if (target.repositoryId) {
        const ids =
          repositoryTokens.get(normalizeToken(target.repositoryId)) ?? [];
        const omitted =
          omissionByToken.get(normalizeToken(target.repositoryId)) ?? [];
        if (ids.length === 0 && omitted.length > 0) {
          status = "unavailable";
          unresolvedReason = resolutionReason(
            "unavailable",
            `target repository ${target.repositoryId} is declared but its snapshot is omitted`,
          );
          resolutions.push({
            id: reference.id,
            fromRepository: reference.fromRepository,
            fromDeclarationId: reference.fromDeclarationId,
            relation: reference.relation,
            target,
            status,
            sourceEvidence,
            candidates,
            unresolvedReason,
          });
          continue;
        }
        if (ids.length === 0) {
          status = "unavailable";
          unresolvedReason = resolutionReason(
            "unavailable",
            `target repository ${target.repositoryId} is not materialized in the workspace`,
          );
          resolutions.push({
            id: reference.id,
            fromRepository: reference.fromRepository,
            fromDeclarationId: reference.fromDeclarationId,
            relation: reference.relation,
            target,
            status,
            sourceEvidence,
            candidates,
            unresolvedReason,
          });
          continue;
        }
        repositoryTokenAmbiguous = ids.length > 1;
        candidateRepositoryIds = ids;
      } else {
        candidateRepositoryIds = repositories.map(
          (repository) => repository.data.repositoryId,
        );
      }
      const targetKeys = nameKeys(target.name, target.aliases);
      const matchedDeclarations = allDeclarations.filter((declaration) => {
        if (!candidateRepositoryIds.includes(declaration.repositoryId))
          return false;
        if (declaration.kind !== target.kind) return false;
        const declarationsKeys = nameKeys(
          declaration.name,
          declaration.aliases,
        );
        return [...targetKeys].some((key) => declarationsKeys.has(key));
      });
      const namedCandidates = matchedDeclarations.map((declaration) =>
        candidateFor(declaration, matchedBy(target, declaration)),
      );
      const versionCandidates = target.version
        ? matchedDeclarations.filter(
            (declaration) => declaration.version === target.version,
          )
        : matchedDeclarations;
      candidates = (
        target.version && versionCandidates.length === 0
          ? namedCandidates
          : versionCandidates.map((declaration) =>
              candidateFor(declaration, matchedBy(target, declaration)),
            )
      ).sort((left, right) => {
        const repository = compareStrings(
          left.repositoryId,
          right.repositoryId,
        );
        return repository !== 0
          ? repository
          : compareStrings(left.declarationId, right.declarationId);
      });
      candidateCount += candidates.length;
      if (candidateCount > maxCandidates)
        resourceError(
          `workspace boundary resolution produced more than ${maxCandidates} candidates`,
        );
      if (
        target.version &&
        matchedDeclarations.length > 0 &&
        versionCandidates.length === 0
      ) {
        status = "unavailable";
        const versions = uniqueSorted(
          matchedDeclarations.map(
            (declaration) => declaration.version ?? "unversioned",
          ),
        );
        unresolvedReason = resolutionReason(
          "unavailable",
          `version-skew: target requires ${target.version}, available declarations are ${versions.join(", ")}`,
        );
      } else if (candidates.length === 0) {
        status = "unavailable";
        unresolvedReason = resolutionReason(
          "unavailable",
          `no declared ${target.kind} named ${target.name} matched the selected repository set`,
        );
      } else if (repositoryTokenAmbiguous || candidates.length > 1) {
        status = "ambiguous";
        unresolvedReason = resolutionReason(
          "ambiguous",
          "more than one declared target matches the name, alias, or repository alias",
        );
      } else {
        status = "resolved";
        const candidate = candidates[0]!;
        const targetDeclaration = declarationById.get(
          `${candidate.repositoryId}/${candidate.declarationId}`,
        )!;
        const scope =
          fromRepository.data.repositoryId === targetDeclaration.repositoryId
            ? "local"
            : "cross-repository";
        edge = {
          id: `edge/${reference.id}`,
          referenceId: reference.id,
          scope,
          fromRepository: fromRepository.data.repositoryId,
          toRepository: targetDeclaration.repositoryId,
          fromDeclarationId: fromDeclaration.id,
          toDeclarationId: targetDeclaration.id,
          relation: reference.relation,
          fromNodeId: fromDeclaration.node.id,
          toNodeId: targetDeclaration.node.id,
          provenance: {
            from: sourceEvidence,
            to: targetDeclaration.evidence,
          },
        };
        edges.push(edge);
        if (edges.length > maxEdges)
          resourceError(
            `workspace boundary resolution produced more than ${maxEdges} edges`,
          );
      }
    }
    resolutions.push({
      id: reference.id,
      fromRepository: reference.fromRepository,
      fromDeclarationId: reference.fromDeclarationId,
      relation: reference.relation,
      target,
      status,
      sourceEvidence,
      candidates,
      ...(edge ? { edge } : {}),
      ...(unresolvedReason ? { unresolvedReason } : {}),
    });
  }
  const cycles = tarjanCycles(edges);
  if (cycles.length > maxCycles)
    resourceError(
      `workspace boundary resolution produced ${cycles.length} cycles but the limit is ${maxCycles}`,
    );
  const repositoriesOutput = [
    ...repositories.map(repositorySummary),
    ...request.omissions.map(omissionSummary),
  ];
  const composition: WorkspaceBoundaryComposition = {
    schemaVersion: WORKSPACE_BOUNDARY_SCHEMA_VERSION,
    contract: WORKSPACE_BOUNDARY_CONTRACT,
    repositories: repositoriesOutput,
    evidenceSources: [...evidenceById.values()],
    resolutions,
    edges,
    cycles,
  };
  return parseWorkspaceBoundaryComposition(composition);
};

export const resolveWorkspaceBoundaryReferences = resolveWorkspaceBoundaries;
export const resolveWorkspaceBoundary = resolveWorkspaceBoundaries;

export const parseWorkspaceBoundaryComposition = (
  value: unknown,
): WorkspaceBoundaryComposition => {
  const parsed = WorkspaceBoundaryCompositionSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkspaceBoundaryValidationError(
      "invalid-input",
      `workspace boundary composition validation failed: ${issueText(parsed.error.issues)}`,
      parsed.error.issues,
    );
  }
  return canonicalizeComposition(parsed.data);
};

export const serializeWorkspaceBoundaryComposition = (value: unknown): string =>
  stableStringify(parseWorkspaceBoundaryComposition(value));
