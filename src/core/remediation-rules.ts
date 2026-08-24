import { createHash } from "node:crypto";

import { z } from "zod";

import { stableStringify } from "./canonical.js";
import {
  generateRemediationSuggestions,
  RemediationRuleSchema,
  type GenerateRemediationSuggestionsOptions,
  type RemediationRule,
  type RemediationSuggestionReport,
} from "./remediation-suggestions.js";

export const REMEDIATION_RULESET_SCHEMA_VERSION = 1 as const;
export const REMEDIATION_RULESET_CONTRACT =
  "cartograph.remediation-rules" as const;
export const REMEDIATION_RULESET_ID =
  "cartograph.default-remediation-rules" as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u,
    "must be a portable lower-case identifier",
  );
const TextSchema = z.string().trim().min(1).max(1_000);

export const RemediationRuleCatalogEntrySchema = z
  .object({
    rule: RemediationRuleSchema,
    applicability: z
      .object({
        findingCodes: z.array(IdentifierSchema).min(1).max(8),
        summary: TextSchema,
      })
      .strict(),
    preconditions: z.array(TextSchema).min(1).max(8),
    nonGoals: z.array(TextSchema).min(1).max(8),
    validationCommands: z.array(TextSchema).min(1).max(8),
    fixtureIds: z
      .object({
        positive: z.array(IdentifierSchema).min(1).max(8),
        negative: z.array(IdentifierSchema).min(1).max(8),
      })
      .strict(),
    reviewStatus: z.literal("reviewed"),
    readOnly: z.literal(true),
  })
  .strict()
  .superRefine((entry, context) => {
    if (!entry.applicability.findingCodes.includes(entry.rule.findingCode)) {
      context.addIssue({
        code: "custom",
        path: ["applicability", "findingCodes"],
        message: "applicability must include the rule finding code",
      });
    }
    const fixtureIds = [
      ...entry.fixtureIds.positive,
      ...entry.fixtureIds.negative,
    ];
    if (new Set(fixtureIds).size !== fixtureIds.length) {
      context.addIssue({
        code: "custom",
        path: ["fixtureIds"],
        message: "positive and negative fixture IDs must be unique",
      });
    }
  });

export const RemediationRuleCatalogSchema = z
  .object({
    schemaVersion: z.literal(REMEDIATION_RULESET_SCHEMA_VERSION),
    contract: z.literal(REMEDIATION_RULESET_CONTRACT),
    catalogId: z.literal(REMEDIATION_RULESET_ID),
    rules: z.array(RemediationRuleCatalogEntrySchema).min(6).max(32),
  })
  .strict()
  .superRefine((catalog, context) => {
    const ruleIds = new Set<string>();
    const findingCodes = new Set<string>();
    for (const [index, entry] of catalog.rules.entries()) {
      if (ruleIds.has(entry.rule.ruleId)) {
        context.addIssue({
          code: "custom",
          path: ["rules", index, "rule", "ruleId"],
          message: "rule IDs must be unique",
        });
      }
      if (findingCodes.has(entry.rule.findingCode)) {
        context.addIssue({
          code: "custom",
          path: ["rules", index, "rule", "findingCode"],
          message: "finding codes must be unique in the reviewed catalog",
        });
      }
      ruleIds.add(entry.rule.ruleId);
      findingCodes.add(entry.rule.findingCode);
    }
  });

export type RemediationRuleCatalogEntry = z.infer<
  typeof RemediationRuleCatalogEntrySchema
>;
export type RemediationRuleCatalog = z.infer<
  typeof RemediationRuleCatalogSchema
>;

const ruleEntry = (
  rule: RemediationRule,
  applicability: string,
  preconditions: string[],
  nonGoals: string[],
  validationCommands: string[],
  positiveFixture: string,
  negativeFixture: string,
): RemediationRuleCatalogEntry => ({
  rule,
  applicability: {
    findingCodes: [rule.findingCode],
    summary: applicability,
  },
  preconditions,
  nonGoals,
  validationCommands,
  fixtureIds: { positive: [positiveFixture], negative: [negativeFixture] },
  reviewStatus: "reviewed",
  readOnly: true,
});

