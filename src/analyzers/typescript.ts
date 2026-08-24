import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { Node, Project, SyntaxKind, ts } from "ts-morph";
import type {
  ArrowFunction,
  CallExpression,
  Expression,
  FunctionDeclaration,
  FunctionExpression,
  MethodDeclaration,
  SourceFile,
  Symbol,
} from "ts-morph";

import type {
  Diagnostic,
  Evidence,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  Revision,
  SourceLocation,
  ResourceLimits,
} from "../core/index.js";
import { CAPABILITY_REGISTRY_VERSION } from "../core/index.js";

import {
  analyzeExpressRouteCall,
  isPotentialExpressReceiver,
} from "./express.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const EXCLUDED_DIRECTORIES = new Set([
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

const READ_METHODS = new Set([
  "aggregate",
  "count",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "groupBy",
]);
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "delete",
  "deleteMany",
  "update",
  "updateMany",
  "upsert",
]);
const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "request",
]);
const BUILTIN_CALL_ROOTS = new Set([
  "Array",
  "Boolean",
  "Date",
  "Error",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "console",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "setInterval",
  "setTimeout",
  "structuredClone",
  "queueMicrotask",
]);
const FRAMEWORK_CALL_ROOTS = new Set([
  "Router",
  "axios",
  "express",
  "req",
  "request",
  "res",
  "response",
]);

const DETECTOR_VERSION = "cartograph.typescript-express@1";

export interface TypeScriptAnalyzerOptions {
  rootDir: string;
  tsconfigPath?: string;
  include?: readonly string[];
  exclude?: readonly string[];
  extractors?: readonly ("typescript" | "express")[];
  resources?: Partial<ResourceLimits>;
  revision?: Partial<Revision>;
}

export class ResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceLimitError";
  }
}

export type TypeScriptAnalyzerResult = GraphSnapshot;

type FunctionLike =
  ArrowFunction | FunctionDeclaration | FunctionExpression | MethodDeclaration;

interface CallableInfo {
  declarationKeys: Set<string>;
  file: SourceFile;
  graphNode: GraphNode;
  node: FunctionLike;
}

interface AnalyzerContext {
  blockedRelativeImports: Set<string>;
  callablesByDeclaration: Map<string, CallableInfo>;
  callablesByStableKey: Map<string, CallableInfo>;
  diagnostics: Map<string, Diagnostic>;
  edges: Map<string, GraphEdge>;
  fileHashes: Map<string, string>;
  filesByPath: Map<string, SourceFile>;
  nodes: Map<string, GraphNode>;
  project: Project;
  rootDir: string;
  sourcePaths: Set<string>;
  sourceFiles: SourceFile[];
  extractors: ReadonlySet<"typescript" | "express">;
}

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const normalizePath = (value: string): string => value.split(sep).join("/");

const sourceFilePath = (rootDir: string, filePath: string): string => {
  const normalized = normalizePath(relative(rootDir, filePath));
  return normalized.length > 0 ? normalized : basename(filePath);
};

const sourcePosition = (rootDir: string, node: Node): SourceLocation => {
  const sourceFile = node.getSourceFile();
  const lineAndColumn = sourceFile.getLineAndColumnAtPos(node.getStart());
  return {
    path: sourceFilePath(rootDir, sourceFile.getFilePath()),
    line: lineAndColumn.line,
    column: lineAndColumn.column,
  };
};

const hashBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const declarationKey = (node: Node): string =>
  `${node.getSourceFile().getFilePath()}:${node.getKind()}:${node.getPos()}:${node.getEnd()}`;

const edgeKey = (from: string, to: string, kind: GraphEdge["kind"]): string =>
  `${from}\u0000${to}\u0000${kind}`;

const evidenceKey = (
  path: string,
  line: number,
  column: number,
  detector: string,
): string => `source:${path}:${line}:${column}:${detector}`;

const diagnosticKey = (
  code: string,
  location: SourceLocation,
  message: string,
): string =>
  `diagnostic:${code}:${location.path}:${location.line}:${location.column ?? 1}:${hashBytes(
    Buffer.from(message),
  ).slice(0, 16)}`;

const isInsideRoot = (rootDir: string, filePath: string): boolean => {
  const root = resolve(rootDir);
  const candidate = resolve(filePath);
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !relativePath.startsWith(sep))
  );
};

const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxFiles: 20_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxSourceBytes: 64 * 1024 * 1024,
  maxArchiveBytes: 64 * 1024 * 1024,
  maxMemoryBytes: 1024 * 1024 * 1024,
  maxWallClockMs: 30_000,
  maxReportItems: 10_000,
};

const globRegExp = (pattern: string): RegExp => {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character?.replace(/[|\\{}()[\]^$+.*]/gu, "\\$&") ?? "";
    }
  }
  return new RegExp(`${expression}$`, "u");
};

const matchesPathPattern = (pattern: string, path: string): boolean => {
  const normalized = pattern.replaceAll("\\", "/");
  if (normalized === ".") return true;
  if (globRegExp(normalized).test(path)) return true;
  return !/[?*]/u.test(normalized) && path.startsWith(`${normalized}/`);
};

