import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { z, ZodError } from "zod";

import {
  canonicalizeGraphSnapshot,
  GraphValidationError,
  stableStringify,
} from "./canonical.js";
import { canonicalizeGraphDiff } from "./diff.js";
import type {
  ChangedDiagnostic,
  ChangedEdge,
  ChangedNode,
  Diagnostic,
  Evidence,
  GraphDiff,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  RewiredEdge,
} from "./schemas.js";
import { GraphEdgeSchema, GraphNodeSchema } from "./schemas.js";
import { ResourceLimitError, createResourceBudget } from "../resources.js";

/** Version of the portable text query language and its normalized AST. */
export const GRAPH_QUERY_LANGUAGE_SCHEMA_VERSION = 1 as const;
export const GRAPH_QUERY_LANGUAGE_CONTRACT =
  "cartograph.graph-query-language" as const;
export const GRAPH_QUERY_LANGUAGE_MEDIA_TYPE =
  "application/vnd.cartograph.graph-query;version=1" as const;

const MAX_QUERY_TEXT_LENGTH = 16_384;
const MAX_QUERY_PREDICATES = 64;
const MAX_QUERY_VALUES = 32;
const MAX_QUERY_IDENTIFIER_LENGTH = 160;
const MAX_QUERY_VALUE_LENGTH = 512;
const MAX_QUERY_RESULT_BYTES = 16 * 1024 * 1024;

const NODE_KINDS = [
  "endpoint",
  "module",
  "package",
  "service",
  "function",
  "database_table",
  "queue",
  "external_service",
  "file",
  "unknown",
] as const;
const EDGE_KINDS = [
  "calls",
  "imports",
  "reads",
  "writes",
  "publishes",
  "subscribes",
  "requests",
  "contains",
  "routes_to",
  "depends_on",
  "implements",
  "unknown",
] as const;
const CONFIDENCES = [
  "certain",
  "inferred",
  "observed",
  "user_confirmed",
] as const;
const CHANGE_KINDS = [
  "node-added",
  "node-removed",
  "node-changed",
  "edge-added",
  "edge-removed",
  "edge-changed",
  "edge-rewired",
  "diagnostic-added",
  "diagnostic-removed",
  "diagnostic-changed",
  "identity-matched",
  "identity-ambiguous",
  "identity-unsupported",
] as const;

const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_QUERY_IDENTIFIER_LENGTH)
  .regex(
    /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u,
    "must be a portable lower-case identifier",
  );
const QueryValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_QUERY_VALUE_LENGTH)
  .refine(
    (value) =>
      !value.includes("\0") && !value.includes("\r") && !value.includes("\n"),
    "must not contain control characters",
  );
const PortablePathSchema = QueryValueSchema.refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z][A-Za-z\d+.-]*:/.test(value) &&
    !value.split("/").some((part) => part === ".."),
  "must be a repository-relative path",
);

const DEFAULT_EDGE_KINDS = [...EDGE_KINDS] as (typeof EDGE_KINDS)[number][];
const DEFAULT_TRAVERSAL = {
  enabled: false,
  direction: "forward" as const,
  edgeKinds: DEFAULT_EDGE_KINDS,
  maxDepth: 0,
  includeUnresolved: true,
};
const DEFAULT_LIMITS = {
  maxDepth: 64,
  maxNodes: 10_000,
  maxEdges: 20_000,
  maxChanges: 20_000,
  maxTimeMs: 5_000,
  maxResultBytes: 4 * 1024 * 1024,
};

export const GraphQueryTargetSchema = z.enum(["nodes", "edges", "changes"]);
export const GraphQueryPredicateFieldSchema = z.enum([
  "kind",
  "node.kind",
  "edge.kind",
  "id",
  "stableKey",
  "name",
  "language",
  "from",
  "to",
  "evidence.path",
  "path",
  "confidence",
  "change",
  "change.kind",
  "revision",
]);
export const GraphQueryPredicateOperatorSchema = z.enum([
  "=",
  "!=",
  "^=",
  "in",
  "<",
  "<=",
  ">",
  ">=",
]);

export const GraphQueryPredicateSchema = z
  .object({
    field: GraphQueryPredicateFieldSchema,
    operator: GraphQueryPredicateOperatorSchema,
    values: z.array(QueryValueSchema).min(1).max(MAX_QUERY_VALUES),
  })
  .strict();

export const GraphQueryDirectionSchema = z.enum([
  "forward",
  "reverse",
  "both",
  "downstream",
  "upstream",
]);

export const GraphQueryTraversalSchema = z
  .object({
    enabled: z.boolean().default(false),
    direction: GraphQueryDirectionSchema.default("forward"),
    edgeKinds: z
      .array(z.enum(EDGE_KINDS))
      .min(1)
      .max(EDGE_KINDS.length)
      .refine(
        (values) => new Set(values).size === values.length,
        "edgeKinds must not contain duplicates",
      )
      .default([...EDGE_KINDS]),
    maxDepth: z.number().int().nonnegative().max(64).default(0),
    includeUnresolved: z.boolean().default(true),
  })
  .strict();

export const GraphQueryLimitsSchema = z
  .object({
    maxDepth: z.number().int().nonnegative().max(64).default(64),
    maxNodes: z.number().int().positive().max(100_000).default(10_000),
    maxEdges: z.number().int().positive().max(200_000).default(20_000),
    maxChanges: z.number().int().positive().max(200_000).default(20_000),
    maxTimeMs: z.number().int().positive().max(120_000).default(5_000),
    maxResultBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_QUERY_RESULT_BYTES)
      .default(4 * 1024 * 1024),
  })
  .strict();

export const GraphQueryRevisionSchema = z
  .object({
    from: QueryValueSchema.optional(),
    to: QueryValueSchema.optional(),
    changes: z
      .array(z.enum(CHANGE_KINDS))
      .min(1)
      .max(CHANGE_KINDS.length)
      .refine(
        (values) => new Set(values).size === values.length,
        "changes must not contain duplicates",
      )
      .default([...CHANGE_KINDS]),
  })
  .strict();

export const GraphQuerySchema = z
  .object({
    schemaVersion: z.literal(GRAPH_QUERY_LANGUAGE_SCHEMA_VERSION),
    contract: z.literal(GRAPH_QUERY_LANGUAGE_CONTRACT),
    queryId: IdentifierSchema,
    target: GraphQueryTargetSchema,
    predicates: z
      .array(GraphQueryPredicateSchema)
      .max(MAX_QUERY_PREDICATES)
      .default([]),
    traversal: GraphQueryTraversalSchema.default(DEFAULT_TRAVERSAL),
    revision: GraphQueryRevisionSchema.optional(),
    limits: GraphQueryLimitsSchema.default(DEFAULT_LIMITS),
  })
  .strict()
  .superRefine((query, context) => {
    for (const predicate of query.predicates) {
      if (predicate.field === "evidence.path" || predicate.field === "path") {
        for (const value of predicate.values) {
          const checked = PortablePathSchema.safeParse(value);
          if (!checked.success)
            context.addIssue({
              code: "custom",
              path: ["predicates"],
              message: `evidence.path ${checked.error.issues[0]?.message ?? "must be a repository-relative path"}`,
            });
        }
      }
    }
    if (
      query.traversal.enabled &&
      query.traversal.maxDepth > query.limits.maxDepth
    )
      context.addIssue({
        code: "custom",
        path: ["traversal", "maxDepth"],
        message: "traversal maxDepth cannot exceed the query maxDepth",
      });
  });

