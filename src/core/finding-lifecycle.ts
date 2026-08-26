import { createHash } from "node:crypto";

import { z, ZodError } from "zod";

import { stableStringify } from "./canonical.js";

export const FINDING_LIFECYCLE_SCHEMA_VERSION = 1 as const;
export const FINDING_LIFECYCLE_CONTRACT =
  "cartograph.finding-lifecycle" as const;
export const FINDING_LIFECYCLE_MEDIA_TYPE =
  "application/vnd.cartograph.finding-lifecycle+json" as const;
export const FINDING_LIFECYCLE_MAX_FINDINGS = 100_000 as const;
export const FINDING_LIFECYCLE_MAX_EVENTS = 500_000 as const;
export const FINDING_LIFECYCLE_MAX_MIGRATIONS = 100_000 as const;
export const FINDING_LIFECYCLE_MAX_EVIDENCE_REFS = 128 as const;

export const FINDING_LIFECYCLE_STATES = [
  "open",
  "acknowledged",
  "remediated",
  "waived",
  "regressed",
  "obsolete",
] as const;

export const FindingLifecycleStateSchema = z.enum(FINDING_LIFECYCLE_STATES);

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

const ShortIdentifierSchema = IdentifierSchema.max(512);
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const DateTimeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), "must be a date-time");
const EvidenceReferenceSchema = IdentifierSchema.refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !/^file:/iu.test(value) &&
    !value.includes("\\"),
  "must be a portable evidence reference",
);

export const FindingLifecycleActorSchema = z
  .object({
    id: ShortIdentifierSchema,
    kind: z.enum(["user", "team", "service", "system"]),
  })
  .strict();

export const FindingIdentitySchema = z
  .object({
    stableKey: ShortIdentifierSchema,
    code: ShortIdentifierSchema,
    scope: ShortIdentifierSchema,
  })
  .strict();

export const FindingRecordSchema = z
  .object({
    id: ShortIdentifierSchema,
    identity: FindingIdentitySchema,
    initialState: FindingLifecycleStateSchema.default("open"),
    policyRevision: ShortIdentifierSchema,
    evidenceRevision: ShortIdentifierSchema,
    evidenceRefs: z
      .array(EvidenceReferenceSchema)
      .max(FINDING_LIFECYCLE_MAX_EVIDENCE_REFS)
      .default([]),
    createdAt: DateTimeSchema,
  })
  .strict();

export const FindingLifecycleEventSchema = z
  .object({
    id: ShortIdentifierSchema,
    findingId: ShortIdentifierSchema,
    from: FindingLifecycleStateSchema,
    to: FindingLifecycleStateSchema,
    actor: FindingLifecycleActorSchema,
    at: DateTimeSchema,
    rationale: z.string().trim().min(1).max(4_096),
    policyRevision: ShortIdentifierSchema,
    evidenceRevision: ShortIdentifierSchema,
    evidenceRefs: z
      .array(EvidenceReferenceSchema)
      .max(FINDING_LIFECYCLE_MAX_EVIDENCE_REFS)
      .default([]),
    sequence: z.number().int().positive().max(1_000_000_000),
    previousDigest: DigestSchema,
    digest: DigestSchema,
    reasonCode: ShortIdentifierSchema.optional(),
    supersedesFindingIds: z.array(ShortIdentifierSchema).max(256).default([]),
  })
  .strict();

export const FindingIdentityMigrationSchema = z
  .object({
    id: ShortIdentifierSchema,
    fromFindingId: ShortIdentifierSchema,
    toFindingId: ShortIdentifierSchema,
    actor: FindingLifecycleActorSchema,
    at: DateTimeSchema,
    rationale: z.string().trim().min(1).max(4_096),
    evidenceRevision: ShortIdentifierSchema,
    evidenceRefs: z
      .array(EvidenceReferenceSchema)
      .max(FINDING_LIFECYCLE_MAX_EVIDENCE_REFS)
      .default([]),
    digest: DigestSchema,
  })
  .strict();

