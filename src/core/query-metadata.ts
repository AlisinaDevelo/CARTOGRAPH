import { z, ZodError } from "zod";

import { GraphValidationError, stableStringify } from "./canonical.js";
import {
  ADR_REFERENCE_DIAGNOSTIC_CODES,
  AdrReferenceDiagnosticCodeSchema,
  AdrReferenceDocumentSchema,
  AdrReferenceSchema,
  serializeAdrGraphEdgeId,
} from "./adr.js";
import {
  PolicyConfigSchema,
  type LocalPolicyRule,
  type PolicyConfig,
} from "./policy.js";
import {
  PolicyEvaluationSchema,
  PolicyExceptionReportSchema,
  PolicyUnsupportedSchema,
  PolicyViolationSchema,
} from "./policy-evaluation.js";
import type { GraphEdge, GraphNode } from "./schemas.js";

export const ARCHITECTURE_QUERY_METADATA_SCHEMA_VERSION = 1 as const;
export const ARCHITECTURE_QUERY_METADATA_CONTRACT =
  "cartograph.architecture-query-metadata" as const;
export const ARCHITECTURE_QUERY_OWNERSHIP_HINT_CONTRACT =
  "cartograph.ownership-hint" as const;

const MetadataIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );

const MetadataPathSchema = MetadataIdentifierSchema.refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !value.startsWith("\\") &&
    !value.startsWith("//") &&
    !/^[A-Za-z][A-Za-z\d+.-]*:/.test(value) &&
    !value.split("/").some((part) => part === ".."),
  "must be a repository-relative metadata source path",
).max(1_024);

const MetadataDateTimeSchema = MetadataIdentifierSchema.refine(
  (value) => Number.isFinite(Date.parse(value)),
  "must be a parseable date-time",
);

const MetadataGraphIdSchema = MetadataIdentifierSchema;

const MetadataTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("node"),
      graphId: MetadataGraphIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("edge"),
      graphId: MetadataGraphIdSchema,
    })
    .strict(),
]);

const MetadataEvidenceRefsSchema = z
  .array(MetadataIdentifierSchema)
  .max(256)
  .default([]);

export const ArchitectureQueryOwnershipHintSchema = z
  .object({
    schemaVersion: z
      .literal(ARCHITECTURE_QUERY_METADATA_SCHEMA_VERSION)
      .default(ARCHITECTURE_QUERY_METADATA_SCHEMA_VERSION),
    contract: z
      .literal(ARCHITECTURE_QUERY_OWNERSHIP_HINT_CONTRACT)
      .default(ARCHITECTURE_QUERY_OWNERSHIP_HINT_CONTRACT),
    id: MetadataIdentifierSchema,
    target: MetadataTargetSchema,
    owners: z.array(MetadataIdentifierSchema).max(64).default([]),
    status: z
      .enum(["declared", "missing", "conflict", "stale", "unsupported"])
      .default("declared"),
    source: MetadataPathSchema.optional(),
    revision: MetadataIdentifierSchema.optional(),
    observedAt: MetadataDateTimeSchema.optional(),
    evidenceRefs: MetadataEvidenceRefsSchema,
  })
  .strict();

export const ArchitectureQueryAdrDiagnosticSchema = z
  .object({
    code: AdrReferenceDiagnosticCodeSchema,
    severity: z.literal("error"),
    referenceId: MetadataIdentifierSchema.optional(),
    file: MetadataPathSchema.optional(),
    graphId: MetadataGraphIdSchema.optional(),
    relatedReferenceId: MetadataIdentifierSchema.optional(),
    message: MetadataIdentifierSchema,
  })
  .strict();

export const ArchitectureQueryMetadataUnsupportedSchema = z
  .object({
    id: MetadataIdentifierSchema,
    category: z.enum(["policy", "decision", "ownership", "other"]),
    code: MetadataIdentifierSchema,
    message: MetadataIdentifierSchema,
    source: MetadataPathSchema.optional(),
    target: MetadataTargetSchema.optional(),
    evidenceRefs: MetadataEvidenceRefsSchema,
  })
  .strict();

