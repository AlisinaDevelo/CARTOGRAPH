import { z } from "zod";

import type { AdrReferenceDocument } from "./adr.js";
import type { ArchitectureWaiver } from "./architecture-waivers.js";
import type { AssuranceBundleRole } from "./assurance-bundle.js";
import {
  replayFindingLifecycle,
  type FindingLifecycleInput,
} from "./finding-lifecycle.js";
import type { PolicyEvaluation } from "./policy-evaluation.js";
import type { PolicyConfig } from "./policy.js";

export const CONTROL_MAPPING_SCHEMA_VERSION = 1 as const;
export const CONTROL_MAPPING_CONTRACT = "cartograph.control-mapping" as const;
export const CONTROL_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const CONTROL_EVIDENCE_CONTRACT = "cartograph.control-evidence" as const;

/** Printed at the top of every report; never configurable. */
export const CONTROL_EVIDENCE_LIMITATIONS = [
  "This report is not a certification, audit opinion, or attestation of compliance with any standard or regulation.",
  "Observed evidence shows only what the verified bundle contains; it does not show that a control is designed or operating effectively.",
  "Owner assertions and test results are reported as supplied and are not verified by CARTOGRAPH.",
  "Static architecture analysis is incomplete; unknowns and unsupported constructs can hide relevant behaviour.",
  "The bundle's origin is not established unless its signature was verified separately with `cartograph bundle verify --signature`.",
] as const;

const IdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "must be a portable identifier");
const TextSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine(
    (value) => !/[\0\r]/u.test(value),
    "must not contain control characters",
  );
const DateTimeSchema = z.string().datetime({ offset: true });

const EvidenceSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("policy-rule"),
      policyId: IdSchema,
      ruleId: IdSchema,
    })
    .strict(),
  z.object({ type: z.literal("decision"), decisionId: IdSchema }).strict(),
  z.object({ type: z.literal("waiver"), waiverId: IdSchema }).strict(),
  z
    .object({
      type: z.literal("finding"),
      findingId: IdSchema,
      expectedStates: z.array(IdSchema).min(1).max(16).optional(),
    })
    .strict(),
  z.object({ type: z.literal("bundle-artifact"), role: IdSchema }).strict(),
  z
    .object({
      type: z.literal("test"),
      name: TextSchema,
      result: z.enum(["pass", "fail"]),
      ranAt: DateTimeSchema,
      reportedBy: IdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("owner-assertion"),
      owner: IdSchema,
      statement: TextSchema,
      assertedAt: DateTimeSchema,
    })
    .strict(),
]);
export type ControlEvidence = z.infer<typeof EvidenceSchema>;

export const ControlMappingSchema = z
  .object({
    schemaVersion: z.literal(CONTROL_MAPPING_SCHEMA_VERSION),
    contract: z.literal(CONTROL_MAPPING_CONTRACT),
    controls: z
      .array(
        z
          .object({
            id: IdSchema,
            title: TextSchema,
            objective: TextSchema,
            owner: IdSchema,
            scope: z
              .object({
                description: TextSchema,
                paths: z.array(z.string().min(1).max(512)).max(64).optional(),
              })
              .strict(),
            period: z
              .object({ from: DateTimeSchema, to: DateTimeSchema })
              .strict()
              .refine(
                (period) => Date.parse(period.from) <= Date.parse(period.to),
                "period.from must not be after period.to",
              ),
            applicability: z.enum(["full", "partial", "not-applicable"]),
            applicabilityNote: TextSchema.optional(),
            evidence: z.array(EvidenceSchema).min(1).max(256),
          })
          .strict()
          .refine(
            (control) =>
              control.applicability === "full" ||
              control.applicabilityNote !== undefined,
            "partial and not-applicable controls need an applicabilityNote",
          ),
      )
      .min(1)
      .max(1_000),
  })
  .strict()
  .superRefine((mapping, context) => {
    const ids = new Set<string>();
    mapping.controls.forEach((control, index) => {
      if (ids.has(control.id))
        context.addIssue({
          code: "custom",
          path: ["controls", index, "id"],
          message: `duplicate control id ${control.id}`,
        });
      ids.add(control.id);
    });
  });
export type ControlMapping = z.infer<typeof ControlMappingSchema>;

export const parseControlMapping = (value: unknown): ControlMapping =>
  ControlMappingSchema.parse(value);

export type ControlBundleEvidence = {
  bundleId: string;
  roles: readonly AssuranceBundleRole[];
  declaredMissing: readonly { role: AssuranceBundleRole; reason: string }[];
  policies: readonly PolicyConfig[];
  evaluations: readonly PolicyEvaluation[];
  decisions: readonly AdrReferenceDocument[];
  waivers: readonly ArchitectureWaiver[];
  findings: readonly FindingLifecycleInput[];
};

