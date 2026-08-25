import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  ADAPTER_API_VERSION,
  ADAPTER_CONTRACT,
  ADAPTER_MEDIA_TYPE,
  CAPABILITY_REGISTRY_VERSION,
  parseAdapterManifest,
  parseAdapterOutput,
  type AdapterInput,
  type CartographAdapter,
  type Evidence,
  type GraphEdge,
  type GraphNode,
} from "../core/index.js";
import { createResourceBudget, ResourceLimitError } from "../resources.js";

const RUST_DETECTOR_VERSION = "cartograph.rust@0.1.0";

export const RUST_ADAPTER_MANIFEST = parseAdapterManifest({
  apiVersion: ADAPTER_API_VERSION,
  contract: ADAPTER_CONTRACT,
  mediaType: ADAPTER_MEDIA_TYPE,
  id: "cartograph.rust",
  version: "0.1.0",
  compatibilityVersion: ADAPTER_API_VERSION,
  capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
  graphSchemaVersion: 1,
  stability: "stable",
  capabilities: [
    {
      id: "rust.modules",
      description:
        "Extracts a bounded Rust module, function, local-import, and local-call graph without executing Rust code.",
      diagnosticCodes: ["UNRESOLVED_RUST_IMPORT", "UNRESOLVED_RUST_CALL"],
      confidence: ["certain", "inferred"],
      examples: [
        "Rust mod/use declarations and function declarations produce portable module and function relationships.",
        "Missing local modules and calls outside the bounded symbol set remain explicit diagnostics.",
      ],
    },
    {
      id: "rust.http",
      description:
        "Extracts literal reqwest and bounded client HTTP destinations from Rust function bodies.",
      diagnosticCodes: ["UNSUPPORTED_RUST_DYNAMIC_HTTP_DESTINATION"],
      confidence: ["inferred"],
      examples: [
        "A literal reqwest or client URL produces an evidence-backed requests edge to an origin node.",
        "A runtime-selected URL remains an explicit diagnostic and never becomes a guessed edge.",
      ],
    },
    {
      id: "rust.sql",
      description:
        "Extracts literal SQL table reads and writes from bounded sqlx query calls.",
      diagnosticCodes: ["UNSUPPORTED_RUST_DYNAMIC_QUERY"],
      confidence: ["inferred"],
      examples: [
        "Literal SELECT, INSERT, UPDATE, and DELETE statements produce database table relationships.",
        "Dynamic SQL strings or statements without a recognizable table remain diagnostics.",
      ],
    },
  ],
  execution: {
    filesystem: "source-read-only",
    network: false,
    childProcess: false,
    dynamicModuleLoading: false,
    repositoryCodeExecution: false,
  },
});

type RustFile = {
  absolutePath: string;
  path: string;
  content: string;
  contentHash: string;
};

type RustFunction = {
  file: RustFile;
  name: string;
  declarationOffset: number;
  bodyStart: number;
  bodyEnd: number;
  node: GraphNode;
};

type RustAnalysis = {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  diagnostics: Map<
    string,
    {
      id: string;
      code: string;
      severity: "warning";
      message: string;
      remediation: string;
      nodeId?: string;
      evidence: Evidence[];
    }
  >;
  evidence: Map<string, Evidence>;
};

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".cartograph",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

const RUST_FILE_PATTERN = /\.rs$/u;
const RUST_IDENTIFIER = "[A-Za-z_][A-Za-z0-9_]*";
const RUST_KEYWORDS = new Set([
  "async",
  "else",
  "for",
  "if",
  "loop",
  "match",
  "return",
  "while",
]);
const RUST_CALL_EXCLUSIONS = new Set([
  "assert",
  "assert_eq",
  "debug_assert",
  "format",
  "get",
  "panic",
  "post",
  "println",
  "query",
  "query_as",
  "todo",
  "unimplemented",
  "vec",
]);

const isInside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

const portablePath = (root: string, absolutePath: string): string => {
  const value = relative(root, absolutePath).replaceAll("\\", "/");
  return value.length > 0 ? value : ".";
};

const normalizedRelative = (value: string): string | undefined => {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === "..")
  )
    return undefined;
  const compact = normalized
    .split("/")
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
  return compact.length > 0 ? compact : ".";
};

const sourceRoots = (root: string, include: readonly string[]): string[] => {
  const roots = include.map((entry) => {
    const normalized = normalizedRelative(entry);
    if (!normalized)
      throw new Error(`Rust include escapes repository: ${entry}`);
    const candidate = resolve(root, normalized);
    if (!isInside(root, candidate))
      throw new Error(`Rust include escapes repository: ${entry}`);
    return candidate;
  });
  return [...new Set(roots)].sort();
};

