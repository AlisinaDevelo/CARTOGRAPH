import { Buffer } from "node:buffer";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { z } from "zod";

import { stableStringify } from "./canonical.js";
import type { GraphSnapshot } from "./schemas.js";

export const ADR_REFERENCE_SCHEMA_VERSION = 1 as const;
export const ADR_REFERENCE_CONTRACT = "cartograph.adr-reference" as const;
export const ADR_REFERENCE_MAX_BYTES = 1024 * 1024;
export const ADR_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;

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

const PortablePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .transform((value, context) => {
    const normalized = value.replaceAll("\\", "/");
    if (
      normalized.includes("\0") ||
      normalized.startsWith("/") ||
      normalized.startsWith("~") ||
      normalized.startsWith("//") ||
      /^[A-Za-z][A-Za-z\d+.-]*:/.test(normalized) ||
      normalized.split("/").some((part) => part === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "must be a portable repository-relative path",
      });
      return z.NEVER;
    }
    const compact = normalized
      .split("/")
      .filter((part) => part.length > 0 && part !== ".")
      .join("/");
    if (compact.length === 0) {
      context.addIssue({
        code: "custom",
        message: "must be a portable repository-relative path",
      });
      return z.NEVER;
    }
    return compact;
  });

const AdrTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );

export const AdrStatusSchema = z.enum([
  "draft",
  "proposed",
  "accepted",
  "rejected",
  "deprecated",
  "superseded",
]);

const GraphIdSchema = IdentifierSchema;

export const AdrReferenceSchema = z
  .object({
    id: IdentifierSchema,
    file: PortablePathSchema,
    title: AdrTitleSchema,
    status: AdrStatusSchema,
    graphIds: z
      .array(GraphIdSchema)
      .min(1)
      .max(256)
      .superRefine((ids, context) => {
        const seen = new Set<string>();
        ids.forEach((id, index) => {
          if (seen.has(id)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: `duplicate graph ID: ${id}`,
            });
          }
          seen.add(id);
        });
      }),
  })
  .strict();

export const AdrReferenceDocumentSchema = z
  .object({
    schemaVersion: z
      .literal(ADR_REFERENCE_SCHEMA_VERSION)
      .default(ADR_REFERENCE_SCHEMA_VERSION),
    references: z.array(AdrReferenceSchema).min(1).max(512),
  })
  .strict()
  .superRefine((document, context) => {
    const ids = new Map<string, number>();
    const files = new Map<string, number>();
    document.references.forEach((reference, index) => {
      const previousId = ids.get(reference.id);
      if (previousId !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["references", index, "id"],
          message: `duplicate ADR reference ID; first declared at index ${previousId}`,
        });
      }
      ids.set(reference.id, index);

      const previousFile = files.get(reference.file);
      if (previousFile !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["references", index, "file"],
          message: `duplicate ADR reference file; first declared at index ${previousFile}`,
        });
      }
      files.set(reference.file, index);
    });
  });

export type AdrStatus = z.infer<typeof AdrStatusSchema>;
export type AdrReference = z.infer<typeof AdrReferenceSchema>;
export type AdrReferenceDocument = z.infer<typeof AdrReferenceDocumentSchema>;

export class AdrReferenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdrReferenceValidationError";
  }
}

export const ADR_REFERENCE_DIAGNOSTIC_CODES = [
  "ADR_REFERENCE_MISSING_FILE",
  "ADR_REFERENCE_MALFORMED_FILE",
  "ADR_REFERENCE_STALE_FILE",
  "ADR_REFERENCE_MALFORMED_GRAPH_ID",
  "ADR_REFERENCE_STALE_GRAPH_ID",
  "ADR_REFERENCE_MISSING_GRAPH_ID",
] as const;

export const AdrReferenceDiagnosticCodeSchema = z.enum(
  ADR_REFERENCE_DIAGNOSTIC_CODES,
);

export type AdrReferenceDiagnosticCode = z.infer<
  typeof AdrReferenceDiagnosticCodeSchema
>;

export type AdrReferenceDiagnostic = {
  code: AdrReferenceDiagnosticCode;
  severity: "error";
  referenceId?: string;
  file?: string;
  graphId?: string;
  message: string;
};

