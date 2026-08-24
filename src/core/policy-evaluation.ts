import { z } from "zod";

import { canonicalizeGraphSnapshot, stableStringify } from "./canonical.js";
import { canonicalizeGraphDiff } from "./diff.js";
import {
  parsePolicyConfig,
  type LocalPolicyRule,
  type PolicyConfig,
} from "./policy.js";
import type {
  ChangedDiagnostic,
  Diagnostic,
  GraphDiff,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  RewiredEdge,
} from "./schemas.js";

export const POLICY_EVALUATION_SCHEMA_VERSION = 1 as const;
export const POLICY_EVALUATION_CONTRACT =
  "cartograph.policy-evaluation" as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );

const EvaluationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );
const ReasonSchema = z.string().trim().min(1).max(2_048);
const EvidenceReferenceSchema = EvaluationIdSchema;
const PolicyTargetSchema = z.enum(["node", "edge", "diff"]);
const PolicyAssertionSchema = z.enum([
  "exists",
  "absent",
  "count-at-most",
  "count-at-least",
]);
const PolicyEffectSchema = z.enum(["informational", "enforce"]);

export const PolicyViolationSchema = z
  .object({
    id: EvaluationIdSchema,
    policyId: IdentifierSchema,
    ruleId: IdentifierSchema,
    target: PolicyTargetSchema,
    assertion: PolicyAssertionSchema,
    effect: PolicyEffectSchema,
    count: z.number().int().nonnegative(),
    expected: z.number().int().nonnegative().optional(),
    matches: z.array(EvaluationIdSchema).max(10_000),
    reason: ReasonSchema,
    evidenceRefs: z.array(EvidenceReferenceSchema).min(1).max(10_000),
  })
  .strict();

export const PolicyUnsupportedSchema = z
  .object({
    id: EvaluationIdSchema,
    policyId: IdentifierSchema,
    ruleId: IdentifierSchema,
    target: PolicyTargetSchema,
    code: z.enum(["unsupported-input", "unsupported-target"]),
    reason: ReasonSchema,
    evidenceRefs: z.array(EvidenceReferenceSchema).min(1).max(128),
  })
  .strict();

export const PolicyEvaluationSchema = z
  .object({
    schemaVersion: z
      .literal(POLICY_EVALUATION_SCHEMA_VERSION)
      .default(POLICY_EVALUATION_SCHEMA_VERSION),
    contract: z.literal(POLICY_EVALUATION_CONTRACT),
    policyId: IdentifierSchema,
    policyVersion: z
      .string()
      .trim()
      .regex(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
        "must be a semantic version",
      ),
    inputKind: z.enum(["snapshot", "diff"]),
    mode: PolicyEffectSchema,
    status: z.enum(["passed", "violations", "unsupported"]),
    evaluatedRules: z.number().int().nonnegative(),
    passedRules: z.number().int().nonnegative(),
    unsupportedRules: z.number().int().nonnegative(),
    violations: z.array(PolicyViolationSchema).max(10_000),
    unsupported: z.array(PolicyUnsupportedSchema).max(10_000),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      report.evaluatedRules !==
      report.violations.length + report.unsupported.length + report.passedRules
    ) {
      context.addIssue({
        code: "custom",
        path: ["evaluatedRules"],
        message:
          "must equal violations plus unsupported and passed rule counts",
      });
    }
    if (report.unsupportedRules !== report.unsupported.length) {
      context.addIssue({
        code: "custom",
        path: ["unsupportedRules"],
        message: "must equal the unsupported rule count",
      });
    }
    const expectedStatus =
      report.violations.length > 0
        ? "violations"
        : report.unsupported.length > 0
          ? "unsupported"
          : "passed";
    if (report.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `must be ${expectedStatus} for the recorded findings`,
      });
    }
  });

export type PolicyViolation = z.infer<typeof PolicyViolationSchema>;
export type PolicyUnsupported = z.infer<typeof PolicyUnsupportedSchema>;
export type PolicyEvaluation = z.infer<typeof PolicyEvaluationSchema>;

