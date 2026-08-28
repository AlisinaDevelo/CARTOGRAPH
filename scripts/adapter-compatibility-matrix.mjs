#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import Ajv from "ajv";

import {
  ADAPTER_API_VERSION,
  ADAPTER_COMPATIBILITY_REGISTRY,
  CAPABILITY_REGISTRY_VERSION,
  GRAPH_SNAPSHOT_SCHEMA_VERSION,
  negotiateAdapterCompatibility,
  runAdapterConformance,
} from "../src/core/index.ts";
import {
  FASTIFY_ADAPTER_MANIFEST,
  SAMPLE_ADAPTER_MANIFEST,
  RUST_ADAPTER_MANIFEST,
  createFastifyAdapter,
  createSampleAdapter,
  createRustAdapter,
} from "../src/adapters/index.ts";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const matrixRelativePath = "schema/adapter-compatibility-matrix.v0.1.json";
const matrixPath = resolve(
  repositoryRoot,
  argumentValue("--matrix") ?? matrixRelativePath,
);
const canonicalMatrixPath = resolve(repositoryRoot, matrixRelativePath);

const readText = (relativePath) =>
  readFileSync(resolve(repositoryRoot, relativePath), "utf8");
const readJson = (relativePath) => JSON.parse(readText(relativePath));
const digest = (value) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

const context = ({
  adapter = "<matrix>",
  capability = "<matrix>",
  fixture = "<matrix>",
  compatibility = "<matrix>",
} = {}) =>
  `adapter=${adapter} capability=${capability} fixture=${fixture} compatibility=${compatibility}`;

const fail = (message, details = {}) => {
  throw new Error(
    `cartograph.adapter-compatibility-matrix validation failed [${context(details)}]: ${message}`,
  );
};

const equal = (label, actual, expected, details) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(
      `${label}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
      details,
    );
};

const ensure = (condition, message, details) => {
  if (!condition) fail(message, details);
};

const resolveRepositoryPath = (candidate, label, details) => {
  ensure(
    typeof candidate === "string" && candidate.length > 0,
    `${label} must be a non-empty repository path`,
    details,
  );
  const target = resolve(repositoryRoot, candidate);
  const targetRelative = relative(repositoryRoot, target);
  ensure(
    !candidate.startsWith("/") &&
      !candidate.startsWith("\\") &&
      !candidate.startsWith("~") &&
      !candidate.includes("\0") &&
      !candidate.split(/[\\/]/u).includes("..") &&
      targetRelative !== ".." &&
      !targetRelative.startsWith(`..${sep}`) &&
      !targetRelative.startsWith(sep),
    `${label} escapes the repository: ${candidate}`,
    details,
  );
  return target;
};

const requireFile = (candidate, label, details) => {
  const target = resolveRepositoryPath(candidate, label, details);
  ensure(existsSync(target), `${label} does not exist: ${candidate}`, details);
  return target;
};

const requirePath = (candidate, label, details) => {
  const target = resolveRepositoryPath(candidate, label, details);
  ensure(existsSync(target), `${label} does not exist: ${candidate}`, details);
  return target;
};

const schemaValidator = (schemaPath, details) => {
  const schema = readJson(schemaPath);
  try {
    return new Ajv({ allErrors: true, strict: false }).compile(schema);
  } catch (error) {
    fail(
      `${schemaPath} could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
      { ...details, compatibility: `schema:${schemaPath}` },
    );
  }
};

const validateJson = (validator, value, label, details) => {
  ensure(
    validator(value),
    `${label} schema validation failed: ${JSON.stringify(validator.errors)}`,
    details,
  );
};

const parseNodeLine = (value) => {
  const match = /^([0-9]+)\.x$/u.exec(value);
  return match ? Number(match[1]) : undefined;
};

const runtimeNodeStatus = (declaredLines) => {
  const actualMajor = Number(process.versions.node.split(".")[0]);
  const actualLine = `${actualMajor}.x`;
  const requestedLine = process.env.CARTOGRAPH_MATRIX_NODE;
  if (requestedLine !== undefined) {
    ensure(
      declaredLines.includes(requestedLine),
      `requested Node line is not declared: ${requestedLine}`,
      { compatibility: "runtime-node-line" },
    );
    const requestedMajor = parseNodeLine(requestedLine);
    ensure(
      requestedMajor !== undefined && requestedMajor === actualMajor,
      `requested Node line ${requestedLine} does not match ${process.version}`,
      { compatibility: "runtime-node-line" },
    );
    return {
      actual: process.version,
      requested: requestedLine,
      line: actualLine,
      status: "matched",
    };
  }
  return {
    actual: process.version,
    requested: null,
    line: actualLine,
    status: declaredLines.includes(actualLine)
      ? "matched-local"
      : "unlisted-local",
  };
};