export type ControlGapReason =
  | "missing"
  | "declared-missing"
  | "not-evaluated"
  | "unsupported-rule"
  | "decision-not-accepted"
  | "stale";
export type ControlConflictReason =
  "rule-violated" | "decision-rejected" | "finding-state" | "test-failed";

export type EvaluatedEvidence = {
  index: number;
  type: ControlEvidence["type"];
  ref: string;
} & (
  | { basis: "observed"; detail?: string }
  | { basis: "asserted"; by: string; at: string }
  | { basis: "gap"; reason: ControlGapReason; detail?: string }
  | { basis: "conflict"; reason: ControlConflictReason; detail?: string }
);

export type ControlStatus =
  | "supported"
  | "asserted-only"
  | "gaps"
  | "conflicting"
  | "out-of-period"
  | "not-applicable";

export type ControlResult = {
  id: string;
  title: string;
  owner: string;
  scope: ControlMapping["controls"][number]["scope"];
  period: { from: string; to: string };
  applicability: "full" | "partial" | "not-applicable";
  applicabilityNote?: string;
  status: ControlStatus;
  observed: EvaluatedEvidence[];
  asserted: EvaluatedEvidence[];
  gaps: EvaluatedEvidence[];
  conflicts: EvaluatedEvidence[];
};

export type ControlEvidenceReport = {
  schemaVersion: typeof CONTROL_EVIDENCE_SCHEMA_VERSION;
  contract: typeof CONTROL_EVIDENCE_CONTRACT;
  limitations: readonly string[];
  asOf: string;
  bundleId: string;
  controls: ControlResult[];
  summary: Record<ControlStatus, number>;
};

const refOf = (evidence: ControlEvidence): string => {
  switch (evidence.type) {
    case "policy-rule":
      return `${evidence.policyId}/${evidence.ruleId}`;
    case "decision":
      return evidence.decisionId;
    case "waiver":
      return evidence.waiverId;
    case "finding":
      return evidence.findingId;
    case "bundle-artifact":
      return evidence.role;
    case "test":
      return evidence.name;
    case "owner-assertion":
      return evidence.owner;
  }
};

/**
 * A finding's state at `asOf`, replayed by the lifecycle contract itself so
 * concurrent and superseded transitions resolve the same way everywhere.
 */
const findingState = (
  input: FindingLifecycleInput,
  findingId: string,
  asOf: number,
): string | undefined => {
  if (!input.findings.some((item) => item.id === findingId)) return undefined;
  const report = replayFindingLifecycle({
    ...input,
    events: input.events.filter((item) => Date.parse(item.at) <= asOf),
  });
  return report.findings.find((item) => item.findingId === findingId)?.state;
};

/**
 * Relate each control's mapped evidence to what a verified bundle contains
 * at `asOf`. Bundle contents are observed; tests and owner statements are
 * asserted. Anything referenced but absent, stale, or contradicted is listed
 * as a gap or conflict, never dropped.
 */
