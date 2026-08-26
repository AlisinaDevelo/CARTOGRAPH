import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { z, ZodError } from "zod";

import { stableStringify } from "./canonical.js";

export const OWNERSHIP_SCHEMA_VERSION = 1 as const;
export const OWNERSHIP_CONTRACT = "cartograph.ownership-resolution" as const;
export const OWNERSHIP_MEDIA_TYPE =
  "application/vnd.cartograph.ownership-resolution+json" as const;
export const OWNERSHIP_MAX_OWNERS = 1_024 as const;
export const OWNERSHIP_MAX_SOURCES = 256 as const;
export const OWNERSHIP_MAX_RULES_PER_SOURCE = 20_000 as const;
export const OWNERSHIP_MAX_TARGETS = 100_000 as const;
export const OWNERSHIP_MAX_CODEOWNERS_BYTES = 1_048_576 as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );

const PortablePathSchema = z
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
      normalized.startsWith("//") ||
      normalized.includes("\0") ||
      /^[A-Za-z][A-Za-z\d+.-]*:/.test(normalized) ||
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

const OwnerReferenceSchema = IdentifierSchema.refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !/^file:/iu.test(value) &&
    !value.includes("\\"),
  "must be a portable owner or team reference",
);

const GlobPatternSchema = IdentifierSchema.max(1_024).refine(
  (value) => !value.startsWith("~") && !value.startsWith("file:"),
  "must not be an absolute or URI pattern",
);

const RevisionSchema = IdentifierSchema.regex(
  /^[A-Za-z0-9._:/+-]+$/u,
  "must be a portable revision token",
);

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const OwnershipOwnerSchema = z
  .object({
    id: OwnerReferenceSchema,
    kind: z.enum(["user", "team", "service"]),
    aliases: z.array(OwnerReferenceSchema).max(64).default([]),
    availability: z.enum(["available", "unavailable"]).default("available"),
  })
  .strict();

export const OwnershipRuleSchema = z
  .object({
    id: IdentifierSchema,
    pattern: GlobPatternSchema,
    ownerRefs: z.array(OwnerReferenceSchema).max(64),
    priority: z.number().int().min(-1_000).max(1_000).default(0),
    order: z.number().int().nonnegative().max(1_000_000),
  })
  .strict();

export const OwnershipSourceSchema = z
  .object({
    id: IdentifierSchema,
    repositoryId: IdentifierSchema,
    kind: z.enum(["local", "codeowners"]),
    path: PortablePathSchema,
    revision: RevisionSchema.optional(),
    precedence: z.number().int().min(0).max(1_000),
    rules: z.array(OwnershipRuleSchema).max(OWNERSHIP_MAX_RULES_PER_SOURCE),
  })
  .strict();

export const OwnershipFallbackSchema = z
  .object({
    ownerRefs: z.array(OwnerReferenceSchema).max(64),
    sourceId: IdentifierSchema.default("fallback"),
    sourcePath: PortablePathSchema.default(".cartograph/ownership.json"),
  })
  .strict();

export const OwnershipTargetSchema = z
  .object({
    id: IdentifierSchema,
    repositoryId: IdentifierSchema,
    path: PortablePathSchema,
    previousPath: PortablePathSchema.optional(),
    stableKey: IdentifierSchema.optional(),
    kind: z.enum(["node", "edge", "diff", "file"]).default("node"),
  })
  .strict();

const OwnershipDiagnosticInputSchema = z
  .object({
    id: IdentifierSchema,
    code: z.string().regex(/^OWNERSHIP_[A-Z0-9_]+$/u),
    severity: z.enum(["info", "warning", "error"]),
    message: IdentifierSchema,
    targetId: IdentifierSchema.optional(),
    sourceId: IdentifierSchema.optional(),
    ruleId: IdentifierSchema.optional(),
    evidenceRefs: z.array(IdentifierSchema).max(128).default([]),
  })
  .strict();

