#!/usr/bin/env node
/* global URL, console, process */

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

import {
  createPatchFilterReport,
  diffGraphSnapshots,
  evaluatePolicyOnDiff,
  parseGraphSnapshot,
  serializePatchFilterReport,
  stableStringify,
} from "../src/core/index.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/patch-filter/scenario.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/patch-filter.v0.1.schema.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/patch-filter-fixtures.v0.1.schema.json",
);

const fail = (message) => {
  throw new Error(`cartograph.patch-filter validation failed: ${message}`);
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const containedPath = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0)
    fail(`${label} must be a non-empty repository-relative path`);
  const candidate = resolve(repositoryRoot, value);
  const relativePath = relative(repositoryRoot, candidate);
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.startsWith("~") ||
    value.includes("\0") ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  )
    fail(`${label} must stay inside the repository: ${value}`);
  if (!existsSync(candidate)) fail(`${label} does not exist: ${value}`);
  return candidate;
};

const expectEqual = (actual, expected, label) => {
  if (stableStringify(actual) !== stableStringify(expected))
    fail(
      `${label} drifted: expected ${stableStringify(expected)}, found ${stableStringify(actual)}`,
    );
};

const validate = () => {
  const fixture = readJson(fixturePath);
  const fixtureSchema = readJson(fixtureSchemaPath);
  const fixtureValidator = new Ajv({ allErrors: true, strict: false }).compile(
    fixtureSchema,
  );
  if (!fixtureValidator(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(fixtureValidator.errors)}`,
    );

  const before = parseGraphSnapshot(
    readJson(
      containedPath(
        `test/fixtures/patch-filter/${fixture.before}`,
        "before fixture",
      ),
    ),
  );
  const after = parseGraphSnapshot(
    readJson(
      containedPath(
        `test/fixtures/patch-filter/${fixture.after}`,
        "after fixture",
      ),
    ),
  );
  const diff = diffGraphSnapshots(before, after);
  const policyEvaluation = evaluatePolicyOnDiff(fixture.policy, diff);
  const report = createPatchFilterReport({
    before,
    after,
    diff,
    request: fixture.request,
    policyEvaluation,
  });
  const repeated = createPatchFilterReport({
    before,
    after,
    diff,
    request: fixture.request,
    policyEvaluation,
  });
  const reportSchema = readJson(schemaPath);
  const reportValidator = new Ajv({ allErrors: true, strict: false }).compile(
    reportSchema,
  );
  if (!reportValidator(report))
    fail(
      `report schema validation failed: ${JSON.stringify(reportValidator.errors)}`,
    );
  expectEqual(
    serializePatchFilterReport(report),
    serializePatchFilterReport(repeated),
    "serialized report",
  );

  const expected = fixture.expected;
  expectEqual(
    report.selection.before.nodes.map((node) => node.id),
    expected.beforeNodeIds,
    "before selected nodes",
  );
  expectEqual(
    report.selection.after.nodes.map((node) => node.id),
    expected.afterNodeIds,
    "after selected nodes",
  );
  expectEqual(
    report.selection.before.edges.map((edge) => edge.identity),
    expected.beforeEdgeIds,
    "before selected edges",
  );
  expectEqual(
    report.selection.after.edges.map((edge) => edge.identity),
    expected.afterEdgeIds,
    "after selected edges",
  );
  expectEqual(
    report.omitted.files.map((file) => file.path),
    expected.generatedOmittedFiles,
    "generated omitted files",
  );
  if (!report.selection.diff.identity.matches.includes(expected.renameIdentity))
    fail(`rename identity was not selected: ${expected.renameIdentity}`);
  if (report.policy.status !== expected.policyStatus)
    fail(
      `policy status drifted: expected ${expected.policyStatus}, found ${report.policy.status}`,
    );
  if (
    report.policy.omittedViolationIds.length !== expected.omittedViolationCount
  )
    fail(
      `omitted policy violation count drifted: expected ${expected.omittedViolationCount}, found ${report.policy.omittedViolationIds.length}`,
    );
  if (!report.deterministic || !report.readOnly)
    fail("report authority flags drifted");

  return {
    ok: true,
    contract: report.contract,
    schemaVersion: report.schemaVersion,
    filterId: report.filterId,
    beforeSelectedNodes: report.selection.before.nodes.length,
    afterSelectedNodes: report.selection.after.nodes.length,
    beforeSelectedEdges: report.selection.before.edges.length,
    afterSelectedEdges: report.selection.after.edges.length,
    omittedRegions: report.omitted.regions.length,
    generatedOmittedFiles: report.omitted.files.length,
    renameIdentities: report.selection.diff.identity.matches.length,
    policyStatus: report.policy.status,
    policyViolationIds: report.policy.violationIds,
    omittedViolationIds: report.policy.omittedViolationIds,
    deterministic: report.deterministic,
    readOnly: report.readOnly,
    requestDigest: report.requestDigest,
    reportDigest: report.reportDigest,
  };
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] !== "validate") {
    console.error("usage: node --import tsx scripts/patch-filter.mjs validate");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(validate()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export { validate as validatePatchFilter };
