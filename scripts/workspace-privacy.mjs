#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  assessWorkspacePrivacy,
  parseWorkspacePrivacyAssessment,
  parseWorkspacePrivacyRequest,
  serializeWorkspacePrivacyAssessment,
} from "../src/core/index.ts";

const repositoryRoot = resolve(process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/workspace-privacy/request.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/workspace-privacy.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const fail = (message) => {
  throw new Error(`workspace privacy validation failed: ${message}`);
};

const validate = () => {
  const request = parseWorkspacePrivacyRequest(readJson(fixturePath));
  const schemaValidator = new Ajv({ allErrors: true }).compile(
    readJson(schemaPath),
  );
  if (!schemaValidator(request)) {
    fail(
      `published schema rejected request: ${JSON.stringify(schemaValidator.errors)}`,
    );
  }

  const assessment = assessWorkspacePrivacy(request);
  if (!schemaValidator(assessment)) {
    fail(
      `published schema rejected assessment: ${JSON.stringify(schemaValidator.errors)}`,
    );
  }
  const roundTrip = parseWorkspacePrivacyAssessment(
    JSON.parse(serializeWorkspacePrivacyAssessment(assessment)),
  );
  if (
    serializeWorkspacePrivacyAssessment(roundTrip) !==
    serializeWorkspacePrivacyAssessment(assessment)
  ) {
    fail("assessment serialization is not deterministic");
  }

  return {
    ok: true,
    repositories: assessment.totals.repositories,
    trustMode: assessment.trustMode,
    status: assessment.status,
    nodes: assessment.totals.nodes,
    edges: assessment.totals.edges,
    bytes: assessment.totals.bytes,
    runtimeMetadataRecords: assessment.runtimeMetadata.records,
    pathExposure: assessment.pathExposure.mode,
    temporaryEntries: assessment.totals.temporaryEntries,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/workspace-privacy.mjs validate",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
