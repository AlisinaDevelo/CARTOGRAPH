import { z } from "zod";

export const DIAGNOSTIC_REGISTRY_VERSION = 1 as const;

const DiagnosticSeveritySchema = z.enum(["info", "warning", "error"]);

const DiagnosticEvidenceContractSchema = z
  .object({
    kind: z.literal("source"),
    location: z.literal("source-span"),
  })
  .strict();

const DiagnosticDefinitionSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    severity: DiagnosticSeveritySchema,
    message: z.string().trim().min(1),
    evidence: DiagnosticEvidenceContractSchema,
    remediation: z.string().trim().min(1),
  })
  .strict();

export const DiagnosticRegistrySchema = z
  .object({
    registryVersion: z.literal(DIAGNOSTIC_REGISTRY_VERSION),
    diagnostics: z.array(DiagnosticDefinitionSchema).min(1),
  })
  .strict()
  .superRefine((registry, context) => {
    const seen = new Set<string>();
    registry.diagnostics.forEach((diagnostic, index) => {
      if (seen.has(diagnostic.code)) {
        context.addIssue({
          code: "custom",
          path: ["diagnostics", index, "code"],
          message: `duplicate diagnostic code: ${diagnostic.code}`,
        });
      }
      seen.add(diagnostic.code);
    });
  });

export type DiagnosticSeverity = z.infer<typeof DiagnosticSeveritySchema>;
export type DiagnosticDefinition = z.infer<typeof DiagnosticDefinitionSchema>;
export type DiagnosticRegistry = z.infer<typeof DiagnosticRegistrySchema>;

export const DIAGNOSTIC_REGISTRY: DiagnosticRegistry =
  DiagnosticRegistrySchema.parse({
    registryVersion: DIAGNOSTIC_REGISTRY_VERSION,
    diagnostics: [
      {
        code: "UNRESOLVED_CALL",
        severity: "warning",
        message: "Could not resolve a callable target for this call.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Keep the callable declaration local and statically resolvable, or review the call manually.",
      },
      {
        code: "UNRESOLVED_IMPORT",
        severity: "warning",
        message: "Could not resolve the requested local module import.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Verify the module path and keep the imported implementation inside the analyzed repository.",
      },
      {
        code: "AMBIGUOUS_PACKAGE_CONDITION",
        severity: "warning",
        message:
          "Package resolution depends on an environment-specific condition branch.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Pin the package condition set or document the runtime environments that may select another branch.",
      },
      {
        code: "AMBIGUOUS_IDENTITY_MATCH",
        severity: "warning",
        message: "Refactor identity has multiple equally plausible candidates.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Review the candidate identities and add stable source or path evidence before accepting the refactor match.",
      },
      {
        code: "IDENTITY_COLLISION",
        severity: "warning",
        message:
          "Refactor identity candidates compete for the same destination and cannot be selected safely.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Review every candidate and add stable source, path, or neighborhood evidence before accepting identity continuity.",
      },
      {
        code: "UNSUPPORTED_IDENTITY_RENAME",
        severity: "warning",
        message:
          "A possible refactor rename lacks enough evidence for a supported identity match.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Review the rename manually or provide path-history, source, or neighborhood evidence before accepting identity continuity.",
      },
      {
        code: "IDENTITY_FALLBACK_MATCH",
        severity: "info",
        message: "A refactor identity used a fallback matching path.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Review the contributing identity signals before treating the fallback match as canonical history.",
      },
      {
        code: "UNRESOLVED_LAYER_ASSIGNMENT",
        severity: "warning",
        message: "A graph boundary could not be assigned to an explicit layer.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Provide explicit layer selectors for the affected nodes before relying on a boundary result.",
      },
      {
        code: "AMBIGUOUS_LAYER_ASSIGNMENT",
        severity: "warning",
        message: "A graph node matches multiple configured layers.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Narrow overlapping layer selectors so each node has one explicit layer.",
      },
      {
        code: "LAYER_BOUNDARY_VIOLATION",
        severity: "warning",
        message:
          "A dependency crosses configured layers in the disallowed direction.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Move the dependency to an allowed direction or record a reviewed policy exception.",
      },
      {
        code: "UNRESOLVED_ROUTE_HANDLER",
        severity: "warning",
        message: "Could not resolve an Express route or middleware handler.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use a locally declared function or statically bound route or middleware handler.",
      },
      {
        code: "UNSUPPORTED_DYNAMIC_HTTP_DESTINATION",
        severity: "warning",
        message:
          "HTTP destination must be a literal string for a confident request edge.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use a literal URL or review the runtime configuration before accepting the request edge.",
      },
      {
        code: "UNSUPPORTED_DYNAMIC_IMPORT",
        severity: "warning",
        message: "Dynamic import destination is not a literal string.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use a literal module specifier or document the runtime module resolver.",
      },
      {
        code: "UNSUPPORTED_DYNAMIC_PRISMA_MODEL",
        severity: "warning",
        message:
          "Prisma model and operation must be statically named properties.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use a statically named model and operation or review the dynamic database access manually.",
      },
      {
        code: "UNSUPPORTED_DYNAMIC_ROUTE",
        severity: "warning",
        message:
          "Express route or middleware registration is not statically resolvable.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use a literal route or middleware path and a statically named registration method.",
      },
    ],
  });

const definitionsByCode = new Map(
  DIAGNOSTIC_REGISTRY.diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic,
  ]),
);

export const getDiagnosticDefinition = (
  code: string,
): DiagnosticDefinition | undefined => definitionsByCode.get(code);
