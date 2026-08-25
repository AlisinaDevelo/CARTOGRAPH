#!/usr/bin/env node
/* global URL, console, process */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const CONTRACT = "cartograph.maintainer-resilience";
const SCHEMA_VERSION = 1;
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/maintainer-resilience/report.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/maintainer-resilience.v0.1.schema.json",
);

const expectedRoleIds = [
  "triage",
  "release",
  "security",
  "core-contracts",
  "adapters",
  "roadmap-operations",
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

const pathWithoutAnchor = (value) => value.split("#", 1)[0];

const assertEvidenceRef = (value, label) => {
  assertPublicText(value, label);
  if (/^[A-Z]+-[0-9]+$/u.test(value)) return;
  const relativePath = pathWithoutAnchor(value);
  if (!existsSync(resolve(repositoryRoot, relativePath)))
    fail(
      `${label} does not resolve to a checked-in path or roadmap issue: ${value}`,
    );
};

const validateSemantics = (fixture) => {
  if (fixture.contract !== CONTRACT || fixture.schemaVersion !== SCHEMA_VERSION)
    fail("contract or schema version drifted");
  if (
    fixture.scope.network ||
    fixture.scope.sourcePayloads ||
    fixture.scope.personalData ||
    !fixture.scope.publicOnly
  )
    fail("scope must remain public-only, local, and source-free");

  const roleIds = fixture.roles.map((role) => role.id);
  if (new Set(roleIds).size !== roleIds.length) fail("role IDs must be unique");
  if (stableStringify(roleIds) !== stableStringify(expectedRoleIds))
    fail("role inventory drifted");

  const rolesById = new Map(fixture.roles.map((role) => [role.id, role]));
  const onboardingIds = new Set();
  const onboardingByRole = new Map();
  for (const item of fixture.onboarding) {
    if (onboardingIds.has(item.id)) fail(`duplicate onboarding ID ${item.id}`);
    onboardingIds.add(item.id);
    if (!rolesById.has(item.roleId))
      fail(`onboarding item ${item.id} uses an unknown role`);
    const roleItems = onboardingByRole.get(item.roleId) ?? [];
    roleItems.push(item);
    onboardingByRole.set(item.roleId, roleItems);
    assertPublicText(item.entrypoint, `onboarding ${item.id}`);
    assertPublicText(item.expected, `onboarding ${item.id}`);
    for (const evidenceRef of item.evidenceRefs)
      assertEvidenceRef(evidenceRef, `onboarding ${item.id} evidence`);
  }

  let staffedBackupCount = 0;
  for (const role of fixture.roles) {
    if (role.primaryOwner.id !== "@AlisinaDevelo")
      fail(`role ${role.id} must identify the current maintainer`);
    if (role.primaryOwner.staffing !== "current")
      fail(`role ${role.id} primary staffing must be current`);
    if (role.backup.status === "staffed") staffedBackupCount += 1;
    assertPublicText(role.primaryOwner.id, `role ${role.id} primary`);
    assertPublicText(role.backup.id, `role ${role.id} backup`);
    assertEvidenceRef(role.backup.route, `role ${role.id} backup route`);
    for (const authorityRef of role.authorityRefs)
      assertEvidenceRef(authorityRef, `role ${role.id} authority`);
    const items = onboardingByRole.get(role.id) ?? [];
    if (items.length === 0) fail(`role ${role.id} has no onboarding steps`);
    const itemIds = items.map((item) => item.id);
    if (stableStringify(itemIds) !== stableStringify(role.onboardingRefs))
      fail(`role ${role.id} onboarding references drifted`);
  }

  const riskIds = new Set();
  const risksById = new Map();
  for (const risk of fixture.risks) {
    if (riskIds.has(risk.id)) fail(`duplicate risk ID ${risk.id}`);
    riskIds.add(risk.id);
    risksById.set(risk.id, risk);
    if (!rolesById.has(risk.roleId))
      fail(`risk ${risk.id} uses an unknown role`);
    assertPublicText(risk.finding, `risk ${risk.id}`);
    assertPublicText(risk.mitigation, `risk ${risk.id}`);
    for (const evidenceRef of risk.evidenceRefs)
      assertEvidenceRef(evidenceRef, `risk ${risk.id} evidence`);
  }
  for (const role of fixture.roles) {
    if (![...risksById.values()].some((risk) => risk.roleId === role.id))
      fail(`role ${role.id} has no published unresolved risk`);
  }

  const dryRunIds = new Set();
  const taskKinds = new Set();
  let passedDryRunCount = 0;
  for (const dryRun of fixture.dryRuns) {
    if (dryRunIds.has(dryRun.id)) fail(`duplicate dry-run ID ${dryRun.id}`);
    dryRunIds.add(dryRun.id);
    taskKinds.add(dryRun.taskKind);
    if (dryRun.outcome === "passed") passedDryRunCount += 1;
    if (dryRun.actorIsRepositoryAuthor)
      fail(
        `dry run ${dryRun.id} is incorrectly attributed to the repository author`,
      );
    assertPublicText(dryRun.actor, `dry run ${dryRun.id} actor`);
    assertPublicText(dryRun.scenario, `dry run ${dryRun.id} scenario`);
    for (const command of dryRun.commands) {
      assertPublicText(command, `dry run ${dryRun.id} command`);
      if (
        /(?:curl|wget|npm\s+publish|git\s+push|gh\s+(?:issue|pr|release)\s+(?:edit|create|merge|close)|https?:\/\/)/iu.test(
          command,
        )
      )
        fail(`dry run ${dryRun.id} contains a mutative or network command`);
    }
    for (const evidenceRef of dryRun.evidenceRefs)
      assertEvidenceRef(evidenceRef, `dry run ${dryRun.id} evidence`);
    for (const riskId of dryRun.unresolvedRiskIds) {
      if (!risksById.has(riskId))
        fail(`dry run ${dryRun.id} references an unknown risk ${riskId}`);
    }
    for (const friction of dryRun.friction)
      assertPublicText(friction, `dry run ${dryRun.id} friction`);
  }
  if (!taskKinds.has("contribution") || !taskKinds.has("release-or-triage"))
    fail(
      "the record must include contribution and release-or-triage rehearsals",
    );
  if (passedDryRunCount < 2)
    fail("both required non-author rehearsals must pass");

  const summary = fixture.summary;
  const onboardingStepCount = fixture.onboarding.length;
  const rolesWithBackupPath = fixture.roles.filter(
    (role) => role.backup.route.length > 0,
  ).length;
  if (
    summary.roleCount !== fixture.roles.length ||
    summary.rolesWithBackupPath !== rolesWithBackupPath ||
    summary.staffedBackupCount !== staffedBackupCount ||
    summary.onboardingStepCount !== onboardingStepCount ||
    summary.dryRunCount !== fixture.dryRuns.length ||
    summary.passedDryRunCount !== passedDryRunCount ||
    summary.unresolvedRiskCount !== fixture.risks.length
  )
    fail("summary counts drifted");
  if (
    !summary.publicOnly ||
    summary.network ||
    summary.sourcePayloads ||
    summary.claimsOfExternalParticipation
  )
    fail("summary violates the public-only rehearsal boundary");

  for (const value of [
    fixture.reportId,
    fixture.provenance.source,
    fixture.provenance.reference,
    fixture.provenance.transformation,
  ])
    assertPublicText(value, "fixture metadata");
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
  return {
    ok: true,
    contract: CONTRACT,
    schemaVersion: SCHEMA_VERSION,
    reportId: fixture.reportId,
    asOf: fixture.asOf,
    roles: fixture.roles.length,
    onboardingSteps: fixture.onboarding.length,
    dryRuns: fixture.dryRuns.length,
    passedDryRuns: fixture.summary.passedDryRunCount,
    unresolvedRisks: fixture.risks.length,
    staffedBackups: fixture.summary.staffedBackupCount,
    network: false,
    sourcePayloads: false,
    digest: digest(stableStringify(fixture)),
  };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node scripts/maintainer-resilience.mjs validate [--fixture path]",
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