export const OwnershipResolutionInputSchema = z
  .object({
    schemaVersion: z.literal(OWNERSHIP_SCHEMA_VERSION),
    contract: z.literal(OWNERSHIP_CONTRACT),
    repositoryId: IdentifierSchema.optional(),
    owners: z.array(OwnershipOwnerSchema).max(OWNERSHIP_MAX_OWNERS),
    sources: z.array(OwnershipSourceSchema).max(OWNERSHIP_MAX_SOURCES),
    sourceDiagnostics: z
      .array(OwnershipDiagnosticInputSchema)
      .max(100_000)
      .default([]),
    fallback: OwnershipFallbackSchema.optional(),
    targets: z.array(OwnershipTargetSchema).max(OWNERSHIP_MAX_TARGETS),
  })
  .strict()
  .superRefine((input, context) => {
    const ownerIds = new Set<string>();
    for (const [index, owner] of input.owners.entries()) {
      if (ownerIds.has(owner.id)) {
        context.addIssue({
          code: "custom",
          path: ["owners", index, "id"],
          message: `duplicate owner ID: ${owner.id}`,
        });
      }
      ownerIds.add(owner.id);
    }
    const sourceIds = new Set<string>();
    for (const [index, source] of input.sources.entries()) {
      if (sourceIds.has(source.id)) {
        context.addIssue({
          code: "custom",
          path: ["sources", index, "id"],
          message: `duplicate ownership source ID: ${source.id}`,
        });
      }
      sourceIds.add(source.id);
      const ruleIds = new Set<string>();
      for (const [ruleIndex, rule] of source.rules.entries()) {
        if (ruleIds.has(rule.id)) {
          context.addIssue({
            code: "custom",
            path: ["sources", index, "rules", ruleIndex, "id"],
            message: `duplicate ownership rule ID in ${source.id}: ${rule.id}`,
          });
        }
        ruleIds.add(rule.id);
      }
    }
    const targetIds = new Set<string>();
    for (const [index, target] of input.targets.entries()) {
      if (targetIds.has(target.id)) {
        context.addIssue({
          code: "custom",
          path: ["targets", index, "id"],
          message: `duplicate ownership target ID: ${target.id}`,
        });
      }
      targetIds.add(target.id);
    }
  });

export const OwnershipEvidenceSchema = z
  .object({
    sourceId: IdentifierSchema,
    sourcePath: PortablePathSchema,
    ruleId: IdentifierSchema.optional(),
    matchedPath: z.enum(["current", "previous", "fallback", "none"]),
    reference: IdentifierSchema,
  })
  .strict();

export const OwnershipMatchSchema = z
  .object({
    sourceId: IdentifierSchema,
    sourceKind: z.enum(["local", "codeowners", "fallback"]),
    sourcePath: PortablePathSchema,
    ruleId: IdentifierSchema,
    pattern: GlobPatternSchema,
    ownerRefs: z.array(OwnerReferenceSchema).max(64),
    owners: z.array(OwnerReferenceSchema).max(64),
    matchedPath: z.enum(["current", "previous"]),
    evidence: z.array(OwnershipEvidenceSchema).min(1).max(128),
  })
  .strict();

export const OwnershipDiagnosticSchema = OwnershipDiagnosticInputSchema;

export const OwnershipResultSchema = z
  .object({
    target: OwnershipTargetSchema,
    status: z.enum([
      "resolved",
      "unowned",
      "ambiguous",
      "unavailable",
      "unsupported",
    ]),
    owners: z.array(OwnerReferenceSchema).max(64),
    matches: z.array(OwnershipMatchSchema).max(128),
    evidence: z.array(OwnershipEvidenceSchema).max(256),
    diagnosticCodes: z.array(z.string().regex(/^OWNERSHIP_[A-Z0-9_]+$/u)),
  })
  .strict();

export const OwnershipSummarySchema = z
  .object({
    targets: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    unowned: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
    matchedRules: z.number().int().nonnegative(),
  })
  .strict();

export const OwnershipProvenanceSchema = z
  .object({
    resolver: z.literal(OWNERSHIP_CONTRACT),
    resolverVersion: z.literal("1"),
    inputDigest: DigestSchema,
    sourceBodiesIncluded: z.literal(false),
  })
  .strict();