export const ArchitectureQueryMetadataDiagnosticSchema = z
  .object({
    id: MetadataIdentifierSchema,
    category: z.enum(["policy", "decision", "ownership", "other"]),
    code: MetadataIdentifierSchema,
    severity: z.enum(["info", "warning", "error"]),
    message: MetadataIdentifierSchema,
    target: MetadataTargetSchema.optional(),
    source: MetadataPathSchema.optional(),
    evidenceRefs: MetadataEvidenceRefsSchema,
  })
  .strict();

export const ArchitectureQueryMetadataPolicyInputSchema = z
  .object({
    source: MetadataPathSchema.optional(),
    config: PolicyConfigSchema,
    evaluation: PolicyEvaluationSchema.optional(),
  })
  .strict();

export const ArchitectureQueryMetadataDecisionInputSchema = z
  .object({
    source: MetadataPathSchema.optional(),
    document: AdrReferenceDocumentSchema,
    diagnostics: z
      .array(ArchitectureQueryAdrDiagnosticSchema)
      .max(10_000)
      .default([]),
  })
  .strict();

export const ArchitectureQueryMetadataOwnershipInputSchema = z
  .object({
    source: MetadataPathSchema.optional(),
    hints: z
      .array(ArchitectureQueryOwnershipHintSchema)
      .max(10_000)
      .default([]),
  })
  .strict();

export const ArchitectureQueryMetadataInputSchema = z
  .object({
    schemaVersion: z
      .literal(ARCHITECTURE_QUERY_METADATA_SCHEMA_VERSION)
      .default(ARCHITECTURE_QUERY_METADATA_SCHEMA_VERSION),
    contract: z
      .literal(ARCHITECTURE_QUERY_METADATA_CONTRACT)
      .default(ARCHITECTURE_QUERY_METADATA_CONTRACT),
    policies: z
      .array(ArchitectureQueryMetadataPolicyInputSchema)
      .max(128)
      .default([]),
    decisions: ArchitectureQueryMetadataDecisionInputSchema.optional(),
    ownership: ArchitectureQueryMetadataOwnershipInputSchema.optional(),
    unsupported: z
      .array(ArchitectureQueryMetadataUnsupportedSchema)
      .max(10_000)
      .default([]),
  })
  .strict();

const PolicyRuleProjectionSchema = z
  .object({
    policyId: MetadataIdentifierSchema,
    policyVersion: MetadataIdentifierSchema,
    ruleId: MetadataIdentifierSchema,
    target: z.enum(["node", "edge", "diff"]),
    assertion: z.enum(["exists", "absent", "count-at-most", "count-at-least"]),
    value: z.number().int().nonnegative().optional(),
    effect: z.enum(["informational", "enforce"]),
    applicableGraphIds: z.array(MetadataGraphIdSchema).max(100_000),
    evidenceRefs: MetadataEvidenceRefsSchema,
  })
  .strict();

const PolicyViolationProjectionSchema = PolicyViolationSchema.extend({
  source: MetadataPathSchema.optional(),
  applicableGraphIds: z.array(MetadataGraphIdSchema).max(100_000),
});

const PolicyUnsupportedProjectionSchema = PolicyUnsupportedSchema.extend({
  source: MetadataPathSchema.optional(),
  applicableGraphIds: z.array(MetadataGraphIdSchema).max(100_000),
});

const PolicyExceptionProjectionSchema = PolicyExceptionReportSchema.extend({
  policyId: MetadataIdentifierSchema,
  policyVersion: MetadataIdentifierSchema,
  source: MetadataPathSchema.optional(),
  applicableGraphIds: z.array(MetadataGraphIdSchema).max(100_000),
});

const PolicyProjectionSchema = z
  .object({
    policyId: MetadataIdentifierSchema,
    policyVersion: MetadataIdentifierSchema,
    source: MetadataPathSchema.optional(),
    evaluationStatus: z
      .enum(["passed", "violations", "unsupported"])
      .optional(),
    evaluationInputKind: z.enum(["snapshot", "diff"]).optional(),
    rules: z.array(PolicyRuleProjectionSchema).max(256),
    violations: z.array(PolicyViolationProjectionSchema).max(10_000),
    unsupported: z.array(PolicyUnsupportedProjectionSchema).max(10_000),
    exceptions: z.array(PolicyExceptionProjectionSchema).max(128),
  })
  .strict();

