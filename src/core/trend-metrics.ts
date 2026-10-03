import { z } from "zod";

import type { AdrReferenceDocument } from "./adr.js";
import { diffGraphSnapshots } from "./diff.js";
import { evaluatePolicyOnSnapshot } from "./policy-evaluation.js";
import { edgeCycles } from "./policy-paths.js";
import type { PolicyConfig } from "./policy.js";
import type { GraphEdge, GraphNode, GraphSnapshot } from "./schemas.js";

export const TREND_METRICS_SCHEMA_VERSION = 1 as const;
export const TREND_METRICS_CONTRACT = "cartograph.trend-metrics" as const;
/** Bumped whenever a metric's definition, scope, or denominator changes. */
export const TREND_METRICS_VERSION = 1 as const;

export type TrendMetricValue =
  | {
      id: string;
      status: "measured";
      value: number;
      numerator: number;
      denominator: number;
      scope: string;
      /**
       * The range the value could take if every unknown in scope resolved
       * against or in favour of the numerator.
       */
      uncertainty?: { lower: number; upper: number; unknowns: number };
    }
  | { id: string; status: "unavailable"; reason: string; scope: string };

export type TrendRevisionInput = {
  revision: string;
  snapshot?: GraphSnapshot;
  /** Content address of the stored snapshot the metrics were computed from. */
  recordId?: string;
  recordSchemaVersion?: number;
  policy?: PolicyConfig;
  decisions?: AdrReferenceDocument;
  policyRecordId?: string;
  decisionsRecordId?: string;
  /** Contract version the stored snapshot was migrated from on import. */
  migratedFrom?: number;
  /** The revision's snapshot was removed by a retention policy. */
  removed?: boolean;
};

export const TREND_BREAK_REASONS = [
  "missing-revision",
  "removed-by-retention",
  "partial-snapshot",
  "contract-change",
  "adapter-change",
  "policy-change",
  "decisions-change",
  "workspace-scope-change",
  "migration",
  "sampling-change",
] as const;
export type TrendBreakReason = (typeof TREND_BREAK_REASONS)[number];

export type TrendMark = { reason: TrendBreakReason; detail?: string };

export type TrendRevision = {
  revision: string;
  status: "measured" | "missing";
  marks: TrendMark[];
  evidence?: {
    recordId?: string;
    snapshotSchemaVersion: number;
    recordSchemaVersion?: number;
    capabilityRegistryVersion: number;
    migratedFrom?: number;
    policyRecordId?: string;
    decisionsRecordId?: string;
    /** Extractor identities (`name@version`) that produced evidence. */
    extractors: string[];
    /** Workspace package nodes the snapshot covers. */
    workspaceScope: string[];
    /** Evidence kinds present (source, runtime, git, user). */
    evidenceKinds: string[];
  };
  metrics: TrendMetricValue[];
};

export type TrendMetricChange =
  | {
      id: string;
      status: "comparable";
      from: number;
      to: number;
      delta: number;
    }
  | {
      id: string;
      status: "incomparable";
      from: number;
      to: number;
      reasons: TrendBreakReason[];
    }
  | { id: string; status: "unavailable" };

export type TrendExplanation = {
  from: string;
  to: string;
  reason: TrendBreakReason;
  reviewer: string;
  note: string;
};

export type TrendInterval = {
  from: string;
  to: string;
  breaks: (TrendMark & { explanation?: { reviewer: string; note: string } })[];
  /** Per-revision metric changes; incomparable values never get a delta. */
  changes: TrendMetricChange[];
  metrics: TrendMetricValue[];
};

export type TrendRestatement = {
  revision: string;
  metric: string;
  previous: number | "unavailable";
  current: number | "unavailable";
  reasons: (
    | "evidence-changed"
    | "metrics-version-change"
    | "policy-change"
    | "decisions-change"
  )[];
};

export type TrendMetricsReport = {
  schemaVersion: typeof TREND_METRICS_SCHEMA_VERSION;
  contract: typeof TREND_METRICS_CONTRACT;
  metricsVersion: typeof TREND_METRICS_VERSION;
  revisions: TrendRevision[];
  intervals: TrendInterval[];
  restatements: TrendRestatement[];
  unexplainedBreaks: number;
};

