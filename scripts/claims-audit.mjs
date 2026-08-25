#!/usr/bin/env node
/* global URL, console, process */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const CONTRACT = "cartograph.claims-audit";
const SCHEMA_VERSION = 1;
const AUDIT_ID = "claims-audit-year1-3-v0.1";
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/claims-audit/audit.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/claims-audit.v0.1.schema.json",
);
const reportPath = resolve(repositoryRoot, "docs/CLAIMS_AUDIT.md");
const adrPath = resolve(
  repositoryRoot,
  "docs/adr/0007-local-first-investment-boundary.md",
);

const expectedClaimIds = [
  "y1-capability-graph",
  "y1-capability-diff",
  "y1-capability-action",
  "y1-capability-distribution",
  "y1-quality-fixture-thresholds",
  "y1-quality-unsupported-diagnostics",
  "y1-privacy-local-boundary",
  "y1-maintenance-support-window",
  "y1-adoption-external-sample",
  "y1-adoption-traction",
  "y2-capability-identity",
  "y2-capability-policy",
  "y2-capability-adr",
  "y2-capability-adapter-contract",
  "y2-quality-identity-baseline",
  "y2-quality-policy-regression",
  "y2-privacy-adapter-isolation",
  "y2-maintenance-ownership",
  "y2-adoption-contributors",
  "y3-capability-rust-pilot",
  "y3-capability-language-expansion",
  "y3-quality-broad-rust-accuracy",
  "y3-capability-runtime-reconciliation",
  "y3-quality-runtime-reproducibility",
  "y3-quality-compatibility-sample",
  "y3-capability-community-feedback",
  "y3-privacy-strategy-boundary",
  "y3-adoption-external-feedback",
  "y3-maintenance-release-history",
  "y3-maintenance-capacity",
  "y3-quality-oss-hardening",
  "y3-privacy-hosted-expansion",
];

const expectedYear4Ids = [
  "year4-correctness-scale",
  "year4-offline-composition",
  "year4-governed-review",
  "year4-replication-stewardship",
];

const expectedSourceInventory = [
  "docs/ROADMAP.md",
  "docs/EVALUATION.md",
  "docs/ACTION.md",
  "docs/RELEASE.md",
  "docs/COMPATIBILITY_REVIEW.md",
  "docs/IDENTITY_QUALITY.md",
  "docs/POLICIES.md",
  "docs/ADAPTERS.md",
  "docs/LANGUAGE_EXPANSION_GATE.md",
  "docs/RUNTIME_RECONCILIATION.md",
  "docs/COMMUNITY_FEEDBACK.md",
  "docs/STRATEGY_PRIVACY_SECURITY_REVIEW.md",
  "docs/OSS_HEALTH_SCORECARD.md",
  "docs/MAINTENANCE.md",
  "docs/UPGRADING.md",
];

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