const runSubcheck = (name, script, args) => {
  try {
    const output = execFileSync(process.execPath, [script, ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const lines = output.split("\n").filter(Boolean);
    let report;
    try {
      report = lines.length > 0 ? JSON.parse(lines.at(-1)) : null;
    } catch {
      report = null;
    }
    return { name, ok: true, report };
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : "";
    fail(
      `${name} failed: ${stderr.trim() || (error instanceof Error ? error.message : String(error))}`,
      { compatibility: name },
    );
  }
};

const matrixAdapters = new Map([
  [
    SAMPLE_ADAPTER_MANIFEST.id,
    { adapter: createSampleAdapter(), manifest: SAMPLE_ADAPTER_MANIFEST },
  ],
  [
    FASTIFY_ADAPTER_MANIFEST.id,
    { adapter: createFastifyAdapter(), manifest: FASTIFY_ADAPTER_MANIFEST },
  ],
  [
    RUST_ADAPTER_MANIFEST.id,
    { adapter: createRustAdapter(), manifest: RUST_ADAPTER_MANIFEST },
  ],
]);

const inputFor = (entry, testCase, sourceRoot) => ({
  apiVersion: ADAPTER_API_VERSION,
  source: {
    rootDir: sourceRoot,
    include: ["."],
    exclude: [],
    revision: { commitSha: `adapter-matrix-${entry.id}-${testCase.id}` },
  },
  config: testCase.config,
  resources: {
    maxFiles: entry.sourceRoot === "repository" ? 1 : 32,
    maxFileBytes: 16_384,
    maxSourceBytes: 65_536,
    maxInputBytes: 16_384,
    maxOutputBytes: 2 * 1024 * 1024,
    // The TypeScript compiler host can exceed 512 MiB on hosted Node 24
    // runners even for this deliberately small Fastify fixture.
    maxMemoryBytes:
      entry.id === "cartograph.fastify"
        ? 1024 * 1024 * 1024
        : 512 * 1024 * 1024,
    maxWallClockMs: entry.maxDurationMs,
  },
});

const validateMatrix = () => {
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  const matrixSchemaPath =
    "schema/adapter-compatibility-matrix.v0.1.schema.json";
  const matrixSchema = readJson(matrixSchemaPath);
  const validateMatrixSchema = new Ajv({
    allErrors: true,
    strict: false,
  }).compile(matrixSchema);
  validateJson(validateMatrixSchema, matrix, "matrix", {
    compatibility: "matrix-schema",
  });

  const support = readJson("schema/support-matrix.v0.1.json");
  const packageJson = readJson("package.json");
  const lockfile = readJson("package-lock.json");
  const ciWorkflow = readText(".github/workflows/ci.yml");
  const docs = readText("docs/ADAPTER_COMPATIBILITY_MATRIX.md");
  const supportDetails = { compatibility: "runtime-toolchain" };

  equal(
    "matrix Node lines",
    matrix.runtime.node,
    support.node.ci,
    supportDetails,
  );
  equal(
    "matrix TypeScript version",
    matrix.runtime.typescript,
    support.toolchain.typescript,
    supportDetails,
  );
  equal(
    "matrix ts-morph version",
    matrix.runtime.tsMorph,
    support.toolchain.tsMorph,
    supportDetails,
  );
  equal(
    "locked TypeScript version",
    lockfile.packages?.["node_modules/typescript"]?.version,
    matrix.runtime.typescript,
    supportDetails,
  );
  equal(
    "locked ts-morph version",
    lockfile.packages?.["node_modules/ts-morph"]?.version,
    matrix.runtime.tsMorph,
    supportDetails,
  );
  const installedTypeScript = readJson("node_modules/typescript/package.json");
  const installedTsMorph = readJson("node_modules/ts-morph/package.json");
  equal(
    "installed TypeScript version",
    installedTypeScript.version,
    matrix.runtime.typescript,
    supportDetails,
  );
  equal(
    "installed ts-morph version",
    installedTsMorph.version,
    matrix.runtime.tsMorph,
    supportDetails,
  );
  ensure(
    typeof packageJson.engines?.node === "string" &&
      packageJson.engines.node.includes(support.node.minimum),
    `package engines.node must include ${support.node.minimum}`,
    supportDetails,
  );
  for (const nodeLine of matrix.runtime.node)
    ensure(
      ciWorkflow.includes(`- "${nodeLine}"`),
      `CI Node matrix is missing ${nodeLine}`,
      { compatibility: "workflow-node-matrix" },
    );
  ensure(
    ciWorkflow.includes("node-version: ${{ matrix.node-version }}"),
    "CI does not install the matrix Node version",
    { compatibility: "workflow-node-matrix" },
  );
  ensure(
    ciWorkflow.includes("npm run adapter:compatibility:validate"),
    "CI does not execute the adapter compatibility matrix",
    { compatibility: "workflow-command" },
  );
  ensure(
    ciWorkflow.includes("CARTOGRAPH_MATRIX_NODE: ${{ matrix.node-version }}"),
    "CI does not bind the requested Node line to the matrix validator",
    { compatibility: "workflow-node-line-binding" },
  );

  const runtime = runtimeNodeStatus(matrix.runtime.node);
  const contracts = matrix.contracts;
  equal("adapter API contract", contracts.adapterApi, ADAPTER_API_VERSION, {
    compatibility: "adapter-api",
  });
  equal(
    "adapter compatibility contract",
    contracts.adapterCompatibility,
    ADAPTER_COMPATIBILITY_REGISTRY.current.compatibilityVersion,
    { compatibility: "adapter-compatibility" },
  );
  equal(
    "capability registry contract",
    contracts.capabilityRegistry,
    CAPABILITY_REGISTRY_VERSION,
    { compatibility: "capability-registry" },
  );
  equal(
    "graph schema contract",
    contracts.graphSchema,
    GRAPH_SNAPSHOT_SCHEMA_VERSION,
    { compatibility: "graph-schema" },
  );

  const adapterSchemaValidator = schemaValidator(
    "schema/adapter.v0.1.schema.json",
    {
      compatibility: "adapter-schema",
    },
  );
  const adapterCompatibilityFixtureSchemaValidator = schemaValidator(
    "schema/adapter-compatibility-fixtures.v0.1.schema.json",
    { compatibility: "compatibility-fixture-schema" },
  );
  const adapterInputSchemaValidator = schemaValidator(
    "schema/adapter-input.v0.1.schema.json",
    { compatibility: "adapter-input-schema" },
  );
  validateJson(
    adapterSchemaValidator,
    readJson("schema/adapter.v0.1.json"),
    "published adapter manifest",
    { compatibility: "adapter-schema" },
  );

  const fixturePath = requireFile(
    matrix.compatibilityFixtures,
    "compatibilityFixtures",
    { compatibility: "compatibility-fixtures" },
  );
  const compatibilityFixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  validateJson(
    adapterCompatibilityFixtureSchemaValidator,
    compatibilityFixture,
    "compatibility fixtures",
    { compatibility: "compatibility-fixture-schema" },
  );
  equal(
    "compatibility fixture target",
    compatibilityFixture.target,
    {
      apiVersion: contracts.adapterApi,
      compatibilityVersion: contracts.adapterCompatibility,
      capabilityRegistryVersion: contracts.capabilityRegistry,
      graphSchemaVersion: contracts.graphSchema,
    },
    { compatibility: "compatibility-target" },
  );

  const declaredIds = new Set();
  const adapterReports = [];
  for (const entry of matrix.adapters) {
    const adapterDetails = { adapter: entry.id, compatibility: "adapter-set" };
    ensure(
      !declaredIds.has(entry.id),
      "duplicate adapter declaration",
      adapterDetails,
    );
    declaredIds.add(entry.id);
    const selected = matrixAdapters.get(entry.id);
    ensure(
      selected !== undefined,
      "adapter is not shipped by this checkout",
      adapterDetails,
    );
    requireFile(entry.module, "module", adapterDetails);
    const sourceRoot =
      entry.sourceRoot === "repository"
        ? repositoryRoot
        : requirePath(entry.sourceRoot, "sourceRoot", adapterDetails);
    const manifest = selected.manifest;
    equal("manifest adapter ID", manifest.id, entry.id, {
      ...adapterDetails,
      compatibility: "adapter-manifest-id",
    });
    equal("manifest API version", manifest.apiVersion, contracts.adapterApi, {
      ...adapterDetails,
      compatibility: "adapter-api",
    });
    equal(
      "manifest compatibility version",
      manifest.compatibilityVersion,
      contracts.adapterCompatibility,
      { ...adapterDetails, compatibility: "adapter-compatibility" },
    );
    equal(
      "manifest capability registry version",
      manifest.capabilityRegistryVersion,
      contracts.capabilityRegistry,
      { ...adapterDetails, compatibility: "capability-registry" },
    );
    equal(
      "manifest graph schema version",
      manifest.graphSchemaVersion,
      contracts.graphSchema,
      { ...adapterDetails, compatibility: "graph-schema" },
    );

    const manifestCapabilities = new Set(
      manifest.capabilities.map(({ id }) => id),
    );
    const declaredCapabilities = new Set();
    const caseIds = new Set();
    const matrixCases = new Map();
    for (const testCase of entry.cases) {
      ensure(!caseIds.has(testCase.id), "duplicate case declaration", {
        ...adapterDetails,
        fixture: testCase.fixture,
        compatibility: "case-set",
      });
      caseIds.add(testCase.id);
      matrixCases.set(testCase.id, testCase);
    }
    for (const capability of entry.capabilities) {
      const capabilityDetails = {
        ...adapterDetails,
        capability: capability.id,
        compatibility: "capability-set",
      };
      ensure(
        !declaredCapabilities.has(capability.id),
        "duplicate capability declaration",
        capabilityDetails,
      );
      declaredCapabilities.add(capability.id);
      ensure(
        manifestCapabilities.has(capability.id),
        "capability is not declared by the runtime manifest",
        capabilityDetails,
      );
      for (const caseId of capability.cases)
        ensure(
          matrixCases.has(caseId),
          `capability fixture case is not declared: ${caseId}`,
          { ...capabilityDetails, fixture: caseId },
        );
    }
    equal(
      "declared capability IDs",
      [...declaredCapabilities].sort(),
      [...manifestCapabilities].sort(),
      { ...adapterDetails, compatibility: "capability-set" },
    );
    const coveredCases = new Set(
      entry.capabilities.flatMap(({ cases }) => cases),
    );
    equal(
      "capability case coverage",
      [...coveredCases].sort(),
      [...caseIds].sort(),
      { ...adapterDetails, compatibility: "capability-fixture-coverage" },
    );

    const conformanceCases = entry.cases.map((testCase) => ({
      id: testCase.id,
      input: inputFor(entry, testCase, sourceRoot),
      expect: {
        minNodes: testCase.minNodes,
        minEdges: testCase.minEdges,
        requiredDiagnosticCodes: testCase.requiredDiagnosticCodes,
        unsupportedDiagnosticCodes: testCase.unsupportedDiagnosticCodes,
      },
    }));
    for (const testCase of conformanceCases)
      validateJson(
        adapterInputSchemaValidator,
        testCase.input,
        "adapter input",
        {
          adapter: entry.id,
          fixture: matrixCases.get(testCase.id).fixture,
          compatibility: "adapter-input-schema",
        },
      );
    const conformanceReports = [];
    for (const [caseIndex, testCase] of conformanceCases.entries()) {
      const declaredCase = entry.cases[caseIndex];
      try {
        const report = runAdapterConformance(selected.adapter, {
          cases: [testCase],
          repetitions: 2,
          maxDurationMs: entry.maxDurationMs,
        });
        ensure(report.deterministic, "conformance was not deterministic", {
          ...adapterDetails,
          capability:
            entry.capabilities.find(({ cases }) =>
              cases.includes(declaredCase.id),
            )?.id ?? "<unknown>",
          fixture: declaredCase.fixture,
          compatibility: "determinism",
        });
        ensure(report.evidenceComplete, "conformance evidence was incomplete", {
          ...adapterDetails,
          capability:
            entry.capabilities.find(({ cases }) =>
              cases.includes(declaredCase.id),
            )?.id ?? "<unknown>",
          fixture: declaredCase.fixture,
          compatibility: "evidence",
        });
        conformanceReports.push(report);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error), {
          adapter: entry.id,
          capability:
            entry.capabilities.find(({ cases }) =>
              cases.includes(declaredCase.id),
            )?.id ?? "<unknown>",
          fixture: declaredCase.fixture,
          compatibility: "adapter-conformance",
        });
      }
    }
    const conformance = {
      deterministic: true,
      evidenceComplete: true,
      cases: conformanceReports.flatMap((report) => report.cases),
      performance: {
        repetitions: 2,
        maxDurationMs: entry.maxDurationMs,
        maxObservedMs: Math.max(
          ...conformanceReports.map(
            (report) => report.performance.maxObservedMs,
          ),
        ),
      },
    };
    const caseReports = conformance.cases.map((report) => {
      const declaredCase = matrixCases.get(report.id);
      const capabilityIds = entry.capabilities
        .filter(({ cases }) => cases.includes(report.id))
        .map(({ id }) => id);
      return {
        id: report.id,
        fixture: declaredCase.fixture,
        capabilities: capabilityIds,
        nodes: report.nodes,
        edges: report.edges,
        diagnostics: report.diagnostics,
        diagnosticCodes: report.diagnosticCodes,
        deterministic: report.deterministic,
        evidenceComplete: report.evidenceComplete,
        durationMs: report.durationMs,
      };
    });
    adapterReports.push({
      id: entry.id,
      module: entry.module,
      capabilities: [...declaredCapabilities].sort(),
      cases: caseReports,
      conformance: {
        deterministic: conformance.deterministic,
        evidenceComplete: conformance.evidenceComplete,
        repetitions: conformance.performance.repetitions,
        maxDurationMs: conformance.performance.maxDurationMs,
      },
    });
  }

  equal(
    "shipped adapter set",
    [...declaredIds].sort(),
    [...matrixAdapters.keys()].sort(),
    { compatibility: "adapter-set" },
  );

  const compatibilityStates = new Set();
  const compatibilityAdapters = new Set();
  const fixtureCaseIds = new Set();
  for (const scenario of compatibilityFixture.cases) {
    const details = {
      adapter: scenario.adapterId,
      fixture: scenario.id,
      compatibility: "negotiation",
    };
    ensure(
      !fixtureCaseIds.has(scenario.id),
      "duplicate compatibility fixture",
      details,
    );
    fixtureCaseIds.add(scenario.id);
    const selected = matrixAdapters.get(scenario.adapterId);
    ensure(
      selected !== undefined,
      "compatibility fixture names an undeclared adapter",
      details,
    );
    const offeredManifest = {
      ...selected.manifest,
      id: scenario.adapterId,
      version: scenario.adapterVersion,
      stability: scenario.stability,
      ...scenario.offered,
    };
    const result = negotiateAdapterCompatibility(offeredManifest, {
      ...compatibilityFixture.target,
      allowExperimental: scenario.allowExperimental,
    });
    equal("negotiated state", result.state, scenario.expectedState, details);
    compatibilityStates.add(result.state);
    compatibilityAdapters.add(scenario.adapterId);
  }
  equal(
    "compatibility state coverage",
    [...compatibilityStates].sort(),
    [...matrix.requiredCompatibilityStates].sort(),
    { compatibility: "negotiation-state-coverage" },
  );
  equal(
    "compatibility adapter coverage",
    [...compatibilityAdapters].sort(),
    [...declaredIds].sort(),
    { compatibility: "negotiation-adapter-coverage" },
  );

  const schemaChecks = [
    runSubcheck("schema-compatibility", "scripts/schema-compatibility.mjs", [
      "check",
    ]),
    runSubcheck("upgrade-policy", "scripts/upgrade-policy.mjs", ["validate"]),
  ];
  const matrixDigest = digest(matrix);
  if (matrixPath === canonicalMatrixPath) {
    ensure(
      docs.includes(matrix.matrixId),
      "documentation is missing the matrix ID",
      {
        compatibility: "documentation",
      },
    );
    ensure(
      docs.includes(matrixDigest),
      "documentation is missing the matrix digest",
      {
        compatibility: "documentation",
      },
    );
    for (const nodeLine of matrix.runtime.node)
      ensure(
        docs.includes(`\`${nodeLine}\``),
        `documentation is missing Node row ${nodeLine}`,
        {
          compatibility: "documentation-runtime",
        },
      );
    for (const state of matrix.requiredCompatibilityStates)
      ensure(
        docs.includes(`\`${state}\``),
        `documentation is missing state ${state}`,
        {
          compatibility: "documentation-negotiation",
        },
      );
    for (const command of matrix.commands)
      ensure(
        docs.includes(command),
        `documentation is missing command ${command}`,
        {
          compatibility: "documentation-command",
        },
      );
  }

  return {
    ok: true,
    contract: matrix.contract,
    schemaVersion: matrix.schemaVersion,
    matrixId: matrix.matrixId,
    matrixDigest,
    runtime,
    toolchain: {
      typescript: matrix.runtime.typescript,
      tsMorph: matrix.runtime.tsMorph,
    },
    contracts,
    adapters: adapterReports,
    compatibility: {
      fixtureCases: compatibilityFixture.cases.length,
      states: [...compatibilityStates].sort(),
      adapters: [...compatibilityAdapters].sort(),
    },
    schemaChecks,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/adapter-compatibility-matrix.mjs validate [--root path] [--matrix path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validateMatrix()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
