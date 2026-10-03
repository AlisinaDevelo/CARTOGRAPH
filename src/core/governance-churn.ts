import type { ArchitectureWaiver } from "./architecture-waivers.js";
import {
  replayFindingLifecycle,
  type FindingLifecycleInput,
} from "./finding-lifecycle.js";
import type { OwnershipResolutionReport } from "./ownership.js";

export const GOVERNANCE_CHURN_SCHEMA_VERSION = 1 as const;
export const GOVERNANCE_CHURN_CONTRACT = "cartograph.governance-churn" as const;
/** Bumped whenever a measure's definition changes. */
export const GOVERNANCE_CHURN_VERSION = 1 as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const EVIDENCE_LIMIT = 100;
const GAP_STATUSES = new Set(["unowned", "ambiguous"]);
const REVIEW_STATES = new Set([
  "acknowledged",
  "waived",
  "remediated",
  "obsolete",
]);

export type OwnershipPoint = {
  revision: string;
  recordId?: string;
  report?: OwnershipResolutionReport;
};

export type GovernanceChurnInputs = {
  ownership?: readonly OwnershipPoint[];
  waivers?: readonly ArchitectureWaiver[];
  findings?: readonly FindingLifecycleInput[];
  /** A waiver created within this many days of its predecessor's expiry is a renewal. */
  renewalGraceDays?: number;
};

type Count = { numerator: number; denominator: number; evidence: string[] };

export type GovernanceChurnReport = {
  schemaVersion: typeof GOVERNANCE_CHURN_SCHEMA_VERSION;
  contract: typeof GOVERNANCE_CHURN_CONTRACT;
  measuresVersion: typeof GOVERNANCE_CHURN_VERSION;
  asOf: string;
  /** Measures are reported separately on purpose; there is no combined score. */
  limitation: string;
  ownership:
    | { status: "unavailable"; reason: string }
    | {
        status: "measured";
        points: {
          revision: string;
          recordId?: string;
          status: "measured" | "missing";
          targets?: number;
          gaps?: number;
        }[];
        intervals: (
          | { from: string; to: string; status: "missing-history" }
          | {
              from: string;
              to: string;
              status: "measured";
              /** True when both revisions were measured and nothing changed. */
              verifiedNoChange: boolean;
              ownerChanges: Count;
              gapsOpened: Count;
              gapsClosed: Count;
              targetsAdded: number;
              targetsRemoved: number;
            }
        )[];
        gapRecurrence: Count;
      };
  waivers:
    | { status: "unavailable"; reason: string }
    | {
        status: "measured";
        renewalGraceDays: number;
        rules: {
          ruleId: string;
          waivers: string[];
          renewals: number;
          expired: number;
          lapsed: number;
          active: number;
          scopeGrowth: { first: number; last: number };
        }[];
        totals: {
          waivers: number;
          renewals: number;
          expired: number;
          lapsed: number;
          rulesWithScopeGrowth: number;
        };
      };
  reviewLatency:
    | { status: "unavailable"; reason: string }
    | {
        status: "measured";
        findings: number;
        reviewed: number;
        medianDays?: number;
        p90Days?: number;
        unreviewed: string[];
        evidence: string[];
      };
};

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const round = (value: number): number => Number(value.toFixed(3));
const count = (items: readonly string[], denominator: number): Count => ({
  numerator: items.length,
  denominator,
  evidence: [...items].sort(compare).slice(0, EVIDENCE_LIMIT),
});

const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;