export const OwnershipResolutionReportSchema = z
  .object({
    schemaVersion: z.literal(OWNERSHIP_SCHEMA_VERSION),
    contract: z.literal(OWNERSHIP_CONTRACT),
    mediaType: z.literal(OWNERSHIP_MEDIA_TYPE),
    provenance: OwnershipProvenanceSchema,
    summary: OwnershipSummarySchema,
    results: z.array(OwnershipResultSchema).max(OWNERSHIP_MAX_TARGETS),
    diagnostics: z.array(OwnershipDiagnosticSchema).max(100_000),
  })
  .strict();

export type OwnershipOwner = z.infer<typeof OwnershipOwnerSchema>;
export type OwnershipRule = z.infer<typeof OwnershipRuleSchema>;
export type OwnershipSource = z.infer<typeof OwnershipSourceSchema>;
export type OwnershipFallback = z.infer<typeof OwnershipFallbackSchema>;
export type OwnershipTarget = z.infer<typeof OwnershipTargetSchema>;
export type OwnershipResolutionInput = z.infer<
  typeof OwnershipResolutionInputSchema
>;
export type OwnershipEvidence = z.infer<typeof OwnershipEvidenceSchema>;
export type OwnershipMatch = z.infer<typeof OwnershipMatchSchema>;
export type OwnershipDiagnostic = z.infer<typeof OwnershipDiagnosticSchema>;
export type OwnershipResult = z.infer<typeof OwnershipResultSchema>;
export type OwnershipSummary = z.infer<typeof OwnershipSummarySchema>;
export type OwnershipProvenance = z.infer<typeof OwnershipProvenanceSchema>;
export type OwnershipResolutionReport = z.infer<
  typeof OwnershipResolutionReportSchema
>;

export type ParseCodeownersOptions = {
  readonly id: string;
  readonly repositoryId: string;
  readonly path: string;
  readonly revision?: string;
  readonly precedence?: number;
};

export type ParseCodeownersResult = {
  readonly source: OwnershipSource;
  readonly diagnostics: readonly OwnershipDiagnostic[];
};

export class OwnershipResolutionError extends Error {
  readonly issues: readonly z.ZodIssue[];

  constructor(message: string, issues: readonly z.ZodIssue[] = []) {
    super(message);
    this.name = "OwnershipResolutionError";
    this.issues = issues;
  }
}

const issueText = (issues: readonly z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
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
      throw new OwnershipResolutionError(
        `${label} validation failed: ${issueText(error.issues)}`,
        error.issues,
      );
    }
    throw error;
  }
};

export const parseOwnershipInput = (value: unknown): OwnershipResolutionInput =>
  parseWith(OwnershipResolutionInputSchema, value, "ownership input");

export const parseOwnershipReport = (
  value: unknown,
): OwnershipResolutionReport =>
  parseWith(OwnershipResolutionReportSchema, value, "ownership report");

export const serializeOwnershipReport = (value: unknown): string =>
  stableStringify(parseOwnershipReport(value));

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const sortUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const sourceReference = (
  source: Pick<OwnershipSource, "id" | "path">,
): string =>
  `ownership://source/${encodeURIComponent(source.id)}#${encodeURIComponent(source.path)}`;

const ruleReference = (
  source: Pick<OwnershipSource, "id">,
  rule: Pick<OwnershipRule, "id">,
): string =>
  `ownership://rule/${encodeURIComponent(source.id)}#${encodeURIComponent(rule.id)}`;

const fallbackReference = (fallback: OwnershipFallback): string =>
  `ownership://fallback/${encodeURIComponent(fallback.sourceId)}#${encodeURIComponent(fallback.sourcePath)}`;

const makeDiagnostic = (
  code: string,
  severity: OwnershipDiagnostic["severity"],
  message: string,
  options: Partial<
    Pick<
      OwnershipDiagnostic,
      "targetId" | "sourceId" | "ruleId" | "evidenceRefs"
    >
  > = {},
): OwnershipDiagnostic => ({
  id: `ownership:diagnostic:${digest(
    stableStringify({ code, message, ...options }),
  )}`,
  code,
  severity,
  message,
  evidenceRefs: [],
  ...options,
});

