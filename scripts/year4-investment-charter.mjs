#!/usr/bin/env node
/* global URL, console, process */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const CONTRACT = "cartograph.year4-investment-charter";
const SCHEMA_VERSION = 1;
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/year4-charter/charter.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/year4-investment-charter.v0.1.schema.json",
);

const REQUIRED_GATE_IDS = [
  "strategy-security-review",
  "local-first-investment-adr",
  "sustainability-cost-model",
  "claims-audit",
  "adoption-evaluation",
  "maintainer-resilience",
];
const REQUIRED_OUTCOME_IDS = [
  "local-core-continuity",
  "security-and-dependency-maintenance",
  "evidence-and-documentation-replay",
  "maintainer-route-rehearsal",
];
const REQUIRED_QUARTER_IDS = ["year4-q1", "year4-q2", "year4-q3", "year4-q4"];
const REQUIRED_RISK_IDS = [
  "single-maintainer-capacity",
  "hosted-check-ceilings",
  "unverified-adoption-and-traction",
  "unsupported-claim-drift",
  "scope-and-release-creep",
];
const EXPECTED_GATE_DIGESTS = {
  "strategy-security-review":
    "sha256:6d64721736a7fad5eea4f940e366ec7723dd66522b23800ed514366ecec5fb1e",
  "local-first-investment-adr": null,
  "sustainability-cost-model":
    "sha256:c97f9910a50ba5b6d905183d85ebc745316c759acc10703628655a379cad8828",
  "claims-audit":
    "sha256:9816d6bdc618f4c34113f44f02e080ca3e764bdf27df24f5cfa206406560e71f",
  "adoption-evaluation":
    "sha256:f0fa50be0315043d26af5b2355ee34f7b439a119a6cf9af227c763bb92de82f1",
  "maintainer-resilience": null,
};

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