const collectRustFiles = (
  root: string,
  include: readonly string[],
  exclude: readonly string[],
  input: AdapterInput,
  checkBudget: () => void,
): RustFile[] => {
  const excluded = new Set(
    exclude
      .map(normalizedRelative)
      .filter((value): value is string => value !== undefined),
  );
  const files = new Map<string, RustFile>();
  const visit = (directory: string): void => {
    checkBudget();
    if (!isInside(root, directory)) return;
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      checkBudget();
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      const path = portablePath(root, absolutePath);
      if (
        [...excluded].some(
          (prefix) => path === prefix || path.startsWith(`${prefix}/`),
        )
      )
        continue;
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !RUST_FILE_PATTERN.test(entry.name)) continue;
      if (files.size >= input.resources.maxFiles)
        throw new ResourceLimitError(
          `Rust adapter exceeded the ${input.resources.maxFiles} file ceiling`,
        );
      const bytes = readFileSync(absolutePath);
      if (bytes.byteLength > input.resources.maxFileBytes)
        throw new ResourceLimitError(
          `Rust adapter file ${path} exceeded the ${input.resources.maxFileBytes} byte ceiling`,
        );
      const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      files.set(path, {
        absolutePath,
        path,
        content: bytes.toString("utf8"),
        contentHash,
      });
    }
  };

  for (const candidate of sourceRoots(root, include)) {
    if (!existsSync(candidate) || !lstatSync(candidate).isDirectory()) continue;
    visit(candidate);
  }
  const result = [...files.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const sourceBytes = result.reduce(
    (total, file) => total + Buffer.byteLength(file.content, "utf8"),
    0,
  );
  if (sourceBytes > input.resources.maxSourceBytes)
    throw new ResourceLimitError(
      `Rust adapter source exceeded the ${input.resources.maxSourceBytes} byte ceiling`,
    );
  return result;
};

const locationAt = (file: RustFile, offset: number) => {
  const prefix = file.content.slice(0, Math.max(0, offset));
  const line = prefix.split("\n").length;
  const lastBreak = prefix.lastIndexOf("\n");
  return { path: file.path, line, column: offset - lastBreak };
};

const evidenceFor = (
  analysis: RustAnalysis,
  file: RustFile,
  offset: number,
  category: string,
): Evidence => {
  const location = locationAt(file, offset);
  const id = `source:${file.path}:${location.line}:${location.column}:${category}`;
  const evidence: Evidence = {
    id,
    kind: "source",
    path: file.path,
    line: location.line,
    column: location.column,
    detector: `${RUST_DETECTOR_VERSION}/${category}`,
    contentHash: file.contentHash,
  };
  analysis.evidence.set(id, evidence);
  return evidence;
};

const addNode = (
  analysis: RustAnalysis,
  stableKey: string,
  kind: GraphNode["kind"],
  name: string,
  file?: RustFile,
  offset = 0,
): GraphNode => {
  const existing = analysis.nodes.get(stableKey);
  if (existing) return existing;
  const node: GraphNode = {
    id: stableKey,
    stableKey,
    kind,
    name,
    language: "rust",
    ...(file ? { location: locationAt(file, offset) } : {}),
  };
  analysis.nodes.set(stableKey, node);
  return node;
};

const addEdge = (
  analysis: RustAnalysis,
  from: GraphNode,
  to: GraphNode,
  kind: GraphEdge["kind"],
  evidence: Evidence,
  confidence: GraphEdge["confidence"] = "inferred",
): void => {
  const key = `${from.id}|${to.id}|${kind}`;
  const existing = analysis.edges.get(key);
  if (!existing) {
    analysis.edges.set(key, {
      from: from.id,
      to: to.id,
      kind,
      confidence,
      evidence: [evidence],
    });
    return;
  }
  if (!existing.evidence.some((candidate) => candidate.id === evidence.id))
    existing.evidence.push(evidence);
  if (existing.confidence !== "certain" && confidence === "certain")
    existing.confidence = confidence;
};