const selectedByPatterns = (
  relativePath: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean =>
  include.some((pattern) => matchesPathPattern(pattern, relativePath)) &&
  !exclude.some((pattern) => matchesPathPattern(pattern, relativePath));

const discoverSourcePaths = (
  rootDir: string,
  include: readonly string[],
  exclude: readonly string[],
  resources: ResourceLimits,
): string[] => {
  const discovered: string[] = [];
  let totalBytes = 0;
  const startedAt = Date.now();

  const checkBudget = (): void => {
    if (Date.now() - startedAt > resources.maxWallClockMs)
      throw new ResourceLimitError(
        `analysis exceeded the ${resources.maxWallClockMs} ms wall-clock ceiling`,
      );
    if (process.memoryUsage().rss > resources.maxMemoryBytes)
      throw new ResourceLimitError(
        `analysis exceeded the ${resources.maxMemoryBytes} byte memory ceiling`,
      );
  };

  const visit = (directory: string): void => {
    checkBudget();
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => compareStrings(left.name, right.name),
    );

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = join(directory, entry.name);
      const relativePath = normalizePath(relative(rootDir, entryPath));

      if (entry.isDirectory()) {
        if (
          !EXCLUDED_DIRECTORIES.has(entry.name) &&
          !exclude.some((pattern) => matchesPathPattern(pattern, relativePath))
        )
          visit(entryPath);
        continue;
      }

      if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(extname(entry.name)) &&
        !entry.name.endsWith(".d.ts") &&
        selectedByPatterns(relativePath, include, exclude)
      ) {
        const bytes = lstatSync(entryPath).size;
        if (bytes > resources.maxFileBytes)
          throw new ResourceLimitError(
            `source file exceeds the ${resources.maxFileBytes} byte file ceiling: ${relativePath}`,
          );
        if (discovered.length >= resources.maxFiles)
          throw new ResourceLimitError(
            `analysis exceeds the ${resources.maxFiles} source-file ceiling`,
          );
        totalBytes += bytes;
        if (totalBytes > resources.maxSourceBytes)
          throw new ResourceLimitError(
            `analysis exceeds the ${resources.maxSourceBytes} byte source ceiling`,
          );
        discovered.push(entryPath);
      }
    }
  };

  visit(rootDir);
  checkBudget();
  return discovered.sort(compareStrings);
};