export const FindingLifecycleInputSchema = z
  .object({
    schemaVersion: z.literal(FINDING_LIFECYCLE_SCHEMA_VERSION),
    contract: z.literal(FINDING_LIFECYCLE_CONTRACT),
    repositoryId: ShortIdentifierSchema,
    policyRevision: ShortIdentifierSchema,
    findings: z
      .array(FindingRecordSchema)
      .min(1)
      .max(FINDING_LIFECYCLE_MAX_FINDINGS),
    events: z
      .array(FindingLifecycleEventSchema)
      .max(FINDING_LIFECYCLE_MAX_EVENTS),
    migrations: z
      .array(FindingIdentityMigrationSchema)
      .max(FINDING_LIFECYCLE_MAX_MIGRATIONS)
      .default([]),
  })
  .strict()
  .superRefine((input, context) => {
    const findingIds = new Set<string>();
    const identityKeys = new Set<string>();
    for (const [index, finding] of input.findings.entries()) {
      if (findingIds.has(finding.id)) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "id"],
          message: `duplicate finding ID: ${finding.id}`,
        });
      }
      findingIds.add(finding.id);
      const identityKey = stableStringify(finding.identity);
      if (identityKeys.has(identityKey)) {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "identity"],
          message: `duplicate finding identity: ${identityKey}`,
        });
      }
      identityKeys.add(identityKey);
    }
    const eventIds = new Set<string>();
    for (const [index, event] of input.events.entries()) {
      if (eventIds.has(event.id)) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "id"],
          message: `duplicate lifecycle event ID: ${event.id}`,
        });
      }
      eventIds.add(event.id);
    }
    const migrationIds = new Set<string>();
    for (const [index, migration] of input.migrations.entries()) {
      if (migrationIds.has(migration.id)) {
        context.addIssue({
          code: "custom",
          path: ["migrations", index, "id"],
          message: `duplicate identity migration ID: ${migration.id}`,
        });
      }
      migrationIds.add(migration.id);
      if (migration.fromFindingId === migration.toFindingId) {
        context.addIssue({
          code: "custom",
          path: ["migrations", index],
          message: "identity migration must change the finding ID",
        });
      }
    }
  });

export const FindingLifecycleEvidenceSchema = z
  .object({
    findingId: ShortIdentifierSchema,
    eventId: ShortIdentifierSchema.optional(),
    migrationId: ShortIdentifierSchema.optional(),
    reference: EvidenceReferenceSchema,
  })
  .strict();

export const FindingLifecycleDiagnosticSchema = z
  .object({
    id: ShortIdentifierSchema,
    code: z.string().regex(/^LIFECYCLE_[A-Z0-9_]+$/u),
    severity: z.enum(["info", "warning", "error"]),
    message: ShortIdentifierSchema,
    findingId: ShortIdentifierSchema.optional(),
    eventId: ShortIdentifierSchema.optional(),
    migrationId: ShortIdentifierSchema.optional(),
    evidenceRefs: z
      .array(EvidenceReferenceSchema)
      .max(FINDING_LIFECYCLE_MAX_EVIDENCE_REFS)
      .default([]),
  })
  .strict();

export const FindingLifecycleFindingResultSchema = z
  .object({
    findingId: ShortIdentifierSchema,
    identity: FindingIdentitySchema,
    state: FindingLifecycleStateSchema,
    policyRevision: ShortIdentifierSchema,
    evidenceRevision: ShortIdentifierSchema,
    eventIds: z.array(ShortIdentifierSchema).max(FINDING_LIFECYCLE_MAX_EVENTS),
    supersededFindingIds: z.array(ShortIdentifierSchema).max(256),
    evidence: z
      .array(FindingLifecycleEvidenceSchema)
      .max(FINDING_LIFECYCLE_MAX_EVIDENCE_REFS),
    diagnosticCodes: z.array(z.string().regex(/^LIFECYCLE_[A-Z0-9_]+$/u)),
  })
  .strict();

export const FindingLifecycleSummarySchema = z
  .object({
    findings: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    appliedEvents: z.number().int().nonnegative(),
    migrations: z.number().int().nonnegative(),
    diagnostics: z.number().int().nonnegative(),
    states: z.record(
      FindingLifecycleStateSchema,
      z.number().int().nonnegative(),
    ),
  })
  .strict();

