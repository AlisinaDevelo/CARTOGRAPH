import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { z, ZodError } from "zod";

import { canonicalizeGraphDiff } from "./diff.js";
import { canonicalizeGraphSnapshot, stableStringify } from "./canonical.js";
import {
  SourceLocationSchema,
  type Diagnostic,
  type Evidence,
  type GraphDiff,
  type GraphEdge,
  type GraphSnapshot,
  type SourceLocation,
} from "./schemas.js";
import {
  PolicyEvaluationSchema,
  type PolicyEvaluation,
  type PolicyViolation,
} from "./policy-evaluation.js";

/**
 * CARTOGRAPH deliberately implements a small, line-local SARIF projection.
 * The native SARIF document remains consumable by code-scanning tools while
 * the `cartograph` property bags retain the canonical graph and evidence
 * identities needed to get back to the local report.
 */
export const SARIF_INTERCHANGE_SCHEMA_VERSION = 1 as const;
export const SARIF_INTERCHANGE_CONTRACT =
  "cartograph.sarif-interchange" as const;
export const SARIF_INTERCHANGE_MEDIA_TYPE = "application/sarif+json" as const;
export const SARIF_VERSION = "2.1.0" as const;
export const SARIF_SCHEMA_URI =
  "https://json.schemastore.org/sarif-2.1.0.json" as const;
export const SARIF_INTERCHANGE_MAX_RESULTS = 10_000 as const;
export const SARIF_INTERCHANGE_MAX_LOCATIONS = 128 as const;
export const SARIF_INTERCHANGE_MAX_RULES = 10_000 as const;
export const SARIF_INTERCHANGE_MAX_REFERENCES = 10_000 as const;
export const SARIF_INTERCHANGE_MAX_BYTES = 16 * 1024 * 1024;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );
const TextSchema = z
  .string()
  .trim()
  .min(1)
  .max(16_384)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );
const PortableReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.includes("\r") &&
      !value.includes("\n") &&
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !value.startsWith("~") &&
      !/^[A-Za-z]:/u.test(value) &&
      !/^file:/iu.test(value) &&
      !/^https?:/iu.test(value),
    "must be a portable non-local reference",
  );
const FingerprintSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, "must be a SHA-256 fingerprint");
const VersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "must be a semantic version",
  );
const ToolVersionSchema = TextSchema.max(128);
const GraphIdSchema = IdentifierSchema.refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !value.startsWith("~") &&
    !/^[A-Za-z]:/u.test(value) &&
    !/^file:/iu.test(value),
  "must be a portable canonical graph ID",
);
const RelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .transform((value, context) => {
    const normalized = value.normalize("NFC").replaceAll("\\", "/");
    const parts = normalized.split("/");
    if (
      normalized.startsWith("/") ||
      normalized.startsWith("~") ||
      normalized.includes("\0") ||
      /^[A-Za-z][A-Za-z\d+.-]*:/u.test(normalized) ||
      parts.some((part) => part === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "must be a repository-relative path",
      });
      return z.NEVER;
    }
    const compact = parts.filter((part) => part.length > 0 && part !== ".");
    return compact.length > 0 ? compact.join("/") : z.NEVER;
  });

export const SarifArtifactLocationSchema = z
  .object({ uri: RelativePathSchema })
  .strict();

export const SarifRegionSchema = z
  .object({
    startLine: z.number().int().positive(),
    startColumn: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    endColumn: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((region, context) => {
    if (region.endLine !== undefined && region.endLine < region.startLine) {
      context.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "must not precede startLine",
      });
    }
    if (
      region.endLine === region.startLine &&
      region.endColumn !== undefined &&
      region.startColumn !== undefined &&
      region.endColumn < region.startColumn
    ) {
      context.addIssue({
        code: "custom",
        path: ["endColumn"],
        message: "must not precede startColumn on the same line",
      });
    }
  });

export const SarifPhysicalLocationSchema = z
  .object({
    artifactLocation: SarifArtifactLocationSchema,
    region: SarifRegionSchema,
  })
  .strict();

