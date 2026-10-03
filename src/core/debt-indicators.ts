import { z } from "zod";

import type { ArchitectureWaiver } from "./architecture-waivers.js";
import {
  replayFindingLifecycle,
  type FindingLifecycleInput,
} from "./finding-lifecycle.js";
import type { OwnershipResolutionReport } from "./ownership.js";
import type { PolicyEvaluation } from "./policy-evaluation.js";
import type { TrendMetricsReport } from "./trend-metrics.js";

export const DEBT_INDICATORS_SCHEMA_VERSION = 1 as const;
export const DEBT_INDICATORS_CONTRACT = "cartograph.debt-indicators" as const;
export const DEBT_INDICATORS_CONFIG_CONTRACT =
  "cartograph.debt-indicators-config" as const;
/** Bumped whenever an indicator's definition changes. */
export const DEBT_INDICATORS_VERSION = 1 as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const EVIDENCE_LIMIT = 50;
const COUNTEREXAMPLE_LIMIT = 10;

export const DEBT_INDICATOR_IDS = [
  "finding-age",
  "finding-recurrence",
  "waiver-history",
  "ownership-gaps",
  "policy-severity",
  "boundary-erosion",
  "unknown-coverage",
  "remediation-evidence",
] as const;
export type DebtIndicatorId = (typeof DEBT_INDICATOR_IDS)[number];

const Threshold = z.number().nonnegative().max(1_000_000);
export const DebtIndicatorsConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    contract: z.literal(DEBT_INDICATORS_CONFIG_CONTRACT),
    thresholds: z
      .object({
        // Days a finding may stay open, acknowledged, or regressed.
        findingMaxOpenDays: Threshold.default(90),
        // Share of findings that ever regressed.
        findingMaxRecurrenceRate: Threshold.max(1).default(0.1),
        // Days ahead in which an expiring waiver counts.
        waiverExpiringWithinDays: Threshold.default(30),
        // Share of waivers expired or expiring.
        waiverMaxAttentionRate: Threshold.max(1).default(0.25),
        // Share of ownership targets unowned or ambiguous.
        ownershipMaxGapRate: Threshold.max(1).default(0.1),
        // Violations of enforced rules.
        policyMaxEnforcedViolations: Threshold.default(0),
        // Increase in the boundary-crossing import share across the range.
        boundaryMaxIncrease: Threshold.max(1).default(0.05),
        // Share of edges without resolved evidence.
        unknownMaxRate: Threshold.max(1).default(0.2),
        // Share of remediated findings closed without evidence references.
        remediationMaxUnevidencedRate: Threshold.max(1).default(0.25),
      })
      .strict()
      .prefault({}),
    disabled: z.array(z.enum(DEBT_INDICATOR_IDS)).max(8).default([]),
  })
  .strict();
export type DebtIndicatorsConfig = z.infer<typeof DebtIndicatorsConfigSchema>;

export const parseDebtIndicatorsConfig = (
  value: unknown,
): DebtIndicatorsConfig => DebtIndicatorsConfigSchema.parse(value);
export const DEFAULT_DEBT_INDICATORS_CONFIG: DebtIndicatorsConfig =
  parseDebtIndicatorsConfig({
    schemaVersion: 1,
    contract: DEBT_INDICATORS_CONFIG_CONTRACT,
  });

export type DebtIndicatorStatus =
  "within-threshold" | "above-threshold" | "unavailable" | "disabled";

export type DebtIndicator = {
  id: DebtIndicatorId;
  definition: string;
  status: DebtIndicatorStatus;
  reason?: string;
  value?: number;
  numerator?: number;
  denominator?: number;
  threshold?: number;
  /** What the status would be at 80% and 120% of the threshold. */
  sensitivity?: { lower: DebtIndicatorStatus; upper: DebtIndicatorStatus };
  /** Items that count toward the value (capped). */
  evidence: string[];
  /** Items considered that do not count (capped), to check the definition. */
  counterexamples: string[];
  /** What the value cannot see. */
  uncertainty: string[];
};

export type DebtIndicatorsReport = {
  schemaVersion: typeof DEBT_INDICATORS_SCHEMA_VERSION;
  contract: typeof DEBT_INDICATORS_CONTRACT;
  indicatorsVersion: typeof DEBT_INDICATORS_VERSION;
  asOf: string;
  /** Indicators describe stored evidence; they do not predict debt or outcomes. */
  limitation: string;
  indicators: DebtIndicator[];
};

export type DebtIndicatorInputs = {
  findings?: readonly FindingLifecycleInput[];
  waivers?: readonly ArchitectureWaiver[];
  ownership?: OwnershipResolutionReport;
  evaluation?: PolicyEvaluation;
  trends?: TrendMetricsReport;
};

