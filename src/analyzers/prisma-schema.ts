import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

import type { ResourceLimits } from "../core/index.js";
import { ResourceLimitError } from "../resources.js";

export const PRISMA_SCHEMA_DETECTOR = "cartograph.prisma-schema@1";

const SUPPORTED_DATASOURCE_PROVIDERS = new Set([
  "cockroachdb",
  "mongodb",
  "mysql",
  "postgresql",
  "sqlite",
  "sqlserver",
]);
const SUPPORTED_GENERATOR_PROVIDERS = new Set([
  "prisma-client",
  "prisma-client-js",
]);
const SCALAR_TYPES = new Set([
  "BigInt",
  "Boolean",
  "Bytes",
  "DateTime",
  "Decimal",
  "Float",
  "Int",
  "Json",
  "String",
]);

export type PrismaSchemaSource = {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly contentHash: string;
};

export type PrismaDatasource = {
  readonly name: string;
  readonly provider?: string;
  readonly source: PrismaSchemaSource;
  readonly providerSource: PrismaSchemaSource;
};

export type PrismaRelation = {
  readonly model: string;
  readonly field: string;
  readonly targetModel: string;
  readonly source: PrismaSchemaSource;
};

export type PrismaModel = {
  readonly name: string;
  readonly source: PrismaSchemaSource;
  readonly relations: readonly PrismaRelation[];
};

export type PrismaGeneratedClient = {
  readonly name: string;
  readonly provider?: string;
  readonly outputPath?: string;
  readonly defaultOutput: boolean;
  readonly source: PrismaSchemaSource;
  readonly outputSource: PrismaSchemaSource;
};

export type PrismaPartialDiagnosticCode =
  | "AMBIGUOUS_PRISMA_SCHEMA"
  | "MULTIPLE_PRISMA_SCHEMA_FILES"
  | "UNSUPPORTED_PRISMA_GENERATED_OUTPUT"
  | "UNSUPPORTED_PRISMA_GENERATOR"
  | "UNSUPPORTED_PRISMA_PROVIDER";

export type PrismaPartialDiagnostic = {
  readonly code: PrismaPartialDiagnosticCode;
  readonly source: PrismaSchemaSource;
  readonly detail?: string;
};

export type PrismaSchemaDiscovery = {
  readonly datasources: readonly PrismaDatasource[];
  readonly models: readonly PrismaModel[];
  readonly generatedClients: readonly PrismaGeneratedClient[];
  readonly diagnostics: readonly PrismaPartialDiagnostic[];
  readonly fileHashes: ReadonlyMap<string, string>;
};

type BlockKind = "datasource" | "generator" | "model";
type ParsedField = {
  readonly name: string;
  readonly type: string;
  readonly source: PrismaSchemaSource;
};
type ParsedBlock = {
  readonly kind: BlockKind;
  readonly name: string;
  readonly source: PrismaSchemaSource;
  readonly fields: ParsedField[];
  readonly attributes: Map<
    string,
    { value: string; source: PrismaSchemaSource }
  >;
};

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

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const hashBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const normalizePath = (value: string): string =>
  value.normalize("NFC").replaceAll(sep, "/");

const relativePath = (rootDir: string, candidate: string): string => {
  const value = normalizePath(relative(rootDir, candidate));
  return value.length > 0 ? value : ".";
};

const isInsideRoot = (rootDir: string, candidate: string): boolean => {
  const root = resolve(rootDir);
  const target = resolve(candidate);
  return target === root || target.startsWith(`${root}${sep}`);
};

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
): PrismaSchemaSource => {
  const location = lineAndColumnAt(text, index);
  return {
    path,
    line: location.line,
    column: location.column,
    contentHash,
  };
};

const scalarValue = (value: string): string | undefined => {
  const normalized = value.replace(/\s+\/\/.*$/u, "").trim();
  if (
    normalized.startsWith('"') &&
    normalized.endsWith('"') &&
    normalized.length >= 2
  )
    return normalized.slice(1, -1);
  if (
    normalized.startsWith("'") &&
    normalized.endsWith("'") &&
    normalized.length >= 2
  )
    return normalized.slice(1, -1);
  return undefined;
};

const parseField = (
  line: string,
  source: PrismaSchemaSource,
): ParsedField | undefined => {
  const match = line.match(
    /^([_A-Za-z][_0-9A-Za-z]*)\s+([_A-Za-z][_0-9A-Za-z]*)(?:\[\])?(?:[!?])?(?:\s|$)/u,
  );
  if (!match?.[1] || !match[2] || match[1].startsWith("@@")) return undefined;
  return { name: match[1], type: match[2], source };
};