const evidenceRecord = (
  sourceId: string,
  sourcePath: string,
  matchedPath: OwnershipEvidence["matchedPath"],
  reference: string,
  ruleId?: string,
): OwnershipEvidence => ({
  sourceId,
  sourcePath,
  ...(ruleId === undefined ? {} : { ruleId }),
  matchedPath,
  reference,
});

const tokenizeCodeownersLine = (line: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of line.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  if (current.length > 0) tokens.push(current);
  return tokens;
};

export const parseCodeowners = (
  text: string,
  options: ParseCodeownersOptions,
): ParseCodeownersResult => {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > OWNERSHIP_MAX_CODEOWNERS_BYTES
  ) {
    throw new OwnershipResolutionError(
      `CODEOWNERS source exceeds the ${OWNERSHIP_MAX_CODEOWNERS_BYTES}-byte limit`,
    );
  }
  const sourceBase = parseWith(
    OwnershipSourceSchema,
    {
      id: options.id,
      repositoryId: options.repositoryId,
      kind: "codeowners",
      path: options.path,
      ...(options.revision === undefined ? {} : { revision: options.revision }),
      precedence: options.precedence ?? 100,
      rules: [],
    },
    "CODEOWNERS source",
  );
  const diagnostics: OwnershipDiagnostic[] = [];
  const rules: OwnershipRule[] = [];
  const lines = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  for (const [lineIndex, rawLine] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const tokens = tokenizeCodeownersLine(trimmed);
    const commentIndex = tokens.findIndex((token) => token.startsWith("#"));
    const usefulTokens =
      commentIndex < 0 ? tokens : tokens.slice(0, commentIndex);
    const pattern = usefulTokens[0];
    const ownerRefs = usefulTokens.slice(1);
    const lineEvidence = sourceReference(sourceBase);
    if (!pattern || ownerRefs.length === 0) {
      diagnostics.push(
        makeDiagnostic(
          "OWNERSHIP_RULE_INVALID",
          "warning",
          `CODEOWNERS line ${lineNumber} must contain a pattern and at least one owner`,
          { sourceId: sourceBase.id, evidenceRefs: [lineEvidence] },
        ),
      );
      continue;
    }
    if (pattern.startsWith("!")) {
      diagnostics.push(
        makeDiagnostic(
          "OWNERSHIP_NEGATION_UNSUPPORTED",
          "warning",
          `CODEOWNERS negation on line ${lineNumber} is not supported and was ignored`,
          { sourceId: sourceBase.id, evidenceRefs: [lineEvidence] },
        ),
      );
      continue;
    }
    if (["[", "]", "{", "}"].some((character) => pattern.includes(character))) {
      diagnostics.push(
        makeDiagnostic(
          "OWNERSHIP_PATTERN_UNSUPPORTED",
          "warning",
          `CODEOWNERS pattern on line ${lineNumber} uses unsupported character-class or brace syntax`,
          { sourceId: sourceBase.id, evidenceRefs: [lineEvidence] },
        ),
      );
      continue;
    }
    try {
      rules.push(
        parseWith(
          OwnershipRuleSchema,
          {
            id: `${sourceBase.id}:line-${lineNumber}`,
            pattern,
            ownerRefs,
            priority: 0,
            order: lineNumber,
          },
          "CODEOWNERS rule",
        ),
      );
    } catch (error) {
      if (!(error instanceof OwnershipResolutionError)) throw error;
      diagnostics.push(
        makeDiagnostic(
          "OWNERSHIP_RULE_INVALID",
          "warning",
          `CODEOWNERS line ${lineNumber} could not be represented by the ownership contract`,
          { sourceId: sourceBase.id, evidenceRefs: [lineEvidence] },
        ),
      );
    }
  }
  return { source: { ...sourceBase, rules }, diagnostics };
};

const unsupportedPattern = (pattern: string): boolean =>
  ["[", "]", "{", "}", "\\"].some((character) => pattern.includes(character));