export type PolicyEvaluationInput =
  { kind: "snapshot"; snapshot: unknown } | { kind: "diff"; diff: unknown };

export class PolicyEvaluationError extends Error {
  readonly code: "invalid-input" | "multiple-inputs" | "missing-input";

  constructor(
    code: "invalid-input" | "multiple-inputs" | "missing-input",
    message: string,
  ) {
    super(message);
    this.name = "PolicyEvaluationError";
    this.code = code;
  }
}

type CandidateTarget = "node" | "edge" | "diff";

type Candidate = {
  id: string;
  target: CandidateTarget;
  node?: GraphNode;
  edge?: GraphEdge;
  diff?: {
    kind: string;
    id: string;
    code?: string;
    classification?: string;
  };
  evidenceRefs: string[];
};

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const graphEdgeId = (edge: Pick<GraphEdge, "from" | "to" | "kind">): string =>
  `edge:${edge.from}|${edge.kind}|${edge.to}`;

const nodeEvidence = (node: GraphNode): string[] => {
  const refs = [`node:${node.id}`, `stable-key:${node.stableKey}`];
  if (node.location) {
    refs.push(`source:${node.location.path}:${node.location.line}`);
  }
  return refs;
};

const edgeEvidence = (edge: GraphEdge): string[] => [
  graphEdgeId(edge),
  ...edge.evidence.map((evidence) => `evidence:${evidence.id}`),
];

const diagnosticEvidence = (diagnostic: Diagnostic): string[] => [
  `diagnostic:${diagnostic.id}`,
  ...(diagnostic.nodeId ? [`node:${diagnostic.nodeId}`] : []),
  ...(diagnostic.edge
    ? [
        `edge:${diagnostic.edge.from}|${diagnostic.edge.kind}|${diagnostic.edge.to}`,
      ]
    : []),
  ...diagnostic.evidence.map((evidence) => `evidence:${evidence.id}`),
];

const nodeCandidate = (node: GraphNode): Candidate => ({
  id: `node:${node.id}`,
  target: "node",
  node,
  evidenceRefs: nodeEvidence(node),
});

const edgeCandidate = (edge: GraphEdge): Candidate => ({
  id: graphEdgeId(edge),
  target: "edge",
  edge,
  evidenceRefs: edgeEvidence(edge),
});

const diffCandidate = (input: {
  kind: string;
  id: string;
  code?: string;
  classification?: string;
  evidenceRefs: string[];
}): Candidate => ({
  id: input.id,
  target: "diff",
  diff: {
    kind: input.kind,
    id: input.id,
    ...(input.code ? { code: input.code } : {}),
    ...(input.classification ? { classification: input.classification } : {}),
  },
  evidenceRefs: input.evidenceRefs,
});

const changedNodeCandidate = (
  kind: "node-added" | "node-removed" | "node-changed",
  node: GraphNode,
  classification?: string,
): Candidate =>
  diffCandidate({
    kind,
    id: `${kind}:${node.stableKey}`,
    ...(classification ? { classification } : {}),
    evidenceRefs: nodeEvidence(node),
  });

const changedEdgeCandidate = (
  kind: "edge-added" | "edge-removed" | "edge-changed",
  edge: GraphEdge,
  classification?: string,
): Candidate =>
  diffCandidate({
    kind,
    id: `${kind}:${graphEdgeId(edge)}`,
    ...(classification ? { classification } : {}),
    evidenceRefs: edgeEvidence(edge),
  });

const rewiredCandidate = (change: RewiredEdge): Candidate =>
  diffCandidate({
    kind: "edge-rewired",
    id: `edge-rewired:${graphEdgeId(change.before)}=>${graphEdgeId(change.after)}`,
    classification: change.classification,
    evidenceRefs: [
      ...edgeEvidence(change.before),
      ...edgeEvidence(change.after),
    ],
  });