const DEFINITIONS: Record<DebtIndicatorId, string> = {
  "finding-age":
    "open, acknowledged, or regressed findings older than findingMaxOpenDays / all such findings",
  "finding-recurrence":
    "findings with an applied transition to regressed / all findings",
  "waiver-history":
    "waivers expired or expiring within waiverExpiringWithinDays / all waivers",
  "ownership-gaps": "unowned or ambiguous ownership targets / all targets",
  "policy-severity": "violations of enforced rules in the policy evaluation",
  "boundary-erosion":
    "summed change in boundary-crossing import share over comparable intervals",
  "unknown-coverage":
    "edges without resolved evidence / all edges, at the last measured revision",
  "remediation-evidence":
    "remediated findings whose remediating event has no evidence references / remediated findings",
};

const OPEN_STATES = new Set(["open", "acknowledged", "regressed"]);
const round = (value: number): number => Number(value.toFixed(6));
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const judge = (value: number, threshold: number): DebtIndicatorStatus =>
  value > threshold ? "above-threshold" : "within-threshold";

const measured = (
  id: DebtIndicatorId,
  value: number,
  threshold: number,
  rest: Partial<DebtIndicator> = {},
): DebtIndicator => ({
  id,
  definition: DEFINITIONS[id],
  status: judge(value, threshold),
  value: round(value),
  threshold,
  sensitivity: {
    lower: judge(value, threshold * 0.8),
    upper: judge(value, threshold * 1.2),
  },
  evidence: [],
  counterexamples: [],
  uncertainty: [],
  ...rest,
});

const unavailable = (id: DebtIndicatorId, reason: string): DebtIndicator => ({
  id,
  definition: DEFINITIONS[id],
  status: "unavailable",
  reason,
  evidence: [],
  counterexamples: [],
  uncertainty: [],
});

const ratio = (numerator: number, denominator: number) => ({
  value: denominator === 0 ? 0 : numerator / denominator,
  numerator,
  denominator,
});

const capped = (items: readonly string[], limit: number): string[] =>
  [...items].sort(compare).slice(0, limit);

type FindingView = {
  id: string;
  state: string;
  createdAt: string;
  regressed: boolean;
  remediatedWithEvidence?: boolean;
  diagnostics: number;
};

const findingViews = (
  inputs: readonly FindingLifecycleInput[],
  asOf: number,
): FindingView[] => {
  const views = new Map<string, FindingView>();
  for (const input of inputs) {
    const applicable = {
      ...input,
      events: input.events.filter((event) => Date.parse(event.at) <= asOf),
    };
    const report = replayFindingLifecycle(applicable);
    const events = new Map(applicable.events.map((event) => [event.id, event]));
    for (const result of report.findings) {
      const finding = input.findings.find(
        (item) => item.id === result.findingId,
      );
      if (finding === undefined) continue;
      const applied = result.eventIds
        .map((id) => events.get(id))
        .filter((event) => event !== undefined);
      const lastRemediation = [...applied]
        .reverse()
        .find((event) => event.to === "remediated");
      views.set(result.findingId, {
        id: result.findingId,
        state: result.state,
        createdAt: finding.createdAt,
        regressed: applied.some((event) => event.to === "regressed"),
        ...(result.state === "remediated" && lastRemediation !== undefined
          ? { remediatedWithEvidence: lastRemediation.evidenceRefs.length > 0 }
          : {}),
        diagnostics: result.diagnosticCodes.length,
      });
    }
  }
  return [...views.values()].sort((left, right) => compare(left.id, right.id));
};

/**
 * Evidence-backed indicators of architecture debt at `asOf`. Each one is a
 * plain count or ratio with its definition, threshold, the items behind it,
 * counterexamples, sensitivity to the threshold, and what it cannot see. An
 * indicator without stored evidence is unavailable, never zero.
 */