export type GraphQueryTarget = z.infer<typeof GraphQueryTargetSchema>;
export type GraphQueryDirection = z.infer<typeof GraphQueryDirectionSchema>;
export type GraphQueryPredicateField = z.infer<
  typeof GraphQueryPredicateFieldSchema
>;
export type GraphQueryPredicateOperator = z.infer<
  typeof GraphQueryPredicateOperatorSchema
>;
export type GraphQueryPredicate = z.infer<typeof GraphQueryPredicateSchema>;
export type GraphQueryTraversal = z.infer<typeof GraphQueryTraversalSchema>;
export type GraphQueryLimits = z.infer<typeof GraphQueryLimitsSchema>;
export type GraphQueryRevision = z.infer<typeof GraphQueryRevisionSchema>;
export type GraphQuery = z.infer<typeof GraphQuerySchema>;
export type GraphQueryChangeKind = (typeof CHANGE_KINDS)[number];

type QueryToken = {
  readonly value: string;
  readonly quoted: boolean;
  readonly offset: number;
};

export type GraphQueryParseErrorCode =
  | "QUERY_PARSE_EMPTY"
  | "QUERY_PARSE_UNEXPECTED_TOKEN"
  | "QUERY_PARSE_MISSING_VALUE"
  | "QUERY_PARSE_INVALID_NUMBER"
  | "QUERY_PARSE_INVALID_FIELD"
  | "QUERY_PARSE_INVALID_VALUE"
  | "QUERY_PARSE_UNTERMINATED_STRING"
  | "QUERY_PARSE_UNSUPPORTED_VERSION"
  | "QUERY_PARSE_TRAILING_INPUT";

/** Stable, location-aware parser failure for the v1 text grammar. */
export class GraphQueryLanguageParseError extends Error {
  readonly code: GraphQueryParseErrorCode;
  readonly offset: number;
  readonly line: number;
  readonly column: number;

  constructor(
    code: GraphQueryParseErrorCode,
    message: string,
    offset: number,
    source: string,
  ) {
    const before = source.slice(0, Math.max(0, offset));
    super(
      `${code} at ${before.split("\n").length}:${offset - before.lastIndexOf("\n")}: ${message}`,
    );
    this.name = "GraphQueryLanguageParseError";
    this.code = code;
    this.offset = offset;
    this.line = before.split("\n").length;
    this.column = offset - before.lastIndexOf("\n");
  }
}

export class GraphQueryLanguageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "GraphQueryLanguageError";
    this.code = code;
  }
}

const tokenise = (source: string): QueryToken[] => {
  if (source.length === 0)
    throw new GraphQueryLanguageParseError(
      "QUERY_PARSE_EMPTY",
      "query text is empty",
      0,
      source,
    );
  if (source.length > MAX_QUERY_TEXT_LENGTH)
    throw new GraphQueryLanguageParseError(
      "QUERY_PARSE_INVALID_VALUE",
      `query text exceeds ${MAX_QUERY_TEXT_LENGTH} characters`,
      MAX_QUERY_TEXT_LENGTH,
      source,
    );
  const tokens: QueryToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === undefined) break;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "#") {
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const start = index;
      index += 1;
      let value = "";
      let closed = false;
      while (index < source.length) {
        const current = source[index];
        if (current === undefined) break;
        if (current === "\\") {
          const next = source[index + 1];
          if (next === undefined) break;
          const escapes: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            "\\": "\\",
            '"': '"',
            "'": "'",
          };
          value += escapes[next] ?? next;
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          closed = true;
          break;
        }
        value += current;
        index += 1;
      }
      if (!closed)
        throw new GraphQueryLanguageParseError(
          "QUERY_PARSE_UNTERMINATED_STRING",
          "quoted value is not terminated",
          start,
          source,
        );
      tokens.push({ value, quoted: true, offset: start });
      continue;
    }
    if (
      source.startsWith("<=", index) ||
      source.startsWith(">=", index) ||
      source.startsWith("!=", index) ||
      source.startsWith("^=", index)
    ) {
      tokens.push({
        value: source.slice(index, index + 2),
        quoted: false,
        offset: index,
      });
      index += 2;
      continue;
    }
    if ("[]=,;<>!^".includes(character)) {
      tokens.push({ value: character, quoted: false, offset: index });
      index += 1;
      continue;
    }
    const start = index;
    while (index < source.length) {
      const current = source[index];
      if (
        current === undefined ||
        /\s/u.test(current) ||
        "[]=,;<>!^#\"'".includes(current)
      )
        break;
      index += 1;
    }
    if (start === index)
      throw new GraphQueryLanguageParseError(
        "QUERY_PARSE_UNEXPECTED_TOKEN",
        `unexpected character ${JSON.stringify(character)}`,
        index,
        source,
      );
    tokens.push({
      value: source.slice(start, index),
      quoted: false,
      offset: start,
    });
  }
  return tokens;
};

const lower = (value: string): string => value.toLowerCase();
const isKeyword = (token: QueryToken | undefined, value: string): boolean =>
  token !== undefined && !token.quoted && lower(token.value) === value;

const confidenceRank = (value: string): number => {
  const ranks: Record<(typeof CONFIDENCES)[number], number> = {
    inferred: 1,
    observed: 2,
    certain: 3,
    user_confirmed: 4,
  };
  return ranks[value as (typeof CONFIDENCES)[number]] ?? -1;
};

const canonicalPredicateField = (
  field: string,
): GraphQueryPredicateField | undefined => {
  const aliases: Record<string, GraphQueryPredicateField> = {
    kind: "kind",
    "node.kind": "node.kind",
    "edge.kind": "edge.kind",
    id: "id",
    stablekey: "stableKey",
    name: "name",
    language: "language",
    from: "from",
    to: "to",
    "evidence.path": "evidence.path",
    path: "path",
    confidence: "confidence",
    change: "change",
    "change.kind": "change.kind",
    revision: "revision",
  };
  return aliases[lower(field)];
};

const canonicalPredicate = (
  target: GraphQueryTarget,
  predicate: GraphQueryPredicate,
): GraphQueryPredicate => {
  let field = predicate.field;
  if (field === "path") field = "evidence.path";
  if (target === "nodes" && field === "node.kind") field = "kind";
  if (target === "edges" && field === "edge.kind") field = "kind";
  return {
    field,
    operator: predicate.operator,
    values:
      predicate.operator === "in"
        ? [...new Set(predicate.values)].sort(compareStrings)
        : [predicate.values[0] as string],
  };
};

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const predicateKey = (predicate: GraphQueryPredicate): string =>
  `${predicate.field}\0${predicate.operator}\0${predicate.values.join("\0")}`;