const localModuleCandidates = (
  containingFile: string,
  specifier: string,
): string[] => {
  const basePath = resolve(dirname(containingFile), specifier);
  const sourceBasePath = basePath.replace(/\.(?:c|m)?jsx?$/iu, "");
  return [
    basePath,
    sourceBasePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.mts`,
    `${basePath}.cts`,
    `${sourceBasePath}.ts`,
    `${sourceBasePath}.tsx`,
    `${sourceBasePath}.mts`,
    `${sourceBasePath}.cts`,
    `${sourceBasePath}.d.ts`,
    join(basePath, "index.ts"),
    join(basePath, "index.tsx"),
    join(basePath, "index.mts"),
    join(basePath, "index.cts"),
    join(basePath, "index.d.ts"),
  ];
};

const isAllowedRelativeModulePath = (
  rootDir: string,
  candidatePath: string,
  sourcePaths: ReadonlySet<string>,
): boolean => {
  if (!isInsideRoot(rootDir, candidatePath)) return false;
  const normalized = resolve(candidatePath);
  if (!existsSync(normalized)) return false;
  let physicalPath: string;
  try {
    physicalPath = realpathSync(normalized);
  } catch {
    return false;
  }
  if (!isInsideRoot(rootDir, physicalPath)) return false;
  const relativePath = relative(rootDir, normalized);
  if (relativePath.split(sep).some((part) => EXCLUDED_DIRECTORIES.has(part))) {
    return false;
  }
  if (normalized.endsWith(".d.ts")) return true;
  return sourcePaths.has(normalized);
};

const findAllowedLocalModule = (
  rootDir: string,
  containingFile: string,
  specifier: string,
  sourcePaths: ReadonlySet<string>,
): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  for (const candidate of localModuleCandidates(containingFile, specifier)) {
    if (
      isAllowedRelativeModulePath(rootDir, candidate, sourcePaths) &&
      existsSync(candidate)
    ) {
      return resolve(candidate);
    }
  }
  return undefined;
};

const moduleExtension = (filePath: string): string => {
  if (filePath.endsWith(".d.ts")) return ts.Extension.Dts;
  switch (extname(filePath)) {
    case ".tsx":
      return ts.Extension.Tsx;
    case ".mts":
      return ts.Extension.Mts;
    case ".cts":
      return ts.Extension.Cts;
    default:
      return ts.Extension.Ts;
  }
};

const projectFor = (
  rootDir: string,
  tsconfigPath: string | undefined,
  sourcePaths: ReadonlySet<string>,
): Project => {
  const configPath = tsconfigPath
    ? resolve(rootDir, tsconfigPath)
    : join(rootDir, "tsconfig.json");
  const resolutionHost = (
    moduleResolutionHost: ts.ModuleResolutionHost,
    getCompilerOptions: () => ts.CompilerOptions,
  ) => ({
    resolveModuleNames: (moduleNames: string[], containingFile: string) =>
      moduleNames.map((moduleName) => {
        if (moduleName.startsWith(".")) {
          const candidate = findAllowedLocalModule(
            rootDir,
            containingFile,
            moduleName,
            sourcePaths,
          );
          if (!candidate) return undefined;
          return {
            resolvedFileName: candidate,
            extension: moduleExtension(candidate),
          } satisfies ts.ResolvedModuleFull;
        }

        return ts.resolveModuleName(
          moduleName,
          containingFile,
          getCompilerOptions(),
          moduleResolutionHost,
        ).resolvedModule;
      }),
  });

  if (existsSync(configPath) && lstatSync(configPath).isFile()) {
    return new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      tsConfigFilePath: configPath,
      resolutionHost,
    });
  }

  return new Project({
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: false,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2023,
    },
    resolutionHost,
  });
};

const resolvedSymbol = (symbol: Symbol | undefined): Symbol | undefined => {
  let current = symbol;
  const seen = new Set<Symbol>();

  while (current && current.isAlias() && !seen.has(current)) {
    seen.add(current);
    const aliased = current.getAliasedSymbol();
    if (!aliased) break;
    current = aliased;
  }

  return current;
};

const symbolDeclarations = (node: Node): Node[] => {
  const symbol = resolvedSymbol(node.getSymbol());
  return symbol?.getDeclarations() ?? [];
};

const relativeImportKey = (sourceFile: SourceFile, specifier: string): string =>
  `${sourceFile.getFilePath()}\u0000${specifier}`;

const importedLocalNames = (declaration: Node): string[] => {
  if (!Node.isImportDeclaration(declaration)) return [];
  const names = [
    declaration.getDefaultImport()?.getText(),
    declaration.getNamespaceImport()?.getText(),
    ...declaration
      .getNamedImports()
      .map(
        (specifier) =>
          specifier.getAliasNode()?.getText() ?? specifier.getName(),
      ),
  ];
  return names.filter((name): name is string => Boolean(name));
};

const expressionRootNode = (expression: Expression): Expression => {
  let current: Node = expression;
  while (
    Node.isPropertyAccessExpression(current) ||
    Node.isElementAccessExpression(current)
  ) {
    current = current.getExpression();
  }
  return current as Expression;
};

const isBlockedImportedReference = (
  context: AnalyzerContext,
  expression: Expression,
): boolean => {
  const root = expressionRootNode(expression);
  if (!Node.isIdentifier(root)) return false;
  const sourceFile = expression.getSourceFile();
  return sourceFile.getImportDeclarations().some((declaration) => {
    const specifier = declaration.getModuleSpecifierValue();
    return (
      specifier.startsWith(".") &&
      context.blockedRelativeImports.has(
        relativeImportKey(sourceFile, specifier),
      ) &&
      importedLocalNames(declaration).includes(root.getText())
    );
  });
};

const declarationsFor = (
  context: AnalyzerContext,
  expression: Expression,
): Node[] =>
  isBlockedImportedReference(context, expression)
    ? []
    : symbolDeclarations(expression);

const declaredCallableName = (
  rootDir: string,
  node: FunctionLike,
  fallback: string,
): string => {
  if (Node.isFunctionDeclaration(node) && node.getName())
    return node.getName() as string;

  if (Node.isMethodDeclaration(node)) return node.getName();

  const variable = node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (variable?.getName()) return variable.getName();

  const location = sourcePosition(rootDir, node);
  return `${fallback}:${location.line}:${location.column ?? 1}`;
};

const lexicalCallableScopes = (
  rootDir: string,
  node: FunctionLike,
): string[] => {
  const scopes: string[] = [];
  let ancestor: Node | undefined = node.getParent();
  while (ancestor && !Node.isSourceFile(ancestor)) {
    if (isCallableNode(ancestor)) {
      const name = declaredCallableName(rootDir, ancestor, "anonymous");
      if (!name.includes(":")) scopes.unshift(name);
    } else if (Node.isClassDeclaration(ancestor)) {
      const name = ancestor.getName();
      if (name) scopes.unshift(name);
    }
    ancestor = ancestor.getParent();
  }
  return scopes;
};

const functionName = (
  rootDir: string,
  node: FunctionLike,
  fallback: string,
): string => {
  return [
    ...lexicalCallableScopes(rootDir, node),
    declaredCallableName(rootDir, node, fallback),
  ].join(".");
};

const isCallableNode = (node: Node): node is FunctionLike =>
  Node.isArrowFunction(node) ||
  Node.isFunctionDeclaration(node) ||
  Node.isFunctionExpression(node) ||
  Node.isMethodDeclaration(node);

const addNode = (
  context: AnalyzerContext,
  stableKey: string,
  kind: GraphNode["kind"],
  name: string,
  location?: SourceLocation,
): GraphNode => {
  const existing = context.nodes.get(stableKey);
  if (existing) return existing;

  const node: GraphNode = {
    id: stableKey,
    stableKey,
    kind,
    name,
    language: "typescript",
    ...(location ? { location } : {}),
  };
  context.nodes.set(stableKey, node);
  return node;
};

const evidenceFor = (
  context: AnalyzerContext,
  node: Node,
  detector: string,
): Evidence => {
  const location = sourcePosition(context.rootDir, node);
  const path = location.path;
  const contentHash = context.fileHashes.get(path);
  const evidence = {
    id: evidenceKey(path, location.line, location.column ?? 1, detector),
    kind: "source" as const,
    path,
    line: location.line,
    ...(location.column ? { column: location.column } : {}),
    detector,
    ...(contentHash ? { contentHash } : {}),
  };
  return evidence as unknown as Evidence;
};

const addDiagnostic = (
  context: AnalyzerContext,
  code: string,
  message: string,
  node: Node,
  severity: Diagnostic["severity"] = "warning",
): void => {
  const location = sourcePosition(context.rootDir, node);
  const evidence = evidenceFor(context, node, `${DETECTOR_VERSION}/diagnostic`);
  const diagnostic: Diagnostic = {
    id: diagnosticKey(code, location, message),
    code,
    severity,
    message,
    location,
    evidence: [evidence],
  };
  context.diagnostics.set(diagnostic.id, diagnostic);
};

const addEdge = (
  context: AnalyzerContext,
  from: GraphNode,
  to: GraphNode,
  kind: GraphEdge["kind"],
  evidence: Evidence,
  confidence: GraphEdge["confidence"] = "certain",
): void => {
  const key = edgeKey(from.id, to.id, kind);
  const existing = context.edges.get(key);
  if (!existing) {
    context.edges.set(key, {
      from: from.id,
      to: to.id,
      kind,
      confidence,
      evidence: [evidence],
    });
    return;
  }

  if (!existing.evidence.some((candidate) => candidate.id === evidence.id)) {
    existing.evidence.push(evidence);
    existing.evidence.sort((left, right) => compareStrings(left.id, right.id));
  }
  if (existing.confidence !== "certain" && confidence === "certain")
    existing.confidence = confidence;
};

const registerCallable = (
  context: AnalyzerContext,
  node: FunctionLike,
  fallbackName = "anonymous",
): CallableInfo => {
  const file = node.getSourceFile();
  const path = sourceFilePath(context.rootDir, file.getFilePath());
  const name = functionName(context.rootDir, node, fallbackName);
  const declarationNodes = [
    node,
    ...(() => {
      const variable = node.getFirstAncestorByKind(
        SyntaxKind.VariableDeclaration,
      );
      return variable ? [variable] : [];
    })(),
    ...symbolDeclarations(node),
  ];
  const uniqueDeclarationNodes = declarationNodes.filter(
    (candidate, index, candidates) =>
      candidates.findIndex(
        (other) => declarationKey(other) === declarationKey(candidate),
      ) === index,
  );

  for (const declaration of uniqueDeclarationNodes) {
    const existing = callableForDeclaration(context, declaration);
    if (existing) {
      for (const candidate of uniqueDeclarationNodes) {
        const key = declarationKey(candidate);
        existing.declarationKeys.add(key);
        context.callablesByDeclaration.set(key, existing);
      }
      return existing;
    }
  }

  const stableBaseKey = `function:${path}:${name}`;
  let stableKey = stableBaseKey;
  const previous = context.callablesByStableKey.get(stableBaseKey);
  if (previous && previous.node !== node) {
    const location = sourcePosition(context.rootDir, node);
    stableKey = `${stableBaseKey}@${location.line}:${location.column ?? 1}`;
    let suffix = 2;
    while (context.callablesByStableKey.has(stableKey)) {
      stableKey = `${stableBaseKey}@${location.line}:${location.column ?? 1}:${suffix}`;
      suffix += 1;
    }
  }
  const graphNode = addNode(
    context,
    stableKey,
    "function",
    name,
    sourcePosition(context.rootDir, node),
  );
  const info: CallableInfo = {
    declarationKeys: new Set(
      uniqueDeclarationNodes.map((declaration) => declarationKey(declaration)),
    ),
    file,
    graphNode,
    node,
  };

  for (const key of info.declarationKeys)
    context.callablesByDeclaration.set(key, info);
  context.callablesByStableKey.set(stableKey, info);
  return info;
};

const registerInlineRouteCallable = (
  context: AnalyzerContext,
  node: FunctionLike,
  method: string,
  path: string,
): CallableInfo => {
  const filePath = sourceFilePath(
    context.rootDir,
    node.getSourceFile().getFilePath(),
  );
  const location = sourcePosition(context.rootDir, node);
  const name = `${method} ${path} handler`;
  const stableKey = `function:${filePath}:route:${method}:${path}:${location.line}:${location.column ?? 1}`;
  const graphNode = addNode(context, stableKey, "function", name, location);
  const info: CallableInfo = {
    declarationKeys: new Set([declarationKey(node)]),
    file: node.getSourceFile(),
    graphNode,
    node,
  };
  for (const key of info.declarationKeys)
    context.callablesByDeclaration.set(key, info);
  context.callablesByStableKey.set(stableKey, info);
  return info;
};

const callableForDeclaration = (
  context: AnalyzerContext,
  node: Node,
): CallableInfo | undefined =>
  context.callablesByDeclaration.get(declarationKey(node));

const resolveCallable = (
  context: AnalyzerContext,
  expression: Expression,
  seen = new Set<Node>(),
): CallableInfo | undefined => {
  if (seen.has(expression) || isBlockedImportedReference(context, expression))
    return undefined;
  seen.add(expression);

  for (const declaration of declarationsFor(context, expression)) {
    const callable = callableForDeclaration(context, declaration);
    if (callable) return callable;
  }

  if (Node.isIdentifier(expression)) {
    const variable = expression
      .getDefinitionNodes()
      .find(Node.isVariableDeclaration);
    if (variable) {
      const callable = callableForDeclaration(context, variable);
      if (callable) return callable;
      const initializer = variable.getInitializer();
      if (initializer && Node.isExpression(initializer)) {
        return resolveCallable(context, initializer, seen);
      }
    }
  }

  return undefined;
};

const enclosingCallable = (
  context: AnalyzerContext,
  node: Node,
): CallableInfo | undefined => {
  let ancestor: Node | undefined = node.getParent();
  while (ancestor && !Node.isSourceFile(ancestor)) {
    if (isCallableNode(ancestor)) {
      const callable = callableForDeclaration(context, ancestor);
      if (callable) return callable;
    }
    ancestor = ancestor.getParent();
  }
  return undefined;
};

const moduleForFile = (
  context: AnalyzerContext,
  file: SourceFile,
): GraphNode => {
  const path = sourceFilePath(context.rootDir, file.getFilePath());
  return addNode(context, `module:${path}`, "module", path, {
    path,
    line: 1,
    column: 1,
  });
};

const callerFor = (context: AnalyzerContext, call: CallExpression): GraphNode =>
  enclosingCallable(context, call)?.graphNode ??
  moduleForFile(context, call.getSourceFile());

const resolveImportedModule = (
  context: AnalyzerContext,
  sourceFile: SourceFile,
  specifier: string,
  specifierNode?: Node,
): GraphNode | undefined => {
  if (specifier.startsWith(".")) {
    const candidatePath = findAllowedLocalModule(
      context.rootDir,
      sourceFile.getFilePath(),
      specifier,
      context.sourcePaths,
    );
    if (!candidatePath) return undefined;
    const candidate = context.filesByPath.get(
      sourceFilePath(context.rootDir, candidatePath),
    );
    return candidate ? moduleForFile(context, candidate) : undefined;
  }

  const declarationTarget = specifierNode?.getParent();
  const moduleSpecifier = sourceFile
    .getImportDeclarations()
    .find((declaration) => declaration.getModuleSpecifierValue() === specifier)
    ?.getModuleSpecifierSourceFile();
  const declaredTarget =
    (declarationTarget && Node.isImportDeclaration(declarationTarget)) ||
    (declarationTarget && Node.isExportDeclaration(declarationTarget))
      ? declarationTarget.getModuleSpecifierSourceFile()
      : undefined;
  const target = moduleSpecifier ?? declaredTarget;

  if (target && isInsideRoot(context.rootDir, target.getFilePath())) {
    const targetPath = sourceFilePath(context.rootDir, target.getFilePath());
    if (context.filesByPath.has(targetPath))
      return moduleForFile(context, target);
  }

  const safeSpecifier = safeModuleSpecifier(specifier);
  return addNode(
    context,
    `module:external:${safeSpecifier}`,
    "module",
    safeSpecifier,
  );
};

const addImportEdge = (
  context: AnalyzerContext,
  sourceFile: SourceFile,
  specifierNode: Node,
  specifier: string,
): void => {
  const target = resolveImportedModule(
    context,
    sourceFile,
    specifier,
    specifierNode,
  );
  if (!target) {
    if (specifier.startsWith(".")) {
      context.blockedRelativeImports.add(
        relativeImportKey(sourceFile, specifier),
      );
    }
    addDiagnostic(
      context,
      "UNRESOLVED_IMPORT",
      "Could not resolve the requested local module import.",
      specifierNode,
    );
    return;
  }
  addEdge(
    context,
    moduleForFile(context, sourceFile),
    target,
    "imports",
    evidenceFor(context, specifierNode, `${DETECTOR_VERSION}/import`),
  );
};

const importSourceFiles = (context: AnalyzerContext): void => {
  for (const sourceFile of context.sourceFiles) {
    for (const declaration of sourceFile.getImportDeclarations()) {
      addImportEdge(
        context,
        sourceFile,
        declaration.getModuleSpecifier(),
        declaration.getModuleSpecifierValue(),
      );
    }

    for (const declaration of sourceFile.getExportDeclarations()) {
      const moduleSpecifier = declaration.getModuleSpecifier();
      const moduleSpecifierValue = declaration.getModuleSpecifierValue();
      if (moduleSpecifier && moduleSpecifierValue) {
        addImportEdge(
          context,
          sourceFile,
          moduleSpecifier,
          moduleSpecifierValue,
        );
      }
    }

    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      if (call.getExpression().getKind() === SyntaxKind.ImportKeyword) {
        const argument = call.getArguments()[0];
        if (argument && Node.isStringLiteral(argument)) {
          addImportEdge(
            context,
            sourceFile,
            argument,
            argument.getLiteralValue(),
          );
        } else {
          addDiagnostic(
            context,
            "UNSUPPORTED_DYNAMIC_IMPORT",
            "Dynamic import destination is not a literal string.",
            call,
          );
        }
      }

      if (
        Node.isIdentifier(call.getExpression()) &&
        call.getExpression().getText() === "require"
      ) {
        const argument = call.getArguments()[0];
        if (argument && Node.isStringLiteral(argument)) {
          addImportEdge(
            context,
            sourceFile,
            argument,
            argument.getLiteralValue(),
          );
        } else {
          addDiagnostic(
            context,
            "UNSUPPORTED_DYNAMIC_IMPORT",
            "Dynamic require destination is not a literal string.",
            call,
          );
        }
      }
    }
  }
};

const registerCallables = (context: AnalyzerContext): void => {
  for (const sourceFile of context.sourceFiles) {
    const declarations = sourceFile.getDescendants().filter(isCallableNode);
    for (const declaration of declarations) {
      if (
        Node.isArrowFunction(declaration) ||
        Node.isFunctionExpression(declaration)
      ) {
        const variable = declaration.getFirstAncestorByKind(
          SyntaxKind.VariableDeclaration,
        );
        if (!variable || variable.getInitializer() !== declaration) continue;
      }
      registerCallable(context, declaration);
    }
  }
};

const literalString = (node: Node | undefined): string | undefined => {
  if (!node) return undefined;
  if (Node.isStringLiteral(node)) return node.getLiteralValue();
  if (Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
  return undefined;
};

const safeHttpDestination = (destination: string): string => {
  const trimmed = destination.trim();
  if (trimmed.length === 0) return "<empty-destination>";
  try {
    const url = new URL(trimmed);
    return url.origin;
  } catch {
    if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//u.test(trimmed)) {
      return "<invalid-destination>";
    }
    const queryStart = trimmed.search(/[?#]/u);
    const normalized = queryStart >= 0 ? trimmed.slice(0, queryStart) : trimmed;
    return normalized.length > 0 ? normalized : "<empty-destination>";
  }
};

const safeModuleSpecifier = (specifier: string): string => {
  const trimmed = specifier.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes("\0") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(trimmed) ||
    /^(?:file|data|blob|javascript):/iu.test(trimmed)
  ) {
    return "<redacted-module>";
  }
  if (/^https?:\/\//iu.test(trimmed)) return safeHttpDestination(trimmed);

  try {
    const url = new URL(trimmed);
    return url.origin === "null"
      ? "<redacted-module>"
      : `${url.protocol}//${url.host}`;
  } catch {
    return trimmed;
  }
};

