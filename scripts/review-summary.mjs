#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  ArchitectureWaiverEvaluationSchema,
  buildReviewSummary,
  evaluateOwnershipWaiverDrift,
  parseAdrReferenceDocument,
  parseCodeowners,
  parseFindingLifecycleInput,
  parseOwnershipInput,
  parseOwnershipWaiverDriftInput,
  replayFindingLifecycle,
  serializeReviewSummary,
  resolveOwnership,
} from "../src/core/index.ts";
import {
  renderReviewSummaryHtml,
  renderReviewSummaryMarkdown,
} from "../src/report/review.ts";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  argumentValue("--fixture") ??
    "test/fixtures/review-summary/scenarios.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/review-summary-fixtures.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readFixtureJson = (path) =>
  readJson(resolve(repositoryRoot, "test/fixtures", path));
const fail = (message) => {
  throw new Error(`cartograph.review-summary validation failed: ${message}`);
};
const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const sortedUnique = (values) => [...new Set(values)].sort();

const policyContext = () => {
  const violation = {
    id: "review-policy-violation",
    policyId: "review-policy",
    ruleId: "no-added-diagnostic",
    target: "diff",
    assertion: "absent",
    effect: "enforce",
    count: 1,
    expected: 0,
    matches: ["diagnostic:added"],
    reason:
      "The review fixture keeps one policy violation for projection coverage.",
    evidenceRefs: ["policy://review/violation"],
  };
  const unsupported = {
    id: "review-policy-unsupported",
    policyId: "review-policy",
    ruleId: "runtime-rule",
    target: "node",
    code: "unsupported-input",
    reason: "The fixture deliberately retains an unsupported policy target.",
    evidenceRefs: ["policy://review/unsupported"],
  };
  return {
    schemaVersion: 1,
    contract: "cartograph.policy-evaluation",
    policyId: "review-policy",
    policyVersion: "1.0.0",
    inputKind: "diff",
    mode: "enforce",
    status: "violations",
    evaluatedRules: 2,
    passedRules: 0,
    unsupportedRules: 1,
    violations: [violation],
    unsupported: [unsupported],
    exceptions: [],
  };
};

const waiverContext = () => {
  const statuses = [
    ["waiver-active", "active", "WAIVER_ACTIVE", "2035-01-01T00:00:00.000Z"],
    [
      "waiver-expiring",
      "expiring",
      "WAIVER_EXPIRING",
      "2030-01-01T00:00:00.000Z",
    ],
    ["waiver-expired", "expired", "WAIVER_EXPIRED", "2020-01-01T00:00:00.000Z"],
    ["waiver-invalid", "invalid", "WAIVER_INVALID", "2032-01-01T00:00:00.000Z"],
  ];
  const waivers = statuses.map(([id, status, code]) => ({
    id,
    ruleId: "no-added-diagnostic",
    status,
    code,
    suppresses: status === "active",
    authorityGranted: false,
    reason: `Fixture waiver ${id} is retained for review projection coverage.`,
    evidenceRefs: [`waiver://${id}`],
  }));
  const evaluation = {
    schemaVersion: 1,
    contract: "cartograph.architecture-waiver",
    mediaType: "application/vnd.cartograph.architecture-waiver+json",
    policyId: "review-policy",
    policyVersion: "1.0.0",
    policyStatus: "violations",
    inputKind: "diff",
    inputDigest: `sha256:${"1".repeat(64)}`,
    status: "violations",
    authorityGranted: false,
    violations: [policyContext().violations[0]],
    unsupported: [],
    suppressed: [],
    waivers,
    summary: {
      waivers: 4,
      active: 1,
      expiring: 1,
      suppressed: 0,
      invalid: 1,
      unsigned: 0,
      replayed: 0,
      expired: 1,
    },
    provenance: {
      resolver: "cartograph.architecture-waiver",
      resolverVersion: "1",
      inputDigest: `sha256:${"2".repeat(64)}`,
      network: false,
      sourceBodiesIncluded: false,
      privateKeysIncluded: false,
      authorityGranted: false,
      deterministic: true,
    },
  };
  return ArchitectureWaiverEvaluationSchema.parse(evaluation);
};

