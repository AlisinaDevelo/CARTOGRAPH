import {
  DiagnosticSchema,
  EvidenceSchema,
  GraphEdgeSchema,
  GraphNodeSchema,
  GraphSnapshotSchema,
  GRAPH_SNAPSHOT_SCHEMA_VERSION,
  type Diagnostic,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
} from "./schemas.js";
import { assertSupportedCapabilityRegistryVersion } from "./capabilities.js";
import { ZodError } from "zod";

export type ContractErrorCode = "duplicate" | "conflict";

export interface GraphValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export class GraphValidationError extends Error {
  readonly contract: string;
  readonly code = "invalid" as const;
  readonly issues: readonly GraphValidationIssue[];

  constructor(contract: string, issues: readonly GraphValidationIssue[]) {
    const details = issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "snapshot";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    super(`${contract} validation failed: ${details}`);
    this.name = "GraphValidationError";
    this.contract = contract;
    this.issues = issues;
  }
}

export class GraphContractError extends Error {
  readonly code: ContractErrorCode;

  constructor(code: ContractErrorCode, message: string) {
    super(message);
    this.name = "GraphContractError";
    this.code = code;
  }
}

export class GraphSchemaVersionError extends Error {
  readonly contract: string;
  readonly requestedVersion: unknown;
  readonly supportedVersion: number;

  constructor(
    contract: string,
    requestedVersion: unknown,
    supportedVersion: number,
  ) {
    const renderedVersion =
      typeof requestedVersion === "string"
        ? requestedVersion
        : JSON.stringify(requestedVersion);
    super(
      `unsupported ${contract} schema version ${renderedVersion}; supported version is ${supportedVersion}. Add or run an explicit migration before analysis.`,
    );
    this.name = "GraphSchemaVersionError";
    this.contract = contract;
    this.requestedVersion = requestedVersion;
    this.supportedVersion = supportedVersion;
  }
}

export const assertSupportedSchemaVersion = (
  input: unknown,
  contract: string,
  supportedVersion: number,
): void => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;

  const record = input as Record<string, unknown>;
  const requestedVersion =
    "schemaVersion" in record ? record.schemaVersion : record.version;
  if (requestedVersion !== undefined && requestedVersion !== supportedVersion) {
    throw new GraphSchemaVersionError(
      contract,
      requestedVersion,
      supportedVersion,
    );
  }
};

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareStrings)) {
      if (record[key] !== undefined) result[key] = canonicalValue(record[key]);
    }
    return result;
  }
  return value;
};

export const stableStringify = (value: unknown): string =>
  JSON.stringify(canonicalValue(value)) ?? "null";

const parseContract = <T>(
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

const canonicalizeDateTime = (value: string): string =>
  new Date(value).toISOString();

const canonicalizeEvidenceRecord = (record: Evidence): Evidence => {
  const parsed = parseContract(
    (input) => EvidenceSchema.parse(input),
    record,
    "Evidence",
  );
  return parsed.observedAt
    ? { ...parsed, observedAt: canonicalizeDateTime(parsed.observedAt) }
    : parsed;
};

export const canonicalizeEvidence = (
  evidence: readonly Evidence[],
): Evidence[] =>
  deduplicateRecords(
    evidence.map(canonicalizeEvidenceRecord),
    (record) => record.id,
    "evidence",
  ).sort((left, right) => compareStrings(left.id, right.id));

export const canonicalizeGraphNode = (node: GraphNode): GraphNode =>
  parseContract((input) => GraphNodeSchema.parse(input), node, "GraphNode");

export const canonicalizeGraphEdge = (edge: GraphEdge): GraphEdge => {
  const parsed = parseContract(
    (input) => GraphEdgeSchema.parse(input),
    edge,
    "GraphEdge",
  );
  return { ...parsed, evidence: canonicalizeEvidence(parsed.evidence) };
};

export const canonicalizeDiagnostic = (diagnostic: Diagnostic): Diagnostic => {
  const parsed = parseContract(
    (input) => DiagnosticSchema.parse(input),
    diagnostic,
    "Diagnostic",
  );
  return { ...parsed, evidence: canonicalizeEvidence(parsed.evidence) };
};

const deduplicateRecords = <T>(
  records: readonly T[],
  identity: (record: T) => string,
  label: string,
): T[] => {
  const seen = new Map<string, T>();
  for (const record of records) {
    const key = identity(record);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, record);
      continue;
    }

    if (stableStringify(existing) !== stableStringify(record)) {
      throw new GraphContractError(
        "conflict",
        `conflicting duplicate ${label} for identity ${key}`,
      );
    }
  }
  return [...seen.values()];
};

