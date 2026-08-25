#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const CONTRACT = "cartograph.community-feedback";
const SCHEMA_VERSION = 1;
const repositoryRoot = resolve(process.cwd());
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/community-feedback/summary.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/community-feedback.v0.1.schema.json",
);

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

const requireValues = (values, required, label) => {
  for (const value of required) {
    if (!values.includes(value)) fail(`${label} is missing ${value}`);
  }
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

  const rfc = fixture.rfcProcess;
  const expectedStages = [
    "proposed",
    "evidence-requested",
    "reviewed",
    "decided",
  ];
  if (stableStringify(rfc.stages) !== stableStringify(expectedStages))
    fail("RFC stages must remain ordered and public");
  requireValues(
    rfc.requiredFields,
    [
      "problem",
      "affected-users",
      "alternatives",
      "evidence-plan",
      "compatibility-impact",
      "privacy-impact",
      "decision",
    ],
    "RFC required fields",
  );
  requireValues(
    rfc.decisionStates,
    ["accept", "defer", "reject", "investigate"],
    "RFC decision states",
  );
  if (!rfc.publicIssueRequired) fail("RFCs must begin as public issues");

  const triageIds = new Set();
  for (const triage of fixture.triageTaxonomy) {
    if (triageIds.has(triage.id)) fail(`duplicate triage ID ${triage.id}`);
    triageIds.add(triage.id);
  }
  requireValues(
    [...triageIds],
    [
      "bug",
      "feature",
      "docs",
      "question",
      "performance",
      "compatibility",
      "security",
      "adopter-feedback",
      "contributor",
      "roadmap",
      "governance",
    ],
    "triage taxonomy",
  );
  requireValues(
    fixture.adopterTemplate.requiredFields,
    [
      "workflow",
      "authorized-input",
      "expected-result",
      "observed-result",
      "reproduction",
      "privacy-review",
      "consent",
      "backlog-impact",
    ],
    "adopter template fields",
  );
  if (!fixture.adopterTemplate.consentRequired)
    fail("adopter feedback must require consent");

  const decisionIds = new Set();
  const decisionsById = new Map();
  for (const decision of fixture.decisions) {
    if (decisionIds.has(decision.id))
      fail(`duplicate decision ID ${decision.id}`);
    decisionIds.add(decision.id);
    decisionsById.set(decision.id, decision);
    if (decision.state !== "investigate" && decision.backlogRef === "none")
      fail(`decision ${decision.id} must name a backlog reference`);
    assertPublicText(decision.rationale, `decision ${decision.id}`);
    for (const evidenceRef of decision.evidenceRefs)
      assertPublicText(evidenceRef, `decision ${decision.id} evidence`);
  }

  const recordIds = new Set();
  for (const record of fixture.records) {
    if (recordIds.has(record.id))
      fail(`duplicate feedback record ${record.id}`);
    recordIds.add(record.id);
    if (record.external && record.synthetic)
      fail(`feedback record ${record.id} cannot be external and synthetic`);
    if (record.external && record.consent !== "explicit")
      fail(`external feedback record ${record.id} needs explicit consent`);
    if (!record.triageIds.every((id) => triageIds.has(id)))
      fail(`feedback record ${record.id} uses an unknown triage ID`);
    if (!decisionsById.has(record.decisionId))
      fail(`feedback record ${record.id} has no explicit backlog decision`);
    if (
      record.privateData ||
      record.sourcePayloadRetained ||
      !record.anonymized
    )
      fail(`feedback record ${record.id} violates the privacy boundary`);
    assertPublicText(record.signal, `feedback record ${record.id}`);
    for (const evidenceRef of record.evidenceRefs)
      assertPublicText(evidenceRef, `feedback record ${record.id} evidence`);
  }

  const summary = fixture.summary;
  const externalCount = fixture.records.filter(
    (record) => record.external,
  ).length;
  const syntheticCount = fixture.records.filter(
    (record) => record.synthetic,
  ).length;
  const backlogDecisionCount = fixture.decisions.filter(
    (decision) => decision.backlogRef !== "none",
  ).length;
  if (
    summary.recordCount !== fixture.records.length ||
    summary.externalRecordCount !== externalCount ||
    summary.syntheticRecordCount !== syntheticCount ||
    summary.decisionCount !== fixture.decisions.length ||
    summary.backlogDecisionCount !== backlogDecisionCount
  )
    fail("feedback summary counts drifted");
  if (
    !summary.allRecordsAnonymized ||
    summary.privateTelemetry ||
    summary.sourcePayloads ||
    summary.personalData
  )
    fail("feedback summary violates the public-only privacy boundary");
  if (fixture.scope.privateTelemetry || fixture.scope.sourcePayloads)
    fail("feedback scope permits private telemetry or source payloads");
  if (
    fixture.records.length > 0 &&
    fixture.records.some((record) => !record.decisionId)
  )
    fail("every retained feedback record must produce a decision");
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
    asOf: fixture.asOf,
    triageCategories: fixture.triageTaxonomy.length,
    records: fixture.records.length,
    externalRecords: fixture.summary.externalRecordCount,
    decisions: fixture.decisions.length,
    backlogDecisions: fixture.summary.backlogDecisionCount,
    privateTelemetry: false,
    sourcePayloads: false,
    digest: digest(stableStringify(fixture)),
  };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node scripts/community-feedback.mjs validate [--fixture path]",
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
