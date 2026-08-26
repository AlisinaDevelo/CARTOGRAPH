import { createHash } from "node:crypto";

import { z, ZodError } from "zod";

import { canonicalizeGraphSnapshot, stableStringify } from "./canonical.js";
import { canonicalizeGraphDiff } from "./diff.js";
import { PolicyEvaluationSchema } from "./policy-evaluation.js";
import type {
  Diagnostic,
  GraphDiff,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  Revision,
} from "./schemas.js";
import { RevisionSchema } from "./schemas.js";
import type { PolicyEvaluation } from "./policy-evaluation.js";

export const PATCH_FILTER_SCHEMA_VERSION = 1 as const;
export const PATCH_FILTER_CONTRACT = "cartograph.patch-filter" as const;
export const PATCH_FILTER_MEDIA_TYPE =
  "application/vnd.cartograph.patch-filter+json" as const;
export const PATCH_FILTER_MAX_CHANGED_FILES = 512 as const;
export const PATCH_FILTER_MAX_SELECTION_ITEMS = 100_000 as const;
export const PATCH_FILTER_MAX_OMITTED_REGIONS = 100_000 as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._:/|%=>-]*$/u,
    "must be a portable architecture identifier",
  );

const PathSchema = z
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
      normalized.startsWith("//") ||
      normalized.includes("\0") ||
      /^[A-Za-z][A-Za-z\d+.-]*:/.test(normalized) ||
      parts.some((part) => part === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "must be a repository-relative path without traversal",
      });
      return z.NEVER;
    }
    const compact = parts.filter((part) => part.length > 0 && part !== ".");
    if (compact.length === 0) {
      context.addIssue({
        code: "custom",
        message: "must name a repository path",
      });
      return z.NEVER;
    }
    return compact.join("/");
  });

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

export const PatchFilterChangedFileSchema = z
  .object({
    path: PathSchema,
    status: z.enum(["added", "modified", "removed", "renamed"]),
    previousPath: PathSchema.optional(),
    generated: z.boolean().default(false),
  })
  .strict()
  .superRefine((file, context) => {
    if (file.status === "renamed") {
      if (file.previousPath === undefined) {
        context.addIssue({
          code: "custom",
          path: ["previousPath"],
          message: "renamed files require previousPath",
        });
      } else if (file.previousPath === file.path) {
        context.addIssue({
          code: "custom",
          path: ["previousPath"],
          message: "renamed files must change path",
        });
      }
    } else if (file.previousPath !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["previousPath"],
        message: "only renamed files may declare previousPath",
      });
    }
  });

const compareChangedFiles = (
  left: PatchFilterChangedFile,
  right: PatchFilterChangedFile,
): number => {
  const pathOrder = compareStrings(left.path, right.path);
  if (pathOrder !== 0) return pathOrder;
  return compareStrings(left.previousPath ?? "", right.previousPath ?? "");
};

export const PatchFilterRequestSchema = z
  .object({
    schemaVersion: z.literal(PATCH_FILTER_SCHEMA_VERSION),
    contract: z.literal(PATCH_FILTER_CONTRACT),
    filterId: IdentifierSchema,
    changedFiles: z
      .array(PatchFilterChangedFileSchema)
      .min(1)
      .max(PATCH_FILTER_MAX_CHANGED_FILES),
    contextDepth: z.number().int().nonnegative().max(1).default(1),
    includeGenerated: z.boolean().default(false),
    maxNodes: z
      .number()
      .int()
      .positive()
      .max(PATCH_FILTER_MAX_SELECTION_ITEMS)
      .default(10_000),
    maxEdges: z
      .number()
      .int()
      .positive()
      .max(PATCH_FILTER_MAX_SELECTION_ITEMS)
      .default(20_000),
    maxDiagnostics: z
      .number()
      .int()
      .positive()
      .max(PATCH_FILTER_MAX_SELECTION_ITEMS)
      .default(10_000),
    maxOmittedRegions: z
      .number()
      .int()
      .positive()
      .max(PATCH_FILTER_MAX_OMITTED_REGIONS)
      .default(20_000),
  })
  .strict()
  .superRefine((request, context) => {
    const paths = new Set<string>();
    for (const [index, file] of request.changedFiles.entries()) {
      for (const path of [file.path, file.previousPath]) {
        if (path === undefined) continue;
        if (paths.has(path)) {
          context.addIssue({
            code: "custom",
            path: ["changedFiles", index],
            message: `changed file path is repeated: ${path}`,
          });
        }
        paths.add(path);
      }
    }
  });

export const PatchFilterSideSchema = z.enum(["before", "after"]);
export const PatchFilterSelectionRoleSchema = z.enum(["changed", "context"]);
export const PatchFilterOmittedReasonSchema = z.enum([
  "generated-file",
  "outside-patch-context",
]);

const EvidencePathListSchema = z.array(PathSchema).max(64);

export const PatchFilterSelectedNodeSchema = z
  .object({
    side: PatchFilterSideSchema,
    id: IdentifierSchema,
    stableKey: IdentifierSchema,
    role: PatchFilterSelectionRoleSchema,
    depth: z.number().int().nonnegative().max(1),
    evidencePaths: EvidencePathListSchema,
  })
  .strict()
  .superRefine((node, context) => {
    if (
      (node.role === "changed" && node.depth !== 0) ||
      (node.role === "context" && node.depth !== 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["role"],
        message: "selection role must match depth",
      });
    }
  });