const patternRegExp = (pattern: string): RegExp | undefined => {
  if (unsupportedPattern(pattern)) return undefined;
  let normalized = pattern.normalize("NFC").replaceAll("\\", "/");
  const anchored = normalized.startsWith("/");
  normalized = normalized.replace(/^\/+/, "").replace(/^\.\//, "");
  if (normalized.endsWith("/")) normalized += "**";
  if (normalized.length === 0) return undefined;
  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === undefined) continue;
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:[^/]+/)*";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.+^$()|]/gu, "\\$&");
    }
  }
  const prefix = anchored ? "^" : normalized.includes("/") ? "^" : "^(?:.*/)?";
  try {
    return new RegExp(`${prefix}${expression}$`, "u");
  } catch {
    return undefined;
  }
};

const matchesPattern = (pattern: string, path: string): boolean =>
  patternRegExp(pattern)?.test(path) ?? false;

type Candidate = {
  readonly source: OwnershipSource;
  readonly rule: OwnershipRule;
  readonly sourceKind?: OwnershipMatch["sourceKind"];
  readonly evidenceSourceReference?: string;
  readonly ownerIds: readonly string[];
  readonly unknownOwnerRefs: readonly string[];
  readonly matchedPath: "current" | "previous";
};

type PathEvaluation = {
  readonly candidates: readonly Candidate[];
  readonly sourceRefs: readonly string[];
  readonly diagnostics: readonly OwnershipDiagnostic[];
};

type Selection = {
  readonly candidates: readonly Candidate[];
  readonly sourceRefs: readonly string[];
  readonly ambiguous: boolean;
  readonly unknownOwnerRefs: readonly string[];
};

const ownerSignature = (selection: Selection): string =>
  stableStringify({
    ambiguous: selection.ambiguous,
    owners: sortUnique(
      selection.candidates.flatMap((candidate) => candidate.ownerIds),
    ),
    unknown: sortUnique(
      selection.candidates.flatMap((candidate) => candidate.unknownOwnerRefs),
    ),
  });

const selectCandidates = (
  candidates: readonly Candidate[],
  sourceRefs: readonly string[],
): Selection => {
  if (candidates.length === 0)
    return {
      candidates: [],
      sourceRefs,
      ambiguous: false,
      unknownOwnerRefs: [],
    };
  const maxPrecedence = Math.max(
    ...candidates.map((candidate) => candidate.source.precedence),
  );
  const top = candidates.filter(
    (candidate) => candidate.source.precedence === maxPrecedence,
  );
  const allCodeowners = top.every(
    (candidate) => candidate.source.kind === "codeowners",
  );
  if (allCodeowners) {
    const lastOrder = Math.max(...top.map((candidate) => candidate.rule.order));
    const winners = top.filter(
      (candidate) => candidate.rule.order === lastOrder,
    );
    return {
      candidates: winners,
      sourceRefs,
      ambiguous:
        new Set(winners.map((candidate) => ownerSignatureFor(candidate))).size >
        1,
      unknownOwnerRefs: sortUnique(
        winners.flatMap((candidate) => candidate.unknownOwnerRefs),
      ),
    };
  }
  const maxPriority = Math.max(
    ...top.map((candidate) => candidate.rule.priority),
  );
  const winners = top.filter(
    (candidate) => candidate.rule.priority === maxPriority,
  );
  const ownerSignatures = new Set(
    winners.map((candidate) => ownerSignatureFor(candidate)),
  );
  return {
    candidates: winners,
    sourceRefs,
    ambiguous: ownerSignatures.size > 1,
    unknownOwnerRefs: sortUnique(
      winners.flatMap((candidate) => candidate.unknownOwnerRefs),
    ),
  };
};

const ownerSignatureFor = (candidate: Candidate): string =>
  stableStringify({
    owners: sortUnique(candidate.ownerIds),
    unknown: sortUnique(candidate.unknownOwnerRefs),
  });

const resolveOwnerRefs = (
  refs: readonly string[],
  ownerByReference: ReadonlyMap<string, OwnershipOwner>,
): {
  readonly ownerIds: readonly string[];
  readonly unknown: readonly string[];
} => {
  const ownerIds: string[] = [];
  const unknown: string[] = [];
  for (const reference of refs) {
    const owner = ownerByReference.get(reference);
    if (!owner) unknown.push(reference);
    else ownerIds.push(owner.id);
  }
  return { ownerIds: sortUnique(ownerIds), unknown: sortUnique(unknown) };
};