const DecisionReferenceProjectionSchema = AdrReferenceSchema.extend({
  source: MetadataPathSchema.optional(),
  matchedGraphIds: z.array(MetadataGraphIdSchema).max(256),
  diagnostics: z.array(ArchitectureQueryAdrDiagnosticSchema).max(10_000),
});

const DecisionsProjectionSchema = z
  .object({
    source: MetadataPathSchema.optional(),
    references: z.array(DecisionReferenceProjectionSchema).max(512),
    diagnostics: z.array(ArchitectureQueryAdrDiagnosticSchema).max(10_000),
  })
  .strict();

const OwnershipHintProjectionSchema =
  ArchitectureQueryOwnershipHintSchema.extend({
    matchedGraphIds: z.array(MetadataGraphIdSchema).max(100_000),
  }).strict();

const OwnershipProjectionSchema = z
  .object({
    source: MetadataPathSchema.optional(),
    hints: z.array(OwnershipHintProjectionSchema).max(10_000),
  })
  .strict();

export const ArchitectureQueryMetadataResultSchema = z
  .object({
    schemaVersion: z.literal(ARCHITECTURE_QUERY_METADATA_SCHEMA_VERSION),
    contract: z.literal(ARCHITECTURE_QUERY_METADATA_CONTRACT),
    policies: z.array(PolicyProjectionSchema).max(128),
    decisions: DecisionsProjectionSchema,
    ownership: OwnershipProjectionSchema,
    unsupported: z
      .array(ArchitectureQueryMetadataUnsupportedSchema)
      .max(10_000),
    diagnostics: z.array(ArchitectureQueryMetadataDiagnosticSchema).max(20_000),
  })
  .strict();

export type ArchitectureQueryOwnershipHint = z.infer<
  typeof ArchitectureQueryOwnershipHintSchema
>;
export type ArchitectureQueryMetadataInput = z.infer<
  typeof ArchitectureQueryMetadataInputSchema
>;
export type ArchitectureQueryMetadataResult = z.infer<
  typeof ArchitectureQueryMetadataResultSchema
>;
export type ArchitectureQueryMetadataDiagnostic = z.infer<
  typeof ArchitectureQueryMetadataDiagnosticSchema
>;
type ArchitectureQueryAdrDiagnostic = z.infer<
  typeof ArchitectureQueryAdrDiagnosticSchema
>;

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const sortUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const parseMetadataContract = <T>(
  parse: (input: unknown) => T,
  input: unknown,
  contract: string,
): T => {
  try {
    return parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new GraphValidationError(
        contract,
        error.issues.map((issue) => ({
          path: issue.path.map((part) =>
            typeof part === "symbol" ? part.toString() : part,
          ),
          message: issue.message,
        })),
      );
    }
    throw error;
  }
};

const emptyMetadataInput = {
  schemaVersion: ARCHITECTURE_QUERY_METADATA_SCHEMA_VERSION,
  contract: ARCHITECTURE_QUERY_METADATA_CONTRACT,
};

export const parseArchitectureQueryMetadata = (
  input: unknown,
): ArchitectureQueryMetadataInput =>
  parseMetadataContract(
    (value) => ArchitectureQueryMetadataInputSchema.parse(value),
    input ?? emptyMetadataInput,
    "ArchitectureQueryMetadata",
  );

type SelectedTarget = {
  kind: "node" | "edge";
  canonicalId: string;
  aliases: readonly string[];
};

const selectedTargets = (
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): SelectedTarget[] => [
  ...nodes.map((node) => ({
    kind: "node" as const,
    canonicalId: `node:${node.id}`,
    aliases: [
      node.id,
      node.stableKey,
      `node:${node.id}`,
      `node:${node.stableKey}`,
    ],
  })),
  ...edges.map((edge) => ({
    kind: "edge" as const,
    canonicalId: serializeAdrGraphEdgeId(edge),
    aliases: [serializeAdrGraphEdgeId(edge)],
  })),
];