const ratio = (
  id: string,
  numerator: number,
  denominator: number,
  scope: string,
): TrendMetricValue =>
  denominator === 0
    ? { id, status: "unavailable", reason: `no ${scope} to measure`, scope }
    : {
        id,
        status: "measured",
        value: Number((numerator / denominator).toFixed(6)),
        numerator,
        denominator,
        scope,
      };

const unavailable = (
  id: string,
  reason: string,
  scope: string,
): TrendMetricValue => ({ id, status: "unavailable", reason, scope });

const SOURCE_ROOTS = new Set(["src", "lib", "app", "source"]);

/**
 * The architectural boundary a module belongs to: `packages/<name>`,
 * `<src|lib|app|source>/<directory>`, or otherwise its top-level directory.
 * Files directly in a root directory belong to that root.
 */
export const moduleBoundary = (path: string): string => {
  const parts = path.split("/");
  const first = parts[0] ?? path;
  if (parts.length > 2 && (first === "packages" || SOURCE_ROOTS.has(first)))
    return `${first}/${parts[1] ?? ""}`;
  return parts.length > 1 ? first : ".";
};

const localModules = (snapshot: GraphSnapshot): Map<string, GraphNode> =>
  new Map(
    snapshot.nodes
      .filter((node) => node.kind === "module" && node.location !== undefined)
      .map((node) => [node.id, node]),
  );

const localImports = (
  snapshot: GraphSnapshot,
  modules: Map<string, GraphNode>,
): GraphEdge[] =>
  snapshot.edges.filter(
    (edge) =>
      edge.kind === "imports" && modules.has(edge.from) && modules.has(edge.to),
  );