const changedDiagnosticCandidate = (
  kind: "diagnostic-added" | "diagnostic-removed" | "diagnostic-changed",
  diagnostic: Diagnostic | ChangedDiagnostic,
  classification?: string,
): Candidate => {
  const current = "after" in diagnostic ? diagnostic.after : diagnostic;
  return diffCandidate({
    kind,
    id: `${kind}:${current.id}`,
    code: current.code,
    ...(classification ? { classification } : {}),
    evidenceRefs: diagnosticEvidence(current),
  });
};

const identityCandidates = (diff: GraphDiff): Candidate[] => [
  ...diff.identity.matches.map((match) =>
    diffCandidate({
      kind: "identity-matched",
      id: `identity-matched:${match.beforeStableKey}=>${match.afterStableKey}`,
      evidenceRefs: [
        ...nodeEvidence(match.before),
        ...nodeEvidence(match.after),
      ],
    }),
  ),
  ...diff.identity.ambiguous.map((ambiguity) =>
    diffCandidate({
      kind: "identity-ambiguous",
      id: `identity-ambiguous:${ambiguity.before.stableKey}`,
      evidenceRefs: [
        ...nodeEvidence(ambiguity.before),
        ...ambiguity.candidates.map(
          (candidate) => `stable-key:${candidate.afterStableKey}`,
        ),
      ],
    }),
  ),
  ...diff.identity.unsupported.map((unsupported) =>
    diffCandidate({
      kind: "identity-unsupported",
      id: `identity-unsupported:${unsupported.before.stableKey}=>${unsupported.after.stableKey}`,
      evidenceRefs: [
        ...nodeEvidence(unsupported.before),
        ...nodeEvidence(unsupported.after),
      ],
    }),
  ),
];

const snapshotCandidates = (
  snapshot: GraphSnapshot,
): { nodes: Candidate[]; edges: Candidate[] } => ({
  nodes: snapshot.nodes.map(nodeCandidate),
  edges: snapshot.edges.map(edgeCandidate),
});

const diffCandidates = (
  diff: GraphDiff,
): { nodes: Candidate[]; edges: Candidate[]; diffs: Candidate[] } => ({
  nodes: [
    ...diff.nodes.added.map((node) => changedNodeCandidate("node-added", node)),
    ...diff.nodes.removed.map((node) =>
      changedNodeCandidate("node-removed", node),
    ),
    ...diff.nodes.changed.map((change) =>
      changedNodeCandidate("node-changed", change.after, change.classification),
    ),
  ],
  edges: [
    ...diff.edges.added.map((edge) => changedEdgeCandidate("edge-added", edge)),
    ...diff.edges.removed.map((edge) =>
      changedEdgeCandidate("edge-removed", edge),
    ),
    ...diff.edges.changed.map((change) =>
      changedEdgeCandidate("edge-changed", change.after, change.classification),
    ),
    ...diff.edges.rewired.map(rewiredCandidate),
  ],
  diffs: [
    ...diff.nodes.added.map((node) => changedNodeCandidate("node-added", node)),
    ...diff.nodes.removed.map((node) =>
      changedNodeCandidate("node-removed", node),
    ),
    ...diff.nodes.changed.map((change) =>
      changedNodeCandidate("node-changed", change.after, change.classification),
    ),
    ...diff.edges.added.map((edge) => changedEdgeCandidate("edge-added", edge)),
    ...diff.edges.removed.map((edge) =>
      changedEdgeCandidate("edge-removed", edge),
    ),
    ...diff.edges.changed.map((change) =>
      changedEdgeCandidate("edge-changed", change.after, change.classification),
    ),
    ...diff.edges.rewired.map(rewiredCandidate),
    ...diff.diagnostics.added.map((diagnostic) =>
      changedDiagnosticCandidate("diagnostic-added", diagnostic),
    ),
    ...diff.diagnostics.removed.map((diagnostic) =>
      changedDiagnosticCandidate("diagnostic-removed", diagnostic),
    ),
    ...diff.diagnostics.changed.map((change) =>
      changedDiagnosticCandidate(
        "diagnostic-changed",
        change,
        change.classification,
      ),
    ),
    ...identityCandidates(diff),
  ],
});