const normalizeQuery = (
  input: Omit<GraphQuery, "queryId"> & { queryId?: string },
): GraphQuery => {
  const parsed = GraphQuerySchema.parse({
    ...input,
    queryId: input.queryId ?? "query",
  });
  const predicates = [
    ...new Map(
      parsed.predicates.map((predicate) => {
        const canonical = canonicalPredicate(parsed.target, predicate);
        return [predicateKey(canonical), canonical] as const;
      }),
    ).values(),
  ].sort((left, right) =>
    compareStrings(predicateKey(left), predicateKey(right)),
  );
  const traversal = {
    ...parsed.traversal,
    edgeKinds: [...parsed.traversal.edgeKinds].sort(compareStrings),
  };
  const revision =
    parsed.revision === undefined
      ? undefined
      : {
          ...parsed.revision,
          changes: [...parsed.revision.changes].sort(compareStrings),
        };
  const withoutId = {
    ...parsed,
    queryId: undefined,
    predicates,
    traversal,
    ...(revision === undefined ? {} : { revision }),
  };
  const digest = createHash("sha256")
    .update(stableStringify(withoutId))
    .digest("hex");
  const queryId = input.queryId ?? `query-${digest.slice(0, 20)}`;
  return GraphQuerySchema.parse({
    ...parsed,
    queryId,
    predicates,
    traversal,
    ...(revision === undefined ? {} : { revision }),
  });
};

type Parser = {
  readonly source: string;
  readonly tokens: readonly QueryToken[];
  index: number;
};

const parserError = (
  parser: Parser,
  code: GraphQueryParseErrorCode,
  message: string,
  token?: QueryToken,
): never =>
  (() => {
    throw new GraphQueryLanguageParseError(
      code,
      message,
      token?.offset ?? parser.source.length,
      parser.source,
    );
  })();

const peek = (parser: Parser): QueryToken | undefined =>
  parser.tokens[parser.index];
const take = (parser: Parser): QueryToken | undefined => {
  const token = peek(parser);
  if (token !== undefined) parser.index += 1;
  return token;
};

const expectToken = (parser: Parser, expected: string): QueryToken => {
  const token = take(parser);
  if (token === undefined || lower(token.value) !== lower(expected))
    return parserError(
      parser,
      "QUERY_PARSE_UNEXPECTED_TOKEN",
      `expected ${expected}`,
      token,
    );
  return token;
};

const valueToken = (parser: Parser, what: string): QueryToken => {
  const token = take(parser);
  if (
    token === undefined ||
    ["and", "traverse", "revision", "limit", ";"].includes(lower(token.value))
  )
    return parserError(
      parser,
      "QUERY_PARSE_MISSING_VALUE",
      `expected ${what}`,
      token,
    );
  return token;
};

const numberToken = (parser: Parser, what: string): number => {
  const token = valueToken(parser, what);
  if (!/^\d+$/u.test(token.value))
    return parserError(
      parser,
      "QUERY_PARSE_INVALID_NUMBER",
      `${what} must be a non-negative integer`,
      token,
    );
  const value = Number(token.value);
  if (!Number.isSafeInteger(value))
    return parserError(
      parser,
      "QUERY_PARSE_INVALID_NUMBER",
      `${what} is too large`,
      token,
    );
  return value;
};

const consumeEquals = (parser: Parser): void => {
  if (peek(parser)?.value === "=") take(parser);
};

const listValues = (parser: Parser, what: string): string[] => {
  const values: string[] = [];
  const bracketed = peek(parser)?.value === "[";
  if (bracketed) take(parser);
  while (true) {
    const token = valueToken(parser, what);
    values.push(token.value);
    if (values.length > MAX_QUERY_VALUES)
      return parserError(
        parser,
        "QUERY_PARSE_INVALID_VALUE",
        `${what} has too many values`,
        token,
      );
    if (peek(parser)?.value === ",") {
      take(parser);
      continue;
    }
    break;
  }
  if (bracketed) expectToken(parser, "]");
  return values;
};

const parsePredicates = (
  parser: Parser,
  target: GraphQueryTarget,
): GraphQueryPredicate[] => {
  const predicates: GraphQueryPredicate[] = [];
  if (isKeyword(peek(parser), "where")) take(parser);
  while (peek(parser) !== undefined) {
    const current = peek(parser);
    if (
      current === undefined ||
      current.value === ";" ||
      ["traverse", "revision", "limit"].includes(lower(current.value))
    )
      break;
    if (isKeyword(current, "and")) {
      take(parser);
      continue;
    }
    const fieldToken = take(parser);
    if (fieldToken === undefined) break;
    const field = canonicalPredicateField(fieldToken.value);
    if (field === undefined)
      return parserError(
        parser,
        "QUERY_PARSE_INVALID_FIELD",
        `unsupported query field ${fieldToken.value}`,
        fieldToken,
      );
    const operatorToken = take(parser);
    if (operatorToken === undefined)
      return parserError(
        parser,
        "QUERY_PARSE_UNEXPECTED_TOKEN",
        "expected a predicate operator",
        operatorToken,
      );
    let operator = operatorToken.value;
    if (lower(operator) === "in") operator = "in";
    if (
      !(
        GraphQueryPredicateOperatorSchema.options as readonly string[]
      ).includes(operator)
    )
      return parserError(
        parser,
        "QUERY_PARSE_UNEXPECTED_TOKEN",
        `unsupported predicate operator ${operator}`,
        operatorToken,
      );
    const values =
      operator === "in"
        ? listValues(parser, fieldToken.value)
        : [valueToken(parser, fieldToken.value).value];
    predicates.push({
      field,
      operator: operator as GraphQueryPredicateOperator,
      values,
    });
    if (predicates.length > MAX_QUERY_PREDICATES)
      return parserError(
        parser,
        "QUERY_PARSE_INVALID_VALUE",
        `query has more than ${MAX_QUERY_PREDICATES} predicates`,
        fieldToken,
      );
    if (target === "changes" && field === "kind") {
      // `kind` is intentionally retained as a dual semantic/change selector;
      // execution resolves the value against both views.
    }
  }
  return predicates;
};

const parseTraversal = (
  parser: Parser,
  limits: GraphQueryLimits,
): GraphQueryTraversal => {
  expectToken(parser, "traverse");
  let direction: GraphQueryTraversal["direction"] = "forward";
  let maxDepth = 0;
  let edgeKinds: GraphQueryTraversal["edgeKinds"] = [...EDGE_KINDS];
  let includeUnresolved = true;
  const directionToken = peek(parser);
  if (
    directionToken &&
    ["forward", "reverse", "both", "downstream", "upstream"].includes(
      lower(directionToken.value),
    )
  ) {
    direction = take(
      parser,
    )!.value.toLowerCase() as GraphQueryTraversal["direction"];
  }
  while (
    peek(parser) !== undefined &&
    !["revision", "limit", "id", ";"].includes(lower(peek(parser)!.value))
  ) {
    const token = take(parser)!;
    const key = lower(token.value);
    if (key === "depth" || key === "maxdepth") {
      consumeEquals(parser);
      maxDepth = numberToken(parser, "traversal depth");
    } else if (key === "edges" || key === "edgekinds") {
      consumeEquals(parser);
      edgeKinds = listValues(
        parser,
        "edge kind",
      ) as GraphQueryTraversal["edgeKinds"];
    } else if (key === "includeunresolved" || key === "unresolved") {
      consumeEquals(parser);
      const value = lower(valueToken(parser, "includeUnresolved").value);
      if (value !== "true" && value !== "false")
        return parserError(
          parser,
          "QUERY_PARSE_INVALID_VALUE",
          "includeUnresolved must be true or false",
          token,
        );
      includeUnresolved = value === "true";
    } else if (key === "and" || key === ",") {
      continue;
    } else {
      return parserError(
        parser,
        "QUERY_PARSE_UNEXPECTED_TOKEN",
        `unexpected traversal token ${token.value}`,
        token,
      );
    }
  }
  if (maxDepth > limits.maxDepth)
    return parserError(
      parser,
      "QUERY_PARSE_INVALID_VALUE",
      "traversal depth exceeds maxDepth",
      directionToken,
    );
  return {
    enabled: true,
    direction,
    edgeKinds,
    maxDepth,
    includeUnresolved,
  };
};