const diagnosticDefinition = (code: string) => {
  switch (code) {
    case "UNSUPPORTED_RUST_DYNAMIC_HTTP_DESTINATION":
      return {
        message: "Rust HTTP destination must be a literal string.",
        remediation:
          "Use a literal reqwest or client URL, or review the runtime destination manually.",
      };
    case "UNSUPPORTED_RUST_DYNAMIC_QUERY":
      return {
        message: "Rust SQL query must contain a literal recognizable table.",
        remediation:
          "Use a literal SQL statement with a table name, or review the runtime query manually.",
      };
    case "UNRESOLVED_RUST_IMPORT":
      return {
        message:
          "Rust local module could not be resolved within the source root.",
        remediation:
          "Keep the module declaration inside the analyzed source root, or review the import manually.",
      };
    case "UNRESOLVED_RUST_CALL":
      return {
        message: "Rust call target is outside the bounded local symbol set.",
        remediation:
          "Review the call target manually or provide a bounded local declaration.",
      };
    default:
      throw new Error(`unregistered Rust diagnostic code: ${code}`);
  }
};

const addDiagnostic = (
  analysis: RustAnalysis,
  code: string,
  file: RustFile,
  offset: number,
  nodeId?: string,
): void => {
  const evidence = evidenceFor(analysis, file, offset, "diagnostic");
  const definition = diagnosticDefinition(code);
  const location = locationAt(file, offset);
  const id = `diagnostic:${code}:${file.path}:${location.line}:${location.column}`;
  analysis.diagnostics.set(id, {
    id,
    code,
    severity: "warning",
    message: definition.message,
    remediation: definition.remediation,
    ...(nodeId ? { nodeId } : {}),
    evidence: [evidence],
  });
};

const matchingBrace = (content: string, open: number): number => {
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = open; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return content.length;
};

const literalString = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed[0] !== '"' || !trimmed.endsWith('"'))
    return undefined;
  return trimmed.slice(1, -1).replaceAll('\\"', '"');
};

const safeOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
};

const localModuleTarget = (
  file: RustFile,
  moduleName: string,
  filesByPath: Map<string, RustFile>,
): RustFile | undefined => {
  const directory = dirname(file.path);
  const stem = basename(file.path, extname(file.path));
  const candidates = [
    join(directory, `${moduleName}.rs`),
    join(directory, stem, "mod.rs"),
  ];
  return candidates
    .map((candidate) => filesByPath.get(candidate))
    .find(Boolean);
};

const functionBody = (
  file: RustFile,
  declarationEnd: number,
): { bodyStart: number; bodyEnd: number } => {
  const open = file.content.indexOf("{", declarationEnd);
  if (open < 0) return { bodyStart: declarationEnd, bodyEnd: declarationEnd };
  return { bodyStart: open + 1, bodyEnd: matchingBrace(file.content, open) };
};

const functionPattern = new RegExp(
  `^\\s*(?:(?:pub(?:\\([^)]*\\))?|async|unsafe|extern(?:\\s+"[^"]+")?)\\s+)*fn\\s+(${RUST_IDENTIFIER})\\s*\\(`,
  "gmu",
);

const modulePattern = new RegExp(
  `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+(${RUST_IDENTIFIER})\\s*;`,
  "gmu",
);

const usePattern = /^\s*(?:pub\s+)?use\s+([^;]+);/gmu;

const addRustImport = (
  analysis: RustAnalysis,
  file: RustFile,
  rawSpecifier: string,
  offset: number,
  filesByPath: Map<string, RustFile>,
): void => {
  const specifier = rawSpecifier.replaceAll(/\s+/gu, "");
  const owner = analysis.nodes.get(`module:${file.path}`);
  if (!owner) return;
  if (specifier.startsWith("crate::")) {
    const moduleName = specifier.slice("crate::".length).split("::")[0];
    if (!moduleName) {
      addDiagnostic(analysis, "UNRESOLVED_RUST_IMPORT", file, offset, owner.id);
      return;
    }
    const targetFile = localModuleTarget(file, moduleName, filesByPath);
    if (!targetFile) {
      addDiagnostic(analysis, "UNRESOLVED_RUST_IMPORT", file, offset, owner.id);
      return;
    }
    const target = analysis.nodes.get(`module:${targetFile.path}`);
    if (target)
      addEdge(
        analysis,
        owner,
        target,
        "imports",
        evidenceFor(analysis, file, offset, "import"),
        "certain",
      );
    return;
  }
  const target = addNode(
    analysis,
    "module:external:<redacted-module>",
    "module",
    "<redacted-module>",
  );
  addEdge(
    analysis,
    owner,
    target,
    "imports",
    evidenceFor(analysis, file, offset, "import"),
    "certain",
  );
};