export const SarifLocationSchema = z
  .object({ physicalLocation: SarifPhysicalLocationSchema })
  .strict();

export const SarifMessageSchema = z.object({ text: TextSchema }).strict();

export const SarifRuleSchema = z
  .object({
    id: IdentifierSchema,
    name: IdentifierSchema,
    shortDescription: SarifMessageSchema,
  })
  .strict();

export const SarifResultPropertiesSchema = z
  .object({
    violationId: IdentifierSchema,
    policyId: IdentifierSchema,
    policyVersion: VersionSchema,
    target: z.enum(["node", "edge", "diff"]),
    graphIds: z
      .array(GraphIdSchema)
      .min(1)
      .max(SARIF_INTERCHANGE_MAX_REFERENCES),
    evidenceRefs: z
      .array(PortableReferenceSchema)
      .min(1)
      .max(SARIF_INTERCHANGE_MAX_REFERENCES),
  })
  .strict();

export const SarifResultSchema = z
  .object({
    ruleId: IdentifierSchema,
    kind: z.literal("fail"),
    level: z.enum(["error", "warning", "note"]),
    message: SarifMessageSchema,
    locations: z
      .array(SarifLocationSchema)
      .min(1)
      .max(SARIF_INTERCHANGE_MAX_LOCATIONS),
    partialFingerprints: z
      .object({ cartographFingerprint: FingerprintSchema })
      .strict(),
    properties: z.object({ cartograph: SarifResultPropertiesSchema }).strict(),
  })
  .strict();

export const SarifDriverPropertiesSchema = z
  .object({
    contract: z.literal(SARIF_INTERCHANGE_CONTRACT),
    schemaVersion: z.literal(SARIF_INTERCHANGE_SCHEMA_VERSION),
    mediaType: z.literal(SARIF_INTERCHANGE_MEDIA_TYPE),
    policyId: IdentifierSchema,
    policyVersion: VersionSchema,
    inputKind: z.enum(["snapshot", "diff"]),
    lineLocalOnly: z.literal(true),
    sourceBodiesIncluded: z.literal(false),
  })
  .strict();

export const SarifRunSchema = z
  .object({
    tool: z
      .object({
        driver: z
          .object({
            name: TextSchema,
            version: TextSchema,
            rules: z.array(SarifRuleSchema).max(SARIF_INTERCHANGE_MAX_RULES),
            properties: z
              .object({ cartograph: SarifDriverPropertiesSchema })
              .strict(),
          })
          .strict(),
      })
      .strict(),
    results: z.array(SarifResultSchema).max(SARIF_INTERCHANGE_MAX_RESULTS),
  })
  .strict();

export const SarifLogSchema = z
  .object({
    $schema: z.literal(SARIF_SCHEMA_URI),
    version: z.literal(SARIF_VERSION),
    runs: z.array(SarifRunSchema).length(1),
  })
  .strict();

export const SarifLocationMappingSchema = z
  .object({
    violationId: IdentifierSchema,
    ruleId: IdentifierSchema,
    fingerprint: FingerprintSchema,
    graphIds: z
      .array(GraphIdSchema)
      .min(1)
      .max(SARIF_INTERCHANGE_MAX_REFERENCES),
    evidenceRefs: z
      .array(PortableReferenceSchema)
      .min(1)
      .max(SARIF_INTERCHANGE_MAX_REFERENCES),
    locations: z
      .array(SarifLocationSchema)
      .min(1)
      .max(SARIF_INTERCHANGE_MAX_LOCATIONS),
  })
  .strict();

export const SarifUnsupportedResultSchema = z
  .object({
    violationId: IdentifierSchema,
    target: z.enum(["node", "edge", "diff"]),
    reason: TextSchema,
  })
  .strict();