const parseRevision = (parser: Parser): GraphQueryRevision => {
  expectToken(parser, "revision");
  let from: string | undefined;
  let to: string | undefined;
  let changes: GraphQueryRevision["changes"] = [...CHANGE_KINDS];
  while (
    peek(parser) !== undefined &&
    !["traverse", "limit", "id", ";"].includes(lower(peek(parser)!.value))
  ) {
    const token = take(parser)!;
    const key = lower(token.value);
    if (key === "from" || key === "base") {
      consumeEquals(parser);
      from = valueToken(parser, "revision from").value;
    } else if (key === "to" || key === "head") {
      consumeEquals(parser);
      to = valueToken(parser, "revision to").value;
    } else if (key === "change" || key === "changes") {
      consumeEquals(parser);
      changes = listValues(
        parser,
        "change kind",
      ) as GraphQueryRevision["changes"];
    } else if (key === "and" || key === ",") {
      continue;
    } else {
      return parserError(
        parser,
        "QUERY_PARSE_UNEXPECTED_TOKEN",
        `unexpected revision token ${token.value}`,
        token,
      );
    }
  }
  if (
    from === undefined &&
    to === undefined &&
    changes.length === CHANGE_KINDS.length
  )
    return parserError(
      parser,
      "QUERY_PARSE_MISSING_VALUE",
      "revision requires from, to, or changes",
      peek(parser),
    );
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    changes,
  };
};

const parseLimits = (
  parser: Parser,
  limits: GraphQueryLimits,
): GraphQueryLimits => {
  expectToken(parser, "limit");
  const next = { ...limits };
  while (
    peek(parser) !== undefined &&
    !["traverse", "revision", "id", ";"].includes(lower(peek(parser)!.value))
  ) {
    const token = take(parser)!;
    const keyMap: Record<string, keyof GraphQueryLimits> = {
      depth: "maxDepth",
      maxdepth: "maxDepth",
      nodes: "maxNodes",
      maxnodes: "maxNodes",
      edges: "maxEdges",
      maxedges: "maxEdges",
      changes: "maxChanges",
      maxchanges: "maxChanges",
      time: "maxTimeMs",
      timems: "maxTimeMs",
      bytes: "maxResultBytes",
      resultbytes: "maxResultBytes",
      maxresultbytes: "maxResultBytes",
    };
    const key = keyMap[lower(token.value)];
    if (key === undefined) {
      if (lower(token.value) === "and" || token.value === ",") continue;
      return parserError(
        parser,
        "QUERY_PARSE_UNEXPECTED_TOKEN",
        `unsupported limit ${token.value}`,
        token,
      );
    }
    consumeEquals(parser);
    next[key] = numberToken(parser, token.value);
  }
  return next;
};

/** Parse the v1 text grammar into a normalized, digest-stable AST. */
export const parseGraphQueryLanguage = (source: string): GraphQuery => {
  const tokens = tokenise(source);
  const parser: Parser = { source, tokens, index: 0 };
  if (isKeyword(peek(parser), "query")) take(parser);
  let versionToken = take(parser);
  if (versionToken === undefined)
    return parserError(
      parser,
      "QUERY_PARSE_UNEXPECTED_TOKEN",
      "expected v1 query header",
    );
  if (lower(versionToken.value) === "version") {
    versionToken = take(parser);
    if (versionToken === undefined)
      return parserError(
        parser,
        "QUERY_PARSE_UNEXPECTED_TOKEN",
        "expected query version",
      );
  }
  if (!/^v?\d+$/u.test(versionToken.value))
    return parserError(
      parser,
      "QUERY_PARSE_UNSUPPORTED_VERSION",
      "query must declare version v1",
      versionToken,
    );
  if (versionToken.value.replace(/^v/u, "") !== "1")
    return parserError(
      parser,
      "QUERY_PARSE_UNSUPPORTED_VERSION",
      "only query language version v1 is supported",
      versionToken,
    );
  if (isKeyword(peek(parser), "select")) take(parser);
  const targetToken = take(parser);
  if (targetToken === undefined)
    return parserError(
      parser,
      "QUERY_PARSE_UNEXPECTED_TOKEN",
      "expected nodes, edges, or changes",
    );
  const targetAliases: Record<string, GraphQueryTarget> = {
    node: "nodes",
    nodes: "nodes",
    edge: "edges",
    edges: "edges",
    change: "changes",
    changes: "changes",
    diff: "changes",
  };
  const target = targetAliases[lower(targetToken.value)];
  if (target === undefined)
    return parserError(
      parser,
      "QUERY_PARSE_INVALID_VALUE",
      "target must be nodes, edges, or changes",
      targetToken,
    );
  let queryId: string | undefined;
  if (isKeyword(peek(parser), "id")) {
    take(parser);
    consumeEquals(parser);
    queryId = valueToken(parser, "query id").value;
  }
  const limits = GraphQueryLimitsSchema.parse({});
  let predicates = parsePredicates(parser, target);
  let traversal: GraphQueryTraversal = GraphQueryTraversalSchema.parse({});
  let revision: GraphQueryRevision | undefined;
  while (peek(parser) !== undefined) {
    if (peek(parser)?.value === ";") {
      take(parser);
      continue;
    }
    const key = lower(peek(parser)!.value);
    if (key === "traverse") {
      traversal = parseTraversal(parser, limits);
    } else if (key === "revision") {
      revision = parseRevision(parser);
    } else if (key === "limit") {
      const parsedLimits = parseLimits(parser, limits);
      Object.assign(limits, parsedLimits);
      if (traversal.enabled && traversal.maxDepth > limits.maxDepth)
        return parserError(
          parser,
          "QUERY_PARSE_INVALID_VALUE",
          "traversal depth exceeds maxDepth",
          peek(parser),
        );
    } else if (key === "where") {
      predicates = [...predicates, ...parsePredicates(parser, target)];
    } else if (key === "id") {
      take(parser);
      consumeEquals(parser);
      queryId = valueToken(parser, "query id").value;
    } else {
      return parserError(
        parser,
        "QUERY_PARSE_TRAILING_INPUT",
        `unexpected token ${peek(parser)!.value}`,
        peek(parser),
      );
    }
  }
  try {
    return normalizeQuery({
      schemaVersion: GRAPH_QUERY_LANGUAGE_SCHEMA_VERSION,
      contract: GRAPH_QUERY_LANGUAGE_CONTRACT,
      ...(queryId === undefined ? {} : { queryId }),
      target,
      predicates,
      traversal,
      ...(revision === undefined ? {} : { revision }),
      limits,
    });
  } catch (error) {
    if (error instanceof ZodError)
      return parserError(
        parser,
        "QUERY_PARSE_INVALID_VALUE",
        error.issues.map((issue) => issue.message).join("; "),
        peek(parser),
      );
    throw error;
  }
};