const addHttpEdges = (
  analysis: RustAnalysis,
  owner: GraphNode,
  file: RustFile,
  body: string,
  bodyOffset: number,
): void => {
  const pattern =
    /(?:reqwest::(?:get|post|put|delete)|client\.(?:get|post|put|delete))\s*\(\s*([^,)]+)/gmu;
  for (const match of body.matchAll(pattern)) {
    const offset = bodyOffset + (match.index ?? 0);
    const argument = match[1] ?? "";
    const destination = literalString(argument);
    if (!destination) {
      addDiagnostic(
        analysis,
        "UNSUPPORTED_RUST_DYNAMIC_HTTP_DESTINATION",
        file,
        offset,
        owner.id,
      );
      continue;
    }
    const origin = safeOrigin(destination);
    if (!origin) {
      addDiagnostic(
        analysis,
        "UNSUPPORTED_RUST_DYNAMIC_HTTP_DESTINATION",
        file,
        offset,
        owner.id,
      );
      continue;
    }
    const target = addNode(
      analysis,
      `external_service:${origin}`,
      "external_service",
      origin,
    );
    addEdge(
      analysis,
      owner,
      target,
      "requests",
      evidenceFor(analysis, file, offset, "http"),
      "inferred",
    );
  }
};

const addSqlEdges = (
  analysis: RustAnalysis,
  owner: GraphNode,
  file: RustFile,
  body: string,
  bodyOffset: number,
): void => {
  const pattern = /sqlx::query(?:_as)?!?\s*\(\s*([^,)]+)/gmu;
  for (const match of body.matchAll(pattern)) {
    const offset = bodyOffset + (match.index ?? 0);
    const query = literalString(match[1] ?? "");
    if (!query) {
      addDiagnostic(
        analysis,
        "UNSUPPORTED_RUST_DYNAMIC_QUERY",
        file,
        offset,
        owner.id,
      );
      continue;
    }
    const operations = [
      {
        pattern: /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/giu,
        kind: "reads" as const,
      },
      {
        pattern: /\bINSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/giu,
        kind: "writes" as const,
      },
      {
        pattern: /\bUPDATE\s+([A-Za-z_][A-Za-z0-9_]*)/giu,
        kind: "writes" as const,
      },
      {
        pattern: /\bDELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/giu,
        kind: "writes" as const,
      },
    ];
    let matched = false;
    for (const operation of operations) {
      for (const tableMatch of query.matchAll(operation.pattern)) {
        matched = true;
        const table = tableMatch[1];
        if (!table) continue;
        const target = addNode(
          analysis,
          `database_table:${table.toLowerCase()}`,
          "database_table",
          table.toLowerCase(),
        );
        addEdge(
          analysis,
          owner,
          target,
          operation.kind,
          evidenceFor(analysis, file, offset, "sql"),
          "inferred",
        );
      }
    }
    if (!matched)
      addDiagnostic(
        analysis,
        "UNSUPPORTED_RUST_DYNAMIC_QUERY",
        file,
        offset,
        owner.id,
      );
  }
};

const addCallEdges = (
  analysis: RustAnalysis,
  owner: RustFunction,
  body: string,
  bodyOffset: number,
  functionsByName: Map<string, RustFunction>,
): void => {
  const pattern = new RegExp(
    `(?:crate::|self::)?(${RUST_IDENTIFIER})\\s*\\(`,
    "gmu",
  );
  for (const match of body.matchAll(pattern)) {
    const name = match[1];
    if (!name || RUST_KEYWORDS.has(name) || RUST_CALL_EXCLUSIONS.has(name))
      continue;
    const target = functionsByName.get(name);
    const offset = bodyOffset + (match.index ?? 0);
    if (!target) {
      if (match[0]?.startsWith("crate::") || match[0]?.startsWith("self::"))
        addDiagnostic(
          analysis,
          "UNRESOLVED_RUST_CALL",
          owner.file,
          offset,
          owner.node.id,
        );
      continue;
    }
    addEdge(
      analysis,
      owner.node,
      target.node,
      "calls",
      evidenceFor(analysis, owner.file, offset, "call"),
      "certain",
    );
  }
};