const defaultCatalog = RemediationRuleCatalogSchema.parse({
  schemaVersion: REMEDIATION_RULESET_SCHEMA_VERSION,
  contract: REMEDIATION_RULESET_CONTRACT,
  catalogId: REMEDIATION_RULESET_ID,
  rules: [
    ruleEntry(
      {
        ruleId: "policy-unknown-edge-review",
        findingCode: "policy.unknown-edge",
        kind: "policy-action",
        title: "Review the unknown-edge policy boundary.",
        rationale:
          "An unknown edge needs an explicit human-reviewed policy decision before it is accepted or rejected.",
        proposal: {
          operation: "policy",
          description:
            "Prepare a reversible policy review; do not apply or weaken the policy automatically.",
          targets: [".cartograph/policy.json"],
          edits: [
            {
              target: ".cartograph/policy.json",
              change:
                "Propose an explicit allow or deny entry after reviewing the linked evidence.",
              reversible: true,
            },
          ],
        },
        confidence: 0.82,
        assumptions: ["The policy baseline digest is current."],
        risk: "medium",
        validationPlan: [
          {
            id: "policy-diff",
            action:
              "Compare the proposed policy entry with the current baseline.",
            expected:
              "The diff is deterministic and leaves policy truth unchanged.",
          },
        ],
      },
      "Applies to a supported unknown-edge policy finding with current evidence.",
      ["A current baseline and linked policy evidence digest are available."],
      [
        "Does not decide policy, mutate graph truth, or apply a configuration edit.",
      ],
      ["Run the policy validator after a human reviews any proposed change."],
      "policy-unknown-edge-positive",
      "policy-unknown-edge-negative",
    ),
    ruleEntry(
      {
        ruleId: "configuration-missing-boundary-review",
        findingCode: "configuration.missing-boundary",
        kind: "configuration-change",
        title: "Review the missing configuration boundary.",
        rationale:
          "A missing boundary should be narrowed to an explicit configuration proposal before implementation is considered.",
        proposal: {
          operation: "configure",
          description:
            "Describe a reversible configuration boundary change for human review.",
          targets: ["config/boundaries.json"],
          edits: [
            {
              target: "config/boundaries.json",
              change:
                "Add an explicit boundary entry only after validating the affected evidence.",
              reversible: true,
            },
          ],
        },
        confidence: 0.78,
        assumptions: [
          "The configuration source is the declared local authority.",
        ],
        risk: "medium",
        validationPlan: [
          {
            id: "boundary-check",
            action:
              "Inspect the proposed boundary against the current graph diff.",
            expected: "No unrelated node or edge changes are introduced.",
          },
        ],
      },
      "Applies to a missing configuration-boundary finding with one owner.",
      ["The finding has a current baseline, evidence, and explicit owner."],
      [
        "Does not write configuration, resolve unrelated findings, or choose commands.",
      ],
      ["Run the local configuration and graph checks after approval."],
      "configuration-missing-boundary-positive",
      "configuration-missing-boundary-negative",
    ),
    ruleEntry(
      {
        ruleId: "decision-reference-missing-review",
        findingCode: "decision.missing-reference",
        kind: "documentation-action",
        title: "Document the missing architecture decision reference.",
        rationale:
          "A missing decision reference is best repaired by linking an existing decision or recording an explicit gap for review.",
        proposal: {
          operation: "document",
          description:
            "Prepare a reversible documentation update that names the decision evidence to review.",
          targets: ["docs/adr/README.md"],
          edits: [
            {
              target: "docs/adr/README.md",
              change:
                "Add a reviewed reference to the relevant architecture decision or mark the gap explicitly.",
              reversible: true,
            },
          ],
        },
        confidence: 0.76,
        assumptions: [
          "A local decision record or an explicit gap owner exists.",
        ],
        risk: "low",
        validationPlan: [
          {
            id: "decision-link",
            action:
              "Check that the documentation reference resolves to the declared decision evidence.",
            expected:
              "The report preserves the original finding and adds no unsupported claim.",
          },
        ],
      },
      "Applies to a missing decision-reference finding with current evidence.",
      ["The evidence points to a stable decision or a documented gap."],
      ["Does not create a decision, infer approval, or change policy state."],
      ["Run the documentation and fixture validators after review."],
      "decision-reference-missing-positive",
      "decision-reference-missing-negative",
    ),
    ruleEntry(
      {
        ruleId: "ownership-missing-owner-review",
        findingCode: "ownership.missing-owner",
        kind: "investigation-step",
        title: "Investigate the missing architecture owner.",
        rationale:
          "Ownerless findings need an explicit ownership lookup before any remediation proposal can be accountable.",
        proposal: {
          operation: "investigate",
          description:
            "Identify the declared local ownership source and request a human owner assignment.",
          targets: [".cartograph/ownership.json"],
          edits: [],
        },
        confidence: 0.74,
        assumptions: ["A local ownership source is available for review."],
        risk: "low",
        validationPlan: [
          {
            id: "owner-source",
            action:
              "Inspect the declared ownership source without changing it.",
            expected:
              "An accountable owner is recorded or the gap remains explicit.",
          },
        ],
      },
      "Applies to a supported missing-owner finding as an investigation only.",
      ["The finding evidence identifies the affected architecture surface."],
      ["Does not invent an owner, assign ownership, or mutate workflow state."],
      ["Run the ownership-source validator after an owner is assigned."],
      "ownership-missing-owner-positive",
      "ownership-missing-owner-negative",
    ),
    ruleEntry(
      {
        ruleId: "exception-expired-review",
        findingCode: "exception.expired",
        kind: "waiver-action",
        title: "Review the expired architecture exception.",
        rationale:
          "An expired exception needs a human decision to remove, renew, or replace it with current evidence.",
        proposal: {
          operation: "waiver",
          description:
            "Prepare a reversible exception review with explicit expiry and evidence ownership.",
          targets: [".cartograph/waivers.json"],
          edits: [
            {
              target: ".cartograph/waivers.json",
              change:
                "Propose removal or renewal only after a reviewer confirms current evidence and expiry.",
              reversible: true,
            },
          ],
        },
        confidence: 0.84,
        assumptions: [
          "The exception record includes an expiry and owner reference.",
        ],
        risk: "high",
        validationPlan: [
          {
            id: "waiver-expiry",
            action:
              "Compare the exception expiry and evidence digest with the current baseline.",
            expected:
              "No expired exception is treated as approved without an explicit review.",
          },
        ],
      },
      "Applies to an expired exception with current, owner-linked evidence.",
      ["The exception expiry and owner are present in the finding evidence."],
      ["Does not renew, remove, or weaken a waiver automatically."],
      ["Run the waiver and policy validators after an explicit decision."],
      "exception-expired-positive",
      "exception-expired-negative",
    ),
    ruleEntry(
      {
        ruleId: "dependency-unresolved-review",
        findingCode: "dependency.unresolved",
        kind: "investigation-step",
        title: "Investigate the unresolved dependency edge.",
        rationale:
          "An unresolved dependency should be traced to bounded evidence before a relationship is proposed.",
        proposal: {
          operation: "investigate",
          description:
            "Inspect the declared dependency evidence and prepare a human-reviewed follow-up.",
          targets: ["docs/DEPENDENCIES.md"],
          edits: [],
        },
        confidence: 0.7,
        assumptions: [
          "The dependency evidence identifies both sides of the boundary.",
        ],
        risk: "medium",
        validationPlan: [
          {
            id: "dependency-trace",
            action:
              "Trace the dependency evidence against the current graph snapshot.",
            expected:
              "The original unresolved relationship remains unchanged until reviewed.",
          },
        ],
      },
      "Applies to a supported unresolved dependency finding with bounded evidence.",
      ["The finding names a bounded dependency surface and current baseline."],
      [
        "Does not create edges, fetch repositories, or execute dependency commands.",
      ],
      ["Run the offline graph and dependency checks after review."],
      "dependency-unresolved-positive",
      "dependency-unresolved-negative",
    ),
  ],
});

