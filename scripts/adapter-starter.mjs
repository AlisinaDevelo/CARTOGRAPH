#!/usr/bin/env node
/* global console, process */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  ADAPTER_API_VERSION,
  ADAPTER_COMPATIBILITY_REGISTRY,
  AdapterIsolationError,
  AdapterValidationError,
  negotiateAdapterCompatibility,
  parseAdapterInput,
  parseAdapterManifest,
  runAdapterConformance,
  runAdapterIsolated,
  supportsAdapterIsolation,
} from "../src/core/index.ts";

const repositoryRoot = resolve(process.cwd());
const starterRoot = resolve(repositoryRoot, "examples/adapter-starter");
const fixturePath = resolve(starterRoot, "fixtures/cases.v0.1.json");
const mirroredFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/adapter-starter/cases.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/adapter-starter-fixtures.v0.1.schema.json",
);
const packagePath = resolve(starterRoot, "package.json");
const adapterPath = resolve(starterRoot, "adapter.mjs");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(`adapter starter validation failed: ${message}`);
};

const inputFor = (fixture) => ({
  apiVersion: ADAPTER_API_VERSION,
  source: {
    rootDir: repositoryRoot,
    include: ["."],
    exclude: [],
    revision: { commitSha: `starter-${fixture}` },
  },
  config: { fixture },
  resources: {
    maxFiles: 128,
    maxFileBytes: 16_384,
    maxSourceBytes: 65_536,
    maxInputBytes: 16_384,
    maxOutputBytes: 2 * 1024 * 1024,
    maxMemoryBytes: 256 * 1024 * 1024,
    maxWallClockMs: 5_000,
  },
});

const assertThrows = (operation, label) => {
  try {
    operation();
  } catch (error) {
    if (error instanceof AdapterValidationError) return;
    fail(`${label} failed with an unexpected error: ${error.message}`);
  }
  fail(`${label} was accepted`);
};