export const SarifProvenanceSchema = z
  .object({
    toolName: TextSchema,
    toolVersion: TextSchema,
    policyId: IdentifierSchema,
    policyVersion: VersionSchema,
    inputKind: z.enum(["snapshot", "diff"]),
    lineLocalOnly: z.literal(true),
    sourceBodiesIncluded: z.literal(false),
  })
  .strict();

export const SarifInterchangeSchema = z
  .object({
    schemaVersion: z.literal(SARIF_INTERCHANGE_SCHEMA_VERSION),
    contract: z.literal(SARIF_INTERCHANGE_CONTRACT),
    mediaType: z.literal(SARIF_INTERCHANGE_MEDIA_TYPE),
    direction: z.enum(["import", "export"]),
    provenance: SarifProvenanceSchema,
    mappings: z
      .array(SarifLocationMappingSchema)
      .max(SARIF_INTERCHANGE_MAX_RESULTS),
    unsupported: z
      .array(SarifUnsupportedResultSchema)
      .max(SARIF_INTERCHANGE_MAX_RESULTS),
    log: SarifLogSchema,
  })
  .strict();

export type SarifArtifactLocation = z.infer<typeof SarifArtifactLocationSchema>;
export type SarifRegion = z.infer<typeof SarifRegionSchema>;
export type SarifPhysicalLocation = z.infer<typeof SarifPhysicalLocationSchema>;
export type SarifLocation = z.infer<typeof SarifLocationSchema>;
export type SarifMessage = z.infer<typeof SarifMessageSchema>;
export type SarifRule = z.infer<typeof SarifRuleSchema>;
export type SarifResultProperties = z.infer<typeof SarifResultPropertiesSchema>;
export type SarifResult = z.infer<typeof SarifResultSchema>;
export type SarifDriverProperties = z.infer<typeof SarifDriverPropertiesSchema>;
export type SarifRun = z.infer<typeof SarifRunSchema>;
export type SarifLog = z.infer<typeof SarifLogSchema>;
export type SarifLocationMapping = z.infer<typeof SarifLocationMappingSchema>;
export type SarifUnsupportedResult = z.infer<
  typeof SarifUnsupportedResultSchema
>;
export type SarifProvenance = z.infer<typeof SarifProvenanceSchema>;
export type SarifInterchangeReport = z.infer<typeof SarifInterchangeSchema>;

export type SarifGraphInput =
  | { readonly kind: "snapshot"; readonly snapshot: unknown }
  | { readonly kind: "diff"; readonly diff: unknown };

export type SarifExportOptions = {
  readonly toolName: string;
  readonly toolVersion: string;
};

export type SarifExportResult = SarifInterchangeReport & {
  readonly direction: "export";
};

export type SarifImportResult = SarifInterchangeReport & {
  readonly direction: "import";
};

export class SarifInterchangeValidationError extends Error {
  readonly issues: readonly z.ZodIssue[];

  constructor(message: string, issues: readonly z.ZodIssue[] = []) {
    super(message);
    this.name = "SarifInterchangeValidationError";
    this.issues = issues;
  }
}

const issueText = (issues: readonly z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "document";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

const parseWith = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T => {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new SarifInterchangeValidationError(
        `${label} validation failed: ${issueText(error.issues)}`,
        error.issues,
      );
    }
    throw error;
  }
};

export const parseSarifLog = (value: unknown): SarifLog =>
  (() => {
    const parsed = parseWith(SarifLogSchema, value, "SARIF log");
    if (
      Buffer.byteLength(stableStringify(parsed), "utf8") >
      SARIF_INTERCHANGE_MAX_BYTES
    )
      throw new SarifInterchangeValidationError(
        `SARIF log exceeds the ${SARIF_INTERCHANGE_MAX_BYTES}-byte limit`,
      );
    return parsed;
  })();

export const serializeSarifLog = (value: unknown): string =>
  stableStringify(parseSarifLog(value));

