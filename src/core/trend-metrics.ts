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
};

export type TrendRevision = {
  revision: string;
  status: "measured" | "missing";
  evidence?: {
    recordId?: string;
    snapshotSchemaVersion: number;
    recordSchemaVersion?: number;
    capabilityRegistryVersion: number;
  };
  metrics: TrendMetricValue[];
};

export type TrendInterval = {
  from: string;
  to: string;
  metrics: TrendMetricValue[];
};

export type TrendMetricsReport = {
  schemaVersion: typeof TREND_METRICS_SCHEMA_VERSION;
  contract: typeof TREND_METRICS_CONTRACT;
  metricsVersion: typeof TREND_METRICS_VERSION;
  revisions: TrendRevision[];
  intervals: TrendInterval[];
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

  const metrics: TrendMetricValue[] = [
    ratio(
      "boundary-crossing-imports",
      crossing.length,
      imports.length,
      "local module imports",
    ),
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

/**
 * Metrics for an ordered list of revisions and the intervals between
 * neighbours. A revision without a stored snapshot is reported as missing,
 * and the intervals touching it are reported as unavailable rather than
 * bridged, so a gap in history is never mistaken for no change.
 */
export const computeTrendMetrics = (
  revisions: readonly TrendRevisionInput[],
): TrendMetricsReport => {
  const measured: TrendRevision[] = revisions.map((input) =>
    input.snapshot === undefined
      ? { revision: input.revision, status: "missing", metrics: [] }
      : {
          revision: input.revision,
          status: "measured",
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
          },
          metrics: revisionMetrics(input),
        },
  );
  const intervals: TrendInterval[] = [];
  for (let index = 1; index < revisions.length; index += 1) {
    const before = revisions[index - 1] as TrendRevisionInput;
    const after = revisions[index] as TrendRevisionInput;
    intervals.push({
      from: before.revision,
      to: after.revision,
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
          : intervalMetrics(before.snapshot, after.snapshot),
    });
  }
  return {
    schemaVersion: TREND_METRICS_SCHEMA_VERSION,
    contract: TREND_METRICS_CONTRACT,
    metricsVersion: TREND_METRICS_VERSION,
    revisions: measured,
    intervals,
  };
};
