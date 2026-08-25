#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import Ajv from "ajv";

import {
  FASTIFY_ADAPTER_MANIFEST,
  RUST_ADAPTER_MANIFEST,
  SAMPLE_ADAPTER_MANIFEST,
} from "../src/adapters/index.ts";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const matrixRelativePath = "schema/adapter-support-matrix.v0.1.json";
const matrixPath = resolve(
  repositoryRoot,
  argumentValue("--matrix") ?? matrixRelativePath,
);
const canonicalMatrixPath = resolve(repositoryRoot, matrixRelativePath);
const schemaRelativePath = "schema/adapter-support-matrix.v0.1.schema.json";

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
  status = "<matrix>",
  criterion = "<matrix>",
} = {}) =>
  `adapter=${adapter} capability=${capability} fixture=${fixture} compatibility=${compatibility} status=${status} criterion=${criterion}`;

const fail = (message, details = {}) => {
  throw new Error(
    `cartograph.adapter-support validation failed [${context(details)}]: ${message}`,
  );
};

const ensure = (condition, message, details) => {
  if (!condition) fail(message, details);
};

const equal = (label, actual, expected, details) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(
      `${label}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
      details,
    );
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

const requirePath = (candidate, label, details) => {
  const target = resolveRepositoryPath(candidate, label, details);
  ensure(existsSync(target), `${label} does not exist: ${candidate}`, details);
  return target;
};

const manifestFor = (manifest) => ({
  version: manifest.version,
  capabilities: manifest.capabilities.map((capability) => capability.id).sort(),
});

const validate = async () => {
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  const schema = readJson(schemaRelativePath);
  const schemaValidator = new Ajv({ allErrors: true, strict: false }).compile(
    schema,
  );
  ensure(
    schemaValidator(matrix),
    `matrix schema validation failed: ${JSON.stringify(schemaValidator.errors)}`,
    { compatibility: "matrix-schema" },
  );

  const docs = readText("docs/ADAPTER_SELECTION.md");
  const supportDocs = readText("docs/SUPPORT_MATRIX.md");
  const adaptersDocs = readText("docs/ADAPTERS.md");
  const evaluationDocs = readText("docs/EVALUATION.md");
  const readme = readText("README.md");

  const statuses = matrix.statusDefinitions.map((entry) => entry.id);
  const expectedStatuses = [
    "implemented",
    "experimental",
    "deferred",
    "unsupported",
  ];
  equal(
    "status definition coverage",
    [...new Set(statuses)].sort(),
    [...expectedStatuses].sort(),
    { compatibility: "status-coverage" },
  );
  equal("status definition count", statuses.length, expectedStatuses.length, {
    compatibility: "status-coverage",
  });

  const criteria = matrix.criteria.map((entry) => entry.id);
  const expectedCriteria = [
    "demand",
    "semantic-fit",
    "quality",
    "reproducibility",
    "security",
    "ownership",
    "compatibility",
    "maintenance",
  ];
  equal(
    "selection criteria coverage",
    [...new Set(criteria)].sort(),
    [...expectedCriteria].sort(),
    { compatibility: "criteria-coverage" },
  );
  equal("selection criteria count", criteria.length, expectedCriteria.length, {
    compatibility: "criteria-coverage",
  });

  const entriesById = new Map();
  for (const entry of matrix.entries) {
    const details = { adapter: entry.id, status: entry.status };
    ensure(!entriesById.has(entry.id), "duplicate matrix entry ID", details);
    entriesById.set(entry.id, entry);
    ensure(
      statuses.includes(entry.status),
      "entry uses an undeclared status",
      details,
    );
    for (const reference of entry.references)
      requirePath(reference, `reference for ${entry.id}`, details);
    if (entry.status === "implemented" || entry.status === "experimental") {
      ensure(
        typeof entry.owner === "string" && entry.owner.length > 0,
        "promoted entry must name an owner",
        details,
      );
      ensure(
        typeof entry.backup === "string" && entry.backup.length > 0,
        "promoted entry must name a backup",
        details,
      );
    }
  }

  const entriesByStatus = Object.fromEntries(
    expectedStatuses.map((status) => [
      status,
      matrix.entries
        .filter((entry) => entry.status === status)
        .map((entry) => entry.id),
    ]),
  );
  for (const status of expectedStatuses)
    ensure(
      entriesByStatus[status].length > 0,
      `status has no matrix entry: ${status}`,
      { status, compatibility: "status-entry-coverage" },
    );

  const runtimeManifests = new Map([
    [SAMPLE_ADAPTER_MANIFEST.id, SAMPLE_ADAPTER_MANIFEST],
    [FASTIFY_ADAPTER_MANIFEST.id, FASTIFY_ADAPTER_MANIFEST],
    [RUST_ADAPTER_MANIFEST.id, RUST_ADAPTER_MANIFEST],
  ]);
  const starterModule = await import(
    pathToFileURL(
      resolve(repositoryRoot, "examples/adapter-starter/adapter.mjs"),
    ).href
  );
  runtimeManifests.set(starterModule.manifest.id, starterModule.manifest);

  const runtimeRows = [
    "cartograph.sample",
    "cartograph.fastify",
    "cartograph.rust",
    "cartograph.starter.example",
  ];
  for (const adapterId of runtimeRows) {
    const entry = entriesById.get(adapterId);
    const manifest = runtimeManifests.get(adapterId);
    const details = { adapter: adapterId, status: entry?.status };
    ensure(
      entry !== undefined,
      "runtime adapter is missing from matrix",
      details,
    );
    ensure(
      manifest !== undefined,
      "runtime adapter manifest is unavailable",
      details,
    );
    ensure(
      entry.status !== "deferred" && entry.status !== "unsupported",
      "shipped adapter cannot be outside an active status",
      details,
    );
    equal("manifest version", entry.version, manifest.version, details);
    equal(
      "manifest capability IDs",
      [...(entry.capabilities ?? [])].sort(),
      manifestFor(manifest).capabilities,
      details,
    );
  }

  const matrixDigest = digest(matrix);
  const isCanonical = matrixPath === canonicalMatrixPath;
  if (isCanonical) {
    ensure(
      docs.includes(matrix.matrixId),
      "selection RFC is missing the matrix ID",
      { compatibility: "documentation" },
    );
    ensure(
      docs.includes(matrixDigest),
      "selection RFC is missing the matrix digest",
      { compatibility: "documentation" },
    );
    ensure(
      supportDocs.includes(matrix.matrixId),
      "support matrix docs are missing the matrix ID",
      { compatibility: "documentation" },
    );
    ensure(
      supportDocs.includes(matrixDigest),
      "support matrix docs are missing the matrix digest",
      { compatibility: "documentation" },
    );
    ensure(
      adaptersDocs.includes("ADAPTER_SELECTION.md"),
      "adapter docs do not link the selection RFC",
      { compatibility: "documentation" },
    );
    ensure(
      readme.includes("ADAPTER_SELECTION.md"),
      "README does not link the selection RFC",
      { compatibility: "documentation" },
    );
    ensure(
      readme.includes("adapter-support-matrix.v0.1.json"),
      "README does not link the machine support matrix",
      { compatibility: "documentation" },
    );
    ensure(
      evaluationDocs.includes("E-006"),
      "evaluation docs do not record E-006",
      { compatibility: "documentation" },
    );
    for (const status of expectedStatuses) {
      ensure(
        docs.includes(`\`${status}\``),
        `selection RFC is missing status ${status}`,
        { status, compatibility: "documentation-status" },
      );
      ensure(
        supportDocs.includes(`\`${status}\``),
        `support matrix docs are missing status ${status}`,
        { status, compatibility: "documentation-status" },
      );
    }
    for (const criterion of expectedCriteria)
      ensure(
        docs.includes(`\`${criterion}\``),
        `selection RFC is missing criterion ${criterion}`,
        { criterion, compatibility: "documentation-criteria" },
      );
  }

  return {
    ok: true,
    contract: matrix.contract,
    schemaVersion: matrix.schemaVersion,
    matrixId: matrix.matrixId,
    matrixDigest,
    review: matrix.review,
    criteria: criteria.length,
    statuses: expectedStatuses,
    entries: matrix.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      status: entry.status,
    })),
    entriesByStatus,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/adapter-support.mjs validate [--root path] [--matrix path]",
  );
  process.exit(2);
}

validate()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