const expressionRootName = (expression: Expression): string | undefined => {
  const current = expressionRootNode(expression);
  return Node.isIdentifier(current) ? current.getText() : undefined;
};

const hasLocalImplementation = (
  context: AnalyzerContext,
  expression: Expression,
): boolean =>
  declarationsFor(context, expression).some((declaration) => {
    if (
      !isInsideRoot(context.rootDir, declaration.getSourceFile().getFilePath())
    )
      return false;
    if (Node.isVariableDeclaration(declaration)) {
      const statement = declaration.getFirstAncestorByKind(
        SyntaxKind.VariableStatement,
      );
      return !statement?.hasDeclareKeyword();
    }
    if (Node.isFunctionDeclaration(declaration)) {
      return !declaration.hasDeclareKeyword();
    }
    return Node.isMethodDeclaration(declaration);
  });

const typeDeclarations = (node: Node): Node[] => {
  const type = node.getType();
  const declarations = [
    ...symbolDeclarations(node),
    ...(type.getSymbol()?.getDeclarations() ?? []),
    ...(type.getAliasSymbol()?.getDeclarations() ?? []),
  ];
  return declarations.filter(
    (declaration, index, candidates) =>
      candidates.findIndex(
        (other) => declarationKey(other) === declarationKey(declaration),
      ) === index,
  );
};