const parseSchemaFile = (
  path: string,
  text: string,
  contentHash: string,
): ParsedBlock[] => {
  const sourceFactory = (index: number): PrismaSchemaSource =>
    sourceAt(path, contentHash, text, index);
  const lines = text.split(/\r?\n/u);
  const blocks: ParsedBlock[] = [];
  let current: ParsedBlock | undefined;
  let blockDepth = 0;
  let offset = 0;

  const flush = (): void => {
    if (current) blocks.push(current);
    current = undefined;
    blockDepth = 0;
  };

  for (const rawLine of lines) {
    const commentIndex = rawLine.indexOf("//");
    const line = (
      commentIndex >= 0 ? rawLine.slice(0, commentIndex) : rawLine
    ).trim();
    const source = sourceFactory(offset + rawLine.search(/\S/u));
    offset += rawLine.length + 1;
    if (line.length === 0) continue;

    const blockMatch = line.match(
      /^(datasource|generator|model)\s+([_A-Za-z][_0-9A-Za-z]*)\s*\{/u,
    );
    if (blockMatch?.[1] && blockMatch[2]) {
      flush();
      current = {
        kind: blockMatch[1] as BlockKind,
        name: blockMatch[2],
        source,
        fields: [],
        attributes: new Map(),
      };
      blockDepth = 1;
      const remainder = line.slice(line.indexOf("{") + 1);
      if (remainder.includes("}")) flush();
      continue;
    }
    if (!current) continue;

    const closing = (line.match(/\}/gu) ?? []).length;
    const opening = (line.match(/\{/gu) ?? []).length;
    const attribute = line.match(/^([_A-Za-z][_0-9A-Za-z]*)\s*=\s*(.+)$/u);
    if (attribute?.[1] && attribute[2]) {
      current.attributes.set(attribute[1], {
        value: attribute[2].trim(),
        source,
      });
    } else if (current.kind === "model" && !line.startsWith("@@")) {
      const field = parseField(line, source);
      if (field) current.fields.push(field);
    }
    blockDepth += opening - closing;
    if (blockDepth <= 0) flush();
  }
  flush();
  return blocks;
};

const walkSchemaFiles = (
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
      } else if (
        entry.isFile() &&
        extname(entry.name).toLowerCase() === ".prisma"
      ) {
        files.push(candidate);
        if (files.length > resources.maxFiles)
          throw new ResourceLimitError(
            `Prisma schema discovery exceeded the ${resources.maxFiles} file ceiling`,
          );
      }
    }
  }
  return files.sort((left, right) =>
    compareStrings(relativePath(rootDir, left), relativePath(rootDir, right)),
  );
};

const addDiagnostic = (
  diagnostics: PrismaPartialDiagnostic[],
  code: PrismaPartialDiagnosticCode,
  source: PrismaSchemaSource,
  detail: string,
): void => {
  diagnostics.push({ code, source, detail });
};