const matchingGraphIds = (
  references: readonly string[],
  targets: readonly SelectedTarget[],
): string[] => {
  const referenceSet = new Set(references);
  return sortUnique(
    targets
      .filter((target) =>
        target.aliases.some((alias) => referenceSet.has(alias)),
      )
      .map((target) => target.canonicalId),
  );
};

const policyRuleMatches = (
  rule: LocalPolicyRule,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): SelectedTarget[] => {
  if (rule.target === "node") {
    return nodes
      .filter(
        (node) =>
          (rule.selector.kind === undefined ||
            rule.selector.kind === node.kind) &&
          (rule.selector.id === undefined ||
            rule.selector.id === node.id ||
            rule.selector.id === node.stableKey) &&
          (rule.selector.name === undefined ||
            rule.selector.name === node.name),
      )
      .map((node) => ({
        kind: "node" as const,
        canonicalId: `node:${node.id}`,
        aliases: [
          node.id,
          node.stableKey,
          `node:${node.id}`,
          `node:${node.stableKey}`,
        ],
      }));
  }
  if (rule.target === "edge") {
    return edges
      .filter(
        (edge) =>
          (rule.selector.kind === undefined ||
            rule.selector.kind === edge.kind) &&
          (rule.selector.from === undefined ||
            rule.selector.from === edge.from) &&
          (rule.selector.to === undefined || rule.selector.to === edge.to),
      )
      .map((edge) => ({
        kind: "edge" as const,
        canonicalId: serializeAdrGraphEdgeId(edge),
        aliases: [serializeAdrGraphEdgeId(edge)],
      }));
  }
  return [];
};

const evidenceForRule = (
  policy: PolicyConfig,
  rule: LocalPolicyRule,
  source: string | undefined,
  applicableGraphIds: readonly string[],
): string[] =>
  sortUnique([
    `policy:${policy.policyId}`,
    `policy-rule:${rule.id}`,
    ...(source === undefined ? [] : [`metadata-source:${source}`]),
    ...applicableGraphIds,
  ]);

const policyFindingGraphIds = (
  finding: { matches?: readonly string[]; evidenceRefs: readonly string[] },
  targets: readonly SelectedTarget[],
): string[] =>
  matchingGraphIds(
    [...(finding.matches ?? []), ...finding.evidenceRefs],
    targets,
  );

const adrDiagnosticsFor = (
  diagnostics: readonly ArchitectureQueryAdrDiagnostic[],
  referenceId: string,
): ArchitectureQueryAdrDiagnostic[] =>
  diagnostics
    .filter((diagnostic) => diagnostic.referenceId === referenceId)
    .sort((left, right) =>
      compareStrings(
        `${left.code}\u0000${left.graphId ?? ""}\u0000${left.message}`,
        `${right.code}\u0000${right.graphId ?? ""}\u0000${right.message}`,
      ),
    );

const metadataDiagnostic = (
  id: string,
  category: ArchitectureQueryMetadataDiagnostic["category"],
  code: string,
  severity: ArchitectureQueryMetadataDiagnostic["severity"],
  message: string,
  options: Partial<
    Pick<
      ArchitectureQueryMetadataDiagnostic,
      "target" | "source" | "evidenceRefs"
    >
  > = {},
): ArchitectureQueryMetadataDiagnostic => ({
  id,
  category,
  code,
  severity,
  message,
  evidenceRefs: [],
  ...options,
});