const isPrismaClientDeclaration = (declaration: Node): boolean => {
  if (
    !(
      Node.isClassDeclaration(declaration) ||
      Node.isInterfaceDeclaration(declaration) ||
      Node.isTypeAliasDeclaration(declaration)
    ) ||
    declaration.getName() !== "PrismaClient"
  ) {
    return false;
  }

  const filePath = normalizePath(declaration.getSourceFile().getFilePath());
  if (!filePath.endsWith(".d.ts")) return false;
  if (filePath.includes("/node_modules/@prisma/client/")) return true;

  let module = declaration.getFirstAncestorByKind(SyntaxKind.ModuleDeclaration);
  while (module) {
    if (module.getName().replace(/^['"]|['"]$/gu, "") === "@prisma/client")
      return true;
    module = module.getParentModule();
  }
  return false;
};

const isPrismaClientConstructor = (initializer: Node): boolean => {
  if (!Node.isNewExpression(initializer)) return false;
  const constructor = initializer.getExpression();
  const name = Node.isIdentifier(constructor)
    ? constructor.getText()
    : Node.isPropertyAccessExpression(constructor)
      ? constructor.getName()
      : undefined;
  return (
    name === "PrismaClient" &&
    typeDeclarations(constructor).some(isPrismaClientDeclaration)
  );
};

const isPrismaClientBinding = (
  context: AnalyzerContext,
  expression: Expression,
): boolean => {
  for (const declaration of declarationsFor(context, expression)) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    const initializer = declaration.getInitializer();
    if (initializer && isPrismaClientConstructor(initializer)) return true;
    const typeNode = declaration.getTypeNode();
    if (
      typeNode &&
      typeDeclarations(typeNode).some(isPrismaClientDeclaration)
    ) {
      return true;
    }
    if (typeDeclarations(declaration).some(isPrismaClientDeclaration)) {
      return true;
    }
  }
  return false;
};

const isVerifiedFetch = (
  context: AnalyzerContext,
  expression: Expression,
): boolean =>
  Node.isIdentifier(expression) &&
  expression.getText() === "fetch" &&
  !isBlockedImportedReference(context, expression) &&
  !hasLocalImplementation(context, expression);

const isVerifiedAxiosReceiver = (
  context: AnalyzerContext,
  receiver: Expression,
): boolean => {
  const root = expressionRootNode(receiver);
  if (!Node.isIdentifier(root) || !/^(?:axios|Axios)$/u.test(root.getText()))
    return false;
  if (isBlockedImportedReference(context, root)) return false;
  return !hasLocalImplementation(context, root);
};

const isVerifiedPrismaReceiver = (
  context: AnalyzerContext,
  receiver: Expression,
): boolean => {
  const root = expressionRootNode(receiver);
  if (!Node.isIdentifier(root)) return false;
  if (isBlockedImportedReference(context, root)) return false;
  const conventionName = /^(?:prisma|db|database|client)$/iu.test(
    root.getText(),
  );
  const localImplementation = hasLocalImplementation(context, root);
  return (
    isPrismaClientBinding(context, root) ||
    (conventionName && !localImplementation)
  );
};

const isVerifiedExpressReceiver = (
  context: AnalyzerContext,
  receiver: Expression,
): boolean => {
  const root = expressionRootNode(receiver);
  if (isBlockedImportedReference(context, root)) return false;
  if (!hasLocalImplementation(context, root)) {
    return isPotentialExpressReceiver(receiver, context.rootDir);
  }

  const declarations = declarationsFor(context, root);
  for (const declaration of declarations) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) continue;
    const initializerText = initializer.getExpression().getText();
    if (
      initializerText === "express" ||
      initializerText === "Router" ||
      initializerText.endsWith(".Router")
    ) {
      return true;
    }
  }

  const typeText = receiver.getType().getText();
  return /(?:express\.)?(?:Application|Router|IRouter|Express)/u.test(typeText);
};