const pathEvaluation = (
  input: OwnershipResolutionInput,
  target: OwnershipTarget,
  path: string,
  matchedPath: "current" | "previous",
  ownerByReference: ReadonlyMap<string, OwnershipOwner>,
): PathEvaluation => {
  const sources = input.sources.filter(
    (source) => source.repositoryId === target.repositoryId,
  );
  const sourceRefs = sources.map((source) => sourceReference(source));
  const diagnostics: OwnershipDiagnostic[] = [];
  const candidates: Candidate[] = [];
  if (sources.length === 0) {
    diagnostics.push(
      makeDiagnostic(
        "OWNERSHIP_SOURCE_UNAVAILABLE",
        "warning",
        `no ownership source is available for repository ${target.repositoryId}`,
        { targetId: target.id },
      ),
    );
  }
  for (const source of sources) {
    for (const rule of source.rules) {
      if (unsupportedPattern(rule.pattern)) {
        diagnostics.push(
          makeDiagnostic(
            "OWNERSHIP_PATTERN_UNSUPPORTED",
            "warning",
            `ownership pattern ${rule.pattern} uses unsupported syntax`,
            {
              targetId: target.id,
              sourceId: source.id,
              ruleId: rule.id,
              evidenceRefs: [
                sourceReference(source),
                ruleReference(source, rule),
              ],
            },
          ),
        );
        continue;
      }
      if (!matchesPattern(rule.pattern, path)) continue;
      const owners = resolveOwnerRefs(rule.ownerRefs, ownerByReference);
      candidates.push({
        source,
        rule,
        ownerIds: owners.ownerIds,
        unknownOwnerRefs: owners.unknown,
        matchedPath,
      });
    }
  }
  return { candidates, sourceRefs, diagnostics };
};

const statusForSelection = (
  selection: Selection,
  owners: ReadonlyMap<string, OwnershipOwner>,
): OwnershipResult["status"] => {
  if (selection.ambiguous) return "ambiguous";
  if (selection.unknownOwnerRefs.length > 0) return "unsupported";
  const ownerIds = sortUnique(
    selection.candidates.flatMap((candidate) => candidate.ownerIds),
  );
  if (ownerIds.length === 0) return "unowned";
  if (
    ownerIds.some(
      (ownerId) => owners.get(ownerId)?.availability === "unavailable",
    )
  )
    return "unavailable";
  return "resolved";
};

const matchesFromSelection = (selection: Selection): OwnershipMatch[] =>
  selection.candidates
    .map((candidate) => {
      const sourceRef =
        candidate.evidenceSourceReference ?? sourceReference(candidate.source);
      const ruleRef = ruleReference(candidate.source, candidate.rule);
      return {
        sourceId: candidate.source.id,
        sourceKind: candidate.sourceKind ?? candidate.source.kind,
        sourcePath: candidate.source.path,
        ruleId: candidate.rule.id,
        pattern: candidate.rule.pattern,
        ownerRefs: [...candidate.rule.ownerRefs].sort(compareStrings),
        owners: [...candidate.ownerIds].sort(compareStrings),
        matchedPath: candidate.matchedPath,
        evidence: [
          evidenceRecord(
            candidate.source.id,
            candidate.source.path,
            candidate.matchedPath,
            sourceRef,
          ),
          evidenceRecord(
            candidate.source.id,
            candidate.source.path,
            candidate.matchedPath,
            ruleRef,
            candidate.rule.id,
          ),
        ],
      };
    })
    .sort((left, right) =>
      compareStrings(
        `${left.sourceId}\0${left.ruleId}\0${left.matchedPath}`,
        `${right.sourceId}\0${right.ruleId}\0${right.matchedPath}`,
      ),
    );

const diagnosticCodeList = (
  diagnostics: readonly OwnershipDiagnostic[],
): string[] => sortUnique(diagnostics.map((diagnostic) => diagnostic.code));