const projectPolicy = (
  input: z.infer<typeof ArchitectureQueryMetadataPolicyInputSchema>,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  targets: readonly SelectedTarget[],
  diagnostics: ArchitectureQueryMetadataDiagnostic[],
): z.infer<typeof PolicyProjectionSchema> => {
  const policy = input.config;
  const ruleProjections = policy.rules
    .map((rule) => {
      const matched = policyRuleMatches(rule, nodes, edges);
      const applicableGraphIds = sortUnique(
        matched.map((item) => item.canonicalId),
      );
      if (rule.target === "diff" || applicableGraphIds.length === 0)
        return undefined;
      return {
        policyId: policy.policyId,
        policyVersion: policy.version,
        ruleId: rule.id,
        target: rule.target,
        assertion: rule.assertion,
        ...(rule.value === undefined ? {} : { value: rule.value }),
        effect: rule.effect ?? policy.mode,
        applicableGraphIds,
        evidenceRefs: evidenceForRule(
          policy,
          rule,
          input.source,
          applicableGraphIds,
        ),
      };
    })
    .filter((rule): rule is NonNullable<typeof rule> => rule !== undefined)
    .sort((left, right) => compareStrings(left.ruleId, right.ruleId));

  const projectedRuleIds = new Map(
    ruleProjections.map((rule) => [rule.ruleId, rule.applicableGraphIds]),
  );
  const evaluation = input.evaluation;
  if (evaluation === undefined) {
    diagnostics.push(
      metadataDiagnostic(
        `policy:${policy.policyId}:evaluation-missing`,
        "policy",
        "METADATA_POLICY_EVALUATION_MISSING",
        "warning",
        `policy ${policy.policyId} supplied rules without an evaluated finding set`,
        input.source === undefined ? {} : { source: input.source },
      ),
    );
  } else if (
    evaluation.policyId !== policy.policyId ||
    evaluation.policyVersion !== policy.version
  ) {
    diagnostics.push(
      metadataDiagnostic(
        `policy:${policy.policyId}:evaluation-conflict`,
        "policy",
        "METADATA_POLICY_EVALUATION_CONFLICT",
        "error",
        `policy evaluation ${evaluation.policyId}@${evaluation.policyVersion} does not match ${policy.policyId}@${policy.version}`,
        input.source === undefined ? {} : { source: input.source },
      ),
    );
  }

  const violations = (evaluation?.violations ?? [])
    .map((violation) => {
      const applicableGraphIds = policyFindingGraphIds(violation, targets);
      return applicableGraphIds.length === 0
        ? undefined
        : {
            ...violation,
            ...(input.source === undefined ? {} : { source: input.source }),
            applicableGraphIds,
          };
    })
    .filter(
      (finding): finding is NonNullable<typeof finding> =>
        finding !== undefined,
    )
    .sort((left, right) => compareStrings(left.id, right.id));

  const unsupported = (evaluation?.unsupported ?? [])
    .map((finding) => ({
      ...finding,
      ...(input.source === undefined ? {} : { source: input.source }),
      applicableGraphIds: policyFindingGraphIds(finding, targets),
    }))
    .sort((left, right) => compareStrings(left.id, right.id));

  const exceptions = (evaluation?.exceptions ?? [])
    .map((exception) => {
      const applicableGraphIds =
        projectedRuleIds.get(exception.ruleId ?? "") ?? [];
      if (
        applicableGraphIds.length === 0 &&
        exception.status !== "malformed" &&
        exception.status !== "expired"
      )
        return undefined;
      return {
        ...exception,
        policyId: policy.policyId,
        policyVersion: policy.version,
        ...(input.source === undefined ? {} : { source: input.source }),
        applicableGraphIds,
      };
    })
    .filter(
      (exception): exception is NonNullable<typeof exception> =>
        exception !== undefined,
    )
    .sort((left, right) => compareStrings(left.id, right.id));

  if (policy.rules.some((rule) => rule.target === "diff")) {
    diagnostics.push(
      metadataDiagnostic(
        `policy:${policy.policyId}:diff-rules-unsupported`,
        "policy",
        "METADATA_POLICY_DIFF_RULE_UNSUPPORTED",
        "info",
        `policy ${policy.policyId} contains diff-target rules that cannot apply to a snapshot query`,
        input.source === undefined ? {} : { source: input.source },
      ),
    );
  }

  return {
    policyId: policy.policyId,
    policyVersion: policy.version,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(evaluation === undefined
      ? {}
      : {
          evaluationStatus: evaluation.status,
          evaluationInputKind: evaluation.inputKind,
        }),
    rules: ruleProjections,
    violations,
    unsupported,
    exceptions,
  };
};