export const PatchFilterSelectedEdgeSchema = z
  .object({
    side: PatchFilterSideSchema,
    identity: IdentifierSchema,
    from: IdentifierSchema,
    to: IdentifierSchema,
    kind: EdgeKindSchema,
    role: PatchFilterSelectionRoleSchema,
    depth: z.number().int().nonnegative().max(1),
    evidencePaths: EvidencePathListSchema,
  })
  .strict()
  .superRefine((edge, context) => {
    if (
      (edge.role === "changed" && edge.depth !== 0) ||
      (edge.role === "context" && edge.depth !== 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["role"],
        message: "selection role must match depth",
      });
    }
  });

export const PatchFilterSelectedDiagnosticSchema = z
  .object({
    side: PatchFilterSideSchema,
    id: IdentifierSchema,
    role: PatchFilterSelectionRoleSchema,
    depth: z.number().int().nonnegative().max(1),
    evidencePaths: EvidencePathListSchema,
  })
  .strict()
  .superRefine((diagnostic, context) => {
    if (
      (diagnostic.role === "changed" && diagnostic.depth !== 0) ||
      (diagnostic.role === "context" && diagnostic.depth !== 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["role"],
        message: "selection role must match depth",
      });
    }
  });

const IdListSchema = z
  .array(IdentifierSchema)
  .max(PATCH_FILTER_MAX_SELECTION_ITEMS);

const PatchFilterDiffNodeSelectionSchema = z
  .object({
    added: IdListSchema,
    removed: IdListSchema,
    changed: IdListSchema,
  })
  .strict();
const PatchFilterDiffIdentitySelectionSchema = z
  .object({
    matches: IdListSchema,
    ambiguous: IdListSchema,
    unsupported: IdListSchema,
  })
  .strict();
const PatchFilterDiffEdgeSelectionSchema = z
  .object({
    added: IdListSchema,
    removed: IdListSchema,
    changed: IdListSchema,
    rewired: IdListSchema,
  })
  .strict();
const PatchFilterDiffDiagnosticSelectionSchema = z
  .object({
    added: IdListSchema,
    removed: IdListSchema,
    changed: IdListSchema,
  })
  .strict();

export const PatchFilterDiffSelectionSchema = z
  .object({
    nodes: PatchFilterDiffNodeSelectionSchema,
    identity: PatchFilterDiffIdentitySelectionSchema,
    edges: PatchFilterDiffEdgeSelectionSchema,
    diagnostics: PatchFilterDiffDiagnosticSelectionSchema,
  })
  .strict();

export const PatchFilterSideSelectionSchema = z
  .object({
    nodes: z
      .array(PatchFilterSelectedNodeSchema)
      .max(PATCH_FILTER_MAX_SELECTION_ITEMS),
    edges: z
      .array(PatchFilterSelectedEdgeSchema)
      .max(PATCH_FILTER_MAX_SELECTION_ITEMS),
    diagnostics: z
      .array(PatchFilterSelectedDiagnosticSchema)
      .max(PATCH_FILTER_MAX_SELECTION_ITEMS),
  })
  .strict();

export const PatchFilterRootSelectionSchema = z
  .object({
    nodeIds: IdListSchema,
    edgeIds: IdListSchema,
    diagnosticIds: IdListSchema,
  })
  .strict();

export const PatchFilterSelectionSchema = z
  .object({
    changedFiles: z
      .array(PatchFilterChangedFileSchema)
      .max(PATCH_FILTER_MAX_CHANGED_FILES),
    roots: z
      .object({
        before: PatchFilterRootSelectionSchema,
        after: PatchFilterRootSelectionSchema,
      })
      .strict(),
    before: PatchFilterSideSelectionSchema,
    after: PatchFilterSideSelectionSchema,
    diff: PatchFilterDiffSelectionSchema,
  })
  .strict();

export const PatchFilterOmittedFileSchema = PatchFilterChangedFileSchema.extend(
  {
    reason: z.literal("generated-file"),
  },
).strict();

export const PatchFilterOmittedRegionSchema = z
  .object({
    side: PatchFilterSideSchema,
    kind: z.enum(["node", "edge", "diagnostic"]),
    identity: IdentifierSchema,
    evidencePaths: EvidencePathListSchema,
    reason: PatchFilterOmittedReasonSchema,
  })
  .strict();

const CountSchema = z.number().int().nonnegative();
export const PatchFilterCountsSchema = z
  .object({
    before: z
      .object({
        nodes: CountSchema,
        edges: CountSchema,
        diagnostics: CountSchema,
        selectedNodes: CountSchema,
        selectedEdges: CountSchema,
        selectedDiagnostics: CountSchema,
        omittedNodes: CountSchema,
        omittedEdges: CountSchema,
        omittedDiagnostics: CountSchema,
      })
      .strict(),
    after: z
      .object({
        nodes: CountSchema,
        edges: CountSchema,
        diagnostics: CountSchema,
        selectedNodes: CountSchema,
        selectedEdges: CountSchema,
        selectedDiagnostics: CountSchema,
        omittedNodes: CountSchema,
        omittedEdges: CountSchema,
        omittedDiagnostics: CountSchema,
      })
      .strict(),
    omittedRegions: CountSchema,
  })
  .strict();

export const PatchFilterPolicyStatusSchema = z.enum([
  "not-provided",
  "passed",
  "violations",
  "unsupported",
]);