const ownershipChurn = (
  points: readonly OwnershipPoint[],
): GovernanceChurnReport["ownership"] => {
  if (points.length === 0)
    return { status: "unavailable", reason: "no revisions were given" };
  if (points.every((point) => point.report === undefined))
    return {
      status: "unavailable",
      reason: "no ownership record is stored for any given revision",
    };
  const ownersOf = (report: OwnershipResolutionReport) =>
    new Map(
      report.results.map((result) => [
        result.target.id,
        {
          owners: [...result.owners].sort(compare).join(","),
          gap: GAP_STATUSES.has(result.status),
        },
      ]),
    );
  const intervals: Extract<
    GovernanceChurnReport["ownership"],
    { status: "measured" }
  >["intervals"] = [];
  const gapHistory = new Map<string, boolean[]>();
  for (const point of points)
    if (point.report !== undefined)
      for (const [target, value] of ownersOf(point.report))
        gapHistory.set(target, [...(gapHistory.get(target) ?? []), value.gap]);

  for (let index = 1; index < points.length; index += 1) {
    const before = points[index - 1] as OwnershipPoint;
    const after = points[index] as OwnershipPoint;
    if (before.report === undefined || after.report === undefined) {
      intervals.push({
        from: before.revision,
        to: after.revision,
        status: "missing-history",
      });
      continue;
    }
    const left = ownersOf(before.report);
    const right = ownersOf(after.report);
    const shared = [...left.keys()].filter((target) => right.has(target));
    const changed = shared.filter(
      (target) => left.get(target)?.owners !== right.get(target)?.owners,
    );
    const opened = shared.filter(
      (target) => !left.get(target)?.gap && right.get(target)?.gap,
    );
    const closed = shared.filter(
      (target) => left.get(target)?.gap && !right.get(target)?.gap,
    );
    const added = [...right.keys()].filter((target) => !left.has(target));
    const removed = [...left.keys()].filter((target) => !right.has(target));
    intervals.push({
      from: before.revision,
      to: after.revision,
      status: "measured",
      verifiedNoChange:
        changed.length === 0 &&
        opened.length === 0 &&
        closed.length === 0 &&
        added.length === 0 &&
        removed.length === 0,
      ownerChanges: count(changed, shared.length),
      gapsOpened: count(opened, shared.length),
      gapsClosed: count(closed, shared.length),
      targetsAdded: added.length,
      targetsRemoved: removed.length,
    });
  }
  // A gap recurs when a target is a gap, is resolved, and is a gap again.
  const everGap = [...gapHistory].filter(([, history]) =>
    history.some(Boolean),
  );
  const recurred = everGap
    .filter(([, history]) => {
      const closedAt = history.findIndex(
        (gap, index) => index > 0 && !gap && history[index - 1] === true,
      );
      return closedAt > 0 && history.slice(closedAt).some(Boolean);
    })
    .map(([target]) => target);
  return {
    status: "measured",
    points: points.map((point) =>
      point.report === undefined
        ? { revision: point.revision, status: "missing" as const }
        : {
            revision: point.revision,
            ...(point.recordId === undefined
              ? {}
              : { recordId: point.recordId }),
            status: "measured" as const,
            targets: point.report.results.length,
            gaps: point.report.results.filter((item) =>
              GAP_STATUSES.has(item.status),
            ).length,
          },
    ),
    intervals,
    gapRecurrence: count(recurred, everGap.length),
  };
};

const waiverChurn = (
  waivers: readonly ArchitectureWaiver[],
  now: number,
  graceDays: number,
): GovernanceChurnReport["waivers"] => {
  if (waivers.length === 0)
    return { status: "unavailable", reason: "no waiver record is stored" };
  const byRule = new Map<string, ArchitectureWaiver[]>();
  for (const waiver of waivers)
    byRule.set(waiver.ruleId, [...(byRule.get(waiver.ruleId) ?? []), waiver]);
  const rules = [...byRule]
    .sort(([left], [right]) => compare(left, right))
    .map(([ruleId, items]) => {
      const ordered = [...items].sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          compare(left.id, right.id),
      );
      let renewals = 0;
      let lapsed = 0;
      ordered.forEach((waiver, index) => {
        const next = ordered[index + 1];
        const expiry = Date.parse(waiver.expiresAt);
        if (
          next !== undefined &&
          Date.parse(next.createdAt) <= expiry + graceDays * DAY_MS
        )
          renewals += 1;
        else if (expiry < now) lapsed += 1;
      });
      const scope = (waiver: ArchitectureWaiver) =>
        waiver.changeScope.affectedIds.length;
      return {
        ruleId,
        waivers: ordered.map((waiver) => waiver.id),
        renewals,
        expired: ordered.filter((waiver) => Date.parse(waiver.expiresAt) < now)
          .length,
        lapsed,
        active: ordered.filter(
          (waiver) =>
            Date.parse(waiver.createdAt) <= now &&
            now <= Date.parse(waiver.expiresAt),
        ).length,
        scopeGrowth: {
          first: scope(ordered[0] as ArchitectureWaiver),
          last: scope(ordered[ordered.length - 1] as ArchitectureWaiver),
        },
      };
    });
  return {
    status: "measured",
    renewalGraceDays: graceDays,
    rules,
    totals: {
      waivers: waivers.length,
      renewals: rules.reduce((sum, rule) => sum + rule.renewals, 0),
      expired: rules.reduce((sum, rule) => sum + rule.expired, 0),
      lapsed: rules.reduce((sum, rule) => sum + rule.lapsed, 0),
      rulesWithScopeGrowth: rules.filter(
        (rule) => rule.scopeGrowth.last > rule.scopeGrowth.first,
      ).length,
    },
  };
};