export const parseSarifInterchange = (
  value: unknown,
): SarifInterchangeReport => {
  const parsed = parseWith(SarifInterchangeSchema, value, "SARIF interchange");
  // Parse the nested log independently so callers receive the same explicit
  // validation error if a future schema loosens the wrapper shape.
  parseSarifLog(parsed.log);
  if (
    Buffer.byteLength(stableStringify(parsed), "utf8") >
    SARIF_INTERCHANGE_MAX_BYTES
  )
    throw new SarifInterchangeValidationError(
      `SARIF interchange exceeds the ${SARIF_INTERCHANGE_MAX_BYTES}-byte limit`,
    );
  return parsed;
};

export const serializeSarifInterchange = (value: unknown): string =>
  stableStringify(parseSarifInterchange(value));

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const uniqueSorted = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const portableReference = (value: string): string =>
  parseWith(PortableReferenceSchema, value, "SARIF evidence reference");

const sourceLocation = (value: unknown): SourceLocation | undefined => {
  const parsed = SourceLocationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const locationFromEvidence = (
  evidence: Evidence,
): SourceLocation | undefined => {
  if (evidence.location !== undefined) return sourceLocation(evidence.location);
  if (evidence.path === undefined || evidence.line === undefined)
    return undefined;
  return sourceLocation({
    path: evidence.path,
    line: evidence.line,
    ...(evidence.column === undefined ? {} : { column: evidence.column }),
    ...(evidence.endLine === undefined ? {} : { endLine: evidence.endLine }),
    ...(evidence.endColumn === undefined
      ? {}
      : { endColumn: evidence.endColumn }),
  });
};

const locationKey = (location: SourceLocation): string =>
  stableStringify(location);

const locationsFromEvidence = (
  evidence: readonly Evidence[],
): SourceLocation[] =>
  [
    ...new Map(
      evidence
        .map((record) => locationFromEvidence(record))
        .filter(
          (location): location is SourceLocation => location !== undefined,
        )
        .map((location) => [locationKey(location), location] as const),
    ).values(),
  ].sort((left, right) => {
    const path = compareStrings(left.path, right.path);
    if (path !== 0) return path;
    if (left.line !== right.line) return left.line - right.line;
    return (left.column ?? 0) - (right.column ?? 0);
  });

type CandidateRecord = {
  readonly locations: readonly SourceLocation[];
};

const edgeKey = (edge: Pick<GraphEdge, "from" | "to" | "kind">): string =>
  `edge:${edge.from}|${edge.kind}|${edge.to}`;

const addCandidate = (
  records: Map<string, CandidateRecord>,
  id: string,
  locations: readonly SourceLocation[],
): void => {
  if (locations.length > 0) records.set(id, { locations });
};

const snapshotCandidates = (
  snapshot: GraphSnapshot,
): Map<string, CandidateRecord> => {
  const records = new Map<string, CandidateRecord>();
  for (const node of snapshot.nodes) {
    if (node.location !== undefined)
      addCandidate(records, `node:${node.id}`, [node.location]);
  }
  for (const edge of snapshot.edges) {
    addCandidate(records, edgeKey(edge), locationsFromEvidence(edge.evidence));
  }
  for (const diagnostic of snapshot.diagnostics) {
    if (diagnostic.location !== undefined)
      addCandidate(records, `diagnostic:${diagnostic.id}`, [
        diagnostic.location,
      ]);
    else
      addCandidate(
        records,
        `diagnostic:${diagnostic.id}`,
        locationsFromEvidence(diagnostic.evidence),
      );
  }
  return records;
};

const diffCandidates = (diff: GraphDiff): Map<string, CandidateRecord> => {
  const records = new Map<string, CandidateRecord>();
  for (const node of diff.nodes.added)
    if (node.location !== undefined)
      addCandidate(records, `node-added:${node.stableKey}`, [node.location]);
  for (const node of diff.nodes.removed)
    if (node.location !== undefined)
      addCandidate(records, `node-removed:${node.stableKey}`, [node.location]);
  for (const change of diff.nodes.changed)
    if (change.after.location !== undefined)
      addCandidate(records, `node-changed:${change.after.stableKey}`, [
        change.after.location,
      ]);
  for (const edge of diff.edges.added)
    addCandidate(
      records,
      `edge-added:${edgeKey(edge)}`,
      locationsFromEvidence(edge.evidence),
    );
  for (const edge of diff.edges.removed)
    addCandidate(
      records,
      `edge-removed:${edgeKey(edge)}`,
      locationsFromEvidence(edge.evidence),
    );
  for (const change of diff.edges.changed)
    addCandidate(
      records,
      `edge-changed:${edgeKey(change.after)}`,
      locationsFromEvidence(change.after.evidence),
    );
  for (const change of diff.edges.rewired)
    addCandidate(
      records,
      `edge-rewired:${edgeKey(change.before)}=>${edgeKey(change.after)}`,
      locationsFromEvidence(change.after.evidence),
    );
  for (const diagnostic of diff.diagnostics.added)
    addCandidate(
      records,
      `diagnostic-added:${diagnostic.id}`,
      diagnosticLocations(diagnostic),
    );
  for (const diagnostic of diff.diagnostics.removed)
    addCandidate(
      records,
      `diagnostic-removed:${diagnostic.id}`,
      diagnosticLocations(diagnostic),
    );
  for (const change of diff.diagnostics.changed)
    addCandidate(
      records,
      `diagnostic-changed:${change.after.id}`,
      diagnosticLocations(change.after),
    );
  for (const match of diff.identity.matches) {
    const locations = [match.before.location, match.after.location].filter(
      (location): location is SourceLocation => location !== undefined,
    );
    addCandidate(
      records,
      `identity-matched:${match.beforeStableKey}=>${match.afterStableKey}`,
      locations,
    );
  }
  for (const unsupported of diff.identity.unsupported) {
    const locations = [
      unsupported.before.location,
      unsupported.after.location,
    ].filter((location): location is SourceLocation => location !== undefined);
    addCandidate(
      records,
      `identity-unsupported:${unsupported.before.stableKey}=>${unsupported.after.stableKey}`,
      locations,
    );
  }
  return records;
};

const diagnosticLocations = (diagnostic: Diagnostic): SourceLocation[] =>
  diagnostic.location === undefined
    ? locationsFromEvidence(diagnostic.evidence)
    : [diagnostic.location];

const sarifLocations = (locations: readonly SourceLocation[]) =>
  locations.map((location) => ({
    physicalLocation: {
      artifactLocation: { uri: location.path },
      region: {
        startLine: location.line,
        ...(location.column === undefined
          ? {}
          : { startColumn: location.column }),
        ...(location.endLine === undefined
          ? {}
          : { endLine: location.endLine }),
        ...(location.endColumn === undefined
          ? {}
          : { endColumn: location.endColumn }),
      },
    },
  }));

const lineLocalLocations = (
  violation: PolicyViolation,
  records: ReadonlyMap<string, CandidateRecord>,
): SourceLocation[] => {
  const locations: SourceLocation[] = [];
  for (const match of violation.matches) {
    const candidate = records.get(match);
    if (candidate === undefined) return [];
    locations.push(...candidate.locations);
  }
  return [
    ...new Map(
      locations.map((location) => [locationKey(location), location] as const),
    ).values(),
  ].sort((left, right) => {
    const path = compareStrings(left.path, right.path);
    if (path !== 0) return path;
    if (left.line !== right.line) return left.line - right.line;
    return (left.column ?? 0) - (right.column ?? 0);
  });
};

const fingerprintFor = (input: {
  readonly violationId: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly target: PolicyViolation["target"];
  readonly graphIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly locations: readonly SourceLocation[];
}): string =>
  digest(
    stableStringify({
      contract: SARIF_INTERCHANGE_CONTRACT,
      schemaVersion: SARIF_INTERCHANGE_SCHEMA_VERSION,
      violationId: input.violationId,
      policyId: input.policyId,
      policyVersion: input.policyVersion,
      target: input.target,
      graphIds: [...input.graphIds].sort(compareStrings),
      evidenceRefs: [...input.evidenceRefs].sort(compareStrings),
      locations: [...input.locations].sort((left, right) =>
        compareStrings(locationKey(left), locationKey(right)),
      ),
    }),
  );

const levelFor = (violation: PolicyViolation): "error" | "warning" | "note" =>
  violation.effect === "enforce" ? "error" : "warning";

const ruleFor = (violation: PolicyViolation): SarifRule => ({
  id: violation.ruleId,
  name: violation.ruleId,
  shortDescription: { text: `CARTOGRAPH policy rule ${violation.ruleId}` },
});

const buildLog = (
  evaluation: PolicyEvaluation,
  options: SarifExportOptions,
  mappings: readonly SarifLocationMapping[],
): SarifLog => {
  const rules = new Map<string, SarifRule>();
  for (const mapping of mappings) {
    const violation = evaluation.violations.find(
      (candidate) => candidate.id === mapping.violationId,
    );
    if (violation !== undefined && !rules.has(violation.ruleId))
      rules.set(violation.ruleId, ruleFor(violation));
  }
  const results: SarifResult[] = mappings.map((mapping) => {
    const violation = evaluation.violations.find(
      (candidate) => candidate.id === mapping.violationId,
    );
    if (violation === undefined)
      throw new SarifInterchangeValidationError(
        `mapping references unknown policy violation ${mapping.violationId}`,
      );
    return {
      ruleId: mapping.ruleId,
      kind: "fail",
      level: levelFor(violation),
      message: { text: violation.reason },
      locations: mapping.locations,
      partialFingerprints: { cartographFingerprint: mapping.fingerprint },
      properties: {
        cartograph: {
          violationId: mapping.violationId,
          policyId: evaluation.policyId,
          policyVersion: evaluation.policyVersion,
          target: violation.target,
          graphIds: mapping.graphIds,
          evidenceRefs: mapping.evidenceRefs,
        },
      },
    };
  });
  return {
    $schema: SARIF_SCHEMA_URI,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: options.toolName,
            version: options.toolVersion,
            rules: [...rules.values()].sort((left, right) =>
              compareStrings(left.id, right.id),
            ),
            properties: {
              cartograph: {
                contract: SARIF_INTERCHANGE_CONTRACT,
                schemaVersion: SARIF_INTERCHANGE_SCHEMA_VERSION,
                mediaType: SARIF_INTERCHANGE_MEDIA_TYPE,
                policyId: evaluation.policyId,
                policyVersion: evaluation.policyVersion,
                inputKind: evaluation.inputKind,
                lineLocalOnly: true,
                sourceBodiesIncluded: false,
              },
            },
          },
        },
        results,
      },
    ],
  };
};

