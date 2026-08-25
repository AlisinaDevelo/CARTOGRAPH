import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

import { Node, SyntaxKind, type Expression, type SourceFile } from "ts-morph";

import type { ResourceLimits } from "../core/index.js";
import { ResourceLimitError } from "../resources.js";

export const API_BOUNDARY_DETECTOR = "cartograph.typescript-api@1";

const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

const GRAPHQL_FACTORY_NAMES = new Set([
  "buildASTSchema",
  "buildSchema",
  "makeExecutableSchema",
]);

const GRAPHQL_TAG_NAMES = new Set(["gql", "graphql", "graphqlTag"]);

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".cartograph",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "vendor",
]);

type ApiSchemaKind = "graphql" | "openapi";

export type ApiSource = {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly contentHash: string;
};

export type ApiBoundary = {
  readonly schema: ApiSchemaKind;
  readonly stableKey: string;
  readonly name: string;
  readonly source: ApiSource;
  readonly operationKey: string;
  readonly method?: string;
  readonly path?: string;
  readonly handlerName?: string;
};

export type ApiResolverBinding = {
  readonly operationKey: string;
  readonly expression: Expression;
  readonly source: ApiSource;
};

export type ApiPartialDiagnosticCode =
  | "PARTIAL_API_SCHEMA_GENERATION"
  | "PARTIAL_API_SCHEMA_ALIAS"
  | "PARTIAL_RUNTIME_COMPOSED_ROUTE";

export type ApiPartialDiagnostic = {
  readonly code: ApiPartialDiagnosticCode;
  readonly source: ApiSource;
  readonly detail?: string;
};

export type ApiBoundaryDiscovery = {
  readonly boundaries: readonly ApiBoundary[];
  readonly resolverBindings: ReadonlyMap<string, ApiResolverBinding>;
  readonly diagnostics: readonly ApiPartialDiagnostic[];
  readonly fileHashes: ReadonlyMap<string, string>;
};

type JsonRecord = Record<string, unknown>;

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hashBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const normalizePath = (value: string): string =>
  value.normalize("NFC").replaceAll(sep, "/");

const relativePath = (rootDir: string, candidate: string): string => {
  const normalized = normalizePath(relative(rootDir, candidate));
  return normalized.length > 0 ? normalized : ".";
};

const countCharacter = (value: string, character: string): number =>
  [...value].filter((candidate) => candidate === character).length;

const lineAndColumnAt = (
  text: string,
  index: number,
): { line: number; column: number } => {
  const prefix = text.slice(0, Math.max(0, index));
  const line = prefix.split(/\r?\n/u).length;
  const lastBreak = Math.max(
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf("\r"),
  );
  return { line, column: prefix.length - lastBreak };
};

const sourceAt = (
  path: string,
  contentHash: string,
  text: string,
  index: number,
): ApiSource => {
  const location = lineAndColumnAt(text, index);
  return {
    path,
    line: location.line,
    column: location.column,
    contentHash,
  };
};

const sourceFromNode = (
  rootDir: string,
  node: Node,
  contentHash?: string,
): ApiSource => {
  const sourceFile = node.getSourceFile();
  const fullText = sourceFile.getFullText();
  const location = sourceFile.getLineAndColumnAtPos(node.getStart());
  return {
    path: relativePath(rootDir, sourceFile.getFilePath()),
    line: location.line,
    column: location.column,
    contentHash: contentHash ?? hashBytes(Buffer.from(fullText)),
  };
};