export const evaluateControlEvidence = (
  mapping: ControlMapping,
  bundle: ControlBundleEvidence,
  asOf: string,
): ControlEvidenceReport => {
  const now = Date.parse(DateTimeSchema.parse(asOf));
  const evaluate = (
    control: ControlMapping["controls"][number],
    evidence: ControlEvidence,
    index: number,
  ): EvaluatedEvidence => {
    const base = { index, type: evidence.type, ref: refOf(evidence) };
    const from = Date.parse(control.period.from);
    const to = Date.parse(control.period.to);
    switch (evidence.type) {
      case "policy-rule": {
        const policy = bundle.policies.find(
          (item) => item.policyId === evidence.policyId,
        );
        if (
          policy === undefined ||
          !policy.rules.some((rule) => rule.id === evidence.ruleId)
        )
          return { ...base, basis: "gap", reason: "missing" };
        const evaluation = bundle.evaluations.find(
          (item) => item.policyId === evidence.policyId,
        );
        if (evaluation === undefined)
          return { ...base, basis: "gap", reason: "not-evaluated" };
        if (
          evaluation.unsupported.some((item) => item.ruleId === evidence.ruleId)
        )
          return { ...base, basis: "gap", reason: "unsupported-rule" };
        const violations = evaluation.violations.filter(
          (item) => item.ruleId === evidence.ruleId,
        );
        return violations.length > 0
          ? {
              ...base,
              basis: "conflict",
              reason: "rule-violated",
              detail: `${violations.length} violation(s) in the bundled evaluation`,
            }
          : {
              ...base,
              basis: "observed",
              detail: "rule evaluated with no violations",
            };
      }
      case "decision": {
        const reference = bundle.decisions
          .flatMap((document) => document.references)
          .find((item) => item.id === evidence.decisionId);
        if (reference === undefined)
          return { ...base, basis: "gap", reason: "missing" };
        if (reference.status === "rejected")
          return { ...base, basis: "conflict", reason: "decision-rejected" };
        if (
          reference.status === "deprecated" ||
          reference.status === "superseded"
        )
          return {
            ...base,
            basis: "gap",
            reason: "stale",
            detail: `decision is ${reference.status}`,
          };
        if (
          reference.effectiveTo !== undefined &&
          Date.parse(reference.effectiveTo) < now
        )
          return {
            ...base,
            basis: "gap",
            reason: "stale",
            detail: "decision is no longer effective",
          };
        if (reference.status !== "accepted")
          return {
            ...base,
            basis: "gap",
            reason: "decision-not-accepted",
            detail: `decision is ${reference.status}`,
          };
        return { ...base, basis: "observed", detail: "accepted decision" };
      }
      case "waiver": {
        const waiver = bundle.waivers.find(
          (item) => item.id === evidence.waiverId,
        );
        if (waiver === undefined)
          return { ...base, basis: "gap", reason: "missing" };
        return Date.parse(waiver.expiresAt) < now
          ? { ...base, basis: "gap", reason: "stale", detail: "waiver expired" }
          : {
              ...base,
              basis: "observed",
              detail: `waiver expires ${waiver.expiresAt}`,
            };
      }
      case "finding": {
        const state = bundle.findings
          .map((input) => findingState(input, evidence.findingId, now))
          .find((item) => item !== undefined);
        if (state === undefined)
          return { ...base, basis: "gap", reason: "missing" };
        if (
          evidence.expectedStates !== undefined &&
          !evidence.expectedStates.includes(state)
        )
          return {
            ...base,
            basis: "conflict",
            reason: "finding-state",
            detail: `finding is ${state}`,
          };
        return { ...base, basis: "observed", detail: `finding is ${state}` };
      }
      case "bundle-artifact": {
        if (bundle.roles.includes(evidence.role as AssuranceBundleRole))
          return { ...base, basis: "observed" };
        const declared = bundle.declaredMissing.find(
          (item) => item.role === evidence.role,
        );
        return declared === undefined
          ? { ...base, basis: "gap", reason: "missing" }
          : {
              ...base,
              basis: "gap",
              reason: "declared-missing",
              detail: declared.reason,
            };
      }
      case "test": {
        const ran = Date.parse(evidence.ranAt);
        if (evidence.result === "fail")
          return { ...base, basis: "conflict", reason: "test-failed" };
        if (ran < from || ran > to || ran > now)
          return {
            ...base,
            basis: "gap",
            reason: "stale",
            detail: "test run is outside the control period",
          };
        return {
          ...base,
          basis: "asserted",
          by: evidence.reportedBy,
          at: evidence.ranAt,
        };
      }
      case "owner-assertion": {
        const at = Date.parse(evidence.assertedAt);
        if (at < from || at > to || at > now)
          return {
            ...base,
            basis: "gap",
            reason: "stale",
            detail: "assertion is outside the control period",
          };
        return {
          ...base,
          basis: "asserted",
          by: evidence.owner,
          at: evidence.assertedAt,
        };
      }
    }
  };

  const controls = mapping.controls.map((control): ControlResult => {
    const items = control.evidence.map((evidence, index) =>
      evaluate(control, evidence, index),
    );
    const observed = items.filter((item) => item.basis === "observed");
    const asserted = items.filter((item) => item.basis === "asserted");
    const gaps = items.filter((item) => item.basis === "gap");
    const conflicts = items.filter((item) => item.basis === "conflict");
    const inPeriod =
      Date.parse(control.period.from) <= now &&
      now <= Date.parse(control.period.to);
    const status: ControlStatus =
      control.applicability === "not-applicable"
        ? "not-applicable"
        : !inPeriod
          ? "out-of-period"
          : conflicts.length > 0
            ? "conflicting"
            : gaps.length > 0
              ? "gaps"
              : observed.length === 0
                ? "asserted-only"
                : "supported";
    return {
      id: control.id,
      title: control.title,
      owner: control.owner,
      scope: control.scope,
      period: control.period,
      applicability: control.applicability,
      ...(control.applicabilityNote === undefined
        ? {}
        : { applicabilityNote: control.applicabilityNote }),
      status,
      observed,
      asserted,
      gaps,
      conflicts,
    };
  });
  const summary: Record<ControlStatus, number> = {
    supported: 0,
    "asserted-only": 0,
    gaps: 0,
    conflicting: 0,
    "out-of-period": 0,
    "not-applicable": 0,
  };
  for (const control of controls) summary[control.status] += 1;
  return {
    schemaVersion: CONTROL_EVIDENCE_SCHEMA_VERSION,
    contract: CONTROL_EVIDENCE_CONTRACT,
    limitations: CONTROL_EVIDENCE_LIMITATIONS,
    asOf,
    bundleId: bundle.bundleId,
    controls,
    summary,
  };
};
