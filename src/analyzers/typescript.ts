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
import {
  CAPABILITY_REGISTRY_VERSION,
  getDiagnosticDefinition,
} from "../core/index.js";

import {
  analyzeExpressRouteCall,
  isPotentialExpressReceiver,
} from "./express.js";
import { analyzeFastifyRouteCall, isFastifyRouteMethod } from "./fastify.js";
import { createResourceBudget, ResourceLimitError } from "../resources.js";

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
const EVENT_SUBSCRIBE_METHODS = new Set([
  "addListener",
  "on",
  "once",
  "prependListener",
]);
const EVENT_PUBLISH_METHOD = "emit";
const QUEUE_PUBLISH_METHODS = new Set([
  "add",
  "addBulk",
  "enqueue",
  "publish",
  "send",
]);
const QUEUE_SUBSCRIBE_METHODS = new Set(["consume", "process", "register"]);
const QUEUE_METHODS = new Set([
  ...QUEUE_PUBLISH_METHODS,
  ...QUEUE_SUBSCRIBE_METHODS,
]);
const QUEUE_CLIENT_MODULES = new Set(["bull", "bullmq"]);
const EVENT_MODULES = new Set(["events", "node:events"]);
const ASYNC_CALLBACK_ROOTS = new Set([
  "queueMicrotask",
  "setImmediate",
  "setInterval",
  "setTimeout",
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
const FASTIFY_DETECTOR_VERSION = "cartograph.typescript-fastify@1";
const ASYNC_DETECTOR_VERSION = `${DETECTOR_VERSION}/async`;

export type TypeScriptExtractor = "typescript" | "express" | "fastify";

export interface TypeScriptAnalyzerOptions {
  rootDir: string;
  tsconfigPath?: string;
  include?: readonly string[];
  exclude?: readonly string[];
  extractors?: readonly TypeScriptExtractor[];
  resources?: Partial<ResourceLimits>;
  revision?: Partial<Revision>;
  signal?: AbortSignal;
}

export { ResourceLimitError } from "../resources.js";

export type TypeScriptAnalyzerResult = GraphSnapshot;

type FunctionLike =
  ArrowFunction | FunctionDeclaration | FunctionExpression | MethodDeclaration;

interface CallableInfo {
  declarationKeys: Set<string>;
  file: SourceFile;
  graphNode: GraphNode;
  node: FunctionLike;
}

type QueueBinding = {
  kind: "queue" | "worker";
  module: string;
  name: string | undefined;
};

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
  resolveModule: (
    moduleName: string,
    containingFile: string,
  ) => string | undefined;
  resolveModuleInfo: (
    moduleName: string,
    containingFile: string,
    resolutionMode?: ts.ResolutionMode,
  ) => ModuleResolutionInfo;
  rootDir: string;
  sourcePaths: Set<string>;
  sourceFiles: SourceFile[];
  extractors: ReadonlySet<TypeScriptExtractor>;
  checkBudget: () => void;
}

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const normalizePath = (value: string): string =>
  value.normalize("NFC").split(sep).join("/");

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

type LoadedProjectConfig = {
  configPath: string;
  configDirectory: string;
  options: ts.CompilerOptions;
};

export type TypeScriptConfigErrorCode =
  "invalid" | "unsupported" | "missing" | "outside-root" | "cycle";

export class TypeScriptConfigError extends Error {
  readonly code: TypeScriptConfigErrorCode;
  readonly configPath: string;
  readonly targetPath: string | undefined;

  constructor(
    code: TypeScriptConfigErrorCode,
    configPath: string,
    message: string,
    targetPath?: string,
  ) {
    super(message);
    this.name = "TypeScriptConfigError";
    this.code = code;
    this.configPath = configPath;
    this.targetPath = targetPath;
  }
}

type LoadedProjectSources = {
  projectPaths: string[];
  sourcePaths: string[];
  configs: LoadedProjectConfig[];
  compilerOptions: ts.CompilerOptions;
};

const tsConfigDiagnosticText = (
  diagnostics: readonly ts.Diagnostic[],
): string =>
  diagnostics
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    )
    .sort(compareStrings)
    .join("; ");

const configDisplayPath = (rootDir: string, configPath: string): string => {
  const path = normalizePath(relative(rootDir, configPath));
  return path.length > 0 ? path : "tsconfig.json";
};

const configError = (
  code: TypeScriptConfigErrorCode,
  rootDir: string,
  configPath: string,
  message: string,
  targetPath?: string,
): TypeScriptConfigError =>
  new TypeScriptConfigError(
    code,
    configDisplayPath(rootDir, configPath),
    message,
    targetPath === undefined
      ? undefined
      : configDisplayPath(rootDir, targetPath),
  );

const configPathInsideRoot = (
  rootDir: string,
  candidatePath: string,
  label: string,
): string | undefined => {
  const absolutePath = resolve(candidatePath);
  if (!isInsideRoot(rootDir, absolutePath))
    throw new Error(`${label} must stay inside the analyzed repository`);
  if (!existsSync(absolutePath)) return undefined;
  const metadata = lstatSync(absolutePath);
  if (metadata.isSymbolicLink())
    throw new Error(`${label} must not be a symbolic link: ${candidatePath}`);
  if (!metadata.isFile())
    throw new Error(`${label} is not a regular file: ${candidatePath}`);
  const physicalPath = realpathSync(absolutePath);
  if (!isInsideRoot(rootDir, physicalPath))
    throw new Error(`${label} must stay inside the analyzed repository`);
  return absolutePath;
};