const parseStructuredQuery = (input: unknown): GraphQuery => {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("query must be a text string or object");
    const record = input as Record<string, unknown>;
    if (record.contract !== GRAPH_QUERY_LANGUAGE_CONTRACT)
      throw new Error(`expected contract ${GRAPH_QUERY_LANGUAGE_CONTRACT}`);
    return normalizeQuery(
      record as Omit<GraphQuery, "queryId"> & { queryId?: string },
    );
  } catch (error) {
    if (error instanceof ZodError)
      throw new GraphValidationError(
        "GraphQuery",
        error.issues.map((issue) => ({
          path: issue.path.map((part) =>
            typeof part === "symbol" ? part.toString() : part,
          ),
          message: issue.message,
        })),
      );
    if (error instanceof Error)
      throw new GraphQueryLanguageError("QUERY_INVALID", error.message);
    throw error;
  }
};

/** Parse either the portable v1 text grammar or its normalized object form. */
export const parseGraphQuery = (input: unknown): GraphQuery =>
  typeof input === "string"
    ? parseGraphQueryLanguage(input)
    : parseStructuredQuery(input);

/** Serialize a query as its canonical, versioned JSON AST. */
export const serializeGraphQuery = (input: unknown): string =>
  stableStringify(parseGraphQuery(input));

const evidencePathValues = (evidence: readonly Evidence[]): string[] =>
  evidence.flatMap((item) =>
    [item.path, item.location?.path].filter(
      (value): value is string => value !== undefined,
    ),
  );

type QueryChange = {
  readonly id: string;
  readonly kind: GraphQueryChangeKind;
  readonly revision: "from" | "to" | "both";
  readonly nodeKind?: GraphNode["kind"];
  readonly edgeKind?: GraphEdge["kind"];
  readonly confidence?: GraphEdge["confidence"];
  readonly evidencePaths: readonly string[];
  readonly node?: GraphNode;
  readonly beforeNode?: GraphNode;
  readonly afterNode?: GraphNode;
  readonly edge?: GraphEdge;
  readonly beforeEdge?: GraphEdge;
  readonly afterEdge?: GraphEdge;
  readonly diagnostic?: Diagnostic;
};

export const GraphQueryChangeSchema = z
  .object({
    id: QueryValueSchema,
    kind: z.enum(CHANGE_KINDS),
    revision: z.enum(["from", "to", "both"]),
    nodeKind: z.enum(NODE_KINDS).optional(),
    edgeKind: z.enum(EDGE_KINDS).optional(),
    confidence: z.enum(CONFIDENCES).optional(),
    evidencePaths: z.array(PortablePathSchema).default([]),
    node: z.unknown().optional(),
    beforeNode: z.unknown().optional(),
    afterNode: z.unknown().optional(),
    edge: z.unknown().optional(),
    beforeEdge: z.unknown().optional(),
    afterEdge: z.unknown().optional(),
    diagnostic: z.unknown().optional(),
  })
  .strict();

export type GraphQueryChangeRecord = z.infer<typeof GraphQueryChangeSchema>;

export const GraphQueryDiagnosticSchema = z
  .object({
    id: QueryValueSchema,
    code: z.string().min(1).max(160),
    severity: z.enum(["info", "warning", "error"]),
    message: QueryValueSchema,
    limit: z
      .enum([
        "maxDepth",
        "maxNodes",
        "maxEdges",
        "maxChanges",
        "maxTimeMs",
        "maxResultBytes",
      ])
      .optional(),
  })
  .strict();

export const GraphQueryResultSchema = z
  .object({
    schemaVersion: z.literal(GRAPH_QUERY_LANGUAGE_SCHEMA_VERSION),
    contract: z.literal(GRAPH_QUERY_LANGUAGE_CONTRACT),
    queryId: IdentifierSchema,
    target: GraphQueryTargetSchema,
    status: z.enum(["ok", "resource-limit", "invalid"]),
    query: GraphQuerySchema,
    snapshotRevision: QueryValueSchema.optional(),
    revisions: z
      .object({ from: QueryValueSchema, to: QueryValueSchema })
      .strict()
      .optional(),
    nodes: z.array(GraphNodeSchema).default([]),
    edges: z.array(GraphEdgeSchema).default([]),
    changes: z.array(GraphQueryChangeSchema).default([]),
    diagnostics: z.array(GraphQueryDiagnosticSchema).default([]),
    truncated: z.boolean().default(false),
  })
  .strict();

export type GraphQueryDiagnostic = z.infer<typeof GraphQueryDiagnosticSchema>;
export type GraphQueryResult = z.infer<typeof GraphQueryResultSchema>;

const compareNodes = (left: GraphNode, right: GraphNode): number => {
  const stable = compareStrings(left.stableKey, right.stableKey);
  return stable === 0 ? compareStrings(left.id, right.id) : stable;
};
const compareEdges = (
  left: Pick<GraphEdge, "from" | "to" | "kind">,
  right: Pick<GraphEdge, "from" | "to" | "kind">,
): number =>
  compareStrings(
    `${left.from}\0${left.to}\0${left.kind}`,
    `${right.from}\0${right.to}\0${right.kind}`,
  );

const edgeKey = (edge: Pick<GraphEdge, "from" | "to" | "kind">): string =>
  `${edge.from}\0${edge.to}\0${edge.kind}`;

const diagnostic = (
  code: string,
  message: string,
  severity: GraphQueryDiagnostic["severity"],
  limit?: GraphQueryDiagnostic["limit"],
): GraphQueryDiagnostic => ({
  id: `query:${code.toLowerCase()}`,
  code,
  severity,
  message,
  ...(limit === undefined ? {} : { limit }),
});

const emptyResult = (
  query: GraphQuery,
  status: GraphQueryResult["status"],
  diagnostics: readonly GraphQueryDiagnostic[],
  snapshot?: GraphSnapshot,
  diff?: GraphDiff,
): GraphQueryResult =>
  GraphQueryResultSchema.parse({
    schemaVersion: GRAPH_QUERY_LANGUAGE_SCHEMA_VERSION,
    contract: GRAPH_QUERY_LANGUAGE_CONTRACT,
    queryId: query.queryId,
    target: query.target,
    status,
    query,
    ...(snapshot === undefined
      ? {}
      : { snapshotRevision: snapshot.revision.commitSha }),
    ...(diff === undefined
      ? {}
      : {
          revisions: {
            from: diff.fromRevision.commitSha,
            to: diff.toRevision.commitSha,
          },
        }),
    nodes: [],
    edges: [],
    changes: [],
    diagnostics,
    truncated: false,
  });

const normalizeDirection = (
  direction: GraphQueryTraversal["direction"],
): "forward" | "reverse" | "both" =>
  direction === "downstream"
    ? "forward"
    : direction === "upstream"
      ? "reverse"
      : direction;

const predicateMatchesValue = (
  operator: GraphQueryPredicateOperator,
  actual: string | undefined,
  values: readonly string[],
): boolean => {
  if (actual === undefined) return operator === "!=";
  if (operator === "=") return actual === values[0];
  if (operator === "!=") return !values.includes(actual);
  if (operator === "^=")
    return values.some((value) => actual.startsWith(value));
  if (operator === "in") return values.includes(actual);
  const actualRank = confidenceRank(actual);
  const expectedRank = confidenceRank(values[0] ?? "");
  if (actualRank < 0 || expectedRank < 0) return false;
  if (operator === "<") return actualRank < expectedRank;
  if (operator === "<=") return actualRank <= expectedRank;
  if (operator === ">") return actualRank > expectedRank;
  return actualRank >= expectedRank;
};

