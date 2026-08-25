#!/usr/bin/env node
/* global Buffer, console, process */

import { performance } from "node:perf_hooks";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import Ajv from "ajv";

import { analyzeTypeScriptRepository } from "../src/analyzers/typescript.js";
import {
  createGraphSnapshot,
  parseAdapterManifest,
  parseGraphSnapshot,
  parsePolicyConfig,
  runAdapter,
  serializeAdapterOutput,
  serializeGraphSnapshot,
  serializePolicyConfig,
} from "../src/core/index.js";
import {
  SAMPLE_ADAPTER_MANIFEST,
  createSampleAdapter,
} from "../src/adapters/index.js";

const repositoryRoot = resolve(
  process.env.CARTOGRAPH_REPOSITORY_ROOT ?? process.cwd(),
);
const scenarioPath = resolve(
  repositoryRoot,
  process.argv.includes("--scenarios")
    ? process.argv[process.argv.indexOf("--scenarios") + 1]
    : "test/fixtures/property-regressions/scenarios.v0.1.json",
);
const scenarioSchemaPath = resolve(
  repositoryRoot,
  "schema/property-regression.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(
    `cartograph.property-regression validation failed: ${message}`,
  );
};

class XorShift32 {
  constructor(seed) {
    this.state = seed >>> 0;
  }

  next() {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  int(maxExclusive) {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1)
      throw new Error(`invalid random bound: ${maxExclusive}`);
    return this.next() % maxExclusive;
  }
}

const suiteById = (scenario, id) => {
  const suite = scenario.suites.find((entry) => entry.id === id);
  if (!suite) fail(`scenario is missing suite ${id}`);
  return suite;
};

const deepClone = (value) => JSON.parse(JSON.stringify(value));

const shuffle = (values, random) => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = random.int(index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
};

const expectRejected = (operation, label) => {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  fail(`${label} was accepted unexpectedly`);
};

const fixtureProject = (
  prefix,
  sourceFiles,
  maxSourceBytes,
  maxGeneratedFiles,
) => {
  const root = mkdtempSync(join(tmpdir(), `cartograph-property-${prefix}-`));
  if (Object.keys(sourceFiles).length > maxGeneratedFiles) {
    rmSync(root, { recursive: true, force: true });
    fail(`${prefix} generated file count exceeds ${maxGeneratedFiles}`);
  }
  const totalBytes = Object.values(sourceFiles).reduce(
    (total, source) => total + Buffer.byteLength(source, "utf8"),
    0,
  );
  if (totalBytes > maxSourceBytes) {
    rmSync(root, { recursive: true, force: true });
    fail(`${prefix} generated source exceeds ${maxSourceBytes} bytes`);
  }
  for (const [path, source] of Object.entries(sourceFiles)) {
    const target = join(root, path);
    writeFileSync(target, source, "utf8");
  }
  return root;
};

const typeScriptSource = (index, random) => {
  const token = random.int(10_000);
  switch (index % 5) {
    case 0:
      return `import { helper${token} } from "./dep";\nexport const value${token} = helper${token}("${token}");\n`;
    case 1:
      return `export function handler${token}(input: string) { return input.trim(); }\n`;
    case 2:
      return `const route${token} = "/v${token}";\nexport { route${token} };\n`;
    case 3:
      return `const marker${token} = "process.env.PROPERTY_SECRET";\nexport default marker${token};\n`;
    default:
      return `export function malformed${token}( {\n  return "bounded";\n}\n`;
  }
};