export const FindingLifecycleProvenanceSchema = z
  .object({
    resolver: z.literal(FINDING_LIFECYCLE_CONTRACT),
    resolverVersion: z.literal("1"),
    inputDigest: DigestSchema,
    appendOnly: z.literal(true),
    sourceBodiesIncluded: z.literal(false),
  })
  .strict();

export const FindingLifecycleReportSchema = z
  .object({
    schemaVersion: z.literal(FINDING_LIFECYCLE_SCHEMA_VERSION),
    contract: z.literal(FINDING_LIFECYCLE_CONTRACT),
    mediaType: z.literal(FINDING_LIFECYCLE_MEDIA_TYPE),
    provenance: FindingLifecycleProvenanceSchema,
    summary: FindingLifecycleSummarySchema,
    findings: z
      .array(FindingLifecycleFindingResultSchema)
      .max(FINDING_LIFECYCLE_MAX_FINDINGS),
    migrations: z
      .array(FindingIdentityMigrationSchema)
      .max(FINDING_LIFECYCLE_MAX_MIGRATIONS),
    diagnostics: z
      .array(FindingLifecycleDiagnosticSchema)
      .max(FINDING_LIFECYCLE_MAX_EVENTS),
  })
  .strict();

export type FindingLifecycleState = z.infer<typeof FindingLifecycleStateSchema>;
export type FindingLifecycleActor = z.infer<typeof FindingLifecycleActorSchema>;
export type FindingIdentity = z.infer<typeof FindingIdentitySchema>;
export type FindingRecord = z.infer<typeof FindingRecordSchema>;
export type FindingLifecycleEvent = z.infer<typeof FindingLifecycleEventSchema>;
export type FindingIdentityMigration = z.infer<
  typeof FindingIdentityMigrationSchema
>;
export type FindingLifecycleInput = z.infer<typeof FindingLifecycleInputSchema>;
export type FindingLifecycleEvidence = z.infer<
  typeof FindingLifecycleEvidenceSchema
>;
export type FindingLifecycleDiagnostic = z.infer<
  typeof FindingLifecycleDiagnosticSchema
>;
export type FindingLifecycleFindingResult = z.infer<
  typeof FindingLifecycleFindingResultSchema
>;
export type FindingLifecycleSummary = z.infer<
  typeof FindingLifecycleSummarySchema
>;
export type FindingLifecycleProvenance = z.infer<
  typeof FindingLifecycleProvenanceSchema
>;
export type FindingLifecycleReport = z.infer<
  typeof FindingLifecycleReportSchema
>;

export class FindingLifecycleValidationError extends Error {
  readonly issues: readonly z.ZodIssue[];

  constructor(message: string, issues: readonly z.ZodIssue[] = []) {
    super(message);
    this.name = "FindingLifecycleValidationError";
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
      throw new FindingLifecycleValidationError(
        `${label} validation failed: ${issueText(error.issues)}`,
        error.issues,
      );
    }
    throw error;
  }
};

export const parseFindingLifecycleInput = (
  value: unknown,
): FindingLifecycleInput =>
  parseWith(FindingLifecycleInputSchema, value, "finding lifecycle input");

export const parseFindingLifecycleReport = (
  value: unknown,
): FindingLifecycleReport =>
  parseWith(FindingLifecycleReportSchema, value, "finding lifecycle report");

export const serializeFindingLifecycleReport = (value: unknown): string =>
  stableStringify(parseFindingLifecycleReport(value));

const digest = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const eventPayload = (
  event: FindingLifecycleEvent,
): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(event).filter(([key]) => key !== "digest"),
  );
};

export const findingLifecycleEventDigest = (
  event: FindingLifecycleEvent,
): `sha256:${string}` => digest(stableStringify(eventPayload(event)));

const migrationPayload = (
  migration: FindingIdentityMigration,
): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(migration).filter(([key]) => key !== "digest"),
  );
};

export const findingIdentityMigrationDigest = (
  migration: FindingIdentityMigration,
): `sha256:${string}` => digest(stableStringify(migrationPayload(migration)));

export const findingLifecycleGenesisDigest = (
  finding: FindingRecord,
): `sha256:${string}` =>
  digest(
    stableStringify({
      contract: FINDING_LIFECYCLE_CONTRACT,
      finding,
    }),
  );

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort(compareStrings);