const nodeMatches = (
  node: GraphNode,
  predicates: readonly GraphQueryPredicate[],
): boolean =>
  predicates.every((predicate) => {
    const field = predicate.field;
    if (
      field === "edge.kind" ||
      field === "from" ||
      field === "to" ||
      field === "confidence" ||
      field === "change" ||
      field === "change.kind" ||
      field === "revision"
    )
      return true;
    const actual =
      field === "kind" || field === "node.kind"
        ? node.kind
        : field === "id"
          ? node.id
          : field === "stableKey"
            ? node.stableKey
            : field === "name"
              ? node.name
              : field === "language"
                ? node.language
                : field === "path" || field === "evidence.path"
                  ? node.location?.path
                  : field === "revision"
                    ? undefined
                    : field === "confidence"
                      ? undefined
                      : undefined;
    return predicateMatchesValue(predicate.operator, actual, predicate.values);
  });

const edgeMatches = (
  edge: GraphEdge,
  predicates: readonly GraphQueryPredicate[],
): boolean =>
  predicates.every((predicate) => {
    const field = predicate.field;
    if (
      field === "node.kind" ||
      field === "id" ||
      field === "stableKey" ||
      field === "name" ||
      field === "language" ||
      field === "change" ||
      field === "change.kind" ||
      field === "revision"
    )
      return true;
    const actual =
      field === "kind" || field === "edge.kind"
        ? edge.kind
        : field === "from"
          ? edge.from
          : field === "to"
            ? edge.to
            : field === "confidence"
              ? edge.confidence
              : field === "path" || field === "evidence.path"
                ? evidencePathValues(edge.evidence)[0]
                : field === "revision"
                  ? undefined
                  : undefined;
    if (field === "path" || field === "evidence.path") {
      const paths = evidencePathValues(edge.evidence);
      if (predicate.operator === "!=")
        return paths.every((path) => !predicate.values.includes(path));
      if (predicate.operator === "=")
        return paths.includes(predicate.values[0] as string);
      if (predicate.operator === "in")
        return paths.some((path) => predicate.values.includes(path));
      if (predicate.operator === "^=")
        return paths.some((path) =>
          predicate.values.some((value) => path.startsWith(value)),
        );
    }
    return predicateMatchesValue(predicate.operator, actual, predicate.values);
  });

const nodePredicatesForTarget = (
  predicates: readonly GraphQueryPredicate[],
  target: GraphQueryTarget,
): readonly GraphQueryPredicate[] =>
  target === "nodes"
    ? predicates
    : predicates.filter((predicate) => predicate.field !== "kind");

const edgePredicatesForTarget = (
  predicates: readonly GraphQueryPredicate[],
  target: GraphQueryTarget,
): readonly GraphQueryPredicate[] =>
  target === "edges"
    ? predicates
    : predicates.filter((predicate) => predicate.field !== "kind");

const traversalEdges = (
  snapshot: GraphSnapshot,
  roots: readonly GraphNode[],
  traversal: GraphQueryTraversal,
  limits: GraphQueryLimits,
  enforce: () => void,
): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } => {
  const direction = normalizeDirection(traversal.direction);
  const directions =
    direction === "both" ? ["forward", "reverse"] : [direction];
  const allowed = new Set(traversal.edgeKinds);
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const nodes = new Map<string, { node: GraphNode; depth: number }>();
  const edges = new Map<string, GraphEdge>();
  let truncated = false;
  for (const root of roots) {
    nodes.set(root.id, { node: root, depth: 0 });
    for (const traversalDirection of directions) {
      const queue: Array<{ id: string; depth: number }> = [
        { id: root.id, depth: 0 },
      ];
      const seen = new Set<string>([root.id]);
      while (queue.length > 0) {
        enforce();
        const current = queue.shift();
        if (current === undefined) break;
        const outgoing = snapshot.edges
          .filter((edge) => allowed.has(edge.kind))
          .filter((edge) =>
            traversalDirection === "forward"
              ? edge.from === current.id
              : edge.to === current.id,
          )
          .sort(compareEdges);
        for (const edge of outgoing) {
          enforce();
          if (edge.evidence.length === 0 && !traversal.includeUnresolved)
            continue;
          const nextId = traversalDirection === "forward" ? edge.to : edge.from;
          const nextDepth = current.depth + 1;
          if (nextDepth > Math.min(traversal.maxDepth, limits.maxDepth)) {
            truncated = true;
            continue;
          }
          edges.set(edgeKey(edge), edge);
          if (!seen.has(nextId)) {
            seen.add(nextId);
            const node = nodeById.get(nextId);
            if (node !== undefined) {
              nodes.set(nextId, {
                node,
                depth: Math.min(
                  nodes.get(nextId)?.depth ?? Number.POSITIVE_INFINITY,
                  nextDepth,
                ),
              });
            }
            if (nodes.size > limits.maxNodes)
              throw new ResourceLimitError(
                `graph query exceeds the ${limits.maxNodes} node ceiling`,
              );
            queue.push({ id: nextId, depth: nextDepth });
          }
          if (edges.size > limits.maxEdges)
            throw new ResourceLimitError(
              `graph query exceeds the ${limits.maxEdges} edge ceiling`,
            );
        }
      }
    }
  }
  return {
    nodes: [...nodes.values()].map((item) => item.node).sort(compareNodes),
    edges: [...edges.values()].sort(compareEdges),
    truncated,
  };
};

const changedNode = (
  kind: GraphQueryChangeKind,
  node: GraphNode,
  revision: "from" | "to",
): QueryChange => ({
  id: `${kind}:${node.stableKey}`,
  kind,
  revision,
  nodeKind: node.kind,
  evidencePaths: node.location === undefined ? [] : [node.location.path],
  node,
  ...(revision === "from" ? { beforeNode: node } : { afterNode: node }),
});

const changedNodePair = (change: ChangedNode): QueryChange => ({
  id: `node-changed:${change.stableKey}`,
  kind: "node-changed",
  revision: "both",
  nodeKind: change.after.kind,
  evidencePaths:
    change.after.location === undefined ? [] : [change.after.location.path],
  node: change.after,
  beforeNode: change.before,
  afterNode: change.after,
});

const changedEdge = (
  kind: GraphQueryChangeKind,
  edge: GraphEdge,
  revision: "from" | "to",
): QueryChange => ({
  id: `${kind}:${edge.from}|${edge.kind}|${edge.to}`,
  kind,
  revision,
  edgeKind: edge.kind,
  confidence: edge.confidence,
  evidencePaths: evidencePathValues(edge.evidence),
  edge,
  ...(revision === "from" ? { beforeEdge: edge } : { afterEdge: edge }),
});

const changedEdgePair = (change: ChangedEdge): QueryChange => ({
  id: `edge-changed:${change.from}|${change.kind}|${change.to}`,
  kind: "edge-changed",
  revision: "both",
  edgeKind: change.after.kind,
  confidence: change.after.confidence,
  evidencePaths: evidencePathValues(change.after.evidence),
  edge: change.after,
  beforeEdge: change.before,
  afterEdge: change.after,
});