const exportInput = (
  evaluationInput: unknown,
  graphInput: SarifGraphInput,
  options: SarifExportOptions,
): SarifExportResult => {
  const evaluation = parseWith(
    PolicyEvaluationSchema,
    evaluationInput,
    "policy evaluation",
  );
  const normalizedOptions: SarifExportOptions = {
    toolName: parseWith(TextSchema, options.toolName, "SARIF tool name"),
    toolVersion: parseWith(
      ToolVersionSchema,
      options.toolVersion,
      "SARIF tool version",
    ),
  };
  if (evaluation.inputKind !== graphInput.kind)
    throw new SarifInterchangeValidationError(
      `policy evaluation input kind ${evaluation.inputKind} does not match ${graphInput.kind} graph input`,
    );
  const records =
    graphInput.kind === "snapshot"
      ? snapshotCandidates(canonicalizeGraphSnapshot(graphInput.snapshot))
      : diffCandidates(canonicalizeGraphDiff(graphInput.diff));
  const mappings: SarifLocationMapping[] = [];
  const unsupported: SarifUnsupportedResult[] = [];
  for (const violation of evaluation.violations) {
    const locations = lineLocalLocations(violation, records);
    if (locations.length === 0) {
      unsupported.push({
        violationId: violation.id,
        target: violation.target,
        reason:
          violation.matches.length === 0
            ? "policy violation has no matched graph object with a source location"
            : "policy violation is not line-local because one or more matched graph objects lack a source location",
      });
      continue;
    }
    const graphIds = uniqueSorted(violation.matches);
    const evidenceRefs = uniqueSorted(
      violation.evidenceRefs.map((reference) => portableReference(reference)),
    );
    const fingerprint = fingerprintFor({
      violationId: violation.id,
      policyId: evaluation.policyId,
      policyVersion: evaluation.policyVersion,
      target: violation.target,
      graphIds,
      evidenceRefs,
      locations,
    });
    mappings.push({
      violationId: violation.id,
      ruleId: violation.ruleId,
      fingerprint,
      graphIds,
      evidenceRefs,
      locations: sarifLocations(locations),
    });
  }
  mappings.sort((left, right) =>
    compareStrings(left.violationId, right.violationId),
  );
  unsupported.sort((left, right) =>
    compareStrings(left.violationId, right.violationId),
  );
  const provenance: SarifProvenance = {
    toolName: normalizedOptions.toolName,
    toolVersion: normalizedOptions.toolVersion,
    policyId: evaluation.policyId,
    policyVersion: evaluation.policyVersion,
    inputKind: evaluation.inputKind,
    lineLocalOnly: true,
    sourceBodiesIncluded: false,
  };
  const report = {
    schemaVersion: SARIF_INTERCHANGE_SCHEMA_VERSION,
    contract: SARIF_INTERCHANGE_CONTRACT,
    mediaType: SARIF_INTERCHANGE_MEDIA_TYPE,
    direction: "export" as const,
    provenance,
    mappings,
    unsupported,
    log: buildLog(evaluation, normalizedOptions, mappings),
  };
  return parseWith(
    SarifInterchangeSchema,
    report,
    "SARIF export",
  ) as SarifExportResult;
};