const revisionMetrics = (input: TrendRevisionInput): TrendMetricValue[] => {
  const snapshot = input.snapshot;
  if (snapshot === undefined) return [];
  const modules = localModules(snapshot);
  const imports = localImports(snapshot, modules);
  const boundaryOf = (id: string): string =>
    moduleBoundary(modules.get(id)?.location?.path ?? id);

  const crossing = imports.filter(
    (edge) => boundaryOf(edge.from) !== boundaryOf(edge.to),
  );
  const directions = new Set(
    crossing.map((edge) => `${boundaryOf(edge.from)}\0${boundaryOf(edge.to)}`),
  );
  const pairs = new Set(
    [...directions].map((key) => {
      const [from, to] = key.split("\0") as [string, string];
      return from < to ? `${from}\0${to}` : `${to}\0${from}`;
    }),
  );
  const tangled = [...pairs].filter((key) => {
    const [left, right] = key.split("\0") as [string, string];
    return (
      directions.has(`${left}\0${right}`) && directions.has(`${right}\0${left}`)
    );
  });

  const cycles = edgeCycles(imports);
  const modulesInCycles = new Set(
    cycles.flatMap((cycle) => cycle.flatMap((edge) => [edge.from, edge.to])),
  );

  const unresolvedEdges = snapshot.edges.filter(
    (edge) => edge.evidence.length === 0 || edge.unresolvedReason !== undefined,
  ).length;

  // Imports from local modules whose target is unknown could cross a
  // boundary or not; they widen the band rather than move the value.
  const unknownImports = snapshot.edges.filter(
    (edge) =>
      edge.kind === "imports" &&
      modules.has(edge.from) &&
      edge.unresolvedReason !== undefined,
  ).length;
  const crossingMetric = ratio(
    "boundary-crossing-imports",
    crossing.length,
    imports.length,
    "local module imports",
  );
  if (crossingMetric.status === "measured" && unknownImports > 0) {
    const total = imports.length + unknownImports;
    crossingMetric.uncertainty = {
      lower: Number((crossing.length / total).toFixed(6)),
      upper: Number(((crossing.length + unknownImports) / total).toFixed(6)),
      unknowns: unknownImports,
    };
  }

  const metrics: TrendMetricValue[] = [
    crossingMetric,
    ratio(
      "bidirectional-boundary-pairs",
      tangled.length,
      pairs.size,
      "boundary pairs connected by imports",
    ),
    ratio(
      "modules-in-import-cycles",
      modulesInCycles.size,
      modules.size,
      "local modules",
    ),
    ratio("import-cycle-groups", cycles.length, modules.size, "local modules"),
    ratio(
      "unresolved-edges",
      unresolvedEdges,
      snapshot.edges.length,
      "graph edges",
    ),
    ratio(
      "diagnostics-per-node",
      snapshot.diagnostics.length,
      snapshot.nodes.length,
      "graph nodes",
    ),
  ];

  if (input.policy === undefined)
    metrics.push(
      unavailable(
        "policy-violation-rate",
        "no policy record for this revision",
        "evaluated policy rules",
      ),
    );
  else {
    const evaluation = evaluatePolicyOnSnapshot(input.policy, snapshot);
    metrics.push(
      ratio(
        "policy-violation-rate",
        evaluation.violations.length,
        evaluation.evaluatedRules,
        "evaluated policy rules",
      ),
    );
  }

  if (input.decisions === undefined)
    metrics.push(
      unavailable(
        "decision-coverage",
        "no decisions record for this revision",
        "local modules",
      ),
    );
  else {
    const covered = new Set(
      input.decisions.references.flatMap((reference) =>
        reference.graphIds
          .filter((graphId) => !graphId.startsWith("edge:"))
          .map((graphId) =>
            graphId.startsWith("node:")
              ? graphId.slice("node:".length)
              : graphId,
          ),
      ),
    );
    metrics.push(
      ratio(
        "decision-coverage",
        [...modules.values()].filter(
          (node) => covered.has(node.id) || covered.has(node.stableKey),
        ).length,
        modules.size,
        "local modules",
      ),
    );
  }

  for (const [id, scope] of [
    ["ownership-coverage", "local modules"],
    ["active-waivers", "policy findings"],
    ["runtime-reconciled-edges", "graph edges"],
  ] as const)
    metrics.push(
      unavailable(
        id,
        "the history store does not record this evidence yet",
        scope,
      ),
    );
  return metrics;
};

const intervalMetrics = (
  before: GraphSnapshot,
  after: GraphSnapshot,
): TrendMetricValue[] => {
  const diff = diffGraphSnapshots(before, after);
  const summary = diff.summary;
  const renamed = diff.identity.matches.filter(
    (match) => match.method !== "stable-key",
  ).length;
  const nodeChanges =
    summary.nodesAdded + summary.nodesRemoved + summary.nodesChanged;
  const edgeChanges =
    summary.edgesAdded + summary.edgesRemoved + summary.edgesChanged;
  return [
    ratio(
      "node-churn",
      nodeChanges,
      Math.max(before.nodes.length, after.nodes.length),
      "graph nodes (larger of the two revisions)",
    ),
    ratio(
      "renamed-nodes",
      renamed,
      before.nodes.length,
      "graph nodes in the earlier revision",
    ),
    ratio(
      "edge-churn",
      edgeChanges,
      Math.max(before.edges.length, after.edges.length),
      "graph edges (larger of the two revisions)",
    ),
  ];
};

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const extractorsOf = (snapshot: GraphSnapshot): string[] =>
  [
    ...new Set(
      [
        ...snapshot.edges.flatMap((edge) => edge.evidence),
        ...snapshot.diagnostics.flatMap((item) => item.evidence ?? []),
      ].flatMap((item) =>
        item.detector === undefined
          ? []
          : [item.detector.split("/")[0] ?? item.detector],
      ),
    ),
  ].sort(compare);

const extractorName = (identity: string): string =>
  identity.slice(0, identity.lastIndexOf("@"));

const partialReasons = (snapshot: GraphSnapshot): number =>
  snapshot.diagnostics.filter(
    (item) => item.severity === "error" || item.code.startsWith("PARTIAL_"),
  ).length;