const rewiredEdge = (change: RewiredEdge): QueryChange => ({
  id: `edge-rewired:${edgeKey(change.before)}=>${edgeKey(change.after)}`,
  kind: "edge-rewired",
  revision: "both",
  edgeKind: change.after.kind,
  confidence: change.after.confidence,
  evidencePaths: evidencePathValues(change.after.evidence),
  edge: change.after,
  beforeEdge: change.before,
  afterEdge: change.after,
});

const changedDiagnostic = (
  kind: "diagnostic-added" | "diagnostic-removed",
  value: Diagnostic,
  revision: "from" | "to",
): QueryChange => ({
  id: `${kind}:${value.id}`,
  kind,
  revision,
  evidencePaths: evidencePathValues(value.evidence),
  diagnostic: value,
});

const changedDiagnosticPair = (change: ChangedDiagnostic): QueryChange => ({
  id: `diagnostic-changed:${change.id}`,
  kind: "diagnostic-changed",
  revision: "both",
  evidencePaths: evidencePathValues(change.after.evidence),
  diagnostic: change.after,
});

const collectChanges = (diff: GraphDiff): QueryChange[] =>
  [
    ...diff.nodes.added.map((node) => changedNode("node-added", node, "to")),
    ...diff.nodes.removed.map((node) =>
      changedNode("node-removed", node, "from"),
    ),
    ...diff.nodes.changed.map(changedNodePair),
    ...diff.edges.added.map((edge) => changedEdge("edge-added", edge, "to")),
    ...diff.edges.removed.map((edge) =>
      changedEdge("edge-removed", edge, "from"),
    ),
    ...diff.edges.changed.map(changedEdgePair),
    ...diff.edges.rewired.map(rewiredEdge),
    ...diff.diagnostics.added.map((value) =>
      changedDiagnostic("diagnostic-added", value, "to"),
    ),
    ...diff.diagnostics.removed.map((value) =>
      changedDiagnostic("diagnostic-removed", value, "from"),
    ),
    ...diff.diagnostics.changed.map(changedDiagnosticPair),
  ].sort((left, right) =>
    compareStrings(`${left.kind}\0${left.id}`, `${right.kind}\0${right.id}`),
  );

const changeMatches = (
  change: QueryChange,
  predicates: readonly GraphQueryPredicate[],
): boolean =>
  predicates.every((predicate) => {
    const field = predicate.field;
    if (field === "change" || field === "change.kind")
      return predicateMatchesValue(
        predicate.operator,
        change.kind,
        predicate.values,
      );
    if (field === "revision")
      return predicateMatchesValue(
        predicate.operator,
        change.revision,
        predicate.values,
      );
    if (field === "kind") {
      if (
        predicateMatchesValue(predicate.operator, change.kind, predicate.values)
      )
        return true;
      const semantic = change.nodeKind ?? change.edgeKind;
      return predicateMatchesValue(
        predicate.operator,
        semantic,
        predicate.values,
      );
    }
    if (field === "node.kind")
      return predicateMatchesValue(
        predicate.operator,
        change.nodeKind,
        predicate.values,
      );
    if (field === "edge.kind")
      return predicateMatchesValue(
        predicate.operator,
        change.edgeKind,
        predicate.values,
      );
    if (field === "confidence")
      return predicateMatchesValue(
        predicate.operator,
        change.confidence,
        predicate.values,
      );
    if (field === "path" || field === "evidence.path") {
      if (predicate.operator === "!=")
        return change.evidencePaths.every(
          (path) => !predicate.values.includes(path),
        );
      if (predicate.operator === "=")
        return change.evidencePaths.includes(predicate.values[0] as string);
      if (predicate.operator === "in")
        return change.evidencePaths.some((path) =>
          predicate.values.includes(path),
        );
      if (predicate.operator === "^=")
        return change.evidencePaths.some((path) =>
          predicate.values.some((value) => path.startsWith(value)),
        );
      return false;
    }
    return false;
  });

const publicChange = (change: QueryChange): GraphQueryChangeRecord => ({
  id: change.id,
  kind: change.kind,
  revision: change.revision,
  ...(change.nodeKind === undefined ? {} : { nodeKind: change.nodeKind }),
  ...(change.edgeKind === undefined ? {} : { edgeKind: change.edgeKind }),
  ...(change.confidence === undefined ? {} : { confidence: change.confidence }),
  evidencePaths: [...change.evidencePaths].sort(compareStrings),
  ...(change.node === undefined ? {} : { node: change.node }),
  ...(change.beforeNode === undefined ? {} : { beforeNode: change.beforeNode }),
  ...(change.afterNode === undefined ? {} : { afterNode: change.afterNode }),
  ...(change.edge === undefined ? {} : { edge: change.edge }),
  ...(change.beforeEdge === undefined ? {} : { beforeEdge: change.beforeEdge }),
  ...(change.afterEdge === undefined ? {} : { afterEdge: change.afterEdge }),
  ...(change.diagnostic === undefined ? {} : { diagnostic: change.diagnostic }),
});

const matchesRevision = (
  query: GraphQuery,
  snapshot?: GraphSnapshot,
  diff?: GraphDiff,
): GraphQueryDiagnostic | undefined => {
  if (query.revision === undefined) return undefined;
  if (diff === undefined)
    return diagnostic(
      "QUERY_DIFF_REQUIRED",
      "revision clauses require a canonical GraphDiff input",
      "error",
    );
  if (
    query.revision.from !== undefined &&
    query.revision.from !== diff.fromRevision.commitSha
  )
    return diagnostic(
      "QUERY_REVISION_MISMATCH",
      `revision from ${query.revision.from} does not match ${diff.fromRevision.commitSha}`,
      "error",
    );
  if (
    query.revision.to !== undefined &&
    query.revision.to !== diff.toRevision.commitSha
  )
    return diagnostic(
      "QUERY_REVISION_MISMATCH",
      `revision to ${query.revision.to} does not match ${diff.toRevision.commitSha}`,
      "error",
    );
  return undefined;
};

const resourceResult = (
  query: GraphQuery,
  message: string,
  limit: GraphQueryDiagnostic["limit"],
  snapshot?: GraphSnapshot,
  diff?: GraphDiff,
): GraphQueryResult =>
  emptyResult(
    query,
    "resource-limit",
    [diagnostic("QUERY_RESOURCE_LIMIT", message, "error", limit)],
    snapshot,
    diff,
  );