const isFrameworkCall = (
  context: AnalyzerContext,
  call: CallExpression,
): boolean => {
  const expression = call.getExpression();
  if (isVerifiedFetch(context, expression)) return true;
  if (!Node.isPropertyAccessExpression(expression)) return false;

  const receiver = expression.getExpression();
  const method = expression.getName();
  if (HTTP_METHODS.has(method) && isVerifiedAxiosReceiver(context, receiver)) {
    return true;
  }
  if (
    (READ_METHODS.has(method) || WRITE_METHODS.has(method)) &&
    isVerifiedPrismaReceiver(context, receiver)
  ) {
    return true;
  }
  if (method === "route" && isVerifiedExpressReceiver(context, receiver)) {
    return true;
  }
  return false;
};

const resolveHttpDestination = (
  call: CallExpression,
): { destination: string; argument: Node } | undefined => {
  const expression = call.getExpression();
  if (Node.isIdentifier(expression) && expression.getText() === "fetch") {
    const argument = call.getArguments()[0];
    const destination = literalString(argument);
    return destination !== undefined && argument
      ? { destination, argument }
      : undefined;
  }

  if (
    !Node.isPropertyAccessExpression(expression) ||
    !HTTP_METHODS.has(expression.getName())
  )
    return undefined;
  const root = expressionRootName(expression.getExpression());
  if (root !== "axios" && root !== "Axios") return undefined;

  const firstArgument = call.getArguments()[0];
  const direct = literalString(firstArgument);
  if (direct !== undefined && firstArgument)
    return { destination: direct, argument: firstArgument };

  if (
    expression.getName() === "request" &&
    firstArgument &&
    Node.isObjectLiteralExpression(firstArgument)
  ) {
    const urlProperty = firstArgument.getProperty("url");
    if (urlProperty && Node.isPropertyAssignment(urlProperty)) {
      const url = literalString(urlProperty.getInitializer());
      if (url !== undefined)
        return {
          destination: url,
          argument: urlProperty.getInitializer() as Node,
        };
    }
  }

  return undefined;
};

const prismaOperation = (
  context: AnalyzerContext,
  call: CallExpression,
):
  | { model: string; kind: "reads" | "writes"; evidenceNode: Node }
  | undefined => {
  const expression = call.getExpression();
  let operation: string | undefined;
  let modelExpression: Expression | undefined;
  if (Node.isPropertyAccessExpression(expression)) {
    operation = expression.getName();
    modelExpression = expression.getExpression();
  } else if (Node.isElementAccessExpression(expression)) {
    operation = literalString(expression.getArgumentExpression());
    modelExpression = expression.getExpression();
  }
  if (!operation || !modelExpression) return undefined;
  const kind = READ_METHODS.has(operation)
    ? "reads"
    : WRITE_METHODS.has(operation)
      ? "writes"
      : undefined;
  if (!kind) return undefined;

  let modelName: string | undefined;
  let receiver: Expression | undefined;
  if (Node.isPropertyAccessExpression(modelExpression)) {
    modelName = modelExpression.getName();
    receiver = modelExpression.getExpression();
  } else if (Node.isElementAccessExpression(modelExpression)) {
    modelName = literalString(modelExpression.getArgumentExpression());
    receiver = modelExpression.getExpression();
  }
  if (!modelName || !receiver || !isVerifiedPrismaReceiver(context, receiver))
    return undefined;
  return {
    model: modelName,
    kind,
    evidenceNode: expression,
  };
};