export const computeDebtIndicators = (
  inputs: DebtIndicatorInputs,
  asOf: string,
  config: DebtIndicatorsConfig = DEFAULT_DEBT_INDICATORS_CONFIG,
): DebtIndicatorsReport => {
  const now = Date.parse(z.string().datetime({ offset: true }).parse(asOf));
  const t = config.thresholds;
  const indicators: DebtIndicator[] = [];
  const findings =
    inputs.findings === undefined || inputs.findings.length === 0
      ? undefined
      : findingViews(inputs.findings, now);
  const noFindings = "no finding-lifecycle record is stored";

  // finding-age
  if (findings === undefined)
    indicators.push(unavailable("finding-age", noFindings));
  else {
    const open = findings.filter((item) => OPEN_STATES.has(item.state));
    const ageDays = (item: FindingView) =>
      (now - Date.parse(item.createdAt)) / DAY_MS;
    const old = open.filter((item) => ageDays(item) > t.findingMaxOpenDays);
    const { value, numerator, denominator } = ratio(old.length, open.length);
    // Age is judged per finding, so the threshold is in days and the status
    // is "above" when any open finding is older than it.
    const statusAt = (days: number): DebtIndicatorStatus =>
      open.some((item) => ageDays(item) > days)
        ? "above-threshold"
        : "within-threshold";
    indicators.push({
      id: "finding-age",
      definition: DEFINITIONS["finding-age"],
      status: statusAt(t.findingMaxOpenDays),
      value: round(value),
      numerator,
      denominator,
      threshold: t.findingMaxOpenDays,
      sensitivity: {
        lower: statusAt(t.findingMaxOpenDays * 0.8),
        upper: statusAt(t.findingMaxOpenDays * 1.2),
      },
      evidence: capped(
        old.map((item) => item.id),
        EVIDENCE_LIMIT,
      ),
      counterexamples: capped(
        open.filter((item) => !old.includes(item)).map((item) => item.id),
        COUNTEREXAMPLE_LIMIT,
      ),
      uncertainty: findings.some((item) => item.diagnostics > 0)
        ? [
            "some findings have lifecycle diagnostics; their state may be contested",
          ]
        : [],
    });
  }

  // finding-recurrence
  if (findings === undefined)
    indicators.push(unavailable("finding-recurrence", noFindings));
  else {
    const regressed = findings.filter((item) => item.regressed);
    const r = ratio(regressed.length, findings.length);
    indicators.push(
      measured("finding-recurrence", r.value, t.findingMaxRecurrenceRate, {
        numerator: r.numerator,
        denominator: r.denominator,
        evidence: capped(
          regressed.map((item) => item.id),
          EVIDENCE_LIMIT,
        ),
        counterexamples: capped(
          findings.filter((item) => !item.regressed).map((item) => item.id),
          COUNTEREXAMPLE_LIMIT,
        ),
        uncertainty: [
          "only regressions recorded as lifecycle events are visible",
        ],
      }),
    );
  }

  // waiver-history
  if (inputs.waivers === undefined || inputs.waivers.length === 0)
    indicators.push(
      unavailable("waiver-history", "no waiver record is stored"),
    );
  else {
    const horizon = now + t.waiverExpiringWithinDays * DAY_MS;
    const attention = inputs.waivers.filter(
      (waiver) => Date.parse(waiver.expiresAt) <= horizon,
    );
    const byRule = new Map<string, number>();
    for (const waiver of inputs.waivers)
      byRule.set(waiver.ruleId, (byRule.get(waiver.ruleId) ?? 0) + 1);
    const renewed = [...byRule].filter(([, count]) => count > 1);
    const r = ratio(attention.length, inputs.waivers.length);
    indicators.push(
      measured("waiver-history", r.value, t.waiverMaxAttentionRate, {
        numerator: r.numerator,
        denominator: r.denominator,
        evidence: capped(
          attention.map(
            (waiver) =>
              `${waiver.id} (${Date.parse(waiver.expiresAt) < now ? "expired" : "expiring"})`,
          ),
          EVIDENCE_LIMIT,
        ),
        counterexamples: capped(
          inputs.waivers
            .filter((waiver) => !attention.includes(waiver))
            .map((waiver) => waiver.id),
          COUNTEREXAMPLE_LIMIT,
        ),
        uncertainty: [
          ...(renewed.length > 0
            ? [
                `${renewed.length} rule(s) have more than one waiver, which may be renewals: ${renewed
                  .map(([rule]) => rule)
                  .sort(compare)
                  .join(", ")}`,
              ]
            : []),
          "only waivers imported into history are counted",
        ],
      }),
    );
  }

  // ownership-gaps
  if (inputs.ownership === undefined)
    indicators.push(
      unavailable("ownership-gaps", "no ownership record is stored"),
    );
  else {
    const results = inputs.ownership.results;
    const gaps = results.filter(
      (item) => item.status === "unowned" || item.status === "ambiguous",
    );
    const unknown = results.filter(
      (item) => item.status === "unavailable" || item.status === "unsupported",
    ).length;
    const r = ratio(gaps.length, results.length);
    indicators.push(
      measured("ownership-gaps", r.value, t.ownershipMaxGapRate, {
        numerator: r.numerator,
        denominator: r.denominator,
        evidence: capped(
          gaps.map((item) => `${item.target.id} (${item.status})`),
          EVIDENCE_LIMIT,
        ),
        counterexamples: capped(
          results
            .filter((item) => item.status === "resolved")
            .map((item) => item.target.id),
          COUNTEREXAMPLE_LIMIT,
        ),
        uncertainty:
          unknown > 0
            ? [`${unknown} target(s) could not be resolved either way`]
            : [],
      }),
    );
  }

  // policy-severity
  if (inputs.evaluation === undefined)
    indicators.push(
      unavailable(
        "policy-severity",
        "no policy record was evaluated for the last revision",
      ),
    );
  else {
    const enforced = inputs.evaluation.violations.filter(
      (item) => item.effect === "enforce",
    );
    const advisory = inputs.evaluation.violations.length - enforced.length;
    indicators.push(
      measured(
        "policy-severity",
        enforced.length,
        t.policyMaxEnforcedViolations,
        {
          numerator: enforced.length,
          evidence: capped(
            enforced.map((item) => item.ruleId),
            EVIDENCE_LIMIT,
          ),
          counterexamples: capped(
            inputs.evaluation.violations
              .filter((item) => item.effect !== "enforce")
              .map((item) => `${item.ruleId} (${item.effect})`),
            COUNTEREXAMPLE_LIMIT,
          ),
          uncertainty: [
            ...(advisory > 0
              ? [`${advisory} advisory violation(s) are not counted`]
              : []),
            ...(inputs.evaluation.unsupportedRules > 0
              ? [
                  `${inputs.evaluation.unsupportedRules} rule(s) could not be evaluated`,
                ]
              : []),
          ],
        },
      ),
    );
  }

  // boundary-erosion and unknown-coverage come from trends.
  const trends = inputs.trends;
  if (trends === undefined || trends.revisions.length < 2)
    indicators.push(
      unavailable(
        "boundary-erosion",
        "at least two revisions are needed for erosion",
      ),
    );
  else {
    let sum = 0;
    const comparable: string[] = [];
    const breaks: string[] = [];
    for (const interval of trends.intervals) {
      const change = interval.changes.find(
        (item) => item.id === "boundary-crossing-imports",
      );
      const label = `${interval.from}..${interval.to}`;
      if (change?.status === "comparable") {
        sum += change.delta;
        comparable.push(
          `${label} ${change.delta >= 0 ? "+" : ""}${change.delta}`,
        );
      } else breaks.push(label);
    }
    indicators.push(
      comparable.length === 0
        ? unavailable(
            "boundary-erosion",
            "no interval is comparable for boundary-crossing imports",
          )
        : measured("boundary-erosion", sum, t.boundaryMaxIncrease, {
            evidence: comparable,
            uncertainty:
              breaks.length > 0
                ? [
                    `not summed across incomparable or missing intervals: ${breaks.join(", ")}`,
                  ]
                : [],
          }),
    );
  }
  const last = [...(trends?.revisions ?? [])]
    .reverse()
    .find((item) => item.status === "measured");
  const unknownMetric = last?.metrics.find(
    (item) => item.id === "unresolved-edges",
  );
  if (unknownMetric === undefined || unknownMetric.status !== "measured")
    indicators.push(
      unavailable("unknown-coverage", "no measured revision is available"),
    );
  else
    indicators.push(
      measured("unknown-coverage", unknownMetric.value, t.unknownMaxRate, {
        numerator: unknownMetric.numerator,
        denominator: unknownMetric.denominator,
        evidence: [`revision ${last?.revision ?? ""}`],
        uncertainty: [
          "dynamic behaviour the analyzer does not model is not counted as unknown",
        ],
      }),
    );

  // remediation-evidence
  if (findings === undefined)
    indicators.push(unavailable("remediation-evidence", noFindings));
  else {
    const remediated = findings.filter(
      (item) => item.remediatedWithEvidence !== undefined,
    );
    const bare = remediated.filter(
      (item) => item.remediatedWithEvidence === false,
    );
    const r = ratio(bare.length, remediated.length);
    indicators.push(
      remediated.length === 0
        ? unavailable("remediation-evidence", "no finding is remediated")
        : measured(
            "remediation-evidence",
            r.value,
            t.remediationMaxUnevidencedRate,
            {
              numerator: r.numerator,
              denominator: r.denominator,
              evidence: capped(
                bare.map((item) => item.id),
                EVIDENCE_LIMIT,
              ),
              counterexamples: capped(
                remediated
                  .filter((item) => item.remediatedWithEvidence === true)
                  .map((item) => item.id),
                COUNTEREXAMPLE_LIMIT,
              ),
              uncertainty: [
                "evidence references are checked for presence, not for content",
              ],
            },
          ),
    );
  }

  const disabled = new Set(config.disabled);
  return {
    schemaVersion: DEBT_INDICATORS_SCHEMA_VERSION,
    contract: DEBT_INDICATORS_CONTRACT,
    indicatorsVersion: DEBT_INDICATORS_VERSION,
    asOf,
    limitation:
      "Indicators summarize stored evidence. They do not measure or predict technical debt, cost, risk, or business outcomes.",
    indicators: indicators.map((indicator) =>
      disabled.has(indicator.id)
        ? {
            id: indicator.id,
            definition: indicator.definition,
            status: "disabled",
            evidence: [],
            counterexamples: [],
            uncertainty: [],
          }
        : indicator,
    ),
  };
};