const validateSemantics = (fixture) => {
  if (fixture.contract !== CONTRACT || fixture.schemaVersion !== SCHEMA_VERSION)
    fail("contract or schema version drifted");
  if (fixture.auditId !== AUDIT_ID) fail("audit ID drifted");
  if (!existsSync(reportPath) || !existsSync(adrPath))
    fail("public report or strategy ADR is missing");

  const inventory = new Set(fixture.sourceInventory);
  for (const path of expectedSourceInventory) {
    if (!inventory.has(path)) fail(`source inventory is missing ${path}`);
  }
  for (const path of inventory) {
    assertPublicText(path, "source inventory path");
    if (!existsSync(resolve(repositoryRoot, path)))
      fail(`source inventory path does not exist: ${path}`);
  }

  const claimIds = fixture.claims.map((claim) => claim.id);
  if (stableStringify(claimIds) !== stableStringify(expectedClaimIds))
    fail("claims must remain ordered and complete");
  const claimById = new Map();
  for (const claim of fixture.claims) {
    if (claimById.has(claim.id)) fail(`duplicate claim ${claim.id}`);
    claimById.set(claim.id, claim);
    assertPublicText(claim.statement, `claim ${claim.id} statement`);
    assertPublicText(claim.finding, `claim ${claim.id} finding`);
    for (const limitation of claim.limitations)
      assertPublicText(limitation, `claim ${claim.id} limitation`);
    if (claim.status !== "verified" && claim.feedsYear4.length === 0)
      fail(`non-verified claim ${claim.id} must feed Year 4`);
    if (claim.status === "unsupported" && !/unsupported/u.test(claim.finding))
      fail(`unsupported claim ${claim.id} must say unsupported plainly`);
    if (
      claim.status === "not-observed" &&
      !/(?:not observed|no |zero |absence)/iu.test(claim.finding)
    )
      fail(`not-observed claim ${claim.id} must say not observed plainly`);
    if (
      claim.status === "negative" &&
      !/(?:no |negative|absent|does not)/iu.test(claim.finding)
    )
      fail(`negative claim ${claim.id} must state the negative result plainly`);
    if (claim.status === "deferred" && !/defer/iu.test(claim.finding))
      fail(`deferred claim ${claim.id} must say deferred plainly`);
    for (const evidence of claim.evidence) {
      if (!inventory.has(evidence.path))
        fail(
          `claim ${claim.id} evidence is outside source inventory: ${evidence.path}`,
        );
      if (!existsSync(resolve(repositoryRoot, evidence.path)))
        fail(
          `claim ${claim.id} evidence path does not exist: ${evidence.path}`,
        );
      assertPublicText(evidence.locator, `claim ${claim.id} evidence locator`);
      if (
        /(?:fetch\(|curl |https?:\/\/|node:https|node:http|telemetry)/iu.test(
          evidence.command,
        )
      )
        fail(
          `claim ${claim.id} evidence command is not offline: ${evidence.command}`,
        );
    }
  }

  const charterEntries = fixture.year4Charter.entries;
  const charterIds = charterEntries.map((entry) => entry.id);
  if (stableStringify(charterIds) !== stableStringify(expectedYear4Ids))
    fail("Year 4 charter entries must remain ordered and complete");
  const charterById = new Map(charterEntries.map((entry) => [entry.id, entry]));
  for (const entry of charterEntries) {
    assertPublicText(entry.title, `Year 4 entry ${entry.id} title`);
    assertPublicText(entry.action, `Year 4 entry ${entry.id} action`);
    assertPublicText(entry.gate, `Year 4 entry ${entry.id} gate`);
    for (const claimId of entry.linkedClaimIds) {
      if (!claimById.has(claimId))
        fail(`Year 4 entry ${entry.id} references unknown claim ${claimId}`);
    }
  }
  for (const claim of fixture.claims) {
    for (const entryId of claim.feedsYear4) {
      const entry = charterById.get(entryId);
      if (!entry || !entry.linkedClaimIds.includes(claim.id))
        fail(`claim ${claim.id} has an unbound Year 4 feed ${entryId}`);
    }
  }

  const statusCounts = {
    verified: 0,
    partial: 0,
    unsupported: 0,
    negative: 0,
    notObserved: 0,
    deferred: 0,
  };
  const yearCounts = { year1: 0, year2: 0, year3: 0 };
  const categoryCounts = {
    capability: 0,
    quality: 0,
    privacy: 0,
    adoption: 0,
    maintenance: 0,
  };
  for (const claim of fixture.claims) {
    statusCounts[
      claim.status === "not-observed" ? "notObserved" : claim.status
    ] += 1;
    yearCounts[`year${claim.year}`] += 1;
    categoryCounts[claim.category] += 1;
  }
  if (
    stableStringify(statusCounts) !==
    stableStringify(fixture.summary.statusCounts)
  )
    fail("status counts drifted");
  if (
    stableStringify(yearCounts) !== stableStringify(fixture.summary.yearCounts)
  )
    fail("year counts drifted");
  if (
    stableStringify(categoryCounts) !==
    stableStringify(fixture.summary.categoryCounts)
  )
    fail("category counts drifted");
  if (
    fixture.summary.verifiedClaims !== statusCounts.verified ||
    fixture.summary.nonVerifiedClaims !==
      fixture.claims.length - statusCounts.verified
  )
    fail("verified/non-verified counts drifted");
  if (
    fixture.scope.network ||
    fixture.scope.sourceBodiesIncluded ||
    fixture.scope.privateDataIncluded ||
    fixture.summary.network ||
    fixture.summary.sourceBodiesIncluded ||
    fixture.summary.privateDataIncluded ||
    fixture.summary.hostedExpansion !== "deferred" ||
    fixture.year4Charter.hostedExpansion !== "deferred"
  )
    fail("claims audit violates the local evidence boundary");

  const auditDigest = digest(stableStringify(fixture));
  const report = readFileSync(reportPath, "utf8");
  const adr = readFileSync(adrPath, "utf8");
  if (!report.includes(AUDIT_ID) || !report.includes(auditDigest))
    fail("public claims audit report is not bound to this audit ID and digest");
  for (const claimId of expectedClaimIds) {
    if (!report.includes(`\`${claimId}\``))
      fail(`public claims audit report is missing claim ${claimId}`);
  }
  for (const entryId of expectedYear4Ids) {
    if (!report.includes(`\`${entryId}\``))
      fail(`public claims audit report is missing Year 4 entry ${entryId}`);
  }
  if (!adr.includes(AUDIT_ID) || !adr.includes(auditDigest))
    fail("strategy ADR is not bound to this audit ID and digest");
  return { auditDigest, statusCounts, yearCounts, categoryCounts, claimById };
};

export const validate = (fixturePath = defaultFixturePath) => {
  const fixture = readJson(fixturePath);
  const schema = readJson(schemaPath);
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(
    schema,
  );
  if (!validateSchema(fixture))
    fail(`schema validation failed: ${JSON.stringify(validateSchema.errors)}`);
  const semantic = validateSemantics(fixture);
  return {
    ok: true,
    contract: CONTRACT,
    schemaVersion: SCHEMA_VERSION,
    auditId: AUDIT_ID,
    asOf: fixture.asOf,
    claims: fixture.claims.length,
    verifiedClaims: fixture.summary.verifiedClaims,
    nonVerifiedClaims: fixture.summary.nonVerifiedClaims,
    statusCounts: semantic.statusCounts,
    year4Entries: fixture.year4Charter.entries.length,
    hostedExpansion: "deferred",
    network: false,
    sourceBodiesIncluded: false,
    privateDataIncluded: false,
    digest: semantic.auditDigest,
  };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node scripts/claims-audit.mjs validate [--fixture path]",
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