const diagnostic = (
  code: string,
  severity: FindingLifecycleDiagnostic["severity"],
  message: string,
  options: Partial<
    Pick<
      FindingLifecycleDiagnostic,
      "findingId" | "eventId" | "migrationId" | "evidenceRefs"
    >
  > = {},
): FindingLifecycleDiagnostic => ({
  id: `lifecycle:diagnostic:${digest(stableStringify({ code, message, ...options }))}`,
  code,
  severity,
  message,
  evidenceRefs: [],
  ...options,
});

const allowedTransitions: Record<
  FindingLifecycleState,
  readonly FindingLifecycleState[]
> = {
  open: ["acknowledged", "remediated", "waived", "obsolete"],
  acknowledged: ["open", "remediated", "waived", "regressed", "obsolete"],
  remediated: ["regressed", "obsolete"],
  waived: ["open", "acknowledged", "remediated", "regressed", "obsolete"],
  regressed: ["acknowledged", "remediated", "waived", "obsolete"],
  obsolete: [],
};

const evidenceFor = (
  findingId: string,
  finding: FindingRecord,
  event?: FindingLifecycleEvent,
): FindingLifecycleEvidence[] => {
  const refs = event?.evidenceRefs ?? finding.evidenceRefs;
  return refs.map((reference) => ({
    findingId,
    ...(event === undefined ? {} : { eventId: event.id }),
    reference,
  }));
};

const deduplicateDiagnostics = (
  diagnostics: readonly FindingLifecycleDiagnostic[],
): FindingLifecycleDiagnostic[] =>
  [...new Map(diagnostics.map((entry) => [entry.id, entry])).values()].sort(
    (left, right) => compareStrings(left.id, right.id),
  );

const resolveMigration = (
  findingId: string,
  migrationByFrom: ReadonlyMap<string, FindingIdentityMigration>,
  findingIds: ReadonlySet<string>,
): { id: string; cycle: boolean } => {
  let current = findingId;
  const seen = new Set<string>();
  while (migrationByFrom.has(current)) {
    if (seen.has(current)) return { id: current, cycle: true };
    seen.add(current);
    current = migrationByFrom.get(current)!.toFindingId;
  }
  return { id: current, cycle: !findingIds.has(current) };
};

const eventOrder = (
  left: FindingLifecycleEvent,
  right: FindingLifecycleEvent,
) => {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  const byTime = Date.parse(left.at) - Date.parse(right.at);
  return byTime !== 0 ? byTime : compareStrings(left.id, right.id);
};

const resultDiagnosticCodes = (
  diagnostics: readonly FindingLifecycleDiagnostic[],
): string[] => sortUnique(diagnostics.map((entry) => entry.code));