const reviewLatency = (
  inputs: readonly FindingLifecycleInput[],
  now: number,
): GovernanceChurnReport["reviewLatency"] => {
  if (inputs.length === 0)
    return {
      status: "unavailable",
      reason: "no finding-lifecycle record is stored",
    };
  const latencies: { id: string; days: number }[] = [];
  const unreviewed: string[] = [];
  let findings = 0;
  for (const input of inputs) {
    const events = input.events.filter((event) => Date.parse(event.at) <= now);
    const report = replayFindingLifecycle({ ...input, events });
    const byId = new Map(events.map((event) => [event.id, event]));
    for (const result of report.findings) {
      const finding = input.findings.find(
        (item) => item.id === result.findingId,
      );
      if (finding === undefined || Date.parse(finding.createdAt) > now)
        continue;
      findings += 1;
      const review = result.eventIds
        .map((id) => byId.get(id))
        .find((event) => event !== undefined && REVIEW_STATES.has(event.to));
      if (review === undefined) unreviewed.push(result.findingId);
      else
        latencies.push({
          id: result.findingId,
          days: round(
            (Date.parse(review.at) - Date.parse(finding.createdAt)) / DAY_MS,
          ),
        });
    }
  }
  const sorted = latencies.map((item) => item.days).sort((a, b) => a - b);
  return {
    status: "measured",
    findings,
    reviewed: latencies.length,
    ...(sorted.length === 0
      ? {}
      : {
          medianDays: percentile(sorted, 0.5),
          p90Days: percentile(sorted, 0.9),
        }),
    unreviewed: unreviewed.sort(compare).slice(0, EVIDENCE_LIMIT),
    evidence: latencies
      .sort((left, right) => compare(left.id, right.id))
      .slice(0, EVIDENCE_LIMIT)
      .map((item) => `${item.id} ${item.days}d`),
  };
};

/**
 * Longitudinal ownership and waiver churn at `asOf`. Ownership is compared
 * between consecutive revisions; a revision without a stored ownership
 * record makes its intervals `missing-history`, which is not the same as a
 * measured interval with no change. Current-state drift between owners and
 * waivers is a separate analysis and is not repeated here.
 */
export const computeGovernanceChurn = (
  inputs: GovernanceChurnInputs,
  asOf: string,
): GovernanceChurnReport => {
  const now = Date.parse(asOf);
  if (Number.isNaN(now)) throw new RangeError("asOf must be a date-time");
  return {
    schemaVersion: GOVERNANCE_CHURN_SCHEMA_VERSION,
    contract: GOVERNANCE_CHURN_CONTRACT,
    measuresVersion: GOVERNANCE_CHURN_VERSION,
    asOf,
    limitation:
      "Each measure stands alone and links to its evidence; none is combined into a score, and a missing record is never treated as no change.",
    ownership: ownershipChurn(inputs.ownership ?? []),
    waivers: waiverChurn(
      inputs.waivers ?? [],
      now,
      inputs.renewalGraceDays ?? 30,
    ),
    reviewLatency: reviewLatency(inputs.findings ?? [], now),
  };
};
