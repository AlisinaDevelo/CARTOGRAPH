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
      {
        code: "PARTIAL_API_SCHEMA_GENERATION",
        severity: "warning",
        message:
          "API schema generation or parsing is only partially covered by the static analyzer.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Keep the schema declaration statically readable and review generated or runtime-composed schema portions manually.",
      },
      {
        code: "PARTIAL_API_SCHEMA_ALIAS",
        severity: "warning",
        message:
          "An API schema boundary uses an alias or handler mapping that is not fully statically resolvable.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use a unique local resolver or handler reference and review aliased or external schema definitions manually.",
      },
      {
        code: "PARTIAL_RUNTIME_COMPOSED_ROUTE",
        severity: "warning",
        message:
          "An API boundary is backed by a runtime-composed route that cannot be mapped statically.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Declare a literal route path and method or review the runtime router composition alongside the API schema.",
      },
      {
        code: "MULTIPLE_PRISMA_SCHEMA_FILES",
        severity: "warning",
        message:
          "Multiple Prisma schema files were discovered and analyzed as separate declarations.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Declare one authoritative Prisma schema set or review duplicate declarations before accepting the merged graph.",
      },
      {
        code: "AMBIGUOUS_PRISMA_SCHEMA",
        severity: "warning",
        message:
          "A Prisma schema declaration is duplicated or ambiguous across the bounded schema set.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Keep datasource, model, and generator names unique across analyzed Prisma schema files.",
      },
      {
        code: "UNSUPPORTED_PRISMA_PROVIDER",
        severity: "warning",
        message:
          "A Prisma datasource provider is unsupported or dynamically configured.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use a supported literal Prisma provider or review the datasource boundary manually; no connection is attempted.",
      },
      {
        code: "UNSUPPORTED_PRISMA_GENERATOR",
        severity: "warning",
        message:
          "A Prisma generator provider is unsupported or dynamically configured.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use a supported Prisma client generator or review generated-client provenance manually; generation is never executed.",
      },
      {
        code: "UNSUPPORTED_PRISMA_GENERATED_OUTPUT",
        severity: "warning",
        message:
          "A Prisma generated-client output path is outside the analyzed repository or dynamically configured.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use a literal output path inside the repository or document the generated artifact provenance manually.",
      },
      {
        code: "AMBIGUOUS_LOCKFILE",
        severity: "warning",
        message:
          "Multiple package-manager lockfiles are present for one package root.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Keep one authoritative lockfile per package root or review the manager boundary before relying on dependency edges.",
      },
      {
        code: "LOCKFILE_MISSING_INTEGRITY",
        severity: "warning",
        message: "A lockfile dependency record has no integrity or checksum.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Regenerate the lockfile with integrity metadata or review the dependency provenance manually.",
      },
      {
        code: "LOCKFILE_VERSION_MISMATCH",
        severity: "warning",
        message:
          "A lockfile version or resolved dependency does not match the supported declaration.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Regenerate the lockfile with the declared package manager and supported format, then review any unresolved dependency versions.",
      },
      {
        code: "UNRESOLVED_FASTIFY_HANDLER",
        severity: "warning",
        message:
          "Could not resolve a Fastify route handler in the supported adapter subset.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use a locally declared or inline Fastify handler and keep route registration statically resolvable.",
      },
      {
        code: "UNSUPPORTED_DYNAMIC_FASTIFY_ROUTE",
        severity: "warning",
        message:
          "Fastify route method and URL must be statically named literals in the supported adapter subset.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use literal Fastify route methods and URLs, or review dynamic registration manually.",
      },
      {
        code: "UNSUPPORTED_DYNAMIC_EVENT_NAME",
        severity: "warning",
        message:
          "Event name must be a literal string for a confident event edge.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use a literal EventEmitter event name or review the runtime dispatch manually.",
      },
      {
        code: "UNSUPPORTED_EVENT_REFLECTION",
        severity: "warning",
        message: "Event handler must be a statically resolvable callable.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Pass a local function or statically bound handler instead of a string or reflective event target.",
      },
      {
        code: "UNSUPPORTED_QUEUE_CLIENT",
        severity: "warning",
        message:
          "Queue client is outside the supported Bull and BullMQ registration subset.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use the supported Bull or BullMQ queue registration pattern, or review the client manually before relying on its edges.",
      },
      {
        code: "UNSUPPORTED_DYNAMIC_QUEUE_NAME",
        severity: "warning",
        message:
          "Queue name must be a literal string for a confident queue edge.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use a literal queue name or review the runtime queue selection manually.",
      },
      {
        code: "UNSUPPORTED_CALLBACK_REFLECTION",
        severity: "warning",
        message:
          "Asynchronous callback must be a statically resolvable callable.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Pass a local function or statically bound callback instead of a string or reflective target.",
      },
      {
        code: "UNRESOLVED_ASYNC_HANDLER",
        severity: "warning",
        message: "Could not resolve an asynchronous event or queue handler.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Keep the asynchronous handler local and statically resolvable, or review the registration manually.",
      },
      {
        code: "UNSUPPORTED_RUST_DYNAMIC_HTTP_DESTINATION",
        severity: "warning",
        message: "Rust HTTP destination must be a literal string.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use a literal reqwest or client URL, or review the runtime destination manually.",
      },
      {
        code: "UNSUPPORTED_RUST_DYNAMIC_QUERY",
        severity: "warning",
        message: "Rust SQL query must contain a literal recognizable table.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Use a literal SQL statement with a table name, or review the runtime query manually.",
      },
      {
        code: "UNRESOLVED_RUST_IMPORT",
        severity: "warning",
        message:
          "Rust local module could not be resolved within the source root.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Keep the module declaration inside the analyzed source root, or review the import manually.",
      },
      {
        code: "UNRESOLVED_RUST_CALL",
        severity: "warning",
        message: "Rust call target is outside the bounded local symbol set.",
        evidence: { kind: "source", location: "source-span" },
        remediation:
          "Review the call target manually or provide a bounded local declaration.",
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