export const replayFindingLifecycle = (
  value: unknown,
): FindingLifecycleReport => {
  const input = parseFindingLifecycleInput(value);
  const findingById = new Map(
    input.findings.map((finding) => [finding.id, finding]),
  );
  const diagnostics: FindingLifecycleDiagnostic[] = [];
  const migrationByFrom = new Map<string, FindingIdentityMigration>();
  const migrations = [...input.migrations].sort((left, right) =>
    compareStrings(left.id, right.id),
  );

  for (const migration of migrations) {
    if (findingIdentityMigrationDigest(migration) !== migration.digest) {
      diagnostics.push(
        diagnostic(
          "LIFECYCLE_MIGRATION_TAMPERED",
          "error",
          `identity migration digest does not match its canonical payload: ${migration.id}`,
          {
            migrationId: migration.id,
            evidenceRefs: migration.evidenceRefs,
          },
        ),
      );
      continue;
    }
    if (migrationByFrom.has(migration.fromFindingId)) {
      diagnostics.push(
        diagnostic(
          "LIFECYCLE_MIGRATION_CONFLICT",
          "error",
          `multiple identity migrations claim the same source finding: ${migration.fromFindingId}`,
          { migrationId: migration.id, evidenceRefs: migration.evidenceRefs },
        ),
      );
      continue;
    }
    migrationByFrom.set(migration.fromFindingId, migration);
    if (!findingById.has(migration.toFindingId)) {
      diagnostics.push(
        diagnostic(
          "LIFECYCLE_MIGRATION_TARGET_MISSING",
          "warning",
          `identity migration target is not declared: ${migration.toFindingId}`,
          { migrationId: migration.id, evidenceRefs: migration.evidenceRefs },
        ),
      );
    }
    const resolved = resolveMigration(
      migration.fromFindingId,
      migrationByFrom,
      new Set(findingById.keys()),
    );
    if (resolved.cycle) {
      diagnostics.push(
        diagnostic(
          "LIFECYCLE_MIGRATION_CYCLE",
          "error",
          `identity migration cycle or unavailable target detected at ${migration.fromFindingId}`,
          { migrationId: migration.id, evidenceRefs: migration.evidenceRefs },
        ),
      );
    }
  }

  const eventByFinding = new Map<string, FindingLifecycleEvent[]>();
  for (const event of input.events) {
    const resolved = resolveMigration(
      event.findingId,
      migrationByFrom,
      new Set(findingById.keys()),
    );
    if (resolved.cycle || !findingById.has(resolved.id)) {
      diagnostics.push(
        diagnostic(
          "LIFECYCLE_EVENT_FINDING_MISSING",
          "error",
          `event refers to a finding that is not available after identity migration: ${event.findingId}`,
          {
            eventId: event.id,
            findingId: event.findingId,
            evidenceRefs: event.evidenceRefs,
          },
        ),
      );
      continue;
    }
    const list = eventByFinding.get(resolved.id) ?? [];
    list.push(event);
    eventByFinding.set(resolved.id, list);
  }

  const results: FindingLifecycleFindingResult[] = [];
  let appliedEvents = 0;
  for (const finding of [...input.findings].sort((left, right) =>
    compareStrings(left.id, right.id),
  )) {
    const findingDiagnostics: FindingLifecycleDiagnostic[] = [];
    const events = [...(eventByFinding.get(finding.id) ?? [])].sort(eventOrder);
    let state = finding.initialState;
    let policyRevision = finding.policyRevision;
    let evidenceRevision = finding.evidenceRevision;
    let previousDigest = findingLifecycleGenesisDigest(finding);
    let expectedSequence = 1;
    const eventIds: string[] = [];
    const supersededFindingIds: string[] = [];
    const evidence = evidenceFor(finding.id, finding);
    const usedSequences = new Set<number>();
    for (const event of events) {
      if (usedSequences.has(event.sequence)) {
        findingDiagnostics.push(
          diagnostic(
            "LIFECYCLE_CONCURRENT_EVENT",
            "warning",
            `multiple lifecycle events claim sequence ${event.sequence}; deterministic event order retains the first record`,
            {
              findingId: finding.id,
              eventId: event.id,
              evidenceRefs: event.evidenceRefs,
            },
          ),
        );
        continue;
      }
      usedSequences.add(event.sequence);
      if (event.sequence !== expectedSequence) {
        findingDiagnostics.push(
          diagnostic(
            "LIFECYCLE_SEQUENCE_GAP",
            "error",
            `lifecycle sequence expected ${expectedSequence} but found ${event.sequence}`,
            {
              findingId: finding.id,
              eventId: event.id,
              evidenceRefs: event.evidenceRefs,
            },
          ),
        );
        continue;
      }
      if (event.previousDigest !== previousDigest) {
        findingDiagnostics.push(
          diagnostic(
            "LIFECYCLE_CHAIN_MISMATCH",
            "error",
            `event previous digest does not match the append-only chain: ${event.id}`,
            {
              findingId: finding.id,
              eventId: event.id,
              evidenceRefs: event.evidenceRefs,
            },
          ),
        );
        continue;
      }
      if (findingLifecycleEventDigest(event) !== event.digest) {
        findingDiagnostics.push(
          diagnostic(
            "LIFECYCLE_EVENT_TAMPERED",
            "error",
            `event digest does not match its canonical payload: ${event.id}`,
            {
              findingId: finding.id,
              eventId: event.id,
              evidenceRefs: event.evidenceRefs,
            },
          ),
        );
        continue;
      }
      if (
        event.from !== state ||
        !allowedTransitions[state].includes(event.to)
      ) {
        findingDiagnostics.push(
          diagnostic(
            "LIFECYCLE_INVALID_TRANSITION",
            "error",
            `invalid finding state transition ${event.from} -> ${event.to} from current state ${state}`,
            {
              findingId: finding.id,
              eventId: event.id,
              evidenceRefs: event.evidenceRefs,
            },
          ),
        );
        continue;
      }
      if (event.policyRevision !== policyRevision) {
        findingDiagnostics.push(
          diagnostic(
            "LIFECYCLE_POLICY_CHANGED",
            "info",
            `policy revision changed from ${policyRevision} to ${event.policyRevision}`,
            {
              findingId: finding.id,
              eventId: event.id,
              evidenceRefs: event.evidenceRefs,
            },
          ),
        );
      }
      if (event.evidenceRevision !== evidenceRevision) {
        findingDiagnostics.push(
          diagnostic(
            "LIFECYCLE_EVIDENCE_CHANGED",
            "info",
            `evidence revision changed from ${evidenceRevision} to ${event.evidenceRevision}`,
            {
              findingId: finding.id,
              eventId: event.id,
              evidenceRefs: event.evidenceRefs,
            },
          ),
        );
      }
      for (const supersededFindingId of event.supersedesFindingIds) {
        const resolved = resolveMigration(
          supersededFindingId,
          migrationByFrom,
          new Set(findingById.keys()),
        );
        if (resolved.cycle || !findingById.has(resolved.id)) {
          findingDiagnostics.push(
            diagnostic(
              "LIFECYCLE_SUPERSESSION_TARGET_MISSING",
              "warning",
              `supersession target is not declared: ${supersededFindingId}`,
              {
                findingId: finding.id,
                eventId: event.id,
                evidenceRefs: event.evidenceRefs,
              },
            ),
          );
        } else if (resolved.id === finding.id) {
          findingDiagnostics.push(
            diagnostic(
              "LIFECYCLE_SUPERSESSION_SELF_REFERENCE",
              "error",
              `finding cannot supersede itself: ${finding.id}`,
              {
                findingId: finding.id,
                eventId: event.id,
                evidenceRefs: event.evidenceRefs,
              },
            ),
          );
        } else {
          supersededFindingIds.push(resolved.id);
        }
      }
      state = event.to;
      policyRevision = event.policyRevision;
      evidenceRevision = event.evidenceRevision;
      previousDigest = event.digest;
      expectedSequence += 1;
      eventIds.push(event.id);
      evidence.push(...evidenceFor(finding.id, finding, event));
      appliedEvents += 1;
    }
    const localDiagnostics = deduplicateDiagnostics(findingDiagnostics);
    results.push({
      findingId: finding.id,
      identity: finding.identity,
      state,
      policyRevision,
      evidenceRevision,
      eventIds,
      supersededFindingIds: sortUnique(supersededFindingIds),
      evidence: evidence.slice(0, FINDING_LIFECYCLE_MAX_EVIDENCE_REFS),
      diagnosticCodes: resultDiagnosticCodes(localDiagnostics),
    });
    diagnostics.push(...localDiagnostics);
  }

  const allDiagnostics = deduplicateDiagnostics(diagnostics);
  const states = Object.fromEntries(
    FINDING_LIFECYCLE_STATES.map((state) => [state, 0]),
  ) as Record<FindingLifecycleState, number>;
  for (const result of results) states[result.state] += 1;
  const report = {
    schemaVersion: FINDING_LIFECYCLE_SCHEMA_VERSION,
    contract: FINDING_LIFECYCLE_CONTRACT,
    mediaType: FINDING_LIFECYCLE_MEDIA_TYPE,
    provenance: {
      resolver: FINDING_LIFECYCLE_CONTRACT,
      resolverVersion: "1" as const,
      inputDigest: digest(stableStringify(input)),
      appendOnly: true as const,
      sourceBodiesIncluded: false as const,
    },
    summary: {
      findings: results.length,
      events: input.events.length,
      appliedEvents,
      migrations: input.migrations.length,
      diagnostics: allDiagnostics.length,
      states,
    },
    findings: results,
    migrations,
    diagnostics: allDiagnostics,
  } satisfies FindingLifecycleReport;
  return parseFindingLifecycleReport(report);
};