const revisionMarks = (input: TrendRevisionInput): TrendMark[] => {
  if (input.snapshot === undefined)
    return [
      input.removed === true
        ? { reason: "removed-by-retention" }
        : { reason: "missing-revision" },
    ];
  const marks: TrendMark[] = [];
  const partial = partialReasons(input.snapshot);
  if (partial > 0)
    marks.push({
      reason: "partial-snapshot",
      detail: `${partial} error or partial-analysis diagnostic(s)`,
    });
  if (input.migratedFrom !== undefined)
    marks.push({
      reason: "migration",
      detail: `snapshot migrated from contract v${input.migratedFrom}`,
    });
  return marks;
};

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  left.every((item, index) => item === right[index]);

const intervalBreaks = (
  before: TrendRevision,
  after: TrendRevision,
): TrendMark[] => {
  const breaks: TrendMark[] = [];
  for (const revision of [before, after])
    for (const mark of revision.marks)
      breaks.push({
        reason: mark.reason,
        detail: `${revision.revision}${mark.detail === undefined ? "" : `: ${mark.detail}`}`,
      });
  const left = before.evidence;
  const right = after.evidence;
  if (left === undefined || right === undefined) return breaks;
  if (
    left.snapshotSchemaVersion !== right.snapshotSchemaVersion ||
    left.capabilityRegistryVersion !== right.capabilityRegistryVersion
  )
    breaks.push({
      reason: "contract-change",
      detail: `snapshot v${left.snapshotSchemaVersion}→v${right.snapshotSchemaVersion}, capabilities v${left.capabilityRegistryVersion}→v${right.capabilityRegistryVersion}`,
    });
  const versions = (identities: readonly string[]) =>
    new Map(identities.map((item) => [extractorName(item), item]));
  const leftVersions = versions(left.extractors);
  const changed = [...versions(right.extractors)]
    .filter(([name, identity]) => {
      const previous = leftVersions.get(name);
      return previous !== undefined && previous !== identity;
    })
    .map(([, identity]) => identity);
  if (changed.length > 0)
    breaks.push({ reason: "adapter-change", detail: changed.join(", ") });
  if (left.policyRecordId !== right.policyRecordId)
    breaks.push({ reason: "policy-change" });
  if (left.decisionsRecordId !== right.decisionsRecordId)
    breaks.push({ reason: "decisions-change" });
  if (!sameSet(left.workspaceScope, right.workspaceScope))
    breaks.push({ reason: "workspace-scope-change" });
  if (!sameSet(left.evidenceKinds, right.evidenceKinds))
    breaks.push({
      reason: "sampling-change",
      detail: `evidence kinds ${left.evidenceKinds.join("+") || "none"}→${right.evidenceKinds.join("+") || "none"}`,
    });
  return breaks;
};

// Which metrics a break makes incomparable; everything else affects all.
const BREAK_SCOPE: Partial<Record<TrendBreakReason, readonly string[]>> = {
  "policy-change": ["policy-violation-rate"],
  "decisions-change": ["decision-coverage"],
};

const metricChanges = (
  before: TrendRevision,
  after: TrendRevision,
  breaks: readonly TrendMark[],
): TrendMetricChange[] =>
  after.metrics.map((metric) => {
    const previous = before.metrics.find((item) => item.id === metric.id);
    if (previous?.status !== "measured" || metric.status !== "measured")
      return { id: metric.id, status: "unavailable" };
    const reasons = [
      ...new Set(
        breaks
          .filter((item) => {
            const scope = BREAK_SCOPE[item.reason];
            return scope === undefined || scope.includes(metric.id);
          })
          .map((item) => item.reason),
      ),
    ].sort(compare);
    return reasons.length > 0
      ? {
          id: metric.id,
          status: "incomparable",
          from: previous.value,
          to: metric.value,
          reasons,
        }
      : {
          id: metric.id,
          status: "comparable",
          from: previous.value,
          to: metric.value,
          delta: Number((metric.value - previous.value).toFixed(6)),
        };
  });