export const PatchFilterPolicySchema = z
  .object({
    source: z.enum(["not-provided", "full-diff"]),
    status: PatchFilterPolicyStatusSchema,
    evaluationDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/u)
      .nullable(),
    violationIds: IdListSchema,
    retainedViolationIds: IdListSchema,
    omittedViolationIds: IdListSchema,
    unsupportedIds: IdListSchema,
    preserved: z.literal(true),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.source === "not-provided") {
      if (
        policy.status !== "not-provided" ||
        policy.evaluationDigest !== null ||
        policy.violationIds.length > 0 ||
        policy.retainedViolationIds.length > 0 ||
        policy.omittedViolationIds.length > 0 ||
        policy.unsupportedIds.length > 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["source"],
          message: "not-provided policy state cannot publish an evaluation",
        });
      }
      return;
    }
    if (policy.evaluationDigest === null) {
      context.addIssue({
        code: "custom",
        path: ["evaluationDigest"],
        message: "full-diff policy state requires an evaluation digest",
      });
    }
    if (
      stableStringify(
        [
          ...new Set([
            ...policy.retainedViolationIds,
            ...policy.omittedViolationIds,
          ]),
        ].sort(compareStrings),
      ) !== stableStringify([...policy.violationIds].sort(compareStrings))
    ) {
      context.addIssue({
        code: "custom",
        path: ["violationIds"],
        message: "policy violation visibility does not cover every violation",
      });
    }
    if (policy.status === "violations" && policy.violationIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "violations status requires violation IDs",
      });
    }
    if (policy.status !== "violations" && policy.violationIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["violationIds"],
        message: "non-violations policy status cannot publish violations",
      });
    }
  });