const runTypeScriptCase = (index, random, scenario) => {
  const token = random.int(10_000);
  const source = typeScriptSource(index, random);
  const root = fixtureProject(
    `ts-${index}`,
    {
      "index.ts": source,
      "dep.ts": `export const helper${token} = (value: string) => value;\n`,
    },
    scenario.budgets.maxSourceBytes,
    scenario.budgets.maxGeneratedFiles,
  );
  try {
    const first = serializeGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: root }),
    );
    const second = serializeGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: root }),
    );
    if (first !== second) fail(`typescript case ${index} is not deterministic`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const snapshotInput = (index, random) => {
  const moduleId = `module:property-${index}`;
  const functionId = `function:property-${index}:entry`;
  const evidence = {
    id: `property:evidence:${index}`,
    kind: "source",
    path: "src/index.ts",
    line: 1,
    detector: "property-regression@0.1.0",
    contentHash: `sha256:${"a".repeat(64)}`,
  };
  const base = {
    schemaVersion: 1,
    revision: { commitSha: `property-snapshot-${index}` },
    nodes: [
      {
        id: moduleId,
        kind: "module",
        name: "property",
        language: "typescript",
        location: { path: "src/index.ts", line: 1 },
      },
      {
        id: functionId,
        kind: "function",
        name: "entry",
        language: "typescript",
        location: { path: "src/index.ts", line: 2 },
      },
    ],
    edges: [
      {
        from: moduleId,
        to: functionId,
        kind: "contains",
        confidence: "certain",
        evidence: [evidence],
      },
    ],
    diagnostics: [],
  };

  if (index % 4 !== 0) {
    const reordered = deepClone(base);
    reordered.nodes = shuffle(reordered.nodes, random);
    reordered.edges = shuffle(reordered.edges, random);
    return reordered;
  }

  const mutation = index / 4;
  if (mutation % 4 === 0) return { ...base, schemaVersion: 99 };
  if (mutation % 4 === 1) {
    const invalid = deepClone(base);
    invalid.edges[0].to = "module:missing";
    return invalid;
  }
  if (mutation % 4 === 2) return { ...base, unexpected: "reject" };
  return JSON.parse('{"__proto__":{"polluted":"property"}}');
};

const runSnapshotCase = (index, random) => {
  const input = snapshotInput(index, random);
  if (index % 4 === 0) {
    parseGraphSnapshot(input);
    return;
  }
  const serialized = serializeGraphSnapshot(createGraphSnapshot(input));
  if (
    serialized !==
    serializeGraphSnapshot(parseGraphSnapshot(JSON.parse(serialized)))
  )
    fail(`snapshot case ${index} is not idempotently canonical`);
};

const policyInput = (index) => {
  const target = ["node", "edge", "diff"][index % 3];
  const selector =
    target === "node"
      ? { kind: "endpoint" }
      : target === "edge"
        ? { kind: "calls" }
        : { kind: "edge-added" };
  const base = {
    schemaVersion: 1,
    policyId: `property-policy-${index}`,
    version: "0.1.0",
    mode: index % 2 === 0 ? "informational" : "enforce",
    rules: [
      {
        id: `property-rule-${index}`,
        target,
        selector,
        assertion: index % 2 === 0 ? "exists" : "count-at-most",
        ...(index % 2 === 0 ? {} : { value: 10 }),
      },
    ],
  };
  if (index % 4 !== 0) return base;
  switch ((index / 4) % 4) {
    case 0:
      return { ...base, command: "node" };
    case 1:
      return { ...base, includes: [{ path: "../outside.json" }] };
    case 2:
      return { ...base, rules: [{ ...base.rules[0], selector: {} }] };
    default:
      return { ...base, version: "not-semver" };
  }
};

const adapterInput = (index) => ({
  apiVersion: 1,
  source: {
    rootDir: repositoryRoot,
    include: ["."],
    exclude: [],
    revision: { commitSha: `property-adapter-${index}` },
  },
  config: {
    fixture: ["empty", "supported", "unsupported"][index % 3],
  },
  resources: {
    maxFiles: 128,
    maxFileBytes: 16_384,
    maxSourceBytes: 65_536,
    maxWallClockMs: 3_000,
  },
});

const invalidAdapterInput = (index) => {
  const base = adapterInput(index);
  switch ((index / 4) % 4) {
    case 0:
      return { ...base, config: { command: "node" } };
    case 1:
      return { ...base, source: { ...base.source, include: ["../outside"] } };
    case 2:
      return { ...base, apiVersion: 2 };
    default:
      return { ...base, resources: { ...base.resources, maxFiles: 0 } };
  }
};

const runAdapterCase = (index) => {
  if (index % 4 === 0) {
    runAdapter(createSampleAdapter(), invalidAdapterInput(index));
    return;
  }
  const output = runAdapter(createSampleAdapter(), adapterInput(index));
  const serialized = serializeAdapterOutput(output);
  if (serialized !== serializeAdapterOutput(JSON.parse(serialized)))
    fail(`adapter case ${index} is not idempotently canonical`);
};

const runRegressionFixtures = () => {
  const sentinelRoot = mkdtempSync(
    join(tmpdir(), "cartograph-property-sentinel-"),
  );
  const sentinel = join(sentinelRoot, "must-not-exist.txt");
  try {
    writeFileSync(
      join(sentinelRoot, "index.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "executed");\n`,
      "utf8",
    );
    analyzeTypeScriptRepository({ rootDir: sentinelRoot });
    if (existsSync(sentinel))
      fail("typescript no-execution regression executed source");
  } finally {
    rmSync(sentinelRoot, { recursive: true, force: true });
  }

  const malformedRoot = mkdtempSync(
    join(tmpdir(), "cartograph-property-malformed-"),
  );
  try {
    writeFileSync(
      join(malformedRoot, "index.ts"),
      'export function malformed( { return "bounded"; }\n',
      "utf8",
    );
    serializeGraphSnapshot(
      analyzeTypeScriptRepository({ rootDir: malformedRoot }),
    );
  } finally {
    rmSync(malformedRoot, { recursive: true, force: true });
  }

  const prototypeInput = JSON.parse('{"__proto__":{"polluted":"property"}}');
  expectRejected(
    () => parseGraphSnapshot(prototypeInput),
    "snapshot prototype-pollution regression",
  );
  if ({}.polluted !== undefined)
    fail("snapshot prototype-pollution regression mutated Object.prototype");
  expectRejected(
    () =>
      parseGraphSnapshot({ schemaVersion: 99, revision: { commitSha: "x" } }),
    "snapshot schema-version regression",
  );

  const policy = {
    schemaVersion: 1,
    policyId: "property-regression",
    version: "0.1.0",
    rules: [
      {
        id: "property-rule",
        target: "node",
        selector: { kind: "endpoint" },
        assertion: "exists",
      },
    ],
  };
  expectRejected(
    () => parsePolicyConfig({ ...policy, command: "node" }),
    "policy executable-config regression",
  );
  expectRejected(
    () =>
      parsePolicyConfig({ ...policy, includes: [{ path: "../../outside" }] }),
    "policy path-traversal regression",
  );

  expectRejected(
    () =>
      parseAdapterManifest({
        ...SAMPLE_ADAPTER_MANIFEST,
        execution: { ...SAMPLE_ADAPTER_MANIFEST.execution, network: true },
      }),
    "adapter authority-escalation regression",
  );
  expectRejected(
    () =>
      runAdapter(createSampleAdapter(), {
        ...adapterInput(1),
        config: { module: "x" },
      }),
    "adapter executable-config regression",
  );
};

const runSuite = (scenario, suite, random, operation, rejectionRule) => {
  let rejected = 0;
  let maxCaseMs = 0;
  const started = performance.now();
  for (let index = 0; index < suite.cases; index += 1) {
    const caseStarted = performance.now();
    const shouldReject = rejectionRule(index);
    let thrown;
    try {
      operation(index, random, scenario);
    } catch (error) {
      thrown = error;
    }
    const elapsed = performance.now() - caseStarted;
    maxCaseMs = Math.max(maxCaseMs, elapsed);
    if (elapsed > scenario.budgets.maxCaseMs)
      fail(
        `${suite.id} case ${index} exceeded ${scenario.budgets.maxCaseMs}ms`,
      );
    if (shouldReject && thrown === undefined)
      fail(`${suite.id} case ${index} was expected to reject`);
    if (!shouldReject && thrown !== undefined) {
      const detail = thrown instanceof Error ? thrown.message : String(thrown);
      fail(`${suite.id} case ${index} crashed: ${detail}`);
    }
    if (thrown !== undefined) rejected += 1;
  }
  if (rejected !== suite.expectedRejections)
    fail(
      `${suite.id} rejection count drift: expected ${suite.expectedRejections}, found ${rejected}`,
    );
  return {
    id: suite.id,
    cases: suite.cases,
    rejected,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
    maxCaseMs: Number(maxCaseMs.toFixed(3)),
  };
};

const validate = () => {
  const scenario = readJson(scenarioPath);
  const schema = readJson(scenarioSchemaPath);
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(
    schema,
  );
  if (!validateSchema(scenario))
    fail(
      `scenario schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );

  const expectedSuites = [
    "typescript-input",
    "snapshot-json",
    "policy-config",
    "adapter-output",
  ];
  if (
    scenario.suites.map((suite) => suite.id).join(",") !==
    expectedSuites.join(",")
  )
    fail("scenario suites must remain in the reviewed order");
  const expectedRegressionIds = [
    "typescript-no-execution",
    "typescript-malformed-source",
    "snapshot-prototype-pollution",
    "snapshot-schema-version",
    "policy-executable-config",
    "policy-path-traversal",
    "adapter-authority-escalation",
    "adapter-executable-config",
  ];
  const regressionIds = scenario.regressions.map((regression) => regression.id);
  if (regressionIds.join(",") !== expectedRegressionIds.join(","))
    fail("scenario regression fixtures do not match the reviewed set");
  const totalCases = scenario.suites.reduce(
    (total, suite) => total + suite.cases,
    0,
  );
  if (totalCases > 128)
    fail(`property case count exceeds bounded maximum: ${totalCases}`);

  const random = new XorShift32(scenario.seed);
  const runStarted = performance.now();
  const suites = [
    runSuite(
      scenario,
      suiteById(scenario, "typescript-input"),
      random,
      runTypeScriptCase,
      () => false,
    ),
    runSuite(
      scenario,
      suiteById(scenario, "snapshot-json"),
      random,
      runSnapshotCase,
      (index) => index % 4 === 0,
    ),
    runSuite(
      scenario,
      suiteById(scenario, "policy-config"),
      random,
      (index) => {
        const input = policyInput(index);
        if (index % 4 === 0) {
          parsePolicyConfig(input);
          return;
        }
        const serialized = serializePolicyConfig(parsePolicyConfig(input));
        if (serialized !== serializePolicyConfig(JSON.parse(serialized)))
          fail(`policy case ${index} is not idempotently canonical`);
      },
      (index) => index % 4 === 0,
    ),
    runSuite(
      scenario,
      suiteById(scenario, "adapter-output"),
      random,
      runAdapterCase,
      (index) => index % 4 === 0,
    ),
  ];

  runRegressionFixtures();
  const elapsedMs = Number((performance.now() - runStarted).toFixed(3));
  if (elapsedMs > scenario.budgets.maxTotalMs)
    fail(
      `property suite exceeded ${scenario.budgets.maxTotalMs}ms: ${elapsedMs}ms`,
    );
  console.log(
    JSON.stringify({
      ok: true,
      contract: scenario.contract,
      schemaVersion: scenario.schemaVersion,
      seed: scenario.seed,
      suites,
      totalCases,
      expectedRejections: suites.reduce(
        (total, suite) => total + suite.rejected,
        0,
      ),
      regressions: scenario.regressions.map((regression) => regression.id),
      runtimeBudgetMs: scenario.budgets.maxTotalMs,
      elapsedMs,
      security: {
        sourceExecution: false,
        prototypePollution: false,
        executablePolicy: false,
        adapterAuthorityEscalation: false,
      },
      releaseGating: true,
    }),
  );
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/property-regressions.mjs validate [--scenarios path]",
  );
  process.exit(2);
}

try {
  validate();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
