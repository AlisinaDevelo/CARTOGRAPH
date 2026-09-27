import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ARCHITECTURE_QUERY_CONTRACT,
  ARCHITECTURE_QUERY_SCHEMA_VERSION,
  executeArchitectureQuery,
  executeGraphQuery,
  serializeArchitectureQueryResult,
  stableStringify,
  type ArchitectureQueryResult,
  type GraphQueryResult,
} from "./core/index.js";
import { loadDiff, loadSnapshot } from "./commands.js";
import {
  renderArchitectureQueryMarkdown,
  renderGraphQueryMarkdown,
} from "./report/query.js";

const MAX_QUERY_FILE_BYTES = 1024 * 1024;

export type QueryFormat = "json" | "markdown";

export type QueryRequest =
  | { kind: "expression"; expression: string }
  | { kind: "file"; path: string }
  | { kind: "cycles"; edgeKinds: readonly string[] }
  | {
      kind: "path";
      from: string;
      to: string;
      edgeKinds: readonly string[];
    };

export type QueryCommandOptions = {
  input: string;
  inputKind: "snapshot" | "diff";
  request: QueryRequest;
  format: QueryFormat;
};

export type QueryCommandResult = {
  output: string;
  matched: number;
  status: string;
};

/**
 * Accept a bare repository-relative module path (`src/app.ts`) wherever a node
 * reference is expected; anything already shaped like a node ID is kept.
 */
export const nodeReference = (value: string): string =>
  /^[a-z_]+:/u.test(value) ? value : `module:${value.replace(/^\.\//u, "")}`;

const readQueryFile = async (path: string): Promise<unknown> => {
  const inputPath = resolve(path);
  const metadata = await stat(inputPath);
  if (!metadata.isFile())
    throw new Error(`query is not a regular file: ${path}`);
  if (metadata.size > MAX_QUERY_FILE_BYTES)
    throw new Error(`query exceeds the 1 MiB input limit: ${path}`);
  const source = await readFile(inputPath, "utf8");
  try {
    return JSON.parse(source) as unknown;
  } catch {
    // Not JSON: treat the file as a text query in the graph query language.
    return source.trim();
  }
};

const architectureQuery = (
  queryId: string,
  body: Record<string, unknown>,
): Record<string, unknown> => ({
  schemaVersion: ARCHITECTURE_QUERY_SCHEMA_VERSION,
  contract: ARCHITECTURE_QUERY_CONTRACT,
  queryId,
  ...body,
});

const architectureMatches = (result: ArchitectureQueryResult): number => {
  switch (result.operation) {
    case "cycles":
      return result.cycles.length;
    case "dependency-path":
      return result.paths.length;
    case "boundary-crossing":
      return result.boundaries.length;
    case "select-edges":
      return result.edges.length;
    default:
      return result.nodes.length;
  }
};

const graphMatches = (result: GraphQueryResult): number =>
  result.target === "changes"
    ? result.changes.length
    : result.target === "edges"
      ? result.edges.length
      : result.nodes.length;

const isArchitectureQuery = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  (value as { contract?: unknown }).contract === ARCHITECTURE_QUERY_CONTRACT;

const runArchitecture = (
  snapshot: unknown,
  query: unknown,
  format: QueryFormat,
): QueryCommandResult => {
  const result = executeArchitectureQuery(snapshot, query);
  return {
    output:
      format === "json"
        ? `${serializeArchitectureQueryResult(result)}\n`
        : renderArchitectureQueryMarkdown(result),
    matched: architectureMatches(result),
    status: result.status,
  };
};

const runGraph = (
  input: unknown,
  query: unknown,
  format: QueryFormat,
): QueryCommandResult => {
  const result = executeGraphQuery(input, query);
  return {
    output:
      format === "json"
        ? `${stableStringify(result)}\n`
        : renderGraphQueryMarkdown(result),
    matched: graphMatches(result),
    status: result.status,
  };
};

export async function runQueryCommand(
  options: QueryCommandOptions,
): Promise<QueryCommandResult> {
  const input =
    options.inputKind === "snapshot"
      ? await loadSnapshot(options.input)
      : await loadDiff(options.input);
  const { request } = options;
  const requireSnapshot = (operation: string): void => {
    if (options.inputKind !== "snapshot")
      throw new Error(`${operation} queries require --snapshot`);
  };

  switch (request.kind) {
    case "expression":
      return runGraph(input, request.expression, options.format);
    case "file": {
      const query = await readQueryFile(request.path);
      if (isArchitectureQuery(query)) {
        requireSnapshot("architecture");
        return runArchitecture(input, query, options.format);
      }
      return runGraph(input, query, options.format);
    }
    case "cycles":
      requireSnapshot("cycle");
      return runArchitecture(
        input,
        architectureQuery("cli-cycles", {
          operation: "cycles",
          selectors: { nodes: [{ kind: "module" }], edges: [] },
          traversal: {
            direction: "forward",
            edgeKinds: request.edgeKinds,
            includeUnresolved: false,
          },
        }),
        options.format,
      );
    case "path":
      requireSnapshot("dependency-path");
      return runArchitecture(
        input,
        architectureQuery("cli-dependency-path", {
          operation: "dependency-path",
          path: {
            from: nodeReference(request.from),
            to: nodeReference(request.to),
            edgeKinds: request.edgeKinds,
          },
        }),
        options.format,
      );
  }
}