export const discoverPrismaSchema = (
  rootDir: string,
  resources: ResourceLimits,
  checkBudget: () => void,
): PrismaSchemaDiscovery => {
  const resolvedRoot = realpathSync(resolve(rootDir));
  const schemaFiles = walkSchemaFiles(resolvedRoot, resources, checkBudget);
  const diagnostics: PrismaPartialDiagnostic[] = [];
  const fileHashes = new Map<string, string>();
  const parsed: Array<{ path: string; blocks: ParsedBlock[] }> = [];

  for (const file of schemaFiles) {
    checkBudget();
    const metadata = lstatSync(file);
    if (metadata.size > resources.maxFileBytes)
      throw new ResourceLimitError(
        `Prisma schema ${relativePath(resolvedRoot, file)} exceeds the ${resources.maxFileBytes} byte file ceiling`,
      );
    const bytes = readFileSync(file);
    const text = bytes.toString("utf8");
    const path = relativePath(resolvedRoot, file);
    const contentHash = hashBytes(bytes);
    fileHashes.set(path, contentHash);
    parsed.push({
      path,
      blocks: parseSchemaFile(path, text, contentHash),
    });
  }

  if (parsed.length > 1) {
    const first = parsed[0];
    const firstBlock = first?.blocks[0];
    if (first && firstBlock)
      addDiagnostic(
        diagnostics,
        "MULTIPLE_PRISMA_SCHEMA_FILES",
        firstBlock.source,
        `Found ${parsed.length} Prisma schema files; all files are analyzed and duplicate declarations fail closed.`,
      );
  }

  const datasources = new Map<string, PrismaDatasource>();
  const models = new Map<string, PrismaModel>();
  const generatedClients = new Map<string, PrismaGeneratedClient>();
  const modelFields = new Map<string, ParsedField[]>();

  for (const file of parsed) {
    for (const block of file.blocks) {
      if (block.kind === "datasource") {
        const providerAttribute = block.attributes.get("provider");
        const provider = providerAttribute
          ? scalarValue(providerAttribute.value)
          : undefined;
        const existing = datasources.get(block.name);
        if (existing) {
          addDiagnostic(
            diagnostics,
            "AMBIGUOUS_PRISMA_SCHEMA",
            block.source,
            `Datasource ${block.name} is declared more than once.`,
          );
          continue;
        }
        const providerSource = providerAttribute?.source ?? block.source;
        datasources.set(block.name, {
          name: block.name,
          ...(provider ? { provider } : {}),
          source: block.source,
          providerSource,
        });
        if (!provider || !SUPPORTED_DATASOURCE_PROVIDERS.has(provider))
          addDiagnostic(
            diagnostics,
            "UNSUPPORTED_PRISMA_PROVIDER",
            providerSource,
            `Datasource ${block.name} uses an unsupported or dynamically configured provider.`,
          );
        continue;
      }

      if (block.kind === "model") {
        if (models.has(block.name)) {
          addDiagnostic(
            diagnostics,
            "AMBIGUOUS_PRISMA_SCHEMA",
            block.source,
            `Model ${block.name} is declared more than once.`,
          );
          continue;
        }
        models.set(block.name, {
          name: block.name,
          source: block.source,
          relations: [],
        });
        modelFields.set(block.name, block.fields);
        continue;
      }

      const providerAttribute = block.attributes.get("provider");
      const outputAttribute = block.attributes.get("output");
      const provider = providerAttribute
        ? scalarValue(providerAttribute.value)
        : undefined;
      const output = outputAttribute
        ? scalarValue(outputAttribute.value)
        : undefined;
      const defaultOutput = outputAttribute === undefined;
      const outputSource = outputAttribute?.source ?? block.source;
      if (!provider || !SUPPORTED_GENERATOR_PROVIDERS.has(provider))
        addDiagnostic(
          diagnostics,
          "UNSUPPORTED_PRISMA_GENERATOR",
          providerAttribute?.source ?? block.source,
          `Generator ${block.name} uses an unsupported or dynamically configured provider.`,
        );
      let outputPath: string | undefined;
      if (output !== undefined) {
        const resolvedOutput = resolve(
          dirnameForSchema(resolvedRoot, block.source.path),
          output,
        );
        if (!isInsideRoot(resolvedRoot, resolvedOutput)) {
          addDiagnostic(
            diagnostics,
            "UNSUPPORTED_PRISMA_GENERATED_OUTPUT",
            outputSource,
            `Generator ${block.name} writes outside the analyzed repository.`,
          );
        } else {
          outputPath = relativePath(resolvedRoot, resolvedOutput);
        }
      } else if (outputAttribute) {
        addDiagnostic(
          diagnostics,
          "UNSUPPORTED_PRISMA_GENERATED_OUTPUT",
          outputSource,
          `Generator ${block.name} uses a dynamically configured output path.`,
        );
      }
      const key = `${block.name}:${outputPath ?? (defaultOutput ? "@prisma/client" : "<unsupported>")}`;
      if (generatedClients.has(key)) {
        addDiagnostic(
          diagnostics,
          "AMBIGUOUS_PRISMA_SCHEMA",
          block.source,
          `Generator ${block.name} has a duplicate generated-client declaration.`,
        );
        continue;
      }
      generatedClients.set(key, {
        name: block.name,
        ...(provider ? { provider } : {}),
        ...(outputPath ? { outputPath } : {}),
        defaultOutput,
        source: block.source,
        outputSource,
      });
    }
  }

  const modelNames = new Set(models.keys());
  for (const [modelName, fields] of modelFields) {
    const model = models.get(modelName);
    if (!model) continue;
    const relations: PrismaRelation[] = [];
    for (const field of fields) {
      if (
        SCALAR_TYPES.has(field.type) ||
        field.type === "Unsupported" ||
        !modelNames.has(field.type)
      )
        continue;
      relations.push({
        model: modelName,
        field: field.name,
        targetModel: field.type,
        source: field.source,
      });
    }
    models.set(modelName, { ...model, relations });
  }

  return {
    datasources: [...datasources.values()].sort((left, right) =>
      compareStrings(left.name, right.name),
    ),
    models: [...models.values()].sort((left, right) =>
      compareStrings(left.name, right.name),
    ),
    generatedClients: [...generatedClients.values()].sort((left, right) =>
      compareStrings(
        `${left.name}:${left.outputPath ?? (left.defaultOutput ? "@prisma/client" : "<unsupported>")}`,
        `${right.name}:${right.outputPath ?? (right.defaultOutput ? "@prisma/client" : "<unsupported>")}`,
      ),
    ),
    diagnostics: diagnostics.sort((left, right) =>
      compareStrings(
        `${left.source.path}:${left.source.line}:${left.code}:${left.detail ?? ""}`,
        `${right.source.path}:${right.source.line}:${right.code}:${right.detail ?? ""}`,
      ),
    ),
    fileHashes,
  };
};

const dirnameForSchema = (rootDir: string, path: string): string =>
  resolve(rootDir, path.split("/").slice(0, -1).join("/"));