export type AdrReferenceValidationOptions = {
  root?: string;
  snapshot?: Pick<GraphSnapshot, "nodes" | "edges">;
  requiredGraphIds?: readonly string[];
};

export type AdrReferenceValidationResult = {
  ok: boolean;
  diagnostics: AdrReferenceDiagnostic[];
};

const issueText = (issues: z.ZodIssue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "adr";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

export const parseAdrReferenceDocument = (
  value: unknown,
): AdrReferenceDocument => {
  const parsed = AdrReferenceDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new AdrReferenceValidationError(issueText(parsed.error.issues));
  }
  return parsed.data;
};

const containedPath = (
  root: string,
  candidate: string,
  label: string,
): string => {
  const normalized = candidate.replaceAll("\\", "/").trim();
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    normalized.startsWith("//") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new AdrReferenceValidationError(
      `${label} must be a repository-relative local file`,
    );
  }

  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = realpathSync(root);
    realCandidate = realpathSync(resolve(realRoot, normalized));
  } catch {
    throw new AdrReferenceValidationError(
      `${label} does not exist: ${candidate}`,
    );
  }
  const relativePath = relative(realRoot, realCandidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  ) {
    throw new AdrReferenceValidationError(
      `${label} must stay inside the analyzed repository`,
    );
  }
  return realCandidate;
};

