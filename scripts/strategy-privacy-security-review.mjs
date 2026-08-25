#!/usr/bin/env node
/* global URL, console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const CONTRACT = "cartograph.strategy-privacy-security-review";
const SCHEMA_VERSION = 1;
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/strategy-security/review.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/strategy-privacy-security-review.v0.1.schema.json",
);

const REQUIRED_ASSETS = [
  "source-input",
  "graph-diff-integrity",
  "local-files-and-worktree",
  "credentials-and-tokens",
  "reports-and-artifacts",
  "ci-availability-and-budgets",
  "release-integrity",
];
const REQUIRED_ACTORS = [
  "local-caller",
  "repository-author",
  "fork-contributor",
  "github-runner",
  "dependency-or-release-actor",
  "security-reporter",
];
const REQUIRED_FLOWS = [
  "local-source-to-analyzer",
  "git-to-temporary-revision",
  "graph-to-local-report",
  "pull-request-to-read-only-action",
  "local-policy-to-evaluator",
  "local-trace-to-reconciliation",
  "release-input-to-artifact",
];
const REQUIRED_RETENTION = [
  "source-retention",
  "revision-tree-retention",
  "local-output-retention",
  "github-artifact-retention",
  "runtime-trace-retention",
  "workflow-log-retention",
  "telemetry-retention",
];
const REQUIRED_REVIEW_QUESTIONS = [
  "diff-wall-clock-aggregation",
  "diff-report-cardinality",
  "snapshot-memory-budget",
  "action-root-and-config",
  "runtime-core-vs-cli-ceilings",
  "adapter-isolation-selection",
  "release-privilege-assumption",
];
const REQUIRED_ABUSE_CASES = [
  "repository-code-execution",
  "repository-path-escape",
  "unsafe-git-ref",
  "output-overwrite-or-symlink",
  "resource-exhaustion",
  "report-markup-injection",
  "fork-token-exposure",
  "dependency-or-release-compromise",
  "optional-trace-disclosure",
];
const REQUIRED_MITIGATIONS = [
  "offline-parser-boundary",
  "path-containment-and-nofollow",
  "read-only-git-boundary",
  "resource-and-cancellation-budgets",
  "escaped-static-reports",
  "fork-safe-read-only-ci",
  "expansion-review-gate",
];
const REQUIRED_REJECTIONS = [
  "hosted-source-copy",
  "required-account",
  "hidden-telemetry",
  "automatic-runtime-collector",
  "provider-source-routing",
];
const REQUIRED_RESIDUALS = [
  "dynamic-language-incompleteness",
  "trusted-dependency-chain",
  "concurrent-filesystem-race",
  "runner-boundary",
];
const OFFLINE_FLOWS = new Set([
  "local-source-to-analyzer",
  "git-to-temporary-revision",
  "graph-to-local-report",
  "local-policy-to-evaluator",
  "local-trace-to-reconciliation",
]);

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
};

const stableStringify = (value) => JSON.stringify(stableValue(value));

const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const fail = (message) => {
  throw new Error(`${CONTRACT} validation failed: ${message}`);
};

const assertPublicText = (value, label) => {
  if (
    /(?:\/Users\/|\/home\/|password=|BEGIN (?:RSA|OPENSSH) PRIVATE KEY|gh[pous]_[A-Za-z0-9]+)/u.test(
      value,
    )
  )
    fail(`${label} contains a private path or secret marker`);
};

const ids = (entries, label) => {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) fail(`duplicate ${label} ${entry.id}`);
    seen.add(entry.id);
    for (const value of Object.values(entry)) {
      if (typeof value === "string")
        assertPublicText(value, `${label} ${entry.id}`);
      if (Array.isArray(value))
        for (const item of value)
          if (typeof item === "string")
            assertPublicText(item, `${label} ${entry.id}`);
    }
    if (!entry.evidenceRefs?.length)
      fail(`${label} ${entry.id} has no evidence`);
  }
  return [...seen];
};

const requireExactIds = (actual, expected, label) => {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (stableStringify(sortedActual) !== stableStringify(sortedExpected))
    fail(`${label} set drifted`);
};

const validateSemantics = (fixture) => {
  if (fixture.contract !== CONTRACT || fixture.schemaVersion !== SCHEMA_VERSION)
    fail("contract or schema version drifted");
  if (fixture.selectedBranch.id !== "oss-local-first")
    fail("selected branch must remain OSS-only local-first");
  if (
    fixture.decision.id !== "oss-only-no-new-boundary" ||
    fixture.decision.hostedExpansion !== "deferred" ||
    fixture.decision.newTrustBoundaryRequired !== false
  )
    fail(
      "strategy decision must defer hosted expansion without a new boundary",
    );
  for (const [key, value] of Object.entries(fixture.scope)) {
    if (typeof value === "boolean" && value !== false)
      fail(`scope ${key} must remain false`);
  }
  if (fixture.scope.collectionMode !== "local-explicit-inputs-only")
    fail("collection mode must remain local and explicit");

  requireExactIds(ids(fixture.assets, "asset"), REQUIRED_ASSETS, "asset");
  requireExactIds(ids(fixture.actors, "actor"), REQUIRED_ACTORS, "actor");
  requireExactIds(
    ids(fixture.dataFlows, "data flow"),
    REQUIRED_FLOWS,
    "data flow",
  );
  requireExactIds(
    ids(fixture.retention, "retention rule"),
    REQUIRED_RETENTION,
    "retention",
  );
  requireExactIds(
    ids(fixture.resolvedQuestions, "review question"),
    REQUIRED_REVIEW_QUESTIONS,
    "review question",
  );
  requireExactIds(
    ids(fixture.abuseCases, "abuse case"),
    REQUIRED_ABUSE_CASES,
    "abuse case",
  );
  requireExactIds(
    ids(fixture.blockingMitigations, "mitigation"),
    REQUIRED_MITIGATIONS,
    "mitigation",
  );
  requireExactIds(
    ids(fixture.rejectedDataCollection, "rejected collection"),
    REQUIRED_REJECTIONS,
    "rejected collection",
  );
  requireExactIds(
    ids(fixture.residualRisks, "residual risk"),
    REQUIRED_RESIDUALS,
    "residual risk",
  );

  for (const flow of fixture.dataFlows) {
    if (OFFLINE_FLOWS.has(flow.id) && flow.network !== false)
      fail(`local data flow ${flow.id} enables network access`);
    if (!OFFLINE_FLOWS.has(flow.id) && flow.network !== true)
      fail(`workflow/release data flow ${flow.id} must disclose network use`);
    if (flow.controls.length === 0) fail(`data flow ${flow.id} has no control`);
  }
  if (
    !fixture.resolvedQuestions.some(
      (question) => question.status === "gap-remains",
    )
  )
    fail("review must retain at least one unresolved control gap");
  for (const abuseCase of fixture.abuseCases) {
    if (abuseCase.status === "blocked" && abuseCase.controls.length === 0)
      fail(`blocked abuse case ${abuseCase.id} has no control`);
  }
  const mitigationById = new Map(
    fixture.blockingMitigations.map((mitigation) => [
      mitigation.id,
      mitigation,
    ]),
  );
  for (const id of REQUIRED_MITIGATIONS) {
    if (!mitigationById.has(id)) fail(`required mitigation is missing: ${id}`);
  }
  if (
    mitigationById.get("expansion-review-gate")?.status !==
    "required-before-expansion"
  )
    fail("hosted expansion gate must remain blocking");
  for (const rejection of fixture.rejectedDataCollection) {
    if (
      !/reject|not|without|no |prohibit|disabled|defer/iu.test(
        rejection.rationale,
      )
    )
      fail(`rejected collection ${rejection.id} needs a rejection rationale`);
  }
  if (
    fixture.tenancyAuthorization.multiTenant ||
    fixture.tenancyAuthorization.accountRequired ||
    fixture.tenancyAuthorization.secretsAvailable ||
    fixture.tenancyAuthorization.sourceUpload ||
    fixture.tenancyAuthorization.actionPermission !== "contents-read-only"
  )
    fail("tenancy or authorization boundary widened");
  if (
    fixture.supplyChain.installScriptsExecuted ||
    !fixture.supplyChain.actionsPinned ||
    !fixture.supplyChain.lockfileRequired ||
    !fixture.supplyChain.dependencyReview ||
    !fixture.supplyChain.codeql ||
    !fixture.supplyChain.provenance
  )
    fail("supply-chain controls drifted");
  if (
    fixture.provenance.sourceBodiesIncluded ||
    fixture.provenance.secretsIncluded
  )
    fail("provenance contains source or secrets");
};

export const validate = (fixturePath = defaultFixturePath) => {
  const fixture = readJson(fixturePath);
  const schema = readJson(schemaPath);
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(
    schema,
  );
  if (!validateSchema(fixture))
    fail(`schema validation failed: ${JSON.stringify(validateSchema.errors)}`);
  validateSemantics(fixture);
  const reviewDigest = digest(stableStringify(fixture));
  const adrText = readFileSync(
    resolve(repositoryRoot, "docs/adr/0007-local-first-investment-boundary.md"),
    "utf8",
  );
  if (!adrText.includes(fixture.reviewId) || !adrText.includes(reviewDigest))
    fail("ADR 0007 is not bound to this review ID and digest");
  return {
    ok: true,
    contract: CONTRACT,
    schemaVersion: SCHEMA_VERSION,
    reviewId: fixture.reviewId,
    selectedBranch: fixture.selectedBranch.id,
    decision: fixture.decision.id,
    assets: fixture.assets.length,
    actors: fixture.actors.length,
    dataFlows: fixture.dataFlows.length,
    reviewGaps: fixture.resolvedQuestions.filter(
      (question) => question.status === "gap-remains",
    ).length,
    abuseCases: fixture.abuseCases.length,
    blockingMitigations: fixture.blockingMitigations.length,
    rejectedDataCollection: fixture.rejectedDataCollection.length,
    hostedExpansion: fixture.decision.hostedExpansion,
    network: false,
    sourceUpload: false,
    hiddenTelemetry: false,
    digest: reviewDigest,
  };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node scripts/strategy-privacy-security-review.mjs validate [--fixture path]",
    );
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(validate(argumentValue("--fixture"))));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