const contextFor = (scenario) => {
  const lifecycleFixture = readFixtureJson(scenario.sources.lifecycle);
  const lifecycle = replayFindingLifecycle(
    parseFindingLifecycleInput(lifecycleFixture.input),
  );
  const ownershipFixture = readFixtureJson(scenario.sources.ownership);
  const codeowners = ownershipFixture.codeowners.map((entry) =>
    parseCodeowners(entry.text, entry),
  );
  const ownership = resolveOwnership(
    parseOwnershipInput({
      ...ownershipFixture.request,
      sources: [
        ...ownershipFixture.request.sources,
        ...codeowners.map((entry) => entry.source),
      ],
      sourceDiagnostics: [
        ...ownershipFixture.request.sourceDiagnostics,
        ...codeowners.flatMap((entry) => entry.diagnostics),
      ],
    }),
  );
  const driftFixture = readFixtureJson(scenario.sources.waiverDrift);
  const drift = evaluateOwnershipWaiverDrift(
    parseOwnershipWaiverDriftInput(driftFixture.scenarios[0].input),
  );
  const adrFixture = readFixtureJson(scenario.sources.adr);
  const adr = parseAdrReferenceDocument(adrFixture.cases[0].document);
  return {
    policy: policyContext(),
    lifecycle,
    ownership,
    waiverEvaluation: waiverContext(),
    waiverDrift: drift,
    waiverSnapshots: [
      "waiver-active",
      "waiver-expiring",
      "waiver-expired",
      "waiver-invalid",
    ].map((id, index) => ({
      id,
      ruleId: "no-added-diagnostic",
      policyVersion: "1.0.0",
      evidenceRevision: "review-evidence",
      createdAt: "2029-01-01T00:00:00.000Z",
      expiresAt: [
        "2035-01-01T00:00:00.000Z",
        "2030-01-01T00:00:00.000Z",
        "2020-01-01T00:00:00.000Z",
        "2032-01-01T00:00:00.000Z",
      ][index],
      waiverDigest: `sha256:${String(index + 3)
        .repeat(64)
        .slice(0, 64)}`,
      scopeDigest: `sha256:${String(index + 7)
        .repeat(64)
        .slice(0, 64)}`,
      affectedIds: ["diagnostic:added"],
      status: ["active", "expiring", "expired", "invalid"][index],
      code: [
        "WAIVER_ACTIVE",
        "WAIVER_EXPIRING",
        "WAIVER_EXPIRED",
        "WAIVER_INVALID",
      ][index],
      evidenceRefs: [`waiver://${id}`],
    })),
    adr,
    artifacts: [
      {
        id: "artifact-diff",
        label: "Graph diff",
        kind: "diff",
        path: "artifacts/diff.json",
        local: true,
      },
      {
        id: "artifact-review",
        label: "Review summary",
        kind: "review",
        path: "artifacts/review.json",
        local: true,
      },
    ],
  };
};

const validate = () => {
  const fixture = readJson(fixturePath);
  const schema = readJson(schemaPath);
  const validator = new Ajv({ allErrors: true }).compile(schema);
  if (!validator(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validator.errors)}`,
    );
  const results = [];
  for (const scenario of fixture.scenarios) {
    const diff = readFixtureJson(scenario.sources.diff);
    const report = buildReviewSummary({
      schemaVersion: 1,
      contract: "cartograph.review-summary",
      diff,
      context: contextFor(scenario),
    });
    const expected = scenario.expected;
    if (report.status !== expected.status)
      fail(
        `scenario ${scenario.id} status drifted: expected ${expected.status}, found ${report.status}`,
      );
    if (
      expected.minimumFindings !== undefined &&
      report.findings.length < expected.minimumFindings
    )
      fail(`scenario ${scenario.id} has too few findings`);
    const kinds = sortedUnique(report.findings.map((finding) => finding.kind));
    for (const kind of expected.requiredKinds)
      if (!kinds.includes(kind))
        fail(`scenario ${scenario.id} lost finding kind ${kind}`);
    for (const context of expected.requiredContext)
      if (!report.context[context].available)
        fail(`scenario ${scenario.id} lost context ${context}`);
    const stepCodes = sortedUnique(report.nextSteps.map((step) => step.code));
    for (const code of expected.requiredNextStepCodes)
      if (!stepCodes.includes(code))
        fail(`scenario ${scenario.id} lost next-step code ${code}`);
    if (report.nextSteps.some((step) => step.mutates))
      fail(`scenario ${scenario.id} contains a mutating next step`);
    const serialized = serializeReviewSummary(report);
    if (serialized !== serializeReviewSummary(JSON.parse(serialized)))
      fail(`scenario ${scenario.id} JSON is not byte-stable`);
    if (
      renderReviewSummaryMarkdown(report).includes("/Users/") ||
      renderReviewSummaryHtml(report).includes("/Users/")
    )
      fail(`scenario ${scenario.id} report leaked an absolute path`);
    const replay = buildReviewSummary({
      schemaVersion: 1,
      contract: "cartograph.review-summary",
      diff,
      context: contextFor(scenario),
    });
    if (serializeReviewSummary(replay) !== serialized)
      fail(`scenario ${scenario.id} evaluation is not deterministic`);
    results.push({
      id: scenario.id,
      status: report.status,
      findings: report.findings.length,
      nextSteps: report.nextSteps.length,
      kinds,
      context: expected.requiredContext,
      digest: digest(serialized),
    });
  }
  return {
    ok: true,
    contract: "cartograph.review-summary",
    schemaVersion: 1,
    fixtureId: fixture.fixtureId,
    scenarios: results,
    offline: true,
    sourceBodiesIncluded: false,
    privateKeysIncluded: false,
    authorityGranted: false,
    automaticActions: false,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/review-summary.mjs validate [--root path] [--fixture path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