const restate = (
  previous: TrendMetricsReport,
  current: readonly TrendRevision[],
  metricsVersion: number,
): TrendRestatement[] => {
  const restatements: TrendRestatement[] = [];
  const valueOf = (metric: TrendMetricValue | undefined) =>
    metric?.status === "measured" ? metric.value : ("unavailable" as const);
  for (const revision of current) {
    const old = previous.revisions.find(
      (item) => item.revision === revision.revision,
    );
    if (old === undefined) continue;
    const ids = new Set([
      ...old.metrics.map((item) => item.id),
      ...revision.metrics.map((item) => item.id),
    ]);
    for (const id of [...ids].sort(compare)) {
      const was = valueOf(old.metrics.find((item) => item.id === id));
      const now = valueOf(revision.metrics.find((item) => item.id === id));
      if (was === now) continue;
      const reasons: TrendRestatement["reasons"] = [];
      if (old.evidence?.recordId !== revision.evidence?.recordId)
        reasons.push("evidence-changed");
      if (previous.metricsVersion !== metricsVersion)
        reasons.push("metrics-version-change");
      if (old.evidence?.policyRecordId !== revision.evidence?.policyRecordId)
        reasons.push("policy-change");
      if (
        old.evidence?.decisionsRecordId !== revision.evidence?.decisionsRecordId
      )
        reasons.push("decisions-change");
      restatements.push({
        revision: revision.revision,
        metric: id,
        previous: was,
        current: now,
        reasons,
      });
    }
  }
  return restatements;
};

const CHURN_IDS = [
  ["node-churn", "graph nodes (larger of the two revisions)"],
  ["renamed-nodes", "graph nodes in the earlier revision"],
  ["edge-churn", "graph edges (larger of the two revisions)"],
] as const;

export type TrendMetricsOptions = {
  /** An earlier report for the same revisions; differences are restatements. */
  previous?: TrendMetricsReport;
  /** Reviewer notes for known breaks between two revisions. */
  explanations?: readonly TrendExplanation[];
};

/**
 * Metrics for an ordered list of revisions and the intervals between
 * neighbours. A revision without a stored snapshot is reported as missing,
 * and the intervals touching it are reported as unavailable rather than
 * bridged, so a gap in history is never mistaken for no change. Every
 * interval lists the breaks that make its revisions incomparable, and a
 * metric affected by a break gets no delta. Nothing is interpolated or
 * ranked.
 */