const analyzeRust = (input: AdapterInput) => {
  const root = resolve(input.source.rootDir);
  if (!existsSync(root) || !lstatSync(root).isDirectory())
    throw new Error(
      `Rust adapter source root is not a directory: ${input.source.rootDir}`,
    );
  const checkBudget = createResourceBudget({
    maxMemoryBytes: input.resources.maxMemoryBytes,
    maxWallClockMs: input.resources.maxWallClockMs,
  });
  checkBudget();
  const files = collectRustFiles(
    root,
    input.source.include,
    input.source.exclude,
    input,
    checkBudget,
  );
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const analysis: RustAnalysis = {
    nodes: new Map(),
    edges: new Map(),
    diagnostics: new Map(),
    evidence: new Map(),
  };
  const functions: RustFunction[] = [];
  const functionsByName = new Map<string, RustFunction[]>();

  for (const file of files) {
    checkBudget();
    const module = addNode(
      analysis,
      `module:${file.path}`,
      "module",
      file.path,
      file,
      0,
    );
    for (const match of file.content.matchAll(functionPattern)) {
      const name = match[1];
      if (!name) continue;
      const declarationOffset = match.index ?? 0;
      const body = functionBody(file, declarationOffset + match[0].length);
      const node = addNode(
        analysis,
        `function:${file.path}:${name}`,
        "function",
        name,
        file,
        declarationOffset,
      );
      addEdge(
        analysis,
        module,
        node,
        "contains",
        evidenceFor(analysis, file, declarationOffset, "function"),
        "certain",
      );
      const functionInfo: RustFunction = {
        file,
        name,
        declarationOffset,
        bodyStart: body.bodyStart,
        bodyEnd: body.bodyEnd,
        node,
      };
      functions.push(functionInfo);
      const namedFunctions = functionsByName.get(name) ?? [];
      namedFunctions.push(functionInfo);
      functionsByName.set(name, namedFunctions);
    }
  }

  for (const file of files) {
    checkBudget();
    const module = analysis.nodes.get(`module:${file.path}`);
    if (!module) continue;
    for (const match of file.content.matchAll(modulePattern)) {
      const moduleName = match[1];
      if (!moduleName) continue;
      const offset = match.index ?? 0;
      const targetFile = localModuleTarget(file, moduleName, filesByPath);
      if (!targetFile) {
        addDiagnostic(
          analysis,
          "UNRESOLVED_RUST_IMPORT",
          file,
          offset,
          module.id,
        );
        continue;
      }
      const target = analysis.nodes.get(`module:${targetFile.path}`);
      if (target)
        addEdge(
          analysis,
          module,
          target,
          "imports",
          evidenceFor(analysis, file, offset, "mod"),
          "certain",
        );
    }

    for (const match of file.content.matchAll(usePattern)) {
      addRustImport(
        analysis,
        file,
        match[1] ?? "",
        match.index ?? 0,
        filesByPath,
      );
    }
  }

  const uniquelyNamedFunctions = new Map<string, RustFunction>();
  for (const [name, namedFunctions] of functionsByName)
    if (namedFunctions.length === 1) {
      const [functionInfo] = namedFunctions;
      if (functionInfo) uniquelyNamedFunctions.set(name, functionInfo);
    }

  for (const functionInfo of functions) {
    checkBudget();
    const body = functionInfo.file.content.slice(
      functionInfo.bodyStart,
      functionInfo.bodyEnd,
    );
    addHttpEdges(
      analysis,
      functionInfo.node,
      functionInfo.file,
      body,
      functionInfo.bodyStart,
    );
    addSqlEdges(
      analysis,
      functionInfo.node,
      functionInfo.file,
      body,
      functionInfo.bodyStart,
    );
    addCallEdges(
      analysis,
      functionInfo,
      body,
      functionInfo.bodyStart,
      uniquelyNamedFunctions,
    );
  }

  const revision = input.source.revision ?? { commitSha: "rust-adapter" };
  return parseAdapterOutput({
    apiVersion: ADAPTER_API_VERSION,
    graph: {
      schemaVersion: 1,
      capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
      revision,
      nodes: [...analysis.nodes.values()].sort((left, right) =>
        left.stableKey.localeCompare(right.stableKey),
      ),
      edges: [...analysis.edges.values()].sort((left, right) =>
        `${left.from}|${left.to}|${left.kind}`.localeCompare(
          `${right.from}|${right.to}|${right.kind}`,
        ),
      ),
      diagnostics: [...analysis.diagnostics.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    },
    evidence: [...analysis.evidence.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    diagnostics: [],
    capability: RUST_ADAPTER_MANIFEST,
  });
};

export const createRustAdapter = (): CartographAdapter => ({
  manifest: RUST_ADAPTER_MANIFEST,
  analyze(input) {
    return analyzeRust(input);
  },
});