const propertyName = (node: Node): string | undefined => {
  if (Node.isPropertyAssignment(node) || Node.isMethodDeclaration(node)) {
    const nameNode = node.getNameNode();
    if (Node.isIdentifier(nameNode) || Node.isStringLiteral(nameNode))
      return nameNode.getText().replace(/^['"]|['"]$/gu, "");
  }
  if (Node.isShorthandPropertyAssignment(node)) return node.getName();
  return undefined;
};

const literalText = (node: Node | undefined): string | undefined => {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
    return node.getLiteralValue();
  return undefined;
};

const scalarText = (value: string): string => {
  const withoutComment = value.replace(/\s+#.*$/u, "").trim();
  if (
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  )
    return withoutComment.slice(1, -1);
  return withoutComment;
};

const addBoundary = (
  boundaries: Map<string, ApiBoundary>,
  boundary: ApiBoundary,
): void => {
  if (!boundaries.has(boundary.stableKey))
    boundaries.set(boundary.stableKey, boundary);
};

const parseGraphqlText = (
  boundaries: Map<string, ApiBoundary>,
  text: string,
  path: string,
  contentHash: string,
  sourceFactory: (index: number) => ApiSource,
): void => {
  const rootTypes = new Set(["Query", "Mutation", "Subscription"]);
  for (const match of text.matchAll(
    /(?:schema|extend\s+schema)\s*\{([\s\S]*?)\}/gu,
  )) {
    const body = match[1] ?? "";
    for (const rootMatch of body.matchAll(
      /\b(query|mutation|subscription)\s*:\s*([_A-Za-z][_0-9A-Za-z]*)/gu,
    )) {
      const rootType = rootMatch[2];
      if (rootType) rootTypes.add(rootType);
    }
  }

  const lines = text.split(/\r?\n/u);
  let currentType: string | undefined;
  let braceDepth = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex] ?? "";
    const line = rawLine.replace(/#[^\n]*$/u, "");
    const typeMatch = line.match(
      /^\s*(?:extend\s+)?type\s+([_A-Za-z][_0-9A-Za-z]*)[^{}]*\{/u,
    );
    let fieldText = line;
    if (typeMatch) {
      const typeName = typeMatch[1];
      if (!typeName) continue;
      currentType = typeName;
      const openIndex = line.indexOf("{");
      fieldText = openIndex >= 0 ? line.slice(openIndex + 1) : "";
      braceDepth = countCharacter(line, "{") - countCharacter(line, "}");
    } else if (!currentType) {
      continue;
    }

    if (rootTypes.has(currentType)) {
      const fieldPattern =
        /(?:^|[,{}])\s*([_A-Za-z][_0-9A-Za-z]*)\s*(?:\([^)]*\))?\s*:/gu;
      for (const fieldMatch of fieldText.matchAll(fieldPattern)) {
        const fieldName = fieldMatch[1];
        if (!fieldName || !currentType) continue;
        const matchIndex = fieldMatch.index ?? 0;
        const fieldOffset =
          lineIndex === 0
            ? matchIndex
            : lines.slice(0, lineIndex).join("\n").length + 1 + matchIndex;
        const source = sourceFactory(fieldOffset);
        const operationKey = `${currentType}.${fieldName}`;
        addBoundary(boundaries, {
          schema: "graphql",
          stableKey: `endpoint:graphql:${operationKey}`,
          name: operationKey,
          operationKey,
          source,
        });
      }
    }

    if (!typeMatch)
      braceDepth +=
        countCharacter(fieldText, "{") - countCharacter(fieldText, "}");
    if (braceDepth <= 0) currentType = undefined;
  }
  void path;
  void contentHash;
};

const openApiOperation = (
  boundaries: Map<string, ApiBoundary>,
  path: string,
  method: string,
  operation: JsonRecord,
  source: ApiSource,
): void => {
  const normalizedMethod = method.toUpperCase();
  const operationId =
    typeof operation.operationId === "string"
      ? operation.operationId.trim()
      : undefined;
  const handler =
    typeof operation["x-cartograph-handler"] === "string"
      ? operation["x-cartograph-handler"].trim()
      : operationId;
  const operationKey = `${normalizedMethod} ${path}`;
  addBoundary(boundaries, {
    schema: "openapi",
    stableKey: `endpoint:openapi:${normalizedMethod}:${path}`,
    name: operationKey,
    operationKey,
    method: normalizedMethod,
    path,
    source,
    ...(handler ? { handlerName: handler } : {}),
  });
};

const parseOpenApiJson = (
  boundaries: Map<string, ApiBoundary>,
  diagnostics: ApiPartialDiagnostic[],
  document: JsonRecord,
  text: string,
  path: string,
  contentHash: string,
  sourceFactory: (index: number) => ApiSource,
): void => {
  const paths = document.paths;
  if (!isRecord(paths)) return;
  for (const [routePath, item] of Object.entries(paths).sort(
    ([left], [right]) => compareStrings(left, right),
  )) {
    const routeIndex = text.indexOf(JSON.stringify(routePath));
    const routeSource = sourceFactory(routeIndex >= 0 ? routeIndex : 0);
    if (!isRecord(item)) {
      diagnostics.push({
        code: "PARTIAL_API_SCHEMA_ALIAS",
        source: routeSource,
        detail: `OpenAPI path ${routePath} is not a static operation object.`,
      });
      continue;
    }
    if (typeof item.$ref === "string") {
      diagnostics.push({
        code: "PARTIAL_API_SCHEMA_ALIAS",
        source: routeSource,
        detail: `OpenAPI path ${routePath} uses an external or aliased $ref.`,
      });
    }
    for (const [method, operation] of Object.entries(item).sort(
      ([left], [right]) => compareStrings(left, right),
    )) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      if (!isRecord(operation)) continue;
      if (typeof operation.$ref === "string") {
        diagnostics.push({
          code: "PARTIAL_API_SCHEMA_ALIAS",
          source: routeSource,
          detail: `OpenAPI ${method.toUpperCase()} ${routePath} uses an aliased $ref.`,
        });
        continue;
      }
      const methodIndex = text.indexOf(
        JSON.stringify(method),
        routeIndex >= 0 ? routeIndex : 0,
      );
      openApiOperation(
        boundaries,
        routePath,
        method,
        operation,
        sourceFactory(
          methodIndex >= 0 ? methodIndex : routeIndex >= 0 ? routeIndex : 0,
        ),
      );
    }
  }
  void path;
  void contentHash;
};

const parseOpenApiYaml = (
  boundaries: Map<string, ApiBoundary>,
  diagnostics: ApiPartialDiagnostic[],
  text: string,
  path: string,
  contentHash: string,
  sourceFactory: (index: number) => ApiSource,
): void => {
  const lines = text.split(/\r?\n/u);
  const pathsIndent =
    lines.findIndex((line) => /^\s*paths\s*:\s*$/u.test(line)) >= 0
      ? (lines
          .find((line) => /^\s*paths\s*:\s*$/u.test(line))
          ?.match(/^\s*/u)?.[0].length ?? 0)
      : -1;
  if (pathsIndent < 0) return;

  let currentPath: string | undefined;
  let currentPathIndent = -1;
  let currentMethod: string | undefined;
  let currentMethodIndent = -1;
  let operation: JsonRecord | undefined;
  let operationLine = 0;

  const lineOffset = (lineIndex: number): number =>
    lines.slice(0, Math.max(0, lineIndex)).join("\n").length +
    (lineIndex > 0 ? 1 : 0);

  const flush = (): void => {
    if (currentPath && currentMethod && operation) {
      openApiOperation(
        boundaries,
        currentPath,
        currentMethod,
        operation,
        sourceFactory(lineOffset(operationLine)),
      );
    }
    currentMethod = undefined;
    currentMethodIndent = -1;
    operation = undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const indentation = rawLine.length - rawLine.trimStart().length;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (indentation <= pathsIndent && !/^paths\s*:/u.test(trimmed)) {
      if (currentPath) flush();
      currentPath = undefined;
      continue;
    }
    if (indentation <= pathsIndent && /^paths\s*:/u.test(trimmed)) continue;

    const pathMatch = rawLine.match(/^\s*(['"]?)(\/[^:'"]+)\1\s*:\s*$/u);
    if (pathMatch && indentation > pathsIndent) {
      flush();
      currentPath = pathMatch[2];
      currentPathIndent = indentation;
      operationLine = index;
      continue;
    }
    if (!currentPath || indentation <= currentPathIndent) continue;

    const methodMatch = trimmed.match(
      /^(get|post|put|patch|delete|head|options|trace)\s*:\s*$/iu,
    );
    if (methodMatch && indentation > currentPathIndent) {
      flush();
      currentMethod = methodMatch[1]?.toLowerCase();
      currentMethodIndent = indentation;
      operation = {};
      operationLine = index;
      continue;
    }
    if (!currentMethod || !operation || indentation <= currentMethodIndent) {
      if (trimmed.startsWith("$ref:") || trimmed.startsWith("<<:")) {
        diagnostics.push({
          code: "PARTIAL_API_SCHEMA_ALIAS",
          source: sourceFactory(lineOffset(index)),
          detail: `OpenAPI path ${currentPath} uses an aliased YAML reference.`,
        });
      }
      continue;
    }
    const fieldMatch = trimmed.match(/^([^:]+):\s*(.*)$/u);
    if (!fieldMatch) continue;
    const key = fieldMatch[1]?.trim();
    const value = fieldMatch[2] ?? "";
    if (
      key === "$ref" ||
      key === "<<" ||
      value.startsWith("*") ||
      value.startsWith("&")
    ) {
      diagnostics.push({
        code: "PARTIAL_API_SCHEMA_ALIAS",
        source: sourceFactory(lineOffset(index)),
        detail: `OpenAPI ${currentMethod.toUpperCase()} ${currentPath} uses a YAML alias or reference.`,
      });
      continue;
    }
    if (key === "operationId" || key === "x-cartograph-handler")
      operation[key] = scalarText(value);
  }
  flush();
  void path;
  void contentHash;
};

const candidateSchemaKind = (
  path: string,
  text: string,
): ApiSchemaKind | undefined => {
  const extension = extname(path).toLowerCase();
  if (extension === ".graphql" || extension === ".gql") return "graphql";
  if (extension === ".yaml" || extension === ".yml") {
    return /^\s*(?:openapi|swagger)\s*:/mu.test(text) &&
      /^\s*paths\s*:/mu.test(text)
      ? "openapi"
      : undefined;
  }
  if (extension === ".json") {
    const base = path.split(sep).pop()?.toLowerCase() ?? "";
    return /(?:openapi|swagger)/u.test(base) ||
      /"(?:openapi|swagger)"\s*:/u.test(text)
      ? "openapi"
      : undefined;
  }
  return undefined;
};

const walkFiles = (
  rootDir: string,
  resources: ResourceLimits,
  checkBudget: () => void,
): string[] => {
  const directories = [rootDir];
  const files: string[] = [];
  const visited = new Set<string>();
  for (let index = 0; index < directories.length; index += 1) {
    checkBudget();
    const directory = directories[index];
    if (!directory) continue;
    let physical: string;
    try {
      physical = realpathSync(directory);
    } catch {
      continue;
    }
    if (visited.has(physical)) continue;
    visited.add(physical);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort(
        (left, right) => compareStrings(left.name, right.name),
      );
    } catch {
      continue;
    }
    for (const entry of entries) {
      checkBudget();
      if (entry.isSymbolicLink()) continue;
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) directories.push(candidate);
      } else if (entry.isFile()) {
        files.push(candidate);
        if (files.length > resources.maxFiles)
          throw new ResourceLimitError(
            `API boundary discovery exceeded the ${resources.maxFiles} file ceiling`,
          );
      }
    }
  }
  return files.sort((left, right) =>
    compareStrings(relativePath(rootDir, left), relativePath(rootDir, right)),
  );
};

const collectResolverObject = (
  rootDir: string,
  object: Node,
  bindings: Map<string, ApiResolverBinding>,
  diagnostics: ApiPartialDiagnostic[],
): void => {
  if (!Node.isObjectLiteralExpression(object)) return;
  for (const typeProperty of object.getProperties()) {
    const typeName = propertyName(typeProperty);
    if (!typeName) {
      diagnostics.push({
        code: "PARTIAL_API_SCHEMA_ALIAS",
        source: sourceFromNode(rootDir, typeProperty),
        detail: "GraphQL resolver type uses a computed property name.",
      });
      continue;
    }
    let value: Node | undefined;
    if (Node.isPropertyAssignment(typeProperty))
      value = typeProperty.getInitializer();
    if (!value || !Node.isObjectLiteralExpression(value)) continue;
    for (const fieldProperty of value.getProperties()) {
      const fieldName = propertyName(fieldProperty);
      if (!fieldName) {
        diagnostics.push({
          code: "PARTIAL_API_SCHEMA_ALIAS",
          source: sourceFromNode(rootDir, fieldProperty),
          detail: `GraphQL resolver type ${typeName} uses a computed field alias.`,
        });
        continue;
      }
      let expression: Expression | undefined;
      if (Node.isPropertyAssignment(fieldProperty)) {
        const initializer = fieldProperty.getInitializer();
        if (initializer && Node.isExpression(initializer))
          expression = initializer;
      } else if (Node.isShorthandPropertyAssignment(fieldProperty)) {
        expression = fieldProperty.getNameNode();
      }
      if (!expression) continue;
      const operationKey = `${typeName}.${fieldName}`;
      if (bindings.has(operationKey)) {
        diagnostics.push({
          code: "PARTIAL_API_SCHEMA_ALIAS",
          source: sourceFromNode(rootDir, fieldProperty),
          detail: `GraphQL resolver alias ${operationKey} has multiple declarations.`,
        });
        continue;
      }
      bindings.set(operationKey, {
        operationKey,
        expression,
        source: sourceFromNode(rootDir, fieldProperty),
      });
    }
  }
};

const collectTypeScriptBoundaries = (
  rootDir: string,
  sourceFiles: readonly SourceFile[],
  boundaries: Map<string, ApiBoundary>,
  bindings: Map<string, ApiResolverBinding>,
  diagnostics: ApiPartialDiagnostic[],
): void => {
  for (const sourceFile of sourceFiles) {
    const contentHash = hashBytes(Buffer.from(sourceFile.getFullText()));
    for (const variable of sourceFile.getDescendantsOfKind(
      SyntaxKind.VariableDeclaration,
    )) {
      const initializer = variable.getInitializer();
      if (!initializer) continue;
      if (
        Node.isObjectLiteralExpression(initializer) &&
        /resolver/iu.test(variable.getName())
      )
        collectResolverObject(rootDir, initializer, bindings, diagnostics);
    }

    for (const property of sourceFile.getDescendantsOfKind(
      SyntaxKind.PropertyAssignment,
    )) {
      if (propertyName(property)?.toLowerCase() !== "resolvers") continue;
      const initializer = property.getInitializer();
      if (initializer)
        collectResolverObject(rootDir, initializer, bindings, diagnostics);
    }

    for (const tagged of sourceFile.getDescendantsOfKind(
      SyntaxKind.TaggedTemplateExpression,
    )) {
      const tagText = tagged.getTag().getText().split(".").pop() ?? "";
      if (!GRAPHQL_TAG_NAMES.has(tagText)) continue;
      const template = tagged.getTemplate();
      const text = literalText(template);
      if (text === undefined) {
        diagnostics.push({
          code: "PARTIAL_API_SCHEMA_GENERATION",
          source: sourceFromNode(rootDir, tagged, contentHash),
          detail: "GraphQL tagged template is dynamically composed.",
        });
        continue;
      }
      const source = sourceFromNode(rootDir, template, contentHash);
      parseGraphqlText(boundaries, text, source.path, contentHash, (index) => {
        const base = sourceFile.getLineAndColumnAtPos(template.getStart());
        const local = lineAndColumnAt(text, index);
        return {
          path: source.path,
          line: base.line + local.line - 1,
          column:
            local.line === 1 ? base.column + local.column - 1 : local.column,
          contentHash,
        };
      });
    }

    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      const expressionName =
        call.getExpression().getText().split(".").pop() ?? "";
      if (!GRAPHQL_FACTORY_NAMES.has(expressionName)) continue;
      const first = call.getArguments()[0];
      let schemaExpression: Node | undefined = first;
      if (first && Node.isObjectLiteralExpression(first)) {
        const typeDefs = first.getProperty("typeDefs");
        if (Node.isPropertyAssignment(typeDefs))
          schemaExpression = typeDefs.getInitializer();
      }
      const schemaText = literalText(schemaExpression);
      if (schemaText === undefined) {
        diagnostics.push({
          code: "PARTIAL_API_SCHEMA_GENERATION",
          source: sourceFromNode(rootDir, call, contentHash),
          detail: `${expressionName} receives a runtime-composed GraphQL schema.`,
        });
        continue;
      }
      const source = sourceFromNode(
        rootDir,
        schemaExpression ?? call,
        contentHash,
      );
      parseGraphqlText(
        boundaries,
        schemaText,
        source.path,
        contentHash,
        (index) => {
          const base = sourceFile.getLineAndColumnAtPos(
            (schemaExpression ?? call).getStart(),
          );
          const local = lineAndColumnAt(schemaText, index);
          return {
            path: source.path,
            line: base.line + local.line - 1,
            column:
              local.line === 1 ? base.column + local.column - 1 : local.column,
            contentHash,
          };
        },
      );
    }
  }
};