const hasDynamicPrismaModel = (
  context: AnalyzerContext,
  call: CallExpression,
): boolean => {
  const expression = call.getExpression();
  const modelExpression = Node.isPropertyAccessExpression(expression)
    ? expression.getExpression()
    : Node.isElementAccessExpression(expression)
      ? expression.getExpression()
      : undefined;
  if (!modelExpression || !Node.isElementAccessExpression(modelExpression))
    return false;
  if (literalString(modelExpression.getArgumentExpression()) !== undefined)
    return false;
  return isVerifiedPrismaReceiver(context, modelExpression.getExpression());
};

const hasDynamicPrismaOperation = (
  context: AnalyzerContext,
  call: CallExpression,
): boolean => {
  const expression = call.getExpression();
  if (!Node.isElementAccessExpression(expression)) return false;
  if (literalString(expression.getArgumentExpression()) !== undefined)
    return false;
  const modelExpression = expression.getExpression();
  if (
    !Node.isPropertyAccessExpression(modelExpression) &&
    !Node.isElementAccessExpression(modelExpression)
  )
    return false;
  return isVerifiedPrismaReceiver(context, modelExpression);
};

const prismaModelName = (value: string): string => {
  if (/^[A-Z]/.test(value)) return value;
  return value
    .split(/[_-]/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
};

const addHttpEdge = (
  context: AnalyzerContext,
  call: CallExpression,
): boolean => {
  const destination = resolveHttpDestination(call);
  const expression = call.getExpression();
  const looksLikeHttpCall =
    isVerifiedFetch(context, expression) ||
    (Node.isPropertyAccessExpression(expression) &&
      HTTP_METHODS.has(expression.getName()) &&
      isVerifiedAxiosReceiver(context, expression.getExpression()));
  if (!looksLikeHttpCall) return false;

  if (!destination) {
    addDiagnostic(
      context,
      "UNSUPPORTED_DYNAMIC_HTTP_DESTINATION",
      "HTTP destination must be a literal string for a confident request edge.",
      call,
    );
    return true;
  }

  const target = addNode(
    context,
    `external_service:${safeHttpDestination(destination.destination)}`,
    "external_service",
    safeHttpDestination(destination.destination),
  );
  addEdge(
    context,
    callerFor(context, call),
    target,
    "requests",
    evidenceFor(context, destination.argument, `${DETECTOR_VERSION}/http`),
    Node.isIdentifier(expression) &&
      !declarationsFor(context, expression).some((declaration) =>
        isInsideRoot(
          context.rootDir,
          declaration.getSourceFile().getFilePath(),
        ),
      )
      ? "certain"
      : "inferred",
  );
  return true;
};

const addPrismaEdge = (
  context: AnalyzerContext,
  call: CallExpression,
): boolean => {
  if (resolveCallable(context, call.getExpression())) return false;
  if (
    hasDynamicPrismaModel(context, call) ||
    hasDynamicPrismaOperation(context, call)
  ) {
    addDiagnostic(
      context,
      "UNSUPPORTED_DYNAMIC_PRISMA_MODEL",
      "Prisma model and operation must be statically named properties.",
      call,
    );
    return true;
  }
  const operation = prismaOperation(context, call);
  if (!operation) return false;
  const target = addNode(
    context,
    `database_table:prisma:${prismaModelName(operation.model)}`,
    "database_table",
    prismaModelName(operation.model),
  );
  addEdge(
    context,
    callerFor(context, call),
    target,
    operation.kind,
    evidenceFor(context, operation.evidenceNode, `${DETECTOR_VERSION}/prisma`),
    "inferred",
  );
  return true;
};

const addCallEdge = (context: AnalyzerContext, call: CallExpression): void => {
  const expression = call.getExpression();
  const target = resolveCallable(context, expression);
  if (target) {
    addEdge(
      context,
      callerFor(context, call),
      target.graphNode,
      "calls",
      evidenceFor(context, expression, `${DETECTOR_VERSION}/call`),
    );
    return;
  }
  if (isFrameworkCall(context, call)) return;
  if (
    Node.isPropertyAccessExpression(expression) &&
    expression.getName() === "route" &&
    isVerifiedExpressReceiver(context, expression.getExpression())
  ) {
    return;
  }

  const root = expressionRootName(expression);
  if (!root || BUILTIN_CALL_ROOTS.has(root) || FRAMEWORK_CALL_ROOTS.has(root))
    return;
  const declarations = declarationsFor(context, expression);
  const hasLocalDeclaration = declarations.some((declaration) =>
    isInsideRoot(context.rootDir, declaration.getSourceFile().getFilePath()),
  );
  if (
    hasLocalDeclaration ||
    (declarations.length === 0 &&
      (Node.isIdentifier(expression) ||
        Node.isPropertyAccessExpression(expression)))
  ) {
    addDiagnostic(
      context,
      "UNRESOLVED_CALL",
      "Could not resolve a callable target for this call.",
      expression,
    );
  }
};

const addRouteEdges = (
  context: AnalyzerContext,
  call: CallExpression,
): boolean => {
  const routeResult = analyzeExpressRouteCall(call, {
    isExpressReceiver: (receiver) =>
      isVerifiedExpressReceiver(context, receiver),
  });
  if (!routeResult) return false;

  if (routeResult.diagnostic) {
    addDiagnostic(
      context,
      routeResult.diagnostic.code,
      routeResult.diagnostic.message,
      routeResult.diagnostic.node,
    );
    return true;
  }

  const endpoint = addNode(
    context,
    `endpoint:${routeResult.method}:${routeResult.path}`,
    "endpoint",
    `${routeResult.method} ${routeResult.path}`,
    sourcePosition(context.rootDir, call),
  );

  for (const handler of routeResult.handlers) {
    const callable = resolveCallable(context, handler);
    if (callable) {
      addEdge(
        context,
        endpoint,
        callable.graphNode,
        "calls",
        evidenceFor(context, call, `${DETECTOR_VERSION}/express-route`),
        "inferred",
      );
      continue;
    }

    if (
      Node.isArrowFunction(handler) ||
      Node.isFunctionExpression(handler) ||
      Node.isFunctionDeclaration(handler)
    ) {
      const inline = registerInlineRouteCallable(
        context,
        handler,
        routeResult.method,
        routeResult.path,
      );
      addEdge(
        context,
        endpoint,
        inline.graphNode,
        "calls",
        evidenceFor(context, call, `${DETECTOR_VERSION}/express-route`),
        "inferred",
      );
      continue;
    }

    addDiagnostic(
      context,
      "UNRESOLVED_ROUTE_HANDLER",
      "Could not resolve an Express route handler.",
      handler,
    );
  }

  return true;
};

const analyzeCalls = (context: AnalyzerContext): void => {
  for (const sourceFile of context.sourceFiles) {
    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      if (context.extractors.has("express") && addRouteEdges(context, call))
        continue;
      if (addHttpEdge(context, call)) continue;
      if (addPrismaEdge(context, call)) continue;
      addCallEdge(context, call);
    }

    for (const elementAccess of sourceFile.getDescendantsOfKind(
      SyntaxKind.ElementAccessExpression,
    )) {
      const receiver = elementAccess.getExpression();
      const argument = elementAccess.getArgumentExpression();
      if (isVerifiedExpressReceiver(context, receiver)) {
        addDiagnostic(
          context,
          "UNSUPPORTED_DYNAMIC_ROUTE",
          "Express route method must be a statically named property.",
          elementAccess,
        );
      } else if (
        Node.isPropertyAccessExpression(receiver) &&
        READ_METHODS.has(receiver.getName()) &&
        !literalString(argument)
      ) {
        addDiagnostic(
          context,
          "UNSUPPORTED_DYNAMIC_PRISMA_MODEL",
          "Prisma model and operation must be statically named properties.",
          elementAccess,
        );
      }
    }
  }
};