const deduplicateDiagnostics = (
  diagnostics: readonly OwnershipDiagnostic[],
): OwnershipDiagnostic[] =>
  [
    ...new Map(
      diagnostics.map((diagnostic) => [diagnostic.id, diagnostic]),
    ).values(),
  ].sort((left, right) => compareStrings(left.id, right.id));

const resolveTarget = (
  input: OwnershipResolutionInput,
  target: OwnershipTarget,
  ownerByReference: ReadonlyMap<string, OwnershipOwner>,
  owners: ReadonlyMap<string, OwnershipOwner>,
): {
  readonly result: OwnershipResult;
  readonly diagnostics: readonly OwnershipDiagnostic[];
} => {
  const current = pathEvaluation(
    input,
    target,
    target.path,
    "current",
    ownerByReference,
  );
  let selected = selectCandidates(current.candidates, current.sourceRefs);
  let diagnostics = [...current.diagnostics];
  if (target.previousPath !== undefined) {
    const previous = pathEvaluation(
      input,
      target,
      target.previousPath,
      "previous",
      ownerByReference,
    );
    diagnostics = [...diagnostics, ...previous.diagnostics];
    const previousSelection = selectCandidates(
      previous.candidates,
      previous.sourceRefs,
    );
    if (current.candidates.length === 0 && previous.candidates.length > 0) {
      selected = previousSelection;
      diagnostics.push(
        makeDiagnostic(
          "OWNERSHIP_RENAME_FALLBACK",
          "info",
          `ownership resolved from the previous path ${target.previousPath}`,
          {
            targetId: target.id,
            evidenceRefs: [...previousSelection.sourceRefs],
          },
        ),
      );
    } else if (
      current.candidates.length > 0 &&
      previous.candidates.length > 0 &&
      ownerSignature(selected) !== ownerSignature(previousSelection)
    ) {
      selected = {
        candidates: [...selected.candidates, ...previousSelection.candidates],
        sourceRefs: sortUnique([
          ...selected.sourceRefs,
          ...previousSelection.sourceRefs,
        ]),
        ambiguous: true,
        unknownOwnerRefs: sortUnique([
          ...selected.unknownOwnerRefs,
          ...previousSelection.unknownOwnerRefs,
        ]),
      };
      diagnostics.push(
        makeDiagnostic(
          "OWNERSHIP_RENAME_CONFLICT",
          "warning",
          `current and previous paths resolve to different owners`,
          {
            targetId: target.id,
            evidenceRefs: sortUnique([
              ...selected.sourceRefs,
              ...previousSelection.sourceRefs,
            ]),
          },
        ),
      );
    }
  }
  if (selected.candidates.length === 0 && input.fallback !== undefined) {
    const fallbackOwners = resolveOwnerRefs(
      input.fallback.ownerRefs,
      ownerByReference,
    );
    const fallbackSource: OwnershipSource = {
      id: input.fallback.sourceId,
      repositoryId: target.repositoryId,
      kind: "local",
      path: input.fallback.sourcePath,
      precedence: 0,
      rules: [],
    };
    const fallbackRule: OwnershipRule = {
      id: `${input.fallback.sourceId}:fallback`,
      pattern: "**",
      ownerRefs: input.fallback.ownerRefs,
      priority: 0,
      order: 0,
    };
    selected = {
      candidates: [
        {
          source: fallbackSource,
          rule: fallbackRule,
          sourceKind: "fallback",
          evidenceSourceReference: fallbackReference(input.fallback),
          ownerIds: fallbackOwners.ownerIds,
          unknownOwnerRefs: fallbackOwners.unknown,
          matchedPath: "current",
        },
      ],
      sourceRefs: [fallbackReference(input.fallback)],
      ambiguous: false,
      unknownOwnerRefs: fallbackOwners.unknown,
    };
  }
  const status = statusForSelection(selected, owners);
  if (selected.unknownOwnerRefs.length > 0) {
    diagnostics.push(
      makeDiagnostic(
        "OWNERSHIP_OWNER_UNKNOWN",
        "warning",
        `one or more ownership references are not declared in the owner registry`,
        {
          targetId: target.id,
          evidenceRefs: sortUnique(selected.sourceRefs),
        },
      ),
    );
  }
  const ownerIds = sortUnique(
    selected.candidates.flatMap((candidate) => candidate.ownerIds),
  );
  if (
    ownerIds.some(
      (ownerId) => owners.get(ownerId)?.availability === "unavailable",
    )
  ) {
    diagnostics.push(
      makeDiagnostic(
        "OWNERSHIP_OWNER_UNAVAILABLE",
        "warning",
        `one or more resolved owners are unavailable`,
        { targetId: target.id, evidenceRefs: sortUnique(selected.sourceRefs) },
      ),
    );
  }
  if (status === "ambiguous") {
    diagnostics.push(
      makeDiagnostic(
        "OWNERSHIP_CONFLICT",
        "warning",
        `multiple ownership rules remain after precedence selection`,
        { targetId: target.id, evidenceRefs: sortUnique(selected.sourceRefs) },
      ),
    );
  }
  if (status === "unowned" && selected.candidates.length === 0) {
    diagnostics.push(
      makeDiagnostic(
        "OWNERSHIP_NO_MATCH",
        "info",
        `no ownership rule or fallback matched the target`,
        { targetId: target.id, evidenceRefs: sortUnique(selected.sourceRefs) },
      ),
    );
  }
  const matches = matchesFromSelection(selected);
  const evidence = matches.flatMap((match) => match.evidence);
  if (evidence.length === 0) {
    for (const reference of selected.sourceRefs) {
      const source = input.sources.find(
        (candidate) => sourceReference(candidate) === reference,
      );
      if (source)
        evidence.push(
          evidenceRecord(source.id, source.path, "none", reference),
        );
    }
  }
  return {
    result: {
      target,
      status,
      owners: ownerIds,
      matches,
      evidence,
      diagnosticCodes: diagnosticCodeList(diagnostics),
    },
    diagnostics,
  };
};