const matchesNode = (
  node: GraphNode,
  selector: Extract<LocalPolicyRule, { target: "node" }>["selector"],
): boolean =>
  (selector.kind === undefined || selector.kind === node.kind) &&
  (selector.id === undefined ||
    selector.id === node.id ||
    selector.id === node.stableKey) &&
  (selector.name === undefined || selector.name === node.name);

const matchesEdge = (
  edge: GraphEdge,
  selector: Extract<LocalPolicyRule, { target: "edge" }>["selector"],
): boolean =>
  (selector.kind === undefined || selector.kind === edge.kind) &&
  (selector.from === undefined || selector.from === edge.from) &&
  (selector.to === undefined || selector.to === edge.to);

const matchesDiff = (
  diff: NonNullable<Candidate["diff"]>,
  selector: Extract<LocalPolicyRule, { target: "diff" }>["selector"],
): boolean =>
  (selector.kind === undefined || selector.kind === diff.kind) &&
  (selector.id === undefined || selector.id === diff.id) &&
  (selector.code === undefined || selector.code === diff.code) &&
  (selector.classification === undefined ||
    selector.classification === diff.classification);

const matchingCandidates = (
  rule: LocalPolicyRule,
  candidates: { nodes: Candidate[]; edges: Candidate[]; diffs: Candidate[] },
): Candidate[] => {
  const targetCandidates =
    rule.target === "node"
      ? candidates.nodes
      : rule.target === "edge"
        ? candidates.edges
        : candidates.diffs;
  return targetCandidates.filter((candidate) => {
    if (rule.target === "node") {
      return candidate.node
        ? matchesNode(candidate.node, rule.selector)
        : false;
    }
    if (rule.target === "edge") {
      return candidate.edge
        ? matchesEdge(candidate.edge, rule.selector)
        : false;
    }
    return candidate.diff ? matchesDiff(candidate.diff, rule.selector) : false;
  });
};

const ruleViolation = (
  policy: PolicyConfig,
  rule: LocalPolicyRule,
  inputKind: "snapshot" | "diff",
  matches: readonly Candidate[],
): PolicyViolation | undefined => {
  const count = matches.length;
  const violated =
    rule.assertion === "exists"
      ? count === 0
      : rule.assertion === "absent"
        ? count > 0
        : rule.assertion === "count-at-most"
          ? count > (rule.value ?? 0)
          : count < (rule.value ?? 0);
  if (!violated) return undefined;

  const expected =
    rule.assertion === "exists"
      ? 1
      : rule.assertion === "absent"
        ? 0
        : rule.value;
  const effect = rule.effect ?? policy.mode;
  const reason =
    rule.assertion === "exists"
      ? `policy rule ${rule.id} requires at least one matching ${rule.target}, but none matched`
      : rule.assertion === "absent"
        ? `policy rule ${rule.id} forbids matching ${rule.target}, but ${count} matched`
        : rule.assertion === "count-at-most"
          ? `policy rule ${rule.id} permits at most ${rule.value} matching ${rule.target}, but ${count} matched`
          : `policy rule ${rule.id} requires at least ${rule.value} matching ${rule.target}, but only ${count} matched`;
  const evidenceRefs = uniqueSorted([
    `input:${inputKind}`,
    `policy:${policy.policyId}`,
    `policy-rule:${rule.id}`,
    ...matches.flatMap((candidate) => candidate.evidenceRefs),
  ]);
  return {
    id: `violation:${rule.id}`,
    policyId: policy.policyId,
    ruleId: rule.id,
    target: rule.target,
    assertion: rule.assertion,
    effect,
    count,
    ...(expected === undefined ? {} : { expected }),
    matches: matches.map((candidate) => candidate.id).sort(compareStrings),
    reason,
    evidenceRefs,
  };
};