const createContext = (options: TypeScriptAnalyzerOptions): AnalyzerContext => {
  const rootDir = resolve(options.rootDir);
  if (!existsSync(rootDir) || !lstatSync(rootDir).isDirectory()) {
    throw new Error(
      `TypeScript analyzer root is not a directory: ${options.rootDir}`,
    );
  }

  const extractors = new Set<"typescript" | "express">(
    options.extractors ?? ["typescript", "express"],
  );
  if (!extractors.has("typescript")) {
    throw new Error('the "typescript" extractor is required for this analyzer');
  }
  const resources: ResourceLimits = {
    ...DEFAULT_RESOURCE_LIMITS,
    ...options.resources,
  };
  const paths = discoverSourcePaths(
    rootDir,
    options.include ?? ["."],
    options.exclude ?? [],
    resources,
  ).map((path) => resolve(path));
  const sourcePaths = new Set(paths);
  const project = projectFor(rootDir, options.tsconfigPath, sourcePaths);
  for (const path of paths) project.addSourceFileAtPath(path);

  const sourceFiles = paths
    .map((path) => project.getSourceFile(path))
    .filter((sourceFile): sourceFile is SourceFile => sourceFile !== undefined)
    .sort((left, right) =>
      compareStrings(
        sourceFilePath(rootDir, left.getFilePath()),
        sourceFilePath(rootDir, right.getFilePath()),
      ),
    );
  const filesByPath = new Map(
    sourceFiles.map((file) => [
      sourceFilePath(rootDir, file.getFilePath()),
      file,
    ]),
  );
  const fileHashes = new Map(
    paths.map((path) => [
      sourceFilePath(rootDir, path),
      hashBytes(readFileSync(path)),
    ]),
  );

  return {
    blockedRelativeImports: new Set(),
    callablesByDeclaration: new Map(),
    callablesByStableKey: new Map(),
    diagnostics: new Map(),
    edges: new Map(),
    fileHashes,
    filesByPath,
    nodes: new Map(),
    project,
    rootDir,
    sourcePaths,
    sourceFiles,
    extractors,
  };
};

export const analyzeTypeScriptRepository = (
  input: TypeScriptAnalyzerOptions | string,
): TypeScriptAnalyzerResult => {
  const options: TypeScriptAnalyzerOptions =
    typeof input === "string" ? { rootDir: input } : input;
  const context = createContext(options);
  for (const sourceFile of context.sourceFiles)
    moduleForFile(context, sourceFile);
  registerCallables(context);
  importSourceFiles(context);
  analyzeCalls(context);

  const revision: Revision = {
    commitSha: options.revision?.commitSha ?? "working-tree",
    ...(options.revision?.parentSha
      ? { parentSha: options.revision.parentSha }
      : {}),
    ...(options.revision?.branch
      ? { branch: options.revision.branch }
      : { branch: "working-tree" }),
    ...(options.revision?.authoredAt
      ? { authoredAt: options.revision.authoredAt }
      : {}),
  };

  return {
    schemaVersion: 1,
    capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
    revision,
    nodes: [...context.nodes.values()].sort((left, right) =>
      compareStrings(left.stableKey, right.stableKey),
    ),
    edges: [...context.edges.values()].sort((left, right) =>
      compareStrings(
        edgeKey(left.from, left.to, left.kind),
        edgeKey(right.from, right.to, right.kind),
      ),
    ),
    diagnostics: [...context.diagnostics.values()].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
  };
};

export const analyzeTypeScriptProject = analyzeTypeScriptRepository;
export const analyzeTypeScript = analyzeTypeScriptRepository;