export const resolveOwnership = (value: unknown): OwnershipResolutionReport => {
  const input = parseOwnershipInput(value);
  const ownerByReference = new Map<string, OwnershipOwner>();
  const ownerMapDiagnostics: OwnershipDiagnostic[] = [];
  for (const owner of input.owners) {
    const references = [owner.id, ...owner.aliases];
    for (const reference of references) {
      const existing = ownerByReference.get(reference);
      if (existing && existing.id !== owner.id) {
        ownerMapDiagnostics.push(
          makeDiagnostic(
            "OWNERSHIP_ALIAS_CONFLICT",
            "error",
            `owner reference ${reference} maps to both ${existing.id} and ${owner.id}`,
            { evidenceRefs: [] },
          ),
        );
        continue;
      }
      ownerByReference.set(reference, owner);
    }
  }
  const ownersById = new Map(input.owners.map((owner) => [owner.id, owner]));
  const resolved = input.targets.map((target) =>
    resolveTarget(input, target, ownerByReference, ownersById),
  );
  const diagnostics = deduplicateDiagnostics([
    ...input.sourceDiagnostics,
    ...ownerMapDiagnostics,
    ...resolved.flatMap((entry) => entry.diagnostics),
  ]);
  const results = resolved
    .map((entry) => entry.result)
    .sort((left, right) => compareStrings(left.target.id, right.target.id));
  const counts = results.reduce(
    (summary, result) => {
      summary[result.status] += 1;
      summary.matchedRules += result.matches.length;
      return summary;
    },
    {
      targets: results.length,
      resolved: 0,
      unowned: 0,
      ambiguous: 0,
      unavailable: 0,
      unsupported: 0,
      matchedRules: 0,
    },
  );
  const report = {
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    contract: OWNERSHIP_CONTRACT,
    mediaType: OWNERSHIP_MEDIA_TYPE,
    provenance: {
      resolver: OWNERSHIP_CONTRACT,
      resolverVersion: "1" as const,
      inputDigest: digest(stableStringify(input)),
      sourceBodiesIncluded: false as const,
    },
    summary: counts,
    results,
    diagnostics,
  } satisfies OwnershipResolutionReport;
  return parseOwnershipReport(report);
};