export const PatchFilterReportSchema = z
  .object({
    schemaVersion: z.literal(PATCH_FILTER_SCHEMA_VERSION),
    contract: z.literal(PATCH_FILTER_CONTRACT),
    mediaType: z.literal(PATCH_FILTER_MEDIA_TYPE),
    filterId: IdentifierSchema,
    fromRevision: RevisionSchema,
    toRevision: RevisionSchema,
    requestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    selection: PatchFilterSelectionSchema,
    omitted: z
      .object({
        files: z
          .array(PatchFilterOmittedFileSchema)
          .max(PATCH_FILTER_MAX_CHANGED_FILES),
        regions: z
          .array(PatchFilterOmittedRegionSchema)
          .max(PATCH_FILTER_MAX_OMITTED_REGIONS),
        counts: PatchFilterCountsSchema,
      })
      .strict(),
    policy: PatchFilterPolicySchema,
    deterministic: z.literal(true),
    readOnly: z.literal(true),
    reportDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .strict();

export type PatchFilterChangedFile = z.infer<
  typeof PatchFilterChangedFileSchema
>;
export type PatchFilterRequest = z.infer<typeof PatchFilterRequestSchema>;
export type PatchFilterSide = z.infer<typeof PatchFilterSideSchema>;
export type PatchFilterSelectionRole = z.infer<
  typeof PatchFilterSelectionRoleSchema
>;
export type PatchFilterSelectedNode = z.infer<
  typeof PatchFilterSelectedNodeSchema
>;
export type PatchFilterSelectedEdge = z.infer<
  typeof PatchFilterSelectedEdgeSchema
>;
export type PatchFilterSelectedDiagnostic = z.infer<
  typeof PatchFilterSelectedDiagnosticSchema
>;
export type PatchFilterSideSelection = z.infer<
  typeof PatchFilterSideSelectionSchema
>;
export type PatchFilterDiffSelection = z.infer<
  typeof PatchFilterDiffSelectionSchema
>;
export type PatchFilterSelection = z.infer<typeof PatchFilterSelectionSchema>;
export type PatchFilterOmittedRegion = z.infer<
  typeof PatchFilterOmittedRegionSchema
>;
export type PatchFilterCounts = z.infer<typeof PatchFilterCountsSchema>;
export type PatchFilterPolicy = z.infer<typeof PatchFilterPolicySchema>;
export type PatchFilterReport = z.infer<typeof PatchFilterReportSchema>;

export type PatchFilterErrorCode =
  "invalid-input" | "conflict" | "resource-limit";

export class PatchFilterError extends Error {
  readonly code: PatchFilterErrorCode;

  constructor(code: PatchFilterErrorCode, message: string) {
    super(message);
    this.name = "PatchFilterError";
    this.code = code;
  }
}

export interface PatchFilterOptions {
  diff: unknown;
  before: unknown;
  after: unknown;
  request: unknown;
  policyEvaluation?: unknown;
}

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const compareNumbers = (left: number, right: number): number => left - right;

const digest = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(stableStringify(value), "utf8").digest("hex")}`;

const pathList = (values: readonly (string | undefined)[]): string[] =>
  [
    ...new Set(values.filter((value): value is string => value !== undefined)),
  ].sort(compareStrings);

const evidencePaths = (
  evidence: readonly {
    path?: string | undefined;
    location?: { path: string } | undefined;
  }[],
): string[] =>
  pathList(evidence.flatMap((entry) => [entry.path, entry.location?.path]));

const nodePaths = (node: GraphNode): string[] =>
  node.location === undefined ? [] : [node.location.path];

const edgePaths = (edge: GraphEdge): string[] => evidencePaths(edge.evidence);

const diagnosticPaths = (diagnostic: Diagnostic): string[] =>
  pathList([diagnostic.location?.path, ...evidencePaths(diagnostic.evidence)]);

const edgeIdentity = (edge: Pick<GraphEdge, "from" | "to" | "kind">): string =>
  `${edge.from}|${edge.kind}|${edge.to}`;

const changedIdentity = (
  before: Pick<GraphEdge, "from" | "to" | "kind">,
  after: Pick<GraphEdge, "from" | "to" | "kind">,
): string => `${edgeIdentity(before)}=>${edgeIdentity(after)}`;

const identityMatch = (
  beforeStableKey: string,
  afterStableKey: string,
): string => `${beforeStableKey}=>${afterStableKey}`;

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const parseRequest = (input: unknown): PatchFilterRequest => {
  try {
    const parsed = PatchFilterRequestSchema.parse(input);
    return {
      ...parsed,
      changedFiles: [...parsed.changedFiles].sort(compareChangedFiles),
    };
  } catch (error) {
    if (error instanceof ZodError)
      throw new PatchFilterError(
        "invalid-input",
        `patch filter request is invalid: ${error.message}`,
      );
    throw error;
  }
};

type PathSets = {
  active: Record<PatchFilterSide, Set<string>>;
  generated: Record<PatchFilterSide, Set<string>>;
};

const pathSetsFor = (request: PatchFilterRequest): PathSets => {
  const active: PathSets["active"] = { before: new Set(), after: new Set() };
  const generated: PathSets["generated"] = {
    before: new Set(),
    after: new Set(),
  };
  for (const file of request.changedFiles) {
    const paths: Record<PatchFilterSide, string[]> = {
      before:
        file.status === "added"
          ? []
          : [
              file.status === "renamed"
                ? (file.previousPath as string)
                : file.path,
            ],
      after: file.status === "removed" ? [] : [file.path],
    };
    for (const side of ["before", "after"] as const) {
      for (const path of paths[side]) {
        if (file.generated && !request.includeGenerated)
          generated[side].add(path);
        else active[side].add(path);
      }
    }
  }
  return { active, generated };
};

const pathClass = (
  paths: readonly string[],
  side: PatchFilterSide,
  sets: PathSets,
): "active" | "generated" | undefined => {
  if (paths.some((path) => sets.active[side].has(path))) return "active";
  if (paths.some((path) => sets.generated[side].has(path))) return "generated";
  return undefined;
};

type Roots = {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  diagnosticIds: Set<string>;
};

const emptyRoots = (): Roots => ({
  nodeIds: new Set(),
  edgeIds: new Set(),
  diagnosticIds: new Set(),
});

const rootsFor = (
  snapshot: GraphSnapshot,
  side: PatchFilterSide,
  sets: PathSets,
): Roots => {
  const roots = emptyRoots();
  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  for (const node of snapshot.nodes) {
    if (pathClass(nodePaths(node), side, sets) === "active")
      roots.nodeIds.add(node.id);
  }
  for (const edge of snapshot.edges) {
    if (pathClass(edgePaths(edge), side, sets) !== "active") continue;
    const identity = edgeIdentity(edge);
    roots.edgeIds.add(identity);
  }
  for (const diagnostic of snapshot.diagnostics) {
    if (pathClass(diagnosticPaths(diagnostic), side, sets) !== "active")
      continue;
    roots.diagnosticIds.add(diagnostic.id);
    if (diagnostic.nodeId !== undefined && nodeIds.has(diagnostic.nodeId))
      roots.nodeIds.add(diagnostic.nodeId);
    if (diagnostic.edge !== undefined) {
      roots.edgeIds.add(edgeIdentity(diagnostic.edge));
    }
  }
  return roots;
};

type SideSelectionResult = {
  selection: PatchFilterSideSelection;
  nodeDepths: Map<string, number>;
  selectedEdgeIds: Set<string>;
  selectedDiagnosticIds: Set<string>;
  generatedNodeIds: Set<string>;
};

const sideSelection = (
  snapshot: GraphSnapshot,
  side: PatchFilterSide,
  roots: Roots,
  request: PatchFilterRequest,
  sets: PathSets,
): SideSelectionResult => {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const generatedNodeIds = new Set(
    snapshot.nodes
      .filter((node) => pathClass(nodePaths(node), side, sets) === "generated")
      .map((node) => node.id),
  );
  const nodeDepths = new Map<string, number>();
  for (const nodeId of [...roots.nodeIds].sort(compareStrings)) {
    if (!generatedNodeIds.has(nodeId) && nodeById.has(nodeId))
      nodeDepths.set(nodeId, 0);
  }

  // A changed edge or diagnostic can point at an unchanged endpoint. Keep
  // that endpoint visible as one-hop context without making it a changed root.
  for (const edge of snapshot.edges) {
    if (!roots.edgeIds.has(edgeIdentity(edge))) continue;
    for (const nodeId of [edge.from, edge.to]) {
      if (generatedNodeIds.has(nodeId) || nodeDepths.has(nodeId)) continue;
      nodeDepths.set(nodeId, request.contextDepth === 0 ? 0 : 1);
    }
  }
  for (const diagnostic of snapshot.diagnostics) {
    if (
      !roots.diagnosticIds.has(diagnostic.id) ||
      diagnostic.edge === undefined
    )
      continue;
    for (const nodeId of [diagnostic.edge.from, diagnostic.edge.to]) {
      if (generatedNodeIds.has(nodeId) || nodeDepths.has(nodeId)) continue;
      nodeDepths.set(nodeId, request.contextDepth === 0 ? 0 : 1);
    }
  }

  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of snapshot.edges) {
    if (
      pathClass(edgePaths(edge), side, sets) === "generated" ||
      generatedNodeIds.has(edge.from) ||
      generatedNodeIds.has(edge.to)
    )
      continue;
    for (const nodeId of [edge.from, edge.to]) {
      const outgoing = adjacency.get(nodeId) ?? [];
      outgoing.push(edge);
      adjacency.set(nodeId, outgoing);
    }
  }
  for (const edges of adjacency.values())
    edges.sort((left, right) =>
      compareStrings(edgeIdentity(left), edgeIdentity(right)),
    );

  const queue = [...nodeDepths.entries()]
    .filter(([, depth]) => depth === 0)
    .map(([nodeId]) => nodeId)
    .sort(compareStrings);
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    if (nodeId === undefined) continue;
    const depth = nodeDepths.get(nodeId);
    if (depth === undefined) continue;
    if (depth >= request.contextDepth) continue;
    for (const edge of adjacency.get(nodeId) ?? []) {
      const nextNodeId = edge.from === nodeId ? edge.to : edge.from;
      if (generatedNodeIds.has(nextNodeId) || nodeDepths.has(nextNodeId))
        continue;
      nodeDepths.set(nextNodeId, depth + 1);
      queue.push(nextNodeId);
    }
  }

  if (nodeDepths.size > request.maxNodes)
    throw new PatchFilterError(
      "resource-limit",
      `patch filter selection exceeds the ${request.maxNodes.toLocaleString("en-US")} node ceiling`,
    );

  const selectedNodes = [...nodeDepths.entries()]
    .map(([id, depth]) => {
      const node = nodeById.get(id) as GraphNode;
      return {
        side,
        id: node.id,
        stableKey: node.stableKey,
        role: depth === 0 ? ("changed" as const) : ("context" as const),
        depth,
        evidencePaths: nodePaths(node),
      };
    })
    .sort((left, right) => {
      const depthOrder = compareNumbers(left.depth, right.depth);
      if (depthOrder !== 0) return depthOrder;
      const stableOrder = compareStrings(left.stableKey, right.stableKey);
      return stableOrder !== 0
        ? stableOrder
        : compareStrings(left.id, right.id);
    });

  const selectedEdgeIds = new Set<string>();
  const selectedEdges: PatchFilterSelectedEdge[] = [];
  for (const edge of snapshot.edges) {
    if (pathClass(edgePaths(edge), side, sets) === "generated") continue;
    const identity = edgeIdentity(edge);
    const fromDepth = nodeDepths.get(edge.from);
    const toDepth = nodeDepths.get(edge.to);
    const root = roots.edgeIds.has(identity);
    const bothRoots = fromDepth === 0 && toDepth === 0;
    const withinContext =
      fromDepth !== undefined &&
      toDepth !== undefined &&
      (request.contextDepth === 0
        ? bothRoots
        : Math.min(fromDepth, toDepth) < request.contextDepth);
    if (!root && !bothRoots && !withinContext) continue;
    const depth =
      root || bothRoots ? 0 : Math.max(fromDepth ?? 0, toDepth ?? 0);
    selectedEdgeIds.add(identity);
    selectedEdges.push({
      side,
      identity,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      role: root || bothRoots ? "changed" : "context",
      depth,
      evidencePaths: edgePaths(edge),
    });
  }
  if (selectedEdges.length > request.maxEdges)
    throw new PatchFilterError(
      "resource-limit",
      `patch filter selection exceeds the ${request.maxEdges.toLocaleString("en-US")} edge ceiling`,
    );
  selectedEdges.sort((left, right) => {
    const depthOrder = compareNumbers(left.depth, right.depth);
    return depthOrder !== 0
      ? depthOrder
      : compareStrings(left.identity, right.identity);
  });

  const selectedDiagnosticIds = new Set<string>();
  const selectedDiagnostics: PatchFilterSelectedDiagnostic[] = [];
  for (const diagnostic of snapshot.diagnostics) {
    if (pathClass(diagnosticPaths(diagnostic), side, sets) === "generated")
      continue;
    const root = roots.diagnosticIds.has(diagnostic.id);
    const depths: number[] = [];
    if (diagnostic.nodeId !== undefined) {
      const depth = nodeDepths.get(diagnostic.nodeId);
      if (depth !== undefined) depths.push(depth);
    }
    if (diagnostic.edge !== undefined) {
      const fromDepth = nodeDepths.get(diagnostic.edge.from);
      const toDepth = nodeDepths.get(diagnostic.edge.to);
      if (fromDepth !== undefined) depths.push(fromDepth);
      if (toDepth !== undefined) depths.push(toDepth);
    }
    const depth = depths.length > 0 ? Math.min(...depths) : undefined;
    const inContext =
      depth !== undefined &&
      (request.contextDepth === 0
        ? depth === 0
        : depth <= request.contextDepth);
    if (!root && !inContext) continue;
    const selectedDepth = root ? 0 : (depth as number);
    selectedDiagnosticIds.add(diagnostic.id);
    selectedDiagnostics.push({
      side,
      id: diagnostic.id,
      role: selectedDepth === 0 ? "changed" : "context",
      depth: selectedDepth,
      evidencePaths: diagnosticPaths(diagnostic),
    });
  }
  if (selectedDiagnostics.length > request.maxDiagnostics)
    throw new PatchFilterError(
      "resource-limit",
      `patch filter selection exceeds the ${request.maxDiagnostics.toLocaleString("en-US")} diagnostic ceiling`,
    );
  selectedDiagnostics.sort((left, right) => {
    const depthOrder = compareNumbers(left.depth, right.depth);
    return depthOrder !== 0 ? depthOrder : compareStrings(left.id, right.id);
  });

  return {
    selection: {
      nodes: selectedNodes,
      edges: selectedEdges,
      diagnostics: selectedDiagnostics,
    },
    nodeDepths,
    selectedEdgeIds,
    selectedDiagnosticIds,
    generatedNodeIds,
  };
};

const selectedNode = (side: SideSelectionResult, node: GraphNode): boolean =>
  side.nodeDepths.has(node.id);

const selectedEdge = (
  side: SideSelectionResult,
  edge: Pick<GraphEdge, "from" | "to" | "kind">,
): boolean => side.selectedEdgeIds.has(edgeIdentity(edge));

const selectedDiagnostic = (
  side: SideSelectionResult,
  diagnostic: Diagnostic,
): boolean => side.selectedDiagnosticIds.has(diagnostic.id);

const diffSelectionFor = (
  diff: GraphDiff,
  before: SideSelectionResult,
  after: SideSelectionResult,
): PatchFilterDiffSelection => {
  const nodes = {
    added: sortedUnique(
      diff.nodes.added
        .filter((node) => selectedNode(after, node))
        .map((node) => node.stableKey),
    ),
    removed: sortedUnique(
      diff.nodes.removed
        .filter((node) => selectedNode(before, node))
        .map((node) => node.stableKey),
    ),
    changed: sortedUnique(
      diff.nodes.changed
        .filter(
          (change) =>
            selectedNode(before, change.before) ||
            selectedNode(after, change.after),
        )
        .map((change) => change.stableKey),
    ),
  };
  const identity = {
    matches: sortedUnique(
      diff.identity.matches
        .filter(
          (match) =>
            selectedNode(before, match.before) ||
            selectedNode(after, match.after),
        )
        .map((match) =>
          identityMatch(match.beforeStableKey, match.afterStableKey),
        ),
    ),
    ambiguous: sortedUnique(
      diff.identity.ambiguous
        .filter(
          (ambiguity) =>
            selectedNode(before, ambiguity.before) ||
            ambiguity.candidates.some((candidate) =>
              [...after.nodeDepths.keys()].some(
                (id) =>
                  candidate.afterStableKey ===
                  (after.selection.nodes.find((node) => node.id === id)
                    ?.stableKey ?? ""),
              ),
            ),
        )
        .map((ambiguity) => ambiguity.before.stableKey),
    ),
    unsupported: sortedUnique(
      diff.identity.unsupported
        .filter(
          (candidate) =>
            selectedNode(before, candidate.before) ||
            selectedNode(after, candidate.after),
        )
        .map((candidate) =>
          identityMatch(candidate.before.stableKey, candidate.after.stableKey),
        ),
    ),
  };
  const edges = {
    added: sortedUnique(
      diff.edges.added
        .filter((edge) => selectedEdge(after, edge))
        .map((edge) => edgeIdentity(edge)),
    ),
    removed: sortedUnique(
      diff.edges.removed
        .filter((edge) => selectedEdge(before, edge))
        .map((edge) => edgeIdentity(edge)),
    ),
    changed: sortedUnique(
      diff.edges.changed
        .filter(
          (change) =>
            selectedEdge(before, change.before) ||
            selectedEdge(after, change.after),
        )
        .map((change) => edgeIdentity(change.after)),
    ),
    rewired: sortedUnique(
      diff.edges.rewired
        .filter(
          (change) =>
            selectedEdge(before, change.before) ||
            selectedEdge(after, change.after),
        )
        .map((change) => changedIdentity(change.before, change.after)),
    ),
  };
  const diagnostics = {
    added: sortedUnique(
      diff.diagnostics.added
        .filter((diagnostic) => selectedDiagnostic(after, diagnostic))
        .map((diagnostic) => diagnostic.id),
    ),
    removed: sortedUnique(
      diff.diagnostics.removed
        .filter((diagnostic) => selectedDiagnostic(before, diagnostic))
        .map((diagnostic) => diagnostic.id),
    ),
    changed: sortedUnique(
      diff.diagnostics.changed
        .filter(
          (change) =>
            selectedDiagnostic(before, change.before) ||
            selectedDiagnostic(after, change.after),
        )
        .map((change) => change.id),
    ),
  };
  return { nodes, identity, edges, diagnostics };
};

const omittedRegion = (
  side: PatchFilterSide,
  kind: PatchFilterOmittedRegion["kind"],
  identity: string,
  evidence: string[],
  reason: PatchFilterOmittedRegion["reason"],
): PatchFilterOmittedRegion => ({
  side,
  kind,
  identity,
  evidencePaths: evidence,
  reason,
});

const omittedForSide = (
  snapshot: GraphSnapshot,
  side: PatchFilterSide,
  result: SideSelectionResult,
  sets: PathSets,
): PatchFilterOmittedRegion[] => {
  const regions: PatchFilterOmittedRegion[] = [];
  for (const node of snapshot.nodes) {
    if (result.nodeDepths.has(node.id)) continue;
    regions.push(
      omittedRegion(
        side,
        "node",
        node.stableKey,
        nodePaths(node),
        result.generatedNodeIds.has(node.id) ||
          pathClass(nodePaths(node), side, sets) === "generated"
          ? "generated-file"
          : "outside-patch-context",
      ),
    );
  }
  for (const edge of snapshot.edges) {
    if (result.selectedEdgeIds.has(edgeIdentity(edge))) continue;
    const generated =
      pathClass(edgePaths(edge), side, sets) === "generated" ||
      result.generatedNodeIds.has(edge.from) ||
      result.generatedNodeIds.has(edge.to);
    regions.push(
      omittedRegion(
        side,
        "edge",
        edgeIdentity(edge),
        edgePaths(edge),
        generated ? "generated-file" : "outside-patch-context",
      ),
    );
  }
  for (const diagnostic of snapshot.diagnostics) {
    if (result.selectedDiagnosticIds.has(diagnostic.id)) continue;
    const generated =
      pathClass(diagnosticPaths(diagnostic), side, sets) === "generated" ||
      (diagnostic.nodeId !== undefined &&
        result.generatedNodeIds.has(diagnostic.nodeId));
    regions.push(
      omittedRegion(
        side,
        "diagnostic",
        diagnostic.id,
        diagnosticPaths(diagnostic),
        generated ? "generated-file" : "outside-patch-context",
      ),
    );
  }
  return regions.sort((left, right) => {
    const sideOrder = compareStrings(left.side, right.side);
    if (sideOrder !== 0) return sideOrder;
    const kindOrder = compareStrings(left.kind, right.kind);
    return kindOrder !== 0
      ? kindOrder
      : compareStrings(left.identity, right.identity);
  });
};

const countsFor = (
  snapshot: GraphSnapshot,
  selection: PatchFilterSideSelection,
): PatchFilterCounts["before"] => ({
  nodes: snapshot.nodes.length,
  edges: snapshot.edges.length,
  diagnostics: snapshot.diagnostics.length,
  selectedNodes: selection.nodes.length,
  selectedEdges: selection.edges.length,
  selectedDiagnostics: selection.diagnostics.length,
  omittedNodes: snapshot.nodes.length - selection.nodes.length,
  omittedEdges: snapshot.edges.length - selection.edges.length,
  omittedDiagnostics:
    snapshot.diagnostics.length - selection.diagnostics.length,
});

const selectedPolicyReferences = (
  diffSelection: PatchFilterDiffSelection,
  before: SideSelectionResult,
  after: SideSelectionResult,
): Set<string> => {
  const refs = new Set<string>();
  for (const selection of [before.selection, after.selection]) {
    for (const node of selection.nodes) {
      refs.add(`node:${node.id}`);
      refs.add(`node:${node.stableKey}`);
    }
    for (const edge of selection.edges) refs.add(`edge:${edge.identity}`);
    for (const diagnostic of selection.diagnostics)
      refs.add(`diagnostic:${diagnostic.id}`);
  }
  for (const stableKey of diffSelection.nodes.added)
    refs.add(`node-added:${stableKey}`);
  for (const stableKey of diffSelection.nodes.removed)
    refs.add(`node-removed:${stableKey}`);
  for (const stableKey of diffSelection.nodes.changed)
    refs.add(`node-changed:${stableKey}`);
  for (const identity of diffSelection.edges.added)
    refs.add(`edge-added:edge:${identity}`);
  for (const identity of diffSelection.edges.removed)
    refs.add(`edge-removed:edge:${identity}`);
  for (const identity of diffSelection.edges.changed)
    refs.add(`edge-changed:edge:${identity}`);
  for (const identity of diffSelection.edges.rewired)
    refs.add(`edge-rewired:${identity}`);
  for (const id of diffSelection.diagnostics.added)
    refs.add(`diagnostic-added:${id}`);
  for (const id of diffSelection.diagnostics.removed)
    refs.add(`diagnostic-removed:${id}`);
  for (const id of diffSelection.diagnostics.changed)
    refs.add(`diagnostic-changed:${id}`);
  return refs;
};

const policyFor = (
  policyInput: unknown,
  selectedRefs: Set<string>,
): PatchFilterPolicy => {
  if (policyInput === undefined) {
    return {
      source: "not-provided",
      status: "not-provided",
      evaluationDigest: null,
      violationIds: [],
      retainedViolationIds: [],
      omittedViolationIds: [],
      unsupportedIds: [],
      preserved: true,
    };
  }
  let evaluation: PolicyEvaluation;
  try {
    evaluation = PolicyEvaluationSchema.parse(policyInput);
  } catch (error) {
    throw new PatchFilterError(
      "invalid-input",
      `full-diff policy evaluation is invalid: ${
        error instanceof ZodError ? error.message : String(error)
      }`,
    );
  }
  if (evaluation.inputKind !== "diff")
    throw new PatchFilterError(
      "conflict",
      "patch filtering requires a policy evaluation produced from the full GraphDiff",
    );
  const violations = evaluation.violations.map((violation) => violation.id);
  const retainedViolationIds: string[] = [];
  const omittedViolationIds: string[] = [];
  for (const violation of evaluation.violations) {
    const matches = violation.matches;
    if (
      matches.length === 0 ||
      matches.some((match) => selectedRefs.has(match))
    )
      retainedViolationIds.push(violation.id);
    else omittedViolationIds.push(violation.id);
  }
  return {
    source: "full-diff",
    status: evaluation.status,
    evaluationDigest: digest(evaluation),
    violationIds: sortedUnique(violations),
    retainedViolationIds: sortedUnique(retainedViolationIds),
    omittedViolationIds: sortedUnique(omittedViolationIds),
    unsupportedIds: sortedUnique(evaluation.unsupported.map((item) => item.id)),
    preserved: true,
  };
};

const parseRevision = (input: unknown): Revision => RevisionSchema.parse(input);

const selectedReportBase = (
  diff: GraphDiff,
  request: PatchFilterRequest,
  selection: PatchFilterSelection,
  omitted: PatchFilterReport["omitted"],
  policy: PatchFilterPolicy,
): Omit<PatchFilterReport, "reportDigest"> => ({
  schemaVersion: PATCH_FILTER_SCHEMA_VERSION,
  contract: PATCH_FILTER_CONTRACT,
  mediaType: PATCH_FILTER_MEDIA_TYPE,
  filterId: request.filterId,
  fromRevision: parseRevision(diff.fromRevision),
  toRevision: parseRevision(diff.toRevision),
  requestDigest: digest(request),
  selection,
  omitted,
  policy,
  deterministic: true,
  readOnly: true,
});

const parseReport = (input: unknown): PatchFilterReport => {
  try {
    return PatchFilterReportSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError)
      throw new PatchFilterError(
        "invalid-input",
        `patch filter report is invalid: ${error.message}`,
      );
    throw error;
  }
};

/**
 * Select changed-file evidence and a bounded one-hop context from a canonical
 * GraphDiff plus its before/after snapshots. Generated paths are excluded by
 * default, renames root both sides, and the full-diff policy status is carried
 * without re-evaluating or downgrading it on the filtered view.
 */
export const createPatchFilterReport = (
  options: PatchFilterOptions,
): PatchFilterReport => {
  const request = parseRequest(options.request);
  let diff: GraphDiff;
  let before: GraphSnapshot;
  let after: GraphSnapshot;
  try {
    diff = canonicalizeGraphDiff(options.diff);
    before = canonicalizeGraphSnapshot(options.before);
    after = canonicalizeGraphSnapshot(options.after);
  } catch (error) {
    throw new PatchFilterError(
      "invalid-input",
      `patch filter graph input is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    diff.fromRevision.commitSha !== before.revision.commitSha ||
    diff.toRevision.commitSha !== after.revision.commitSha
  )
    throw new PatchFilterError(
      "conflict",
      "GraphDiff revisions must match the before and after snapshots",
    );

  const sets = pathSetsFor(request);
  const beforeRoots = rootsFor(before, "before", sets);
  const afterRoots = rootsFor(after, "after", sets);
  const beforeSelection = sideSelection(
    before,
    "before",
    beforeRoots,
    request,
    sets,
  );
  const afterSelection = sideSelection(
    after,
    "after",
    afterRoots,
    request,
    sets,
  );
  const diffSelection = diffSelectionFor(diff, beforeSelection, afterSelection);
  const selection: PatchFilterSelection = {
    changedFiles: request.changedFiles,
    roots: {
      before: {
        nodeIds: [...beforeRoots.nodeIds].sort(compareStrings),
        edgeIds: [...beforeRoots.edgeIds].sort(compareStrings),
        diagnosticIds: [...beforeRoots.diagnosticIds].sort(compareStrings),
      },
      after: {
        nodeIds: [...afterRoots.nodeIds].sort(compareStrings),
        edgeIds: [...afterRoots.edgeIds].sort(compareStrings),
        diagnosticIds: [...afterRoots.diagnosticIds].sort(compareStrings),
      },
    },
    before: beforeSelection.selection,
    after: afterSelection.selection,
    diff: diffSelection,
  };
  const regions = [
    ...omittedForSide(before, "before", beforeSelection, sets),
    ...omittedForSide(after, "after", afterSelection, sets),
  ].sort((left, right) => {
    const sideOrder = compareStrings(left.side, right.side);
    if (sideOrder !== 0) return sideOrder;
    const kindOrder = compareStrings(left.kind, right.kind);
    return kindOrder !== 0
      ? kindOrder
      : compareStrings(left.identity, right.identity);
  });
  if (regions.length > request.maxOmittedRegions)
    throw new PatchFilterError(
      "resource-limit",
      `patch filter omitted-region report exceeds the ${request.maxOmittedRegions.toLocaleString("en-US")} item ceiling`,
    );
  const omitted = {
    files: request.changedFiles
      .filter((file) => file.generated && !request.includeGenerated)
      .map((file) => ({ ...file, reason: "generated-file" as const })),
    regions,
    counts: {
      before: countsFor(before, beforeSelection.selection),
      after: countsFor(after, afterSelection.selection),
      omittedRegions: regions.length,
    },
  } satisfies PatchFilterReport["omitted"];
  const policy = policyFor(
    options.policyEvaluation,
    selectedPolicyReferences(diffSelection, beforeSelection, afterSelection),
  );
  const base = selectedReportBase(diff, request, selection, omitted, policy);
  const report = parseReport({ ...base, reportDigest: digest(base) });
  return report;
};

export const filterGraphDiff = createPatchFilterReport;

export const parsePatchFilterRequest = (input: unknown): PatchFilterRequest =>
  parseRequest(input);

export const parsePatchFilterReport = (input: unknown): PatchFilterReport => {
  const report = parseReport(input);
  const { reportDigest, ...base } = report;
  if (digest(base) !== reportDigest)
    throw new PatchFilterError(
      "invalid-input",
      "patch filter report digest does not match its content",
    );
  return report;
};

export const serializePatchFilterReport = (input: unknown): string =>
  stableStringify(parsePatchFilterReport(input));