export const readAdrReferenceDocument = (
  root: string,
  referencePath: string,
): AdrReferenceDocument => {
  const inputPath = containedPath(root, referencePath, "ADR reference file");
  const metadata = lstatSync(inputPath);
  if (!metadata.isFile()) {
    throw new AdrReferenceValidationError(
      `ADR reference file is not a regular file: ${referencePath}`,
    );
  }
  if (metadata.size > ADR_REFERENCE_MAX_BYTES) {
    throw new AdrReferenceValidationError(
      `ADR reference file exceeds the ${ADR_REFERENCE_MAX_BYTES} byte limit`,
    );
  }
  const source = readFileSync(inputPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > ADR_REFERENCE_MAX_BYTES) {
    throw new AdrReferenceValidationError(
      `ADR reference file exceeds the ${ADR_REFERENCE_MAX_BYTES} byte limit`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new AdrReferenceValidationError(
      `could not parse ADR reference JSON: ${detail}`,
    );
  }
  return parseAdrReferenceDocument(value);
};

const markdownMetadata = (
  source: string,
): { title: string | undefined; status: string | undefined } => {
  const rawTitle = source.match(/^#\s+(.+?)\s*$/mu)?.[1]?.trim();
  const title = rawTitle?.replace(/^ADR\s+\d+\s*:\s*/iu, "").trim();
  const status = source.match(/^[-*]\s+Status:\s*(.+?)\s*$/imu)?.[1]?.trim();
  return { title, status };
};

const graphEdgeId = (from: string, kind: string, to: string): string =>
  `edge:${from}|${kind}|${to}`;

export const serializeAdrGraphEdgeId = (edge: {
  from: string;
  kind: string;
  to: string;
}): string => graphEdgeId(edge.from, edge.kind, edge.to);

const graphIdExists = (
  graphId: string,
  snapshot: Pick<GraphSnapshot, "nodes" | "edges">,
): { exists: boolean; malformed: boolean } => {
  if (graphId.startsWith("edge:")) {
    const parts = graphId.slice("edge:".length).split("|");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      return { exists: false, malformed: true };
    }
    return {
      exists: snapshot.edges.some(
        (edge) => graphEdgeId(edge.from, edge.kind, edge.to) === graphId,
      ),
      malformed: false,
    };
  }
  if (graphId.startsWith("node:")) {
    const nodeId = graphId.slice("node:".length);
    if (nodeId.length === 0) return { exists: false, malformed: true };
    return {
      exists: snapshot.nodes.some(
        (node) => node.id === nodeId || node.stableKey === nodeId,
      ),
      malformed: false,
    };
  }
  return {
    exists: snapshot.nodes.some(
      (node) => node.id === graphId || node.stableKey === graphId,
    ),
    malformed: false,
  };
};

const compareDiagnostics = (
  left: AdrReferenceDiagnostic,
  right: AdrReferenceDiagnostic,
): number => {
  const leftKey = `${left.referenceId ?? ""}\u0000${left.file ?? ""}\u0000${left.graphId ?? ""}\u0000${left.code}`;
  const rightKey = `${right.referenceId ?? ""}\u0000${right.file ?? ""}\u0000${right.graphId ?? ""}\u0000${right.code}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
};

export const validateAdrReferences = (
  document: AdrReferenceDocument,
  options: AdrReferenceValidationOptions = {},
): AdrReferenceValidationResult => {
  const diagnostics: AdrReferenceDiagnostic[] = [];
  const resolvedRoot = options.root ? realpathSync(options.root) : undefined;
  const coveredGraphIds = new Set<string>();

  for (const reference of document.references) {
    if (resolvedRoot) {
      let filePath: string;
      try {
        filePath = containedPath(
          resolvedRoot,
          reference.file,
          `ADR file for ${reference.id}`,
        );
      } catch (error) {
        diagnostics.push({
          code: "ADR_REFERENCE_MISSING_FILE",
          severity: "error",
          referenceId: reference.id,
          file: reference.file,
          message:
            error instanceof Error
              ? error.message
              : `ADR file is unavailable: ${reference.file}`,
        });
        continue;
      }

      let metadata;
      try {
        metadata = lstatSync(filePath);
      } catch {
        diagnostics.push({
          code: "ADR_REFERENCE_MISSING_FILE",
          severity: "error",
          referenceId: reference.id,
          file: reference.file,
          message: `ADR file does not exist: ${reference.file}`,
        });
        continue;
      }
      if (!metadata.isFile() || metadata.size > ADR_DOCUMENT_MAX_BYTES) {
        diagnostics.push({
          code: "ADR_REFERENCE_MALFORMED_FILE",
          severity: "error",
          referenceId: reference.id,
          file: reference.file,
          message: !metadata.isFile()
            ? `ADR path is not a regular file: ${reference.file}`
            : `ADR file exceeds the ${ADR_DOCUMENT_MAX_BYTES} byte limit: ${reference.file}`,
        });
      } else {
        const metadataFromFile = markdownMetadata(
          readFileSync(filePath, "utf8"),
        );
        if (!metadataFromFile.title || !metadataFromFile.status) {
          diagnostics.push({
            code: "ADR_REFERENCE_MALFORMED_FILE",
            severity: "error",
            referenceId: reference.id,
            file: reference.file,
            message: `ADR file must contain a Markdown title and a '- Status:' line: ${reference.file}`,
          });
        } else if (
          metadataFromFile.title !== reference.title ||
          metadataFromFile.status.toLowerCase() !== reference.status
        ) {
          diagnostics.push({
            code: "ADR_REFERENCE_STALE_FILE",
            severity: "error",
            referenceId: reference.id,
            file: reference.file,
            message: `ADR metadata no longer matches ${reference.file}; expected title/status ${JSON.stringify([reference.title, reference.status])}, found ${JSON.stringify([metadataFromFile.title, metadataFromFile.status])}`,
          });
        }
      }
    }

    for (const graphId of reference.graphIds) {
      coveredGraphIds.add(graphId);
      if (!options.snapshot) continue;
      const result = graphIdExists(graphId, options.snapshot);
      if (result.malformed) {
        diagnostics.push({
          code: "ADR_REFERENCE_MALFORMED_GRAPH_ID",
          severity: "error",
          referenceId: reference.id,
          file: reference.file,
          graphId,
          message: `ADR graph ID is malformed: ${graphId}`,
        });
      } else if (!result.exists) {
        diagnostics.push({
          code: "ADR_REFERENCE_STALE_GRAPH_ID",
          severity: "error",
          referenceId: reference.id,
          file: reference.file,
          graphId,
          message: `ADR graph ID is not present in the supplied graph snapshot: ${graphId}`,
        });
      }
    }
  }

  for (const graphId of options.requiredGraphIds ?? []) {
    if (!coveredGraphIds.has(graphId)) {
      diagnostics.push({
        code: "ADR_REFERENCE_MISSING_GRAPH_ID",
        severity: "error",
        graphId,
        message: `no local ADR reference covers required graph ID: ${graphId}`,
      });
    }
  }

  diagnostics.sort(compareDiagnostics);
  return { ok: diagnostics.length === 0, diagnostics };
};

export const serializeAdrReferenceDocument = (value: unknown): string =>
  stableStringify(parseAdrReferenceDocument(value));