const unsupportedRule = (
  policy: PolicyConfig,
  rule: LocalPolicyRule,
  inputKind: "snapshot" | "diff",
): PolicyUnsupported | undefined => {
  if (inputKind !== "snapshot" || rule.target !== "diff") return undefined;
  return {
    id: `unsupported:${rule.id}`,
    policyId: policy.policyId,
    ruleId: rule.id,
    target: rule.target,
    code: "unsupported-target",
    reason:
      "diff-target policy rules require a canonical GraphDiff input; a snapshot does not contain change records",
    evidenceRefs: uniqueSorted([
      `input:${inputKind}`,
      `policy:${policy.policyId}`,
      `policy-rule:${rule.id}`,
    ]),
  };
};

const parseInput = (
  input: PolicyEvaluationInput,
):
  | { kind: "snapshot"; graph: GraphSnapshot }
  | { kind: "diff"; graph: GraphDiff } => {
  if (input.kind === "snapshot") {
    return {
      kind: "snapshot",
      graph: canonicalizeGraphSnapshot(input.snapshot),
    };
  }
  if (input.kind === "diff") {
    return { kind: "diff", graph: canonicalizeGraphDiff(input.diff) };
  }
  throw new PolicyEvaluationError(
    "invalid-input",
    "policy evaluation input kind must be snapshot or diff",
  );
};

export const evaluatePolicy = (
  policyInput: unknown,
  input: PolicyEvaluationInput,
): PolicyEvaluation => {
  const policy = parsePolicyConfig(policyInput);
  const parsedInput = parseInput(input);
  const candidates =
    parsedInput.kind === "snapshot"
      ? (() => {
          const snapshot = snapshotCandidates(parsedInput.graph);
          return { ...snapshot, diffs: [] };
        })()
      : diffCandidates(parsedInput.graph);
  const violations: PolicyViolation[] = [];
  const unsupported: PolicyUnsupported[] = [];

  for (const rule of policy.rules) {
    const unsupportedFinding = unsupportedRule(policy, rule, parsedInput.kind);
    if (unsupportedFinding) {
      unsupported.push(unsupportedFinding);
      continue;
    }
    const violation = ruleViolation(
      policy,
      rule,
      parsedInput.kind,
      matchingCandidates(rule, candidates),
    );
    if (violation) violations.push(violation);
  }

  violations.sort((left, right) => compareStrings(left.id, right.id));
  unsupported.sort((left, right) => compareStrings(left.id, right.id));
  const report = {
    schemaVersion: POLICY_EVALUATION_SCHEMA_VERSION,
    contract: POLICY_EVALUATION_CONTRACT,
    policyId: policy.policyId,
    policyVersion: policy.version,
    inputKind: parsedInput.kind,
    mode: policy.mode,
    status:
      violations.length > 0
        ? "violations"
        : unsupported.length > 0
          ? "unsupported"
          : "passed",
    evaluatedRules: policy.rules.length,
    passedRules: policy.rules.length - violations.length - unsupported.length,
    unsupportedRules: unsupported.length,
    violations,
    unsupported,
  } satisfies PolicyEvaluation;
  return PolicyEvaluationSchema.parse(report);
};

export const evaluatePolicyOnSnapshot = (
  policyInput: unknown,
  snapshot: unknown,
): PolicyEvaluation =>
  evaluatePolicy(policyInput, { kind: "snapshot", snapshot });

export const evaluatePolicyOnDiff = (
  policyInput: unknown,
  diff: unknown,
): PolicyEvaluation => evaluatePolicy(policyInput, { kind: "diff", diff });

export const evaluatePolicyConfig = evaluatePolicy;

export const serializePolicyEvaluation = (value: unknown): string =>
  stableStringify(PolicyEvaluationSchema.parse(value));