export const defaultRemediationRuleCatalog = (): RemediationRuleCatalog =>
  RemediationRuleCatalogSchema.parse(defaultCatalog);

export const remediationRuleCatalogDigest = (
  catalog: RemediationRuleCatalog,
): `sha256:${string}` =>
  `sha256:${createHash("sha256")
    .update(
      stableStringify(RemediationRuleCatalogSchema.parse(catalog)),
      "utf8",
    )
    .digest("hex")}`;

export const serializeRemediationRuleCatalog = (catalog: unknown): string =>
  stableStringify(RemediationRuleCatalogSchema.parse(catalog));

export interface GenerateDeterministicRemediationSuggestionsOptions extends Omit<
  GenerateRemediationSuggestionsOptions,
  "rules"
> {
  catalog?: RemediationRuleCatalog;
}

const findingSortKey = (value: unknown): string => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return stableStringify(value);
  const finding = value as {
    findingCode?: unknown;
    findingId?: unknown;
  };
  if (
    typeof finding.findingCode === "string" &&
    typeof finding.findingId === "string"
  )
    return `${finding.findingCode}\u0000${finding.findingId}`;
  return stableStringify(value);
};

export const generateDeterministicRemediationSuggestions = (
  findings: readonly unknown[],
  options: GenerateDeterministicRemediationSuggestionsOptions = {},
): RemediationSuggestionReport => {
  const catalog = RemediationRuleCatalogSchema.parse(
    options.catalog ?? defaultCatalog,
  );
  const sortedFindings = [...findings].sort((left, right) =>
    findingSortKey(left).localeCompare(findingSortKey(right)),
  );
  const sortedRules = [...catalog.rules]
    .sort((left, right) => left.rule.ruleId.localeCompare(right.rule.ruleId))
    .map((entry) => entry.rule);
  return generateRemediationSuggestions(sortedFindings, {
    ...options,
    rules: sortedRules,
  });
};