/** Export the line-local subset of a policy evaluation to a SARIF log. */
export function exportSarifPolicyEvaluation(
  evaluationInput: unknown,
  graphInput: SarifGraphInput,
  options: SarifExportOptions,
): SarifExportResult;
export function exportSarifPolicyEvaluation(
  evaluationInput: unknown,
  options: SarifExportOptions & { readonly graph: SarifGraphInput },
): SarifExportResult;
export function exportSarifPolicyEvaluation(
  evaluationInput: unknown,
  graphOrOptions:
    | SarifGraphInput
    | (SarifExportOptions & { readonly graph: SarifGraphInput }),
  maybeOptions?: SarifExportOptions,
): SarifExportResult {
  if (maybeOptions !== undefined)
    return exportInput(
      evaluationInput,
      graphOrOptions as SarifGraphInput,
      maybeOptions,
    );
  const options = graphOrOptions as SarifExportOptions & {
    readonly graph: SarifGraphInput;
  };
  return exportInput(evaluationInput, options.graph, options);
}

export const exportSarifPolicyResults = exportSarifPolicyEvaluation;

export const exportSarifLog = (
  evaluationInput: unknown,
  graphInput: SarifGraphInput,
  options: SarifExportOptions,
): SarifLog =>
  exportSarifPolicyEvaluation(evaluationInput, graphInput, options).log;