/** Execute a normalized v1 query over one local snapshot and, for changes, a local GraphDiff. */
export const executeGraphQuery = (
  snapshotInput: unknown,
  queryInput: unknown,
  diffInput?: unknown,
): GraphQueryResult => {
  let query: GraphQuery;
  try {
    query = parseGraphQuery(queryInput);
  } catch (error) {
    if (error instanceof GraphQueryLanguageParseError) throw error;
    throw error;
  }

  let snapshot: GraphSnapshot | undefined;
  let diff: GraphDiff | undefined;
  try {
    if (snapshotInput !== undefined && snapshotInput !== null) {
      const candidate = snapshotInput as Record<string, unknown>;
      if (
        candidate.summary !== undefined &&
        candidate.fromRevision !== undefined
      )
        diff = canonicalizeGraphDiff(snapshotInput);
      else snapshot = canonicalizeGraphSnapshot(snapshotInput);
    }
    if (diffInput !== undefined) diff = canonicalizeGraphDiff(diffInput);
  } catch (error) {
    if (error instanceof ZodError)
      throw new GraphValidationError(
        "GraphQueryInput",
        error.issues.map((issue) => ({
          path: issue.path.map((part) =>
            typeof part === "symbol" ? part.toString() : part,
          ),
          message: issue.message,
        })),
      );
    throw error;
  }

  if (query.target === "changes" && diff === undefined)
    return emptyResult(
      query,
      "invalid",
      [
        diagnostic(
          "QUERY_DIFF_REQUIRED",
          "changes queries require a canonical GraphDiff input",
          "error",
        ),
      ],
      snapshot,
      diff,
    );
  if (query.target !== "changes" && snapshot === undefined)
    return emptyResult(
      query,
      "invalid",
      [
        diagnostic(
          "QUERY_SNAPSHOT_REQUIRED",
          "node and edge queries require a canonical GraphSnapshot input",
          "error",
        ),
      ],
      snapshot,
      diff,
    );
  const revisionDiagnostic = matchesRevision(query, snapshot, diff);
  if (revisionDiagnostic !== undefined)
    return emptyResult(query, "invalid", [revisionDiagnostic], snapshot, diff);

  const startedAt = performance.now();
  const budget = createResourceBudget({
    maxWallClockMs: query.limits.maxTimeMs,
    subject: `graph query ${query.queryId}`,
  });
  const enforce = (): void => {
    budget();
    if (performance.now() - startedAt > query.limits.maxTimeMs)
      throw new ResourceLimitError(
        `graph query exceeded the ${query.limits.maxTimeMs} ms time ceiling`,
      );
  };

  try {
    let nodes: GraphNode[] = [];
    let edges: GraphEdge[] = [];
    let changes: GraphQueryChangeRecord[] = [];
    let truncated = false;
    if (query.target === "nodes") {
      const selected = snapshot!.nodes.filter((node) =>
        nodeMatches(
          node,
          nodePredicatesForTarget(query.predicates, query.target),
        ),
      );
      if (query.traversal.enabled) {
        const traversed = traversalEdges(
          snapshot!,
          selected,
          query.traversal,
          query.limits,
          enforce,
        );
        nodes = traversed.nodes;
        edges = traversed.edges.filter((edge) =>
          edgeMatches(
            edge,
            edgePredicatesForTarget(query.predicates, query.target),
          ),
        );
        truncated = traversed.truncated;
      } else nodes = selected.sort(compareNodes);
    } else if (query.target === "edges") {
      edges = snapshot!.edges
        .filter((edge) =>
          edgeMatches(
            edge,
            edgePredicatesForTarget(query.predicates, query.target),
          ),
        )
        .sort(compareEdges);
      const ids = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
      nodes = snapshot!.nodes
        .filter((node) => ids.has(node.id))
        .sort(compareNodes);
      if (query.traversal.enabled) {
        const roots =
          snapshot!.nodes.filter((node) =>
            nodeMatches(
              node,
              nodePredicatesForTarget(query.predicates, query.target),
            ),
          ).length > 0
            ? snapshot!.nodes.filter((node) =>
                nodeMatches(
                  node,
                  nodePredicatesForTarget(query.predicates, query.target),
                ),
              )
            : snapshot!.nodes.filter((node) => ids.has(node.id));
        const traversed = traversalEdges(
          snapshot!,
          roots,
          query.traversal,
          query.limits,
          enforce,
        );
        const allEdges = [...edges, ...traversed.edges].filter((edge) =>
          edgeMatches(
            edge,
            edgePredicatesForTarget(query.predicates, query.target),
          ),
        );
        edges = [
          ...new Map(allEdges.map((edge) => [edgeKey(edge), edge])).values(),
        ].sort(compareEdges);
        const allIds = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
        nodes = snapshot!.nodes
          .filter((node) => allIds.has(node.id))
          .sort(compareNodes);
        truncated = traversed.truncated;
      }
    } else {
      const selected = collectChanges(diff!);
      const allowedChanges = new Set(query.revision?.changes ?? CHANGE_KINDS);
      changes = selected
        .filter(
          (change) =>
            allowedChanges.has(change.kind) &&
            changeMatches(change, query.predicates),
        )
        .map(publicChange);
      if (changes.length > query.limits.maxChanges)
        return resourceResult(
          query,
          `graph query contains ${changes.length} changes, exceeding the ${query.limits.maxChanges} change ceiling`,
          "maxChanges",
          snapshot,
          diff,
        );
      const changedNodes = changes
        .flatMap((change) => [change.node, change.beforeNode, change.afterNode])
        .filter((node): node is GraphNode => node !== undefined);
      const changedEdges = changes
        .flatMap((change) => [change.edge, change.beforeEdge, change.afterEdge])
        .filter((edge): edge is GraphEdge => edge !== undefined);
      nodes = [
        ...new Map(changedNodes.map((node) => [node.id, node])).values(),
      ].sort(compareNodes);
      edges = [
        ...new Map(changedEdges.map((edge) => [edgeKey(edge), edge])).values(),
      ].sort(compareEdges);
    }
    enforce();
    if (nodes.length > query.limits.maxNodes)
      return resourceResult(
        query,
        `graph query contains ${nodes.length} nodes, exceeding the ${query.limits.maxNodes} node ceiling`,
        "maxNodes",
        snapshot,
        diff,
      );
    if (edges.length > query.limits.maxEdges)
      return resourceResult(
        query,
        `graph query contains ${edges.length} edges, exceeding the ${query.limits.maxEdges} edge ceiling`,
        "maxEdges",
        snapshot,
        diff,
      );
    const result = GraphQueryResultSchema.parse({
      schemaVersion: GRAPH_QUERY_LANGUAGE_SCHEMA_VERSION,
      contract: GRAPH_QUERY_LANGUAGE_CONTRACT,
      queryId: query.queryId,
      target: query.target,
      status: "ok",
      query,
      ...(snapshot === undefined
        ? {}
        : { snapshotRevision: snapshot.revision.commitSha }),
      ...(diff === undefined
        ? {}
        : {
            revisions: {
              from: diff.fromRevision.commitSha,
              to: diff.toRevision.commitSha,
            },
          }),
      nodes,
      edges,
      changes,
      diagnostics: truncated
        ? [
            diagnostic(
              "QUERY_TRUNCATED",
              "bounded traversal stopped at its depth limit",
              "warning",
              "maxDepth",
            ),
          ]
        : [],
      truncated,
    });
    if (
      Buffer.byteLength(stableStringify(result), "utf8") >
      query.limits.maxResultBytes
    )
      return resourceResult(
        query,
        `graph query result exceeds the ${query.limits.maxResultBytes} byte output ceiling`,
        "maxResultBytes",
        snapshot,
        diff,
      );
    return result;
  } catch (error) {
    if (error instanceof ResourceLimitError) {
      const message = error.message;
      const limit: GraphQueryDiagnostic["limit"] = /node ceiling/iu.test(
        message,
      )
        ? "maxNodes"
        : /edge ceiling/iu.test(message)
          ? "maxEdges"
          : /time|wall-clock/iu.test(message)
            ? "maxTimeMs"
            : "maxDepth";
      return resourceResult(query, message, limit, snapshot, diff);
    }
    throw error;
  }
};

export const executeArchitectureQueryLanguage = executeGraphQuery;
export const parseArchitectureQueryLanguage = parseGraphQuery;
export const serializeArchitectureQueryLanguage = serializeGraphQuery;
export const GraphQueryLanguageResultSchema = GraphQueryResultSchema;