export const computeTrendMetrics = (
  revisions: readonly TrendRevisionInput[],
  options: TrendMetricsOptions = {},
): TrendMetricsReport => {
  const measured: TrendRevision[] = revisions.map((input) =>
    input.snapshot === undefined
      ? {
          revision: input.revision,
          status: "missing",
          marks: revisionMarks(input),
          metrics: [],
        }
      : {
          revision: input.revision,
          status: "measured",
          marks: revisionMarks(input),
          evidence: {
            ...(input.recordId === undefined
              ? {}
              : { recordId: input.recordId }),
            snapshotSchemaVersion: input.snapshot.schemaVersion,
            ...(input.recordSchemaVersion === undefined
              ? {}
              : { recordSchemaVersion: input.recordSchemaVersion }),
            capabilityRegistryVersion:
              input.snapshot.capabilityRegistryVersion ?? 0,
            ...(input.migratedFrom === undefined
              ? {}
              : { migratedFrom: input.migratedFrom }),
            ...(input.policyRecordId === undefined
              ? {}
              : { policyRecordId: input.policyRecordId }),
            ...(input.decisionsRecordId === undefined
              ? {}
              : { decisionsRecordId: input.decisionsRecordId }),
            extractors: extractorsOf(input.snapshot),
            workspaceScope: input.snapshot.nodes
              .filter((node) => node.kind === "package")
              .map((node) => node.id)
              .sort(compare),
            evidenceKinds: [
              ...new Set(
                input.snapshot.edges.flatMap((edge) =>
                  edge.evidence.map((item) => item.kind),
                ),
              ),
            ].sort(compare),
          },
          metrics: revisionMetrics(input),
        },
  );
  const intervals: TrendInterval[] = [];
  let unexplainedBreaks = 0;
  for (let index = 1; index < revisions.length; index += 1) {
    const before = revisions[index - 1] as TrendRevisionInput;
    const after = revisions[index] as TrendRevisionInput;
    const left = measured[index - 1] as TrendRevision;
    const right = measured[index] as TrendRevision;
    const breaks = intervalBreaks(left, right).map((item) => {
      const explanation = options.explanations?.find(
        (note) =>
          note.from === before.revision &&
          note.to === after.revision &&
          note.reason === item.reason,
      );
      if (explanation === undefined) unexplainedBreaks += 1;
      return explanation === undefined
        ? item
        : {
            ...item,
            explanation: {
              reviewer: explanation.reviewer,
              note: explanation.note,
            },
          };
    });
    intervals.push({
      from: before.revision,
      to: after.revision,
      breaks,
      changes: metricChanges(left, right, breaks),
      metrics:
        before.snapshot === undefined || after.snapshot === undefined
          ? [
              unavailable(
                "node-churn",
                "a snapshot for this interval is missing from history",
                "graph nodes (larger of the two revisions)",
              ),
              unavailable(
                "renamed-nodes",
                "a snapshot for this interval is missing from history",
                "graph nodes in the earlier revision",
              ),
              unavailable(
                "edge-churn",
                "a snapshot for this interval is missing from history",
                "graph edges (larger of the two revisions)",
              ),
            ]
          : breaks.some((item) => item.reason === "contract-change")
            ? CHURN_IDS.map(([id, scope]) =>
                unavailable(
                  id,
                  "the snapshots were produced under different contracts",
                  scope,
                ),
              )
            : intervalMetrics(before.snapshot, after.snapshot),
    });
  }
  return {
    schemaVersion: TREND_METRICS_SCHEMA_VERSION,
    contract: TREND_METRICS_CONTRACT,
    metricsVersion: TREND_METRICS_VERSION,
    revisions: measured,
    intervals,
    restatements:
      options.previous === undefined
        ? []
        : restate(options.previous, measured, TREND_METRICS_VERSION),
    unexplainedBreaks,
  };
};

const NoteSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine(
    (value) => !/[\0\r]/u.test(value),
    "must not contain control characters",
  );

export const TrendExplanationsSchema = z
  .object({
    schemaVersion: z.literal(1),
    contract: z.literal("cartograph.trend-explanations"),
    explanations: z
      .array(
        z
          .object({
            from: z.string().min(1).max(128),
            to: z.string().min(1).max(128),
            reason: z.enum(TREND_BREAK_REASONS),
            reviewer: z.string().trim().min(1).max(128),
            note: NoteSchema,
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict();

/** Reviewer notes that explain known breaks (`cartograph.trend-explanations` v1). */
export const parseTrendExplanations = (value: unknown): TrendExplanation[] =>
  TrendExplanationsSchema.parse(value).explanations;

const PreviousMetricSchema = z.union([
  z
    .object({
      id: z.string(),
      status: z.literal("measured"),
      value: z.number(),
    })
    .passthrough(),
  z.object({ id: z.string(), status: z.literal("unavailable") }).passthrough(),
]);

const PreviousReportSchema = z
  .object({
    contract: z.literal(TREND_METRICS_CONTRACT),
    metricsVersion: z.number().int().positive(),
    revisions: z.array(
      z
        .object({
          revision: z.string(),
          evidence: z
            .object({
              recordId: z.string().optional(),
              policyRecordId: z.string().optional(),
              decisionsRecordId: z.string().optional(),
            })
            .passthrough()
            .optional(),
          metrics: z.array(PreviousMetricSchema),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/**
 * Read an earlier trends report for restatement. Only the fields that
 * restatement compares are checked, so reports from older metric versions
 * still load.
 */
export const parseTrendMetricsReport = (value: unknown): TrendMetricsReport =>
  PreviousReportSchema.parse(value) as unknown as TrendMetricsReport;