export const projectArchitectureQueryMetadata = (
  input: unknown,
  selected: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] },
): ArchitectureQueryMetadataResult => {
  const metadata = parseArchitectureQueryMetadata(input);
  const targets = selectedTargets(selected.nodes, selected.edges);
  const aliases = new Set(targets.flatMap((target) => target.aliases));
  const diagnostics: ArchitectureQueryMetadataDiagnostic[] = [];

  const policies = metadata.policies
    .map((policy) =>
      projectPolicy(
        policy,
        selected.nodes,
        selected.edges,
        targets,
        diagnostics,
      ),
    )
    .sort((left, right) => compareStrings(left.policyId, right.policyId));

  const decisions = metadata.decisions;
  const projectedDecisionReferences =
    decisions?.document.references
      .map((reference) => {
        const matchedGraphIds = sortUnique(
          reference.graphIds
            .filter((graphId) => aliases.has(graphId))
            .flatMap((graphId) => matchingGraphIds([graphId], targets)),
        );
        const referenceDiagnostics = adrDiagnosticsFor(
          decisions.diagnostics,
          reference.id,
        );
        if (matchedGraphIds.length === 0 && referenceDiagnostics.length === 0)
          return undefined;
        return {
          ...reference,
          ...(decisions.source === undefined
            ? {}
            : { source: decisions.source }),
          matchedGraphIds,
          diagnostics: referenceDiagnostics,
        };
      })
      .filter(
        (reference): reference is NonNullable<typeof reference> =>
          reference !== undefined,
      )
      .sort((left, right) => compareStrings(left.id, right.id)) ?? [];
  const projectedDecisionIds = new Set(
    projectedDecisionReferences.map((reference) => reference.id),
  );
  const projectedDecisionDiagnostics =
    decisions?.diagnostics
      .filter(
        (diagnostic) =>
          diagnostic.referenceId === undefined ||
          projectedDecisionIds.has(diagnostic.referenceId),
      )
      .sort((left, right) =>
        compareStrings(
          `${left.referenceId ?? ""}\u0000${left.code}\u0000${left.message}`,
          `${right.referenceId ?? ""}\u0000${right.code}\u0000${right.message}`,
        ),
      ) ?? [];
  const projectedDecisions: z.infer<typeof DecisionsProjectionSchema> = {
    ...(decisions?.source === undefined ? {} : { source: decisions.source }),
    references: projectedDecisionReferences,
    diagnostics: projectedDecisionDiagnostics,
  };

  if (decisions === undefined) {
    diagnostics.push(
      metadataDiagnostic(
        "decisions:metadata-missing",
        "decision",
        "METADATA_DECISIONS_MISSING",
        "warning",
        "no ADR reference document was supplied for this query projection",
      ),
    );
  }

  const ownership = metadata.ownership;
  const ownershipHints = ownership?.hints ?? [];
  const projectedOwnershipHints = ownershipHints
    .map((hint) => {
      const matchedGraphIds = matchingGraphIds([hint.target.graphId], targets);
      if (matchedGraphIds.length === 0 && hint.status === "declared")
        return undefined;
      return {
        ...hint,
        ...(ownership?.source === undefined || hint.source !== undefined
          ? {}
          : { source: ownership.source }),
        matchedGraphIds,
      };
    })
    .filter((hint): hint is NonNullable<typeof hint> => hint !== undefined)
    .sort((left, right) => compareStrings(left.id, right.id));

  for (const target of targets) {
    const matchingHints = ownershipHints.filter(
      (hint) => matchingGraphIds([hint.target.graphId], [target]).length > 0,
    );
    if (matchingHints.length === 0) {
      diagnostics.push(
        metadataDiagnostic(
          `ownership:${target.canonicalId}:missing`,
          "ownership",
          "METADATA_OWNERSHIP_MISSING",
          "warning",
          `no declared owner matches ${target.canonicalId}; ownership was not inferred`,
          {
            target: { kind: target.kind, graphId: target.canonicalId },
          },
        ),
      );
      continue;
    }
    const ownerSets = new Set(
      matchingHints.map((hint) =>
        stableStringify([...hint.owners].sort(compareStrings)),
      ),
    );
    if (ownerSets.size > 1) {
      diagnostics.push(
        metadataDiagnostic(
          `ownership:${target.canonicalId}:conflict`,
          "ownership",
          "METADATA_OWNERSHIP_CONFLICT",
          "error",
          `multiple ownership hints disagree for ${target.canonicalId}`,
          {
            target: { kind: target.kind, graphId: target.canonicalId },
            evidenceRefs: sortUnique(
              matchingHints.flatMap((hint) => hint.evidenceRefs),
            ),
          },
        ),
      );
    }
    for (const hint of matchingHints) {
      if (hint.status === "stale") {
        diagnostics.push(
          metadataDiagnostic(
            `ownership:${hint.id}:stale`,
            "ownership",
            "METADATA_OWNERSHIP_STALE",
            "warning",
            `ownership hint ${hint.id} is marked stale`,
            {
              target: { kind: target.kind, graphId: target.canonicalId },
              ...(hint.source === undefined ? {} : { source: hint.source }),
              evidenceRefs: hint.evidenceRefs,
            },
          ),
        );
      } else if (hint.status === "missing") {
        diagnostics.push(
          metadataDiagnostic(
            `ownership:${hint.id}:missing`,
            "ownership",
            "METADATA_OWNERSHIP_MISSING",
            "warning",
            `ownership hint ${hint.id} records a missing owner`,
            {
              target: { kind: target.kind, graphId: target.canonicalId },
              ...(hint.source === undefined ? {} : { source: hint.source }),
              evidenceRefs: hint.evidenceRefs,
            },
          ),
        );
      } else if (hint.status === "unsupported") {
        diagnostics.push(
          metadataDiagnostic(
            `ownership:${hint.id}:unsupported`,
            "ownership",
            "METADATA_OWNERSHIP_UNSUPPORTED",
            "warning",
            `ownership hint ${hint.id} uses an unsupported source semantics`,
            {
              target: { kind: target.kind, graphId: target.canonicalId },
              ...(hint.source === undefined ? {} : { source: hint.source }),
              evidenceRefs: hint.evidenceRefs,
            },
          ),
        );
      }
    }
  }

  const projectedOwnership: z.infer<typeof OwnershipProjectionSchema> = {
    ...(ownership?.source === undefined ? {} : { source: ownership.source }),
    hints: projectedOwnershipHints,
  };

  const unsupported = [...metadata.unsupported].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
  for (const item of unsupported) {
    diagnostics.push(
      metadataDiagnostic(
        `unsupported:${item.id}`,
        item.category,
        item.code,
        "info",
        item.message,
        {
          ...(item.target === undefined ? {} : { target: item.target }),
          ...(item.source === undefined ? {} : { source: item.source }),
          evidenceRefs: item.evidenceRefs,
        },
      ),
    );
  }

  return ArchitectureQueryMetadataResultSchema.parse({
    schemaVersion: ARCHITECTURE_QUERY_METADATA_SCHEMA_VERSION,
    contract: ARCHITECTURE_QUERY_METADATA_CONTRACT,
    policies,
    decisions: projectedDecisions,
    ownership: projectedOwnership,
    unsupported,
    diagnostics: diagnostics.sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
  });
};

export type ArchitectureQueryMetadataPolicyProjection = z.infer<
  typeof PolicyProjectionSchema
>;
export type ArchitectureQueryMetadataDecisionProjection = z.infer<
  typeof DecisionsProjectionSchema
>;
export type ArchitectureQueryMetadataOwnershipProjection = z.infer<
  typeof OwnershipProjectionSchema
>;

// Keep the diagnostic-code list referenced in the public module so contract
// consumers can discover the complete ADR provenance vocabulary without
// importing the lower-level ADR implementation.
export const ARCHITECTURE_QUERY_ADR_DIAGNOSTIC_CODES =
  ADR_REFERENCE_DIAGNOSTIC_CODES;