export const discoverApiBoundaries = (
  rootDir: string,
  sourceFiles: readonly SourceFile[],
  resources: ResourceLimits,
  checkBudget: () => void,
): ApiBoundaryDiscovery => {
  const resolvedRoot = realpathSync(resolve(rootDir));
  const boundaries = new Map<string, ApiBoundary>();
  const resolverBindings = new Map<string, ApiResolverBinding>();
  const diagnostics: ApiPartialDiagnostic[] = [];
  const fileHashes = new Map<string, string>();

  collectTypeScriptBoundaries(
    resolvedRoot,
    sourceFiles,
    boundaries,
    resolverBindings,
    diagnostics,
  );
  for (const sourceFile of sourceFiles)
    fileHashes.set(
      relativePath(resolvedRoot, sourceFile.getFilePath()),
      hashBytes(Buffer.from(sourceFile.getFullText())),
    );

  for (const file of walkFiles(resolvedRoot, resources, checkBudget)) {
    checkBudget();
    const extension = extname(file).toLowerCase();
    const base = file.split(sep).pop()?.toLowerCase() ?? "";
    if (
      extension !== ".graphql" &&
      extension !== ".gql" &&
      extension !== ".json" &&
      extension !== ".yaml" &&
      extension !== ".yml"
    )
      continue;
    const metadata = lstatSync(file);
    if (metadata.size > resources.maxFileBytes)
      throw new ResourceLimitError(
        `API schema ${relativePath(resolvedRoot, file)} exceeds the ${resources.maxFileBytes} byte file ceiling`,
      );
    const bytes = readFileSync(file);
    const text = bytes.toString("utf8");
    const kind = candidateSchemaKind(base, text);
    if (!kind) continue;
    const path = relativePath(resolvedRoot, file);
    const contentHash = hashBytes(bytes);
    fileHashes.set(path, contentHash);
    const sourceFactory = (index: number): ApiSource =>
      sourceAt(path, contentHash, text, Math.max(0, index));
    if (kind === "graphql") {
      parseGraphqlText(boundaries, text, path, contentHash, sourceFactory);
      continue;
    }
    if (extension === ".json") {
      try {
        const document = JSON.parse(text) as unknown;
        if (isRecord(document))
          parseOpenApiJson(
            boundaries,
            diagnostics,
            document,
            text,
            path,
            contentHash,
            sourceFactory,
          );
      } catch (error) {
        diagnostics.push({
          code: "PARTIAL_API_SCHEMA_GENERATION",
          source: sourceFactory(0),
          detail: `OpenAPI JSON could not be parsed: ${error instanceof Error ? error.message : "invalid JSON"}.`,
        });
      }
    } else {
      parseOpenApiYaml(
        boundaries,
        diagnostics,
        text,
        path,
        contentHash,
        sourceFactory,
      );
    }
  }

  return {
    boundaries: [...boundaries.values()].sort((left, right) =>
      compareStrings(left.stableKey, right.stableKey),
    ),
    resolverBindings,
    diagnostics: diagnostics.sort((left, right) =>
      compareStrings(
        `${left.source.path}:${left.source.line}:${left.code}:${left.detail ?? ""}`,
        `${right.source.path}:${right.source.line}:${right.code}:${right.detail ?? ""}`,
      ),
    ),
    fileHashes,
  };
};