const reportFromLog = (
  logInput: unknown,
  envelopeUnsupported: readonly SarifUnsupportedResult[] = [],
): SarifImportResult => {
  const log = parseSarifLog(logInput);
  const run = log.runs[0];
  if (run === undefined)
    throw new SarifInterchangeValidationError("SARIF log must contain one run");
  const driverProperties = run.tool.driver.properties.cartograph;
  const ruleIds = new Set(run.tool.driver.rules.map((rule) => rule.id));
  const seenViolationIds = new Set<string>();
  const mappings: SarifLocationMapping[] = run.results.map((result) => {
    const properties = result.properties.cartograph;
    if (seenViolationIds.has(properties.violationId))
      throw new SarifInterchangeValidationError(
        `SARIF result ${properties.violationId} is duplicated`,
      );
    seenViolationIds.add(properties.violationId);
    if (!ruleIds.has(result.ruleId))
      throw new SarifInterchangeValidationError(
        `SARIF result ${properties.violationId} references undeclared rule ${result.ruleId}`,
      );
    if (
      properties.policyId !== driverProperties.policyId ||
      properties.policyVersion !== driverProperties.policyVersion
    )
      throw new SarifInterchangeValidationError(
        `SARIF result ${properties.violationId} policy metadata does not match its run`,
      );
    const locations = result.locations;
    const evidenceRefs = properties.evidenceRefs.map((reference) =>
      portableReference(reference),
    );
    const expectedFingerprint = fingerprintFor({
      violationId: properties.violationId,
      policyId: properties.policyId,
      policyVersion: properties.policyVersion,
      target: properties.target,
      graphIds: properties.graphIds,
      evidenceRefs,
      locations: locations.map((location) => ({
        path: location.physicalLocation.artifactLocation.uri,
        line: location.physicalLocation.region.startLine,
        ...(location.physicalLocation.region.startColumn === undefined
          ? {}
          : { column: location.physicalLocation.region.startColumn }),
        ...(location.physicalLocation.region.endLine === undefined
          ? {}
          : { endLine: location.physicalLocation.region.endLine }),
        ...(location.physicalLocation.region.endColumn === undefined
          ? {}
          : { endColumn: location.physicalLocation.region.endColumn }),
      })),
    });
    if (
      result.partialFingerprints.cartographFingerprint !== expectedFingerprint
    )
      throw new SarifInterchangeValidationError(
        `SARIF result ${properties.violationId} fingerprint does not match its canonical references`,
      );
    return {
      violationId: properties.violationId,
      ruleId: result.ruleId,
      fingerprint: result.partialFingerprints.cartographFingerprint,
      graphIds: uniqueSorted(properties.graphIds),
      evidenceRefs: uniqueSorted(evidenceRefs),
      locations,
    };
  });
  const provenance: SarifProvenance = {
    toolName: run.tool.driver.name,
    toolVersion: run.tool.driver.version,
    policyId: driverProperties.policyId,
    policyVersion: driverProperties.policyVersion,
    inputKind: driverProperties.inputKind,
    lineLocalOnly: true,
    sourceBodiesIncluded: false,
  };
  const report = {
    schemaVersion: SARIF_INTERCHANGE_SCHEMA_VERSION,
    contract: SARIF_INTERCHANGE_CONTRACT,
    mediaType: SARIF_INTERCHANGE_MEDIA_TYPE,
    direction: "import" as const,
    provenance,
    mappings: mappings.sort((left, right) =>
      compareStrings(left.violationId, right.violationId),
    ),
    unsupported: [...envelopeUnsupported],
    log,
  };
  return parseWith(
    SarifInterchangeSchema,
    report,
    "SARIF import",
  ) as SarifImportResult;
};

/** Import either a native SARIF log or a CARTOGRAPH interchange envelope. */
export const importSarifPolicyEvaluation = (
  value: unknown,
): SarifImportResult => {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "log" in value
  ) {
    const envelope = parseSarifInterchange(value);
    const imported = reportFromLog(envelope.log, envelope.unsupported);
    if (
      imported.provenance.policyId !== envelope.provenance.policyId ||
      imported.provenance.policyVersion !== envelope.provenance.policyVersion ||
      imported.provenance.inputKind !== envelope.provenance.inputKind ||
      stableStringify(imported.mappings) !== stableStringify(envelope.mappings)
    )
      throw new SarifInterchangeValidationError(
        "SARIF envelope metadata does not match its native log",
      );
    return imported;
  }
  return reportFromLog(value);
};

export const importSarifPolicyResults = importSarifPolicyEvaluation;

export const serializeSarifExport = (value: unknown): string =>
  serializeSarifInterchange(value);