const packageFiles = () => {
  const result = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: starterRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    fail(`starter package dry-run failed: ${result.stderr.trim()}`);
  let records;
  try {
    records = JSON.parse(result.stdout);
  } catch (error) {
    fail(`starter package dry-run was not JSON: ${error.message}`);
  }
  const files = records[0]?.files;
  if (!Array.isArray(files)) fail("starter package dry-run omitted files");
  return files.map((entry) => String(entry.path).replace(/^package\//u, ""));
};

const validatePackage = () => {
  const packageJson = readJson(packagePath);
  const requiredFiles = [
    "adapter.mjs",
    "fixtures/cases.v0.1.json",
    "test/adapter.test.mjs",
    "README.md",
    "package.json",
  ];
  for (const relativePath of requiredFiles) {
    if (!existsSync(resolve(starterRoot, relativePath)))
      fail(`starter package is missing ${relativePath}`);
  }
  if (packageJson.type !== "module") fail("starter package must be ESM");
  if (packageJson.exports?.["."] !== "./adapter.mjs")
    fail("starter package must export ./adapter.mjs");
  if (!packageJson.files?.includes("fixtures"))
    fail("starter package must include fixtures in files");
  if (!packageJson.peerDependencies?.["cartograph-cli"])
    fail("starter package must declare cartograph-cli as a peer dependency");
  const testSource = readFileSync(
    resolve(starterRoot, "test/adapter.test.mjs"),
    "utf8",
  );
  for (const requiredImport of [
    "runAdapterConformance",
    "negotiateAdapterCompatibility",
    "parseAdapterManifest",
    "parseAdapterInput",
  ]) {
    if (!testSource.includes(requiredImport))
      fail(`starter compatibility test is missing ${requiredImport}`);
  }
  const files = packageFiles();
  for (const required of requiredFiles) {
    if (!files.includes(required))
      fail(`starter package dry-run omitted ${required}`);
  }
  return { name: packageJson.name, version: packageJson.version, files };
};

const validateFixture = () => {
  const fixture = readJson(fixturePath);
  const mirroredFixture = readJson(mirroredFixturePath);
  const schema = readJson(fixtureSchemaPath);
  const validate = new Ajv({ allErrors: true }).compile(schema);
  if (!validate(fixture))
    fail(`fixture schema failed: ${JSON.stringify(validate.errors)}`);
  const canonicalFixture = JSON.stringify({ ...fixture, $schema: undefined });
  if (
    canonicalFixture !==
    JSON.stringify({ ...mirroredFixture, $schema: undefined })
  )
    fail("starter package fixture differs from its governed test mirror");
  const digest = createHash("sha256").update(canonicalFixture).digest("hex");
  return { fixture, digest };
};

const validateSecurity = (adapter, input) => {
  assertThrows(
    () =>
      parseAdapterManifest({
        ...adapter.manifest,
        execution: { ...adapter.manifest.execution, network: true },
      }),
    "network authority declaration",
  );
  assertThrows(
    () => parseAdapterInput({ ...input, config: { command: "node" } }),
    "executable configuration",
  );
  assertThrows(
    () =>
      parseAdapterInput({
        ...input,
        source: { ...input.source, include: ["../outside"] },
      }),
    "source path escape",
  );
  return {
    network: false,
    childProcess: false,
    repositoryCodeExecution: false,
  };
};

const validateIsolation = async (input) => {
  if (!supportsAdapterIsolation()) {
    try {
      await runAdapterIsolated({ adapterModule: adapterPath, input });
    } catch (error) {
      if (
        !(error instanceof AdapterIsolationError) ||
        error.code !== "unsupported-runtime"
      )
        throw error;
      return { available: false, reason: error.code };
    }
    fail("unsupported isolation runtime unexpectedly ran the starter");
  }
  const output = await runAdapterIsolated({
    adapterModule: adapterPath,
    input,
  });
  if (output.capability.id !== "cartograph.starter.example")
    fail("isolated starter returned the wrong manifest");
  return { available: true, state: output.compatibility?.state ?? null };
};

const validate = async () => {
  const packageReport = validatePackage();
  const { fixture, digest } = validateFixture();
  const module = await import(adapterPath);
  const adapter = module.default;
  const manifest = parseAdapterManifest(adapter.manifest);
  if (
    manifest.id !== fixture.adapterId ||
    manifest.version !== fixture.adapterVersion
  )
    fail("fixture adapter identity does not match the starter manifest");

  const report = runAdapterConformance(adapter, {
    cases: fixture.cases.map((entry) => ({
      id: entry.id,
      input: inputFor(entry.fixture),
      expect: entry.expect,
    })),
    repetitions: 2,
    maxDurationMs: 1_000,
  });
  if (!report.deterministic || !report.evidenceComplete)
    fail(
      "starter conformance report is not deterministic and evidence-complete",
    );

  const compatible = negotiateAdapterCompatibility(adapter.manifest, {
    ...ADAPTER_COMPATIBILITY_REGISTRY.current,
    allowExperimental: false,
  });
  if (compatible.state !== "compatible")
    fail(`starter current compatibility state is ${compatible.state}`);
  const rejected = negotiateAdapterCompatibility(adapter.manifest, {
    ...ADAPTER_COMPATIBILITY_REGISTRY.current,
    capabilityRegistryVersion:
      ADAPTER_COMPATIBILITY_REGISTRY.current.capabilityRegistryVersion + 1,
    allowExperimental: false,
  });
  if (rejected.state !== "rejected")
    fail(`starter future compatibility state is ${rejected.state}`);

  const security = validateSecurity(adapter, inputFor("supported"));
  const isolation = await validateIsolation(inputFor("supported"));
  return {
    ok: true,
    package: packageReport,
    fixtureDigest: `sha256:${digest}`,
    adapterId: manifest.id,
    adapterVersion: manifest.version,
    compatibility: compatible.state,
    rejectedFutureCompatibility: rejected.state,
    conformance: {
      cases: report.cases.length,
      deterministic: report.deterministic,
      evidenceComplete: report.evidenceComplete,
      maxObservedMs: report.performance.maxObservedMs,
    },
    security,
    isolation,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/adapter-starter.mjs validate",
  );
  process.exit(2);
}

validate()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