const canonicalNodes = (nodes: readonly GraphNode[]): GraphNode[] => {
  const parsed = nodes.map(canonicalizeGraphNode);
  const byStableKey = deduplicateRecords(
    parsed,
    (node) => node.stableKey,
    "node",
  );
  const byId = new Map<string, GraphNode>();

  for (const node of byStableKey) {
    const existing = byId.get(node.id);
    if (existing && existing.stableKey !== node.stableKey) {
      throw new GraphContractError(
        "conflict",
        `conflicting duplicate node for identity ${node.id}`,
      );
    }
    byId.set(node.id, node);
  }

  return byStableKey.sort((left, right) => {
    const stableKeyOrder = compareStrings(left.stableKey, right.stableKey);
    return stableKeyOrder === 0
      ? compareStrings(left.id, right.id)
      : stableKeyOrder;
  });
};

const edgeIdentity = (edge: Pick<GraphEdge, "from" | "to" | "kind">): string =>
  stableStringify([edge.from, edge.to, edge.kind]);

const canonicalEdges = (edges: readonly GraphEdge[]): GraphEdge[] => {
  const parsed = edges.map(canonicalizeGraphEdge);
  return deduplicateRecords(parsed, edgeIdentity, "edge").sort((left, right) =>
    compareStrings(edgeIdentity(left), edgeIdentity(right)),
  );
};

const canonicalDiagnostics = (
  diagnostics: readonly Diagnostic[],
): Diagnostic[] =>
  deduplicateRecords(
    diagnostics.map(canonicalizeDiagnostic),
    (diagnostic) => diagnostic.id,
    "diagnostic",
  ).sort((left, right) => compareStrings(left.id, right.id));

const validateGlobalEvidenceIdentity = (
  edges: readonly GraphEdge[],
  diagnostics: readonly Diagnostic[],
): void => {
  const evidenceById = new Map<string, Evidence>();
  const allEvidence = [
    ...edges.flatMap((edge) => edge.evidence),
    ...diagnostics.flatMap((diagnostic) => diagnostic.evidence),
  ];

  for (const evidence of allEvidence) {
    const existing = evidenceById.get(evidence.id);
    if (existing && stableStringify(existing) !== stableStringify(evidence)) {
      throw new GraphContractError(
        "conflict",
        `conflicting duplicate evidence for identity ${evidence.id}`,
      );
    }
    evidenceById.set(evidence.id, evidence);
  }
};

export const canonicalizeGraphSnapshot = (input: unknown): GraphSnapshot => {
  assertSupportedSchemaVersion(
    input,
    "GraphSnapshot",
    GRAPH_SNAPSHOT_SCHEMA_VERSION,
  );
  assertSupportedCapabilityRegistryVersion(input);
  const parsed = parseContract(
    (value) => GraphSnapshotSchema.parse(value),
    input,
    "GraphSnapshot",
  );
  const nodes = canonicalNodes(parsed.nodes);
  const edges = canonicalEdges(parsed.edges);
  const diagnostics = canonicalDiagnostics(parsed.diagnostics);
  validateGlobalEvidenceIdentity(edges, diagnostics);

  return {
    ...parsed,
    revision: {
      ...parsed.revision,
      ...(parsed.revision.authoredAt
        ? { authoredAt: canonicalizeDateTime(parsed.revision.authoredAt) }
        : {}),
    },
    nodes,
    edges,
    diagnostics,
  };
};

export const parseGraphSnapshot = (input: unknown): GraphSnapshot =>
  canonicalizeGraphSnapshot(input);

export const createGraphSnapshot = (input: unknown): GraphSnapshot =>
  canonicalizeGraphSnapshot(input);

export const serializeGraphSnapshot = (snapshot: unknown): string =>
  stableStringify(canonicalizeGraphSnapshot(snapshot));