const safeConfigHost = (
  rootDir: string,
  checkBudget: () => void,
): ts.ParseConfigHost => {
  const safePath = (candidatePath: string): string | undefined => {
    const absolutePath = resolve(candidatePath);
    if (!isInsideRoot(rootDir, absolutePath)) return undefined;
    if (!existsSync(absolutePath)) return undefined;
    const metadata = lstatSync(absolutePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return undefined;
    const physicalPath = realpathSync(absolutePath);
    return isInsideRoot(rootDir, physicalPath) ? absolutePath : undefined;
  };

  return {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (candidatePath) => {
      checkBudget();
      return safePath(candidatePath) !== undefined;
    },
    readFile: (candidatePath) => {
      checkBudget();
      const path = safePath(candidatePath);
      return path === undefined ? undefined : readFileSync(path, "utf8");
    },
    readDirectory: (directory, extensions, excludes, includes, depth) => {
      checkBudget();
      if (!isInsideRoot(rootDir, directory)) return [];
      return ts.sys
        .readDirectory(directory, extensions, excludes, includes, depth)
        .map((candidatePath) => safePath(candidatePath))
        .filter(
          (candidatePath): candidatePath is string =>
            candidatePath !== undefined,
        )
        .sort(compareStrings);
    },
    directoryExists: (directory) => {
      checkBudget();
      const absolutePath = resolve(directory);
      if (!isInsideRoot(rootDir, absolutePath) || !existsSync(absolutePath))
        return false;
      const metadata = lstatSync(absolutePath);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
      return isInsideRoot(rootDir, realpathSync(absolutePath));
    },
    realpath: (candidatePath) => {
      checkBudget();
      const path = safePath(candidatePath);
      return path === undefined ? candidatePath : realpathSync(path);
    },
  };
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

const isProjectSourcePath = (filePath: string): boolean =>
  SOURCE_EXTENSIONS.has(extname(filePath)) && !filePath.endsWith(".d.ts");

const isExcludedProjectPath = (rootDir: string, filePath: string): boolean => {
  const relativePath = relative(rootDir, filePath);
  return relativePath.split(sep).some((part) => EXCLUDED_DIRECTORIES.has(part));
};

const safeProjectFilePath = (
  rootDir: string,
  filePath: string,
): string | undefined => {
  const absolutePath = resolve(filePath);
  if (!isInsideRoot(rootDir, absolutePath))
    throw new Error(
      `tsconfig selected a file outside the analyzed repository: ${filePath}`,
    );
  if (!existsSync(absolutePath)) return undefined;
  const metadata = lstatSync(absolutePath);
  if (metadata.isSymbolicLink()) return undefined;
  if (!metadata.isFile()) return undefined;
  const physicalPath = realpathSync(absolutePath);
  if (!isInsideRoot(rootDir, physicalPath)) return undefined;
  return absolutePath;
};

type RawTypeScriptConfig = Record<string, unknown>;

type ConfigReferenceKind = "extends" | "project reference";

const readRawConfig = (
  rootDir: string,
  configPath: string,
  configHost: ts.ParseConfigHost,
  cache: Map<string, RawTypeScriptConfig>,
  checkBudget: () => void,
): RawTypeScriptConfig => {
  const cached = cache.get(configPath);
  if (cached) return cached;

  checkBudget();
  const loaded = ts.readConfigFile(configPath, (path) =>
    configHost.readFile(path),
  );
  if (loaded.error)
    throw configError(
      "invalid",
      rootDir,
      configPath,
      `could not parse ${configDisplayPath(rootDir, configPath)}: ${tsConfigDiagnosticText([loaded.error])}`,
    );
  if (
    !loaded.config ||
    typeof loaded.config !== "object" ||
    Array.isArray(loaded.config)
  )
    throw configError(
      "invalid",
      rootDir,
      configPath,
      `could not parse ${configDisplayPath(rootDir, configPath)}: expected a JSON object`,
    );

  const config = loaded.config as RawTypeScriptConfig;
  cache.set(configPath, config);
  return config;
};

const configReferencePath = (
  rootDir: string,
  configPath: string,
  referencePath: unknown,
  kind: ConfigReferenceKind,
): string => {
  if (typeof referencePath !== "string" || referencePath.trim().length === 0)
    throw configError(
      "unsupported",
      rootDir,
      configPath,
      `${kind} must use a non-empty string path`,
    );

  const normalizedReference = referencePath.trim().replaceAll("\\", "/");
  if (
    kind === "extends" &&
    !normalizedReference.startsWith(".") &&
    !normalizedReference.startsWith("/")
  )
    throw configError(
      "unsupported",
      rootDir,
      configPath,
      `unsupported tsconfig extends target ${JSON.stringify(referencePath)}; only in-repository paths are supported`,
      resolve(dirname(configPath), normalizedReference),
    );

  const absoluteReference = resolve(dirname(configPath), normalizedReference);
  const candidates =
    extname(absoluteReference) === ".json"
      ? [absoluteReference]
      : [
          absoluteReference,
          `${absoluteReference}.json`,
          join(absoluteReference, "tsconfig.json"),
        ];
  const existingFile = candidates.find((candidate) => {
    if (!existsSync(candidate)) return false;
    try {
      return lstatSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  const candidate = existingFile ?? candidates[0];
  if (!candidate) {
    throw configError(
      "missing",
      rootDir,
      configPath,
      `${kind} target does not exist: ${referencePath}`,
    );
  }
  if (!isInsideRoot(rootDir, candidate))
    throw configError(
      "outside-root",
      rootDir,
      configPath,
      `${kind} must stay inside the analyzed repository: ${referencePath}`,
      candidate,
    );

  const resolved = configPathInsideRoot(
    rootDir,
    candidate,
    kind === "extends" ? "tsconfig extends" : "project reference",
  );
  if (resolved === undefined)
    throw configError(
      "missing",
      rootDir,
      configPath,
      `${kind} target does not exist: ${referencePath}`,
      candidate,
    );
  return resolved;
};

const extendsTarget = (
  rootDir: string,
  configPath: string,
  config: RawTypeScriptConfig,
): string | undefined => {
  if (!("extends" in config)) return undefined;
  if (Array.isArray(config.extends))
    throw configError(
      "unsupported",
      rootDir,
      configPath,
      "tsconfig extends arrays are not supported; use a single in-repository base config",
    );
  return configReferencePath(rootDir, configPath, config.extends, "extends");
};

const projectReferenceTargets = (
  rootDir: string,
  configPath: string,
  config: RawTypeScriptConfig,
): string[] => {
  if (!("references" in config)) return [];
  if (!Array.isArray(config.references))
    throw configError(
      "unsupported",
      rootDir,
      configPath,
      "tsconfig references must be an array of project reference objects",
    );

  return config.references
    .map((reference, index) => {
      if (!reference || typeof reference !== "object")
        throw configError(
          "unsupported",
          rootDir,
          configPath,
          `tsconfig reference ${index} must be an object with a path`,
        );
      return configReferencePath(
        rootDir,
        configPath,
        (reference as Record<string, unknown>).path,
        "project reference",
      );
    })
    .sort(compareStrings);
};

const loadedProjectSources = (
  rootDir: string,
  tsconfigPath: string | undefined,
  include: readonly string[],
  exclude: readonly string[],
  resources: ResourceLimits,
  checkBudget: () => void,
): LoadedProjectSources => {
  const requestedConfigPath = tsconfigPath
    ? resolve(rootDir, tsconfigPath)
    : join(rootDir, "tsconfig.json");
  const rootConfigPath = configPathInsideRoot(
    rootDir,
    requestedConfigPath,
    "tsconfig",
  );

  if (tsconfigPath !== undefined && rootConfigPath === undefined)
    throw new Error(`tsconfig does not exist: ${tsconfigPath}`);

  if (rootConfigPath === undefined) {
    const paths = discoverSourcePaths(
      rootDir,
      include,
      exclude,
      resources,
      checkBudget,
    );
    return {
      projectPaths: paths,
      sourcePaths: paths,
      configs: [],
      compilerOptions: {
        allowJs: false,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: ts.ScriptTarget.ES2023,
      },
    };
  }

  const configHost = safeConfigHost(rootDir, checkBudget);
  const configs: LoadedProjectConfig[] = [];
  const configCache = new Map<string, RawTypeScriptConfig>();
  const visited = new Set<string>();
  const extendsValidated = new Set<string>();
  const projectPaths = new Set<string>();
  const sourcePaths = new Set<string>();

  const validateExtends = (
    configPath: string,
    stack: readonly string[],
  ): void => {
    if (stack.includes(configPath)) {
      const cycle = [...stack.slice(stack.indexOf(configPath)), configPath]
        .map((path) => configDisplayPath(rootDir, path))
        .join(" -> ");
      throw configError(
        "cycle",
        rootDir,
        configPath,
        `tsconfig extends cycle: ${cycle}`,
        configPath,
      );
    }
    if (extendsValidated.has(configPath)) return;
    const config = readRawConfig(
      rootDir,
      configPath,
      configHost,
      configCache,
      checkBudget,
    );
    const target = extendsTarget(rootDir, configPath, config);
    if (target !== undefined) validateExtends(target, [...stack, configPath]);
    extendsValidated.add(configPath);
  };

  const visitProject = (configPath: string, stack: readonly string[]): void => {
    if (stack.includes(configPath)) {
      const cycle = [...stack.slice(stack.indexOf(configPath)), configPath]
        .map((path) => configDisplayPath(rootDir, path))
        .join(" -> ");
      throw configError(
        "cycle",
        rootDir,
        configPath,
        `project reference cycle: ${cycle}`,
        configPath,
      );
    }
    if (visited.has(configPath)) return;

    const config = readRawConfig(
      rootDir,
      configPath,
      configHost,
      configCache,
      checkBudget,
    );
    validateExtends(configPath, []);
    const parsed = ts.parseJsonConfigFileContent(
      config,
      configHost,
      dirname(configPath),
      {},
      configPath,
    );
    if (parsed.errors.length > 0)
      throw configError(
        "invalid",
        rootDir,
        configPath,
        `could not parse ${configDisplayPath(rootDir, configPath)}: ${tsConfigDiagnosticText(parsed.errors)}`,
      );
    configs.push({
      configPath,
      configDirectory: dirname(configPath),
      options: parsed.options,
    });

    for (const fileName of [...parsed.fileNames].sort(compareStrings)) {
      checkBudget();
      const safePath = safeProjectFilePath(rootDir, fileName);
      if (
        safePath === undefined ||
        isExcludedProjectPath(rootDir, safePath) ||
        !selectedByPatterns(
          normalizePath(relative(rootDir, safePath)),
          include,
          exclude,
        )
      )
        continue;
      projectPaths.add(safePath);
      if (isProjectSourcePath(safePath)) sourcePaths.add(safePath);
    }

    const nextStack = [...stack, configPath];
    for (const referencePath of projectReferenceTargets(
      rootDir,
      configPath,
      config,
    )) {
      checkBudget();
      visitProject(referencePath, nextStack);
    }
    visited.add(configPath);
  };

  visitProject(rootConfigPath, []);

  const sortedProjectPaths = [...projectPaths].sort(compareStrings);
  const sortedSourcePaths = [...sourcePaths].sort(compareStrings);
  let totalSourceBytes = 0;
  for (const filePath of sortedSourcePaths) {
    checkBudget();
    const bytes = lstatSync(filePath).size;
    if (bytes > resources.maxFileBytes)
      throw new ResourceLimitError(
        `source file exceeds the ${resources.maxFileBytes} byte file ceiling: ${normalizePath(relative(rootDir, filePath))}`,
      );
    totalSourceBytes += bytes;
    if (totalSourceBytes > resources.maxSourceBytes)
      throw new ResourceLimitError(
        `analysis exceeds the ${resources.maxSourceBytes} byte source ceiling`,
      );
  }

  if (sortedSourcePaths.length > resources.maxFiles)
    throw new ResourceLimitError(
      `analysis exceeds the ${resources.maxFiles} source-file ceiling`,
    );

  checkBudget();
  return {
    projectPaths: sortedProjectPaths,
    sourcePaths: sortedSourcePaths,
    configs: configs.sort((left, right) =>
      compareStrings(left.configPath, right.configPath),
    ),
    compilerOptions: configs[0]?.options ?? {
      allowJs: false,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2023,
    },
  };
};

const discoverSourcePaths = (
  rootDir: string,
  include: readonly string[],
  exclude: readonly string[],
  resources: ResourceLimits,
  checkBudget: () => void,
): string[] => {
  const discovered: string[] = [];
  let totalBytes = 0;

  const visit = (directory: string): void => {
    checkBudget();
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => compareStrings(left.name, right.name),
    );

    for (const entry of entries) {
      checkBudget();
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

type ProjectSetup = {
  project: Project;
  resolveModule: (
    moduleName: string,
    containingFile: string,
  ) => string | undefined;
  resolveModuleInfo: (
    moduleName: string,
    containingFile: string,
    resolutionMode?: ts.ResolutionMode,
  ) => ModuleResolutionInfo;
};

type PackageConditionInfo = {
  packageJsonPath: string;
  selectedConditions: readonly string[];
  availableConditions: readonly string[];
  ambiguous: boolean;
};

type ModuleResolutionInfo = {
  resolvedPath: string | undefined;
  conditionInfo?: PackageConditionInfo | undefined;
};

type PackageManifest = {
  path: string;
  data: Record<string, unknown>;
};

const DETERMINISTIC_PACKAGE_CONDITIONS = new Set([
  "default",
  "import",
  "node",
  "require",
  "types",
]);

const packageNameForSpecifier = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
};

const packageSubpathForSpecifier = (specifier: string): string => {
  const packageName = packageNameForSpecifier(specifier);
  const suffix = specifier.slice(packageName.length);
  return suffix.length === 0 ? "." : `.${suffix}`;
};

const packageConditionKeys = (
  value: unknown,
  keys: Set<string> = new Set(),
): Set<string> => {
  if (Array.isArray(value)) {
    for (const candidate of value) packageConditionKeys(candidate, keys);
    return keys;
  }
  if (!value || typeof value !== "object") return keys;
  for (const [key, candidate] of Object.entries(value)) {
    keys.add(key);
    packageConditionKeys(candidate, keys);
  }
  return keys;
};

const projectFor = (
  rootDir: string,
  loaded: LoadedProjectSources,
  sourcePaths: ReadonlySet<string>,
  checkBudget: () => void,
): ProjectSetup => {
  const compilerOptionsForFile = (filePath: string): ts.CompilerOptions => {
    const candidate = loaded.configs
      .filter((config) => isInsideRoot(config.configDirectory, filePath))
      .sort(
        (left, right) =>
          right.configDirectory.length - left.configDirectory.length,
      )[0];
    return candidate?.options ?? loaded.compilerOptions;
  };
  const safeResolutionHost = safeConfigHost(rootDir, checkBudget);
  const packageManifestCache = new Map<string, PackageManifest | null>();
  const packageManifestAt = (
    directory: string,
  ): PackageManifest | undefined => {
    const manifestPath = resolve(directory, "package.json");
    const cached = packageManifestCache.get(manifestPath);
    if (cached !== undefined) return cached ?? undefined;
    if (!isInsideRoot(rootDir, manifestPath)) {
      packageManifestCache.set(manifestPath, null);
      return undefined;
    }
    const raw = safeResolutionHost.readFile(manifestPath);
    if (raw === undefined) {
      packageManifestCache.set(manifestPath, null);
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        packageManifestCache.set(manifestPath, null);
        return undefined;
      }
      const manifest = {
        path: manifestPath,
        data: parsed as Record<string, unknown>,
      };
      packageManifestCache.set(manifestPath, manifest);
      return manifest;
    } catch {
      packageManifestCache.set(manifestPath, null);
      return undefined;
    }
  };
  const packageManifestsFor = (containingFile: string): PackageManifest[] => {
    const manifests: PackageManifest[] = [];
    let directory = resolve(dirname(containingFile));
    const root = resolve(rootDir);
    while (isInsideRoot(root, directory)) {
      const manifest = packageManifestAt(directory);
      if (manifest) manifests.push(manifest);
      if (directory === root) break;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return manifests;
  };
  const selectedPackageConditions = (
    resolutionMode: ts.ResolutionMode,
  ): string[] =>
    [
      ...(resolutionMode === ts.ModuleKind.ESNext
        ? ["import"]
        : resolutionMode === ts.ModuleKind.CommonJS
          ? ["require"]
          : []),
      "types",
      "node",
    ].sort(compareStrings);
  const conditionInfoForEntry = (
    manifest: PackageManifest,
    entry: unknown,
    resolutionMode: ts.ResolutionMode,
  ): PackageConditionInfo | undefined => {
    if (entry === undefined || typeof entry === "string") return undefined;
    const availableConditions = [...packageConditionKeys(entry)].sort(
      compareStrings,
    );
    const selectedConditions = selectedPackageConditions(resolutionMode);
    return {
      packageJsonPath: manifest.path,
      selectedConditions,
      availableConditions,
      ambiguous: availableConditions.some(
        (condition) => !DETERMINISTIC_PACKAGE_CONDITIONS.has(condition),
      ),
    };
  };
  const packageConditionInfoFor = (
    moduleName: string,
    containingFile: string,
    resolutionMode: ts.ResolutionMode,
  ): PackageConditionInfo | undefined => {
    const manifests = packageManifestsFor(containingFile);
    if (moduleName.startsWith("#")) {
      const manifest = manifests[0];
      if (!manifest) return undefined;
      const importsMap = manifest.data.imports;
      if (
        !importsMap ||
        typeof importsMap !== "object" ||
        Array.isArray(importsMap)
      )
        return undefined;
      return conditionInfoForEntry(
        manifest,
        (importsMap as Record<string, unknown>)[moduleName],
        resolutionMode,
      );
    }

    const manifest = manifests.find(
      (candidate) =>
        candidate.data.name === packageNameForSpecifier(moduleName),
    );
    if (!manifest) return undefined;
    const exportsMap = manifest.data.exports;
    if (exportsMap === undefined) return undefined;
    const subpath = packageSubpathForSpecifier(moduleName);
    let entry: unknown;
    if (
      exportsMap &&
      typeof exportsMap === "object" &&
      !Array.isArray(exportsMap)
    ) {
      const record = exportsMap as Record<string, unknown>;
      const hasSubpathKeys = Object.keys(record).some((key) =>
        key.startsWith("."),
      );
      entry = hasSubpathKeys ? record[subpath] : record;
    } else if (subpath === ".") {
      entry = exportsMap;
    }
    return conditionInfoForEntry(manifest, entry, resolutionMode);
  };
  const resolutionModeForFile = (
    containingFile: string,
    options: ts.CompilerOptions,
    moduleResolutionHost: ts.ModuleResolutionHost,
  ): ts.ResolutionMode => {
    if (
      options.moduleResolution !== ts.ModuleResolutionKind.Node16 &&
      options.moduleResolution !== ts.ModuleResolutionKind.NodeNext
    )
      return undefined;
    return ts.getImpliedNodeFormatForFile(
      containingFile,
      undefined,
      moduleResolutionHost,
      options,
    );
  };
  const resolveModuleInfo = (
    moduleName: string,
    containingFile: string,
    moduleResolutionHost: ts.ModuleResolutionHost,
    requestedResolutionMode?: ts.ResolutionMode,
  ): ModuleResolutionInfo => {
    if (moduleName.startsWith("."))
      return {
        resolvedPath: findAllowedLocalModule(
          rootDir,
          containingFile,
          moduleName,
          sourcePaths,
        ),
      };

    const options = compilerOptionsForFile(containingFile);
    const resolutionMode =
      requestedResolutionMode ??
      resolutionModeForFile(containingFile, options, moduleResolutionHost);

    const resolved = ts.resolveModuleName(
      moduleName,
      containingFile,
      options,
      moduleResolutionHost,
      undefined,
      undefined,
      resolutionMode,
    ).resolvedModule;
    const resolvedPath =
      resolved &&
      isAllowedRelativeModulePath(
        rootDir,
        resolved.resolvedFileName,
        sourcePaths,
      )
        ? resolved.resolvedFileName
        : undefined;
    return {
      resolvedPath,
      ...(options.moduleResolution === ts.ModuleResolutionKind.Node16 ||
      options.moduleResolution === ts.ModuleResolutionKind.NodeNext
        ? {
            conditionInfo: packageConditionInfoFor(
              moduleName,
              containingFile,
              resolutionMode,
            ),
          }
        : {}),
    };
  };
  const resolveModule = (
    moduleName: string,
    containingFile: string,
    moduleResolutionHost: ts.ModuleResolutionHost,
  ): string | undefined => {
    return resolveModuleInfo(moduleName, containingFile, moduleResolutionHost)
      .resolvedPath;
  };
  const resolutionHost = (
    moduleResolutionHost: ts.ModuleResolutionHost,
    _getCompilerOptions: () => ts.CompilerOptions,
  ) => ({
    resolveModuleNames: (moduleNames: string[], containingFile: string) =>
      moduleNames.map((moduleName) => {
        const candidate = resolveModule(
          moduleName,
          containingFile,
          moduleResolutionHost,
        );
        if (!candidate) return undefined;
        return {
          resolvedFileName: candidate,
          extension: moduleExtension(candidate),
        } satisfies ts.ResolvedModuleFull;
      }),
  });

  return {
    project: new Project({
      skipFileDependencyResolution: true,
      compilerOptions: loaded.compilerOptions,
      resolutionHost,
    }),
    resolveModule: (moduleName, containingFile) =>
      resolveModule(moduleName, containingFile, safeResolutionHost),
    resolveModuleInfo: (moduleName, containingFile, resolutionMode) =>
      resolveModuleInfo(
        moduleName,
        containingFile,
        safeResolutionHost,
        resolutionMode,
      ),
  };
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
  _message: string,
  node: Node,
  detail?: string,
): void => {
  const definition = getDiagnosticDefinition(code);
  if (!definition) {
    throw new Error(`unregistered diagnostic code: ${code}`);
  }
  const location = sourcePosition(context.rootDir, node);
  const evidence = evidenceFor(context, node, `${DETECTOR_VERSION}/diagnostic`);
  const message = detail
    ? `${definition.message} ${detail}`
    : definition.message;
  const diagnostic: Diagnostic = {
    id: diagnosticKey(code, location, message),
    code,
    severity: definition.severity,
    message,
    remediation: definition.remediation,
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

const ownerFor = (context: AnalyzerContext, node: Node): GraphNode =>
  enclosingCallable(context, node)?.graphNode ??
  moduleForFile(context, node.getSourceFile());

const callerFor = (context: AnalyzerContext, call: CallExpression): GraphNode =>
  ownerFor(context, call);

const resolveImportedModule = (
  context: AnalyzerContext,
  sourceFile: SourceFile,
  specifier: string,
  specifierNode?: Node,
  resolutionMode?: ts.ResolutionMode,
): {
  target: GraphNode | undefined;
  conditionInfo?: PackageConditionInfo | undefined;
} => {
  if (specifier.startsWith(".")) {
    const candidatePath = findAllowedLocalModule(
      context.rootDir,
      sourceFile.getFilePath(),
      specifier,
      context.sourcePaths,
    );
    if (!candidatePath) return { target: undefined };
    const candidate = context.filesByPath.get(
      sourceFilePath(context.rootDir, candidatePath),
    );
    return {
      target: candidate ? moduleForFile(context, candidate) : undefined,
    };
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
  const resolution = context.resolveModuleInfo(
    specifier,
    sourceFile.getFilePath(),
    resolutionMode,
  );
  const resolvedTarget = resolution.resolvedPath
    ? context.filesByPath.get(
        sourceFilePath(context.rootDir, resolution.resolvedPath),
      )
    : undefined;
  const target = resolvedTarget ?? moduleSpecifier ?? declaredTarget;

  if (target && isInsideRoot(context.rootDir, target.getFilePath())) {
    const targetPath = sourceFilePath(context.rootDir, target.getFilePath());
    if (context.filesByPath.has(targetPath))
      return {
        target: moduleForFile(context, target),
        conditionInfo: resolution.conditionInfo,
      };
  }

  const safeSpecifier = safeModuleSpecifier(specifier);
  return {
    target: addNode(
      context,
      `module:external:${safeSpecifier}`,
      "module",
      safeSpecifier,
    ),
    conditionInfo: resolution.conditionInfo,
  };
};

const addImportEdge = (
  context: AnalyzerContext,
  sourceFile: SourceFile,
  specifierNode: Node,
  specifier: string,
  resolutionMode?: ts.ResolutionMode,
): void => {
  const resolution = resolveImportedModule(
    context,
    sourceFile,
    specifier,
    specifierNode,
    resolutionMode,
  );
  const target = resolution.target;
  if (resolution.conditionInfo?.ambiguous) {
    const selected = resolution.conditionInfo.selectedConditions.join(", ");
    const available = resolution.conditionInfo.availableConditions.join(", ");
    addDiagnostic(
      context,
      "AMBIGUOUS_PACKAGE_CONDITION",
      "Package resolution depends on an environment-specific condition branch.",
      specifierNode,
      `(selected conditions: ${selected}; available conditions: ${available})`,
    );
  }
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
    context.checkBudget();
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
      context.checkBudget();
      if (call.getExpression().getKind() === SyntaxKind.ImportKeyword) {
        const argument = call.getArguments()[0];
        if (argument && Node.isStringLiteral(argument)) {
          addImportEdge(
            context,
            sourceFile,
            argument,
            argument.getLiteralValue(),
            ts.ModuleKind.ESNext,
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
            ts.ModuleKind.CommonJS,
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
    context.checkBudget();
    const declarations = sourceFile.getDescendants().filter(isCallableNode);
    for (const declaration of declarations) {
      context.checkBudget();
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

const importedModuleFor = (expression: Expression): string | undefined => {
  const root = expressionRootNode(expression);
  if (!Node.isIdentifier(root)) return undefined;
  return root
    .getSourceFile()
    .getImportDeclarations()
    .find((declaration) =>
      importedLocalNames(declaration).includes(root.getText()),
    )
    ?.getModuleSpecifierValue();
};

const importedExportNameFor = (expression: Expression): string | undefined => {
  const root = expressionRootNode(expression);
  if (!Node.isIdentifier(root)) return undefined;
  const declaration = root
    .getSourceFile()
    .getImportDeclarations()
    .find((candidate) =>
      importedLocalNames(candidate).includes(root.getText()),
    );
  if (!declaration) return undefined;
  if (Node.isPropertyAccessExpression(expression)) {
    const namespaceImport = declaration.getNamespaceImport()?.getText();
    if (namespaceImport === root.getText()) return expression.getName();
  }
  if (declaration.getDefaultImport()?.getText() === root.getText())
    return "default";
  return declaration
    .getNamedImports()
    .find(
      (specifier) =>
        (specifier.getAliasNode()?.getText() ?? specifier.getName()) ===
        root.getText(),
    )
    ?.getName();
};

const expressionMemberName = (expression: Expression): string | undefined =>
  Node.isIdentifier(expression)
    ? expression.getText()
    : Node.isPropertyAccessExpression(expression)
      ? expression.getName()
      : undefined;

const eventEmitterConstructor = (
  context: AnalyzerContext,
  expression: Expression,
): boolean => {
  const name = expressionMemberName(expression);
  const importedName = importedExportNameFor(expression);
  return (
    (name === "EventEmitter" || importedName === "EventEmitter") &&
    EVENT_MODULES.has(importedModuleFor(expression) ?? "") &&
    !hasLocalImplementation(context, expression)
  );
};

const eventEmitterReceiver = (
  context: AnalyzerContext,
  receiver: Expression,
): boolean => {
  if (Node.isNewExpression(receiver))
    return eventEmitterConstructor(context, receiver.getExpression());

  const root = expressionRootNode(receiver);
  if (!Node.isIdentifier(root) || isBlockedImportedReference(context, root))
    return false;

  for (const declaration of declarationsFor(context, root)) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    const initializer = declaration.getInitializer();
    if (
      initializer &&
      Node.isNewExpression(initializer) &&
      eventEmitterConstructor(context, initializer.getExpression())
    ) {
      return true;
    }
  }

  return (
    !hasLocalImplementation(context, root) &&
    /\bEventEmitter\b/u.test(receiver.getType().getText())
  );
};

const asyncCallableFromExpression = (
  context: AnalyzerContext,
  expression: Node | undefined,
  fallbackName: string,
): CallableInfo | undefined => {
  if (!expression) return undefined;
  if (
    Node.isArrowFunction(expression) ||
    Node.isFunctionExpression(expression) ||
    Node.isFunctionDeclaration(expression) ||
    Node.isMethodDeclaration(expression)
  ) {
    return registerCallable(context, expression, fallbackName);
  }
  if (Node.isExpression(expression))
    return resolveCallable(context, expression);
  return undefined;
};

const queueBindingFromNew = (
  context: AnalyzerContext,
  expression: Node,
): QueueBinding | undefined => {
  if (!Node.isNewExpression(expression)) return undefined;
  const constructor = expression.getExpression();
  const module = importedModuleFor(constructor);
  if (!module || !QUEUE_CLIENT_MODULES.has(module)) return undefined;
  const name = expressionMemberName(constructor);
  const importedName = importedExportNameFor(constructor);
  const worker =
    (name === "Worker" || importedName === "Worker") && module === "bullmq";
  const queue =
    name === "Queue" ||
    importedName === "Queue" ||
    (module === "bull" && !worker);
  if (!worker && !queue) return undefined;
  return {
    kind: worker ? "worker" : "queue",
    module,
    name: literalString(expression.getArguments()[0]),
  };
};

const queueBindingForReceiver = (
  context: AnalyzerContext,
  receiver: Expression,
): QueueBinding | undefined => {
  const direct = queueBindingFromNew(context, receiver);
  if (direct) return direct;

  const root = expressionRootNode(receiver);
  if (!Node.isIdentifier(root) || isBlockedImportedReference(context, root))
    return undefined;
  for (const declaration of declarationsFor(context, root)) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    const initializer = declaration.getInitializer();
    const binding = initializer
      ? queueBindingFromNew(context, initializer)
      : undefined;
    if (binding) return binding;
  }
  return undefined;
};

const queueNode = (
  context: AnalyzerContext,
  binding: QueueBinding,
  node: Node,
): GraphNode => {
  const name = binding.name ?? "<dynamic>";
  return addNode(
    context,
    `queue:${binding.module}:${name}`,
    "queue",
    `${binding.module} ${name}`,
    sourcePosition(context.rootDir, node),
  );
};

const eventNode = (
  context: AnalyzerContext,
  eventName: string,
  node: Node,
): GraphNode =>
  addNode(
    context,
    `queue:event:${eventName}`,
    "queue",
    `event ${eventName}`,
    sourcePosition(context.rootDir, node),
  );

const callbackNode = (
  context: AnalyzerContext,
  callbackName: string,
  node: Node,
): GraphNode =>
  addNode(
    context,
    `queue:callback:${callbackName}`,
    "queue",
    `callback ${callbackName}`,
    sourcePosition(context.rootDir, node),
  );

const queueLikeReceiver = (receiver: Expression): boolean => {
  const root = expressionRootNode(receiver);
  if (!Node.isIdentifier(root)) return false;
  return /(?:queue|worker|job)/iu.test(
    `${root.getText()} ${receiver.getType().getText()}`,
  );
};

const addEventEmitterEdges = (
  context: AnalyzerContext,
  call: CallExpression,
): boolean => {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return false;
  const method = expression.getName();
  if (method !== EVENT_PUBLISH_METHOD && !EVENT_SUBSCRIBE_METHODS.has(method))
    return false;
  const receiver = expression.getExpression();
  if (!eventEmitterReceiver(context, receiver)) return false;

  const eventArgument = call.getArguments()[0];
  const eventName = literalString(eventArgument);
  if (eventName === undefined) {
    addDiagnostic(
      context,
      "UNSUPPORTED_DYNAMIC_EVENT_NAME",
      "Event name must be a literal string for a confident event edge.",
      eventArgument ?? call,
    );
    return true;
  }

  if (method === EVENT_PUBLISH_METHOD) {
    const target = eventNode(context, eventName, eventArgument ?? call);
    addEdge(
      context,
      callerFor(context, call),
      target,
      "publishes",
      evidenceFor(
        context,
        eventArgument ?? call,
        `${ASYNC_DETECTOR_VERSION}/event`,
      ),
    );
    return true;
  }

  const handlerArgument = call.getArguments()[1];
  if (!handlerArgument || literalString(handlerArgument) !== undefined) {
    addDiagnostic(
      context,
      "UNSUPPORTED_EVENT_REFLECTION",
      "Event handler must be a statically resolvable callable.",
      handlerArgument ?? call,
    );
    return true;
  }
  const handler = asyncCallableFromExpression(
    context,
    handlerArgument,
    `event:${eventName}`,
  );
  if (!handler) {
    addDiagnostic(
      context,
      "UNRESOLVED_ASYNC_HANDLER",
      "Could not resolve an asynchronous event or queue handler.",
      handlerArgument,
    );
    return true;
  }

  const target = eventNode(context, eventName, eventArgument ?? call);

  addEdge(
    context,
    callerFor(context, call),
    target,
    "subscribes",
    evidenceFor(context, call, `${ASYNC_DETECTOR_VERSION}/event`),
    "inferred",
  );
  addEdge(
    context,
    target,
    handler.graphNode,
    "calls",
    evidenceFor(context, handlerArgument, `${ASYNC_DETECTOR_VERSION}/handler`),
    "inferred",
  );
  return true;
};

const queueHandlerArgument = (
  context: AnalyzerContext,
  call: CallExpression,
): Node | undefined => {
  const argumentsList = call.getArguments();
  for (const candidate of argumentsList.slice(0, 2).reverse()) {
    if (asyncCallableFromExpression(context, candidate, "queue-handler"))
      return candidate;
  }
  return argumentsList.length > 1 ? argumentsList[1] : argumentsList[0];
};

const addQueueEdges = (
  context: AnalyzerContext,
  call: CallExpression,
): boolean => {
  const expression = call.getExpression();
  if (!Node.isPropertyAccessExpression(expression)) return false;
  const method = expression.getName();
  if (!QUEUE_METHODS.has(method)) return false;
  const receiver = expression.getExpression();
  const binding = queueBindingForReceiver(context, receiver);
  if (!binding) {
    if (!queueLikeReceiver(receiver)) return false;
    addDiagnostic(
      context,
      "UNSUPPORTED_QUEUE_CLIENT",
      "Queue client is outside the supported Bull and BullMQ registration subset.",
      call,
    );
    return true;
  }
  if (
    binding.name === undefined ||
    binding.kind === "worker" ||
    (method === "process" && binding.module !== "bull")
  ) {
    addDiagnostic(
      context,
      binding.name === undefined
        ? "UNSUPPORTED_DYNAMIC_QUEUE_NAME"
        : "UNSUPPORTED_QUEUE_CLIENT",
      binding.name === undefined
        ? "Queue name must be a literal string for a confident queue edge."
        : "Queue client method is outside the supported registration subset.",
      call,
    );
    return true;
  }

  const target = queueNode(context, binding, call);
  if (QUEUE_PUBLISH_METHODS.has(method)) {
    addEdge(
      context,
      callerFor(context, call),
      target,
      "publishes",
      evidenceFor(context, call, `${ASYNC_DETECTOR_VERSION}/queue`),
      "inferred",
    );
    return true;
  }

  const handlerArgument = queueHandlerArgument(context, call);
  if (
    !handlerArgument ||
    literalString(handlerArgument) !== undefined ||
    !asyncCallableFromExpression(context, handlerArgument, "queue-handler")
  ) {
    addDiagnostic(
      context,
      literalString(handlerArgument) !== undefined
        ? "UNSUPPORTED_CALLBACK_REFLECTION"
        : "UNRESOLVED_ASYNC_HANDLER",
      literalString(handlerArgument) !== undefined
        ? "Queue handler must be a statically resolvable callable."
        : "Could not resolve an asynchronous event or queue handler.",
      handlerArgument ?? call,
    );
    return true;
  }
  const handler = asyncCallableFromExpression(
    context,
    handlerArgument,
    "queue-handler",
  );
  if (!handler) return true;
  addEdge(
    context,
    callerFor(context, call),
    target,
    "subscribes",
    evidenceFor(context, call, `${ASYNC_DETECTOR_VERSION}/queue`),
    "inferred",
  );
  addEdge(
    context,
    target,
    handler.graphNode,
    "calls",
    evidenceFor(context, handlerArgument, `${ASYNC_DETECTOR_VERSION}/handler`),
    "inferred",
  );
  return true;
};

const asyncCallbackMethod = (
  context: AnalyzerContext,
  expression: Expression,
): string | undefined => {
  if (Node.isIdentifier(expression)) {
    if (
      ASYNC_CALLBACK_ROOTS.has(expression.getText()) &&
      !isBlockedImportedReference(context, expression) &&
      !hasLocalImplementation(context, expression)
    ) {
      return expression.getText();
    }
    return undefined;
  }
  if (
    Node.isPropertyAccessExpression(expression) &&
    expression.getName() === "nextTick"
  ) {
    const receiver = expression.getExpression();
    if (
      Node.isIdentifier(receiver) &&
      receiver.getText() === "process" &&
      !isBlockedImportedReference(context, receiver) &&
      !hasLocalImplementation(context, receiver)
    ) {
      return "process.nextTick";
    }
  }
  return undefined;
};

const addAsyncCallbackEdges = (
  context: AnalyzerContext,
  call: CallExpression,
): boolean => {
  const method = asyncCallbackMethod(context, call.getExpression());
  if (!method) return false;
  const handlerArgument = call.getArguments()[0];
  if (!handlerArgument || literalString(handlerArgument) !== undefined) {
    addDiagnostic(
      context,
      "UNSUPPORTED_CALLBACK_REFLECTION",
      "Asynchronous callback must be a statically resolvable callable.",
      handlerArgument ?? call,
    );
    return true;
  }
  const handler = asyncCallableFromExpression(
    context,
    handlerArgument,
    `callback:${method}`,
  );
  if (!handler) {
    addDiagnostic(
      context,
      "UNRESOLVED_ASYNC_HANDLER",
      "Could not resolve an asynchronous event or queue handler.",
      handlerArgument,
    );
    return true;
  }
  const target = callbackNode(context, method, call);
  addEdge(
    context,
    callerFor(context, call),
    target,
    "subscribes",
    evidenceFor(context, call, `${ASYNC_DETECTOR_VERSION}/callback`),
    "inferred",
  );
  addEdge(
    context,
    target,
    handler.graphNode,
    "calls",
    evidenceFor(context, handlerArgument, `${ASYNC_DETECTOR_VERSION}/handler`),
    "inferred",
  );
  return true;
};

const callbackInvocation = (
  target: CallableInfo,
  parameter: Node,
): CallExpression | undefined => {
  if (!Node.isParameterDeclaration(parameter)) return undefined;
  const name = parameter.getName();
  const declarationKeyValue = declarationKey(parameter);
  return target.node
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((candidate) => {
      const expression = candidate.getExpression();
      if (expressionRootName(expression) !== name) return false;
      return declarationsForNode(expression).some(
        (declaration) => declarationKey(declaration) === declarationKeyValue,
      );
    });
};

const declarationsForNode = (expression: Expression): Node[] =>
  symbolDeclarations(expression);

const addLocalCallbackEdges = (
  context: AnalyzerContext,
  call: CallExpression,
  target: CallableInfo,
): void => {
  const parameters = target.node.getParameters();
  call.getArguments().forEach((argument, index) => {
    const parameter = parameters[index];
    if (!parameter) return;
    const invocation = callbackInvocation(target, parameter);
    if (!invocation) return;
    const handler = asyncCallableFromExpression(
      context,
      argument,
      "callback-handler",
    );
    if (!handler) {
      addDiagnostic(
        context,
        literalString(argument) !== undefined
          ? "UNSUPPORTED_CALLBACK_REFLECTION"
          : "UNRESOLVED_ASYNC_HANDLER",
        literalString(argument) !== undefined
          ? "Callback target must be a statically resolvable callable."
          : "Could not resolve an asynchronous event or queue handler.",
        argument,
      );
      return;
    }
    addEdge(
      context,
      target.graphNode,
      handler.graphNode,
      "calls",
      evidenceFor(context, argument, `${ASYNC_DETECTOR_VERSION}/callback`),
      "inferred",
    );
    addEdge(
      context,
      target.graphNode,
      handler.graphNode,
      "calls",
      evidenceFor(context, invocation, `${ASYNC_DETECTOR_VERSION}/callback`),
      "inferred",
    );
  });
};

const addWorkerConstructorEdges = (
  context: AnalyzerContext,
  expression: Node,
): boolean => {
  const binding = queueBindingFromNew(context, expression);
  if (!binding || binding.kind !== "worker") return false;
  if (!Node.isNewExpression(expression)) return false;
  if (binding.name === undefined) {
    addDiagnostic(
      context,
      "UNSUPPORTED_DYNAMIC_QUEUE_NAME",
      "Queue name must be a literal string for a confident queue edge.",
      expression,
    );
    return true;
  }
  const handlerArgument = expression.getArguments()[1];
  if (!handlerArgument || literalString(handlerArgument) !== undefined) {
    addDiagnostic(
      context,
      "UNSUPPORTED_CALLBACK_REFLECTION",
      "Queue handler must be a statically resolvable callable.",
      handlerArgument ?? expression,
    );
    return true;
  }
  const handler = asyncCallableFromExpression(
    context,
    handlerArgument,
    "queue-worker",
  );
  if (!handler) {
    addDiagnostic(
      context,
      "UNRESOLVED_ASYNC_HANDLER",
      "Could not resolve an asynchronous event or queue handler.",
      handlerArgument,
    );
    return true;
  }
  const target = queueNode(context, binding, expression);
  addEdge(
    context,
    ownerFor(context, expression),
    target,
    "subscribes",
    evidenceFor(context, expression, `${ASYNC_DETECTOR_VERSION}/queue`),
    "inferred",
  );
  addEdge(
    context,
    target,
    handler.graphNode,
    "calls",
    evidenceFor(context, handlerArgument, `${ASYNC_DETECTOR_VERSION}/handler`),
    "inferred",
  );
  return true;
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
    if (declaration.getSourceFile().getFilePath().endsWith(".d.ts"))
      return false;
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

const fastifyFactoryNamesByFile = new WeakMap<
  SourceFile,
  ReadonlySet<string>
>();

const isImportedFastifyFactory = (
  context: AnalyzerContext,
  expression: Expression,
): boolean => {
  const root = expressionRootNode(expression);
  if (!Node.isIdentifier(root) || isBlockedImportedReference(context, root))
    return false;
  const sourceFile = root.getSourceFile();
  let names = fastifyFactoryNamesByFile.get(sourceFile);
  if (!names) {
    const imported = new Set<string>();
    for (const declaration of sourceFile.getImportDeclarations()) {
      if (declaration.getModuleSpecifierValue() !== "fastify") continue;
      const defaultImport = declaration.getDefaultImport()?.getText();
      if (defaultImport) imported.add(defaultImport);
      const namespaceImport = declaration.getNamespaceImport()?.getText();
      if (namespaceImport) imported.add(namespaceImport);
      for (const specifier of declaration.getNamedImports())
        imported.add(
          specifier.getAliasNode()?.getText() ?? specifier.getName(),
        );
    }
    names = imported;
    fastifyFactoryNamesByFile.set(sourceFile, names);
  }
  return names.has(root.getText());
};

const isVerifiedFastifyReceiver = (
  context: AnalyzerContext,
  receiver: Expression,
): boolean => {
  const root = expressionRootNode(receiver);
  if (isBlockedImportedReference(context, root)) return false;
  const declarations = declarationsFor(context, root);
  for (const declaration of declarations) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    const initializer = declaration.getInitializer();
    if (
      initializer &&
      Node.isCallExpression(initializer) &&
      isImportedFastifyFactory(context, initializer.getExpression())
    )
      return true;
  }
  const typeText = receiver.getType().getText();
  if (/FastifyInstance/u.test(typeText)) return true;
  return (
    !hasLocalImplementation(context, root) &&
    Node.isIdentifier(root) &&
    /^(?:app|server|fastify)$/iu.test(root.getText())
  );
};

const isFrameworkCall = (
  context: AnalyzerContext,
  call: CallExpression,
): boolean => {
  const expression = call.getExpression();
  if (isVerifiedFetch(context, expression)) return true;
  if (isImportedFastifyFactory(context, expression)) return true;
  if (Node.isElementAccessExpression(expression)) {
    return (
      isVerifiedExpressReceiver(context, expression.getExpression()) ||
      isVerifiedFastifyReceiver(context, expression.getExpression())
    );
  }
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
  if (
    (isFastifyRouteMethod(method) || method === "register") &&
    isVerifiedFastifyReceiver(context, receiver)
  ) {
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
    addLocalCallbackEdges(context, call, target);
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

  if (
    declarationsFor(context, expression).some((declaration) =>
      Node.isParameterDeclaration(declaration),
    )
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
    isPotentialMiddlewareHandler: (handler) =>
      resolveCallable(context, handler) !== undefined,
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

const addFastifyRouteEdges = (
  context: AnalyzerContext,
  call: CallExpression,
): boolean => {
  const routeResult = analyzeFastifyRouteCall(call, {
    isFastifyReceiver: (receiver) =>
      isVerifiedFastifyReceiver(context, receiver),
  });
  if (!routeResult) return false;

  for (const diagnostic of routeResult.diagnostics) {
    addDiagnostic(
      context,
      diagnostic.code,
      diagnostic.message,
      diagnostic.node,
    );
  }

  for (const registration of routeResult.registrations) {
    const endpoint = addNode(
      context,
      `endpoint:${registration.method}:${registration.path}`,
      "endpoint",
      `${registration.method} ${registration.path}`,
      sourcePosition(context.rootDir, call),
    );

    for (const handler of registration.handlers) {
      const callable = resolveCallable(context, handler);
      if (callable) {
        addEdge(
          context,
          endpoint,
          callable.graphNode,
          "calls",
          evidenceFor(
            context,
            call,
            `${FASTIFY_DETECTOR_VERSION}/fastify-route`,
          ),
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
          registration.method,
          registration.path,
        );
        addEdge(
          context,
          endpoint,
          inline.graphNode,
          "calls",
          evidenceFor(
            context,
            call,
            `${FASTIFY_DETECTOR_VERSION}/fastify-route`,
          ),
          "inferred",
        );
        continue;
      }

      addDiagnostic(
        context,
        "UNRESOLVED_FASTIFY_HANDLER",
        "Could not resolve a Fastify route handler.",
        handler,
      );
    }
  }

  return true;
};

const analyzeCalls = (context: AnalyzerContext): void => {
  for (const sourceFile of context.sourceFiles) {
    context.checkBudget();
    for (const expression of sourceFile.getDescendantsOfKind(
      SyntaxKind.NewExpression,
    )) {
      context.checkBudget();
      addWorkerConstructorEdges(context, expression);
    }
    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      context.checkBudget();
      if (addEventEmitterEdges(context, call)) continue;
      if (addQueueEdges(context, call)) continue;
      if (addAsyncCallbackEdges(context, call)) continue;
      if (
        context.extractors.has("fastify") &&
        addFastifyRouteEdges(context, call)
      )
        continue;
      if (context.extractors.has("express") && addRouteEdges(context, call))
        continue;
      if (addHttpEdge(context, call)) continue;
      if (addPrismaEdge(context, call)) continue;
      addCallEdge(context, call);
    }

    for (const elementAccess of sourceFile.getDescendantsOfKind(
      SyntaxKind.ElementAccessExpression,
    )) {
      context.checkBudget();
      const receiver = elementAccess.getExpression();
      const argument = elementAccess.getArgumentExpression();
      if (isVerifiedExpressReceiver(context, receiver)) {
        addDiagnostic(
          context,
          "UNSUPPORTED_DYNAMIC_ROUTE",
          "Express route method must be a statically named property.",
          elementAccess,
        );
      } else if (isVerifiedFastifyReceiver(context, receiver)) {
        addDiagnostic(
          context,
          "UNSUPPORTED_DYNAMIC_FASTIFY_ROUTE",
          "Fastify route method must be a statically named property.",
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
  const requestedRootDir = resolve(options.rootDir);
  if (
    !existsSync(requestedRootDir) ||
    !lstatSync(requestedRootDir).isDirectory()
  ) {
    throw new Error(
      `TypeScript analyzer root is not a directory: ${options.rootDir}`,
    );
  }
  const rootDir = realpathSync(requestedRootDir);

  const extractors = new Set<TypeScriptExtractor>(
    options.extractors ?? ["typescript", "express"],
  );
  if (!extractors.has("typescript")) {
    throw new Error('the "typescript" extractor is required for this analyzer');
  }
  const resources: ResourceLimits = {
    ...DEFAULT_RESOURCE_LIMITS,
    ...options.resources,
  };
  const checkBudget = createResourceBudget({
    maxMemoryBytes: resources.maxMemoryBytes,
    maxWallClockMs: resources.maxWallClockMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  checkBudget();
  const loaded = loadedProjectSources(
    rootDir,
    options.tsconfigPath,
    options.include ?? ["."],
    options.exclude ?? [],
    resources,
    checkBudget,
  );
  const paths = loaded.sourcePaths.map((path) => resolve(path));
  const sourcePaths = new Set(paths);
  const projectSetup = projectFor(rootDir, loaded, sourcePaths, checkBudget);
  const project = projectSetup.project;
  for (const path of loaded.projectPaths) project.addSourceFileAtPath(path);

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
    paths.map((path) => {
      checkBudget();
      return [sourceFilePath(rootDir, path), hashBytes(readFileSync(path))];
    }),
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
    resolveModule: projectSetup.resolveModule,
    resolveModuleInfo: projectSetup.resolveModuleInfo,
    rootDir,
    sourcePaths,
    sourceFiles,
    extractors,
    checkBudget,
  };
};

export const analyzeTypeScriptRepository = (
  input: TypeScriptAnalyzerOptions | string,
): TypeScriptAnalyzerResult => {
  const options: TypeScriptAnalyzerOptions =
    typeof input === "string" ? { rootDir: input } : input;
  const context = createContext(options);
  context.checkBudget();
  for (const sourceFile of context.sourceFiles) {
    context.checkBudget();
    moduleForFile(context, sourceFile);
  }
  registerCallables(context);
  importSourceFiles(context);
  analyzeCalls(context);
  context.checkBudget();

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

  const result: TypeScriptAnalyzerResult = {
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

  // ts-morph keeps compiler ASTs attached to the Project. The graph result is
  // fully materialized above, so detach those source files before returning;
  // repeated adapter analyses must not retain an entire compiler project.
  for (const sourceFile of context.project.getSourceFiles())
    context.project.removeSourceFile(sourceFile);

  return result;
};

export const analyzeTypeScriptProject = analyzeTypeScriptRepository;
export const analyzeTypeScript = analyzeTypeScriptRepository;