const assertEvidenceRef = (value, label) => {
  assertPublicText(value, label);
  if (/^[A-Z]+-[0-9]+$/u.test(value)) return;
  if (/^https?:\/\//u.test(value))
    fail(`${label} must use a checked-in path, not a remote URL`);
  const relativePath = value.split("#", 1)[0];
  if (!existsSync(resolve(repositoryRoot, relativePath)))
    fail(`${label} does not resolve to a checked-in path: ${value}`);
};

const assertPublicTree = (value, label) => {
  if (typeof value === "string") {
    assertPublicText(value, label);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertPublicTree(entry, `${label}[${index}]`),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    Object.entries(value).forEach(([key, entry]) =>
      assertPublicTree(entry, `${label}.${key}`),
    );
  }
};

const requireExactIds = (entries, expected, label) => {
  const actual = entries.map((entry) => entry.id);
  if (new Set(actual).size !== actual.length) fail(`duplicate ${label} ID`);
  if (
    stableStringify([...actual].sort()) !==
    stableStringify([...expected].sort())
  )
    fail(`${label} inventory drifted`);
};

const validateSemantics = (fixture) => {
  if (fixture.contract !== CONTRACT || fixture.schemaVersion !== SCHEMA_VERSION)
    fail("contract or schema version drifted");

  if (
    !fixture.scope.publicOnly ||
    fixture.scope.network ||
    fixture.scope.sourceBodiesIncluded ||
    fixture.scope.privateDataIncluded ||
    fixture.scope.hiddenTelemetry ||
    fixture.scope.sourceUpload ||
    fixture.scope.accountRequired ||
    fixture.scope.hostedExpansion !== "deferred"
  )
    fail("charter must remain public-only, offline, source-free, and deferred");

  if (
    fixture.selectedTrack.id !== "conditional-maintenance-first" ||
    fixture.selectedTrack.category !== "maintenance-track" ||
    fixture.selectedTrack.status !== "accepted" ||
    fixture.selectedTrack.fundingMode !== "unfunded-capacity-gated" ||
    fixture.selectedTrack.expansion !== "deferred"
  )
    fail(
      "selected track must remain the unfunded, capacity-gated maintenance track",
    );

  requireExactIds(fixture.owners, ["primary-maintainer"], "owner");
  const owner = fixture.owners[0];
  if (
    owner.handle !== "@AlisinaDevelo" ||
    owner.status !== "named" ||
    owner.backupStatus !== "documented-unverified"
  )
    fail("owner boundary drifted");

  const capacity = fixture.capacity;
  if (
    capacity.status !== "unmeasured" ||
    capacity.namedMaintainers !== 1 ||
    capacity.verifiedBackups !== 0 ||
    capacity.numericQuarterCommitment !== null ||
    capacity.fundingStatus !== "not-approved" ||
    capacity.commitment !== "none"
  )
    fail("capacity must remain unmeasured, single-maintainer, and unfunded");

  requireExactIds(fixture.gates, REQUIRED_GATE_IDS, "gate");
  for (const gate of fixture.gates) {
    if (!EXPECTED_GATE_DIGESTS[gate.id] && gate.digest !== null)
      fail(`gate ${gate.id} must not invent a digest`);
    if (
      EXPECTED_GATE_DIGESTS[gate.id] &&
      gate.digest !== EXPECTED_GATE_DIGESTS[gate.id]
    )
      fail(`gate ${gate.id} digest drifted`);
    if (
      gate.status !== "accepted" &&
      gate.status !== "accepted-with-limitations"
    )
      fail(`gate ${gate.id} is not accepted`);
    if (gate.limitations.length === 0) fail(`gate ${gate.id} lost its limits`);
  }
  const strategyGate = fixture.gates.find(
    (gate) => gate.id === "strategy-security-review",
  );
  if (strategyGate?.decision !== "oss-only-no-new-boundary")
    fail("strategy gate must keep the OSS-only no-new-boundary decision");
  const sustainabilityGate = fixture.gates.find(
    (gate) => gate.id === "sustainability-cost-model",
  );
  if (sustainabilityGate?.decision !== "local-first-capacity-gated")
    fail("sustainability gate must remain capacity-gated");
  const claimsGate = fixture.gates.find((gate) => gate.id === "claims-audit");
  if (claimsGate?.decision !== "defer-expansion")
    fail("claims audit must defer expansion on incomplete evidence");
  const adoptionGate = fixture.gates.find(
    (gate) => gate.id === "adoption-evaluation",
  );
  if (adoptionGate?.decision !== "technical-sample-not-adoption")
    fail("adoption evaluation must not become an adoption claim");

  requireExactIds(fixture.outcomes, REQUIRED_OUTCOME_IDS, "outcome");
  for (const outcome of fixture.outcomes) {
    if (
      outcome.status !== "maintenance-only" ||
      outcome.ownerId !== "primary-maintainer" ||
      outcome.capacityGate !== "explicit-capacity-required" ||
      outcome.stopConditions.length < 2
    )
      fail(
        `outcome ${outcome.id} widened the charter or lost a stop condition`,
      );
  }

  requireExactIds(fixture.quarters, REQUIRED_QUARTER_IDS, "quarter");
  const outcomeIds = new Set(REQUIRED_OUTCOME_IDS);
  for (const quarter of fixture.quarters) {
    if (
      quarter.status !== "maintenance-only" ||
      quarter.ownerId !== "primary-maintainer" ||
      quarter.stopConditions.length < 3 ||
      quarter.plannedOutcomeIds.some((id) => !outcomeIds.has(id))
    )
      fail(`quarter ${quarter.id} lost maintenance-only stop conditions`);
  }

  requireExactIds(fixture.risks, REQUIRED_RISK_IDS, "risk");
  const singleMaintainerRisk = fixture.risks.find(
    (risk) => risk.id === "single-maintainer-capacity",
  );
  if (singleMaintainerRisk?.status !== "open")
    fail("single-maintainer capacity risk must remain open");

  const summary = fixture.summary;
  if (
    summary.selectedTrack !== fixture.selectedTrack.id ||
    summary.gateCount !== fixture.gates.length ||
    summary.outcomeCount !== fixture.outcomes.length ||
    summary.quarterCount !== fixture.quarters.length ||
    summary.riskCount !== fixture.risks.length ||
    summary.nonGoalCount !== fixture.nonGoals.length ||
    summary.hostedExpansion !== "deferred" ||
    summary.fundedTeamScale ||
    summary.ossHardeningBeyondMaintenance ||
    summary.capacityStatus !== capacity.status ||
    summary.network ||
    summary.sourceBodiesIncluded ||
    summary.privateDataIncluded ||
    summary.hiddenTelemetry
  )
    fail("summary counts or boundaries drifted");

  assertPublicTree(fixture, "fixture");
  for (const [group, entries] of [
    ["owner", fixture.owners],
    ["gate", fixture.gates],
    ["outcome", fixture.outcomes],
    ["quarter", fixture.quarters],
    ["risk", fixture.risks],
  ]) {
    for (const entry of entries) {
      for (const evidenceRef of entry.evidenceRefs)
        assertEvidenceRef(evidenceRef, `${group} ${entry.id} evidence`);
    }
  }
  for (const evidenceRef of fixture.selectedTrack.evidenceRefs)
    assertEvidenceRef(evidenceRef, "selected track evidence");
  for (const evidenceRef of fixture.capacity.evidenceRefs)
    assertEvidenceRef(evidenceRef, "capacity evidence");
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
    charterId: fixture.charterId,
    selectedTrack: fixture.selectedTrack.id,
    gates: fixture.gates.length,
    outcomes: fixture.outcomes.length,
    quarters: fixture.quarters.length,
    risks: fixture.risks.length,
    nonGoals: fixture.nonGoals.length,
    capacityStatus: fixture.capacity.status,
    hostedExpansion: "deferred",
    network: false,
    sourceBodiesIncluded: false,
    privateDataIncluded: false,
    hiddenTelemetry: false,
    digest: digest(stableStringify(fixture)),
  };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node scripts/year4-investment-charter.mjs validate [--fixture path]",
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
