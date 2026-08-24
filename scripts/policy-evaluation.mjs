#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  evaluatePolicyOnSnapshot,
  POLICY_EVALUATION_SCHEMA_VERSION,
  PolicyEvaluationSchema,
  serializePolicyEvaluation,
} from "../src/core/policy-evaluation.ts";
import { parsePolicyConfig } from "../src/core/policy.ts";

const repositoryRoot = resolve(process.cwd());
const readJson = (relativePath) =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));

const fixtureSnapshot = {
  schemaVersion: 1,
  revision: { commitSha: "policy-evaluation-fixture" },
  nodes: [{ id: "module:a", kind: "module", name: "a" }],
  edges: [
    {
      from: "module:a",
      to: "module:a",
      kind: "unknown",
      confidence: "inferred",
      evidence: [],
      unresolvedReason: "fixture edge",
    },
  ],
  diagnostics: [],
};

const validate = () => {
  const schema = readJson("schema/policy-evaluation.v0.1.schema.json");
  const sample = readJson("schema/policy-evaluation.v0.1.json");
  const policy = readJson("schema/policy.v0.1.json");
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(sample)) {
    throw new Error(
      `policy evaluation JSON Schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }
  const parsedSample = PolicyEvaluationSchema.parse(sample);
  const report = evaluatePolicyOnSnapshot(policy, fixtureSnapshot);
  if (report.status !== "violations" || report.unsupportedRules !== 1) {
    throw new Error(
      `policy evaluation fixture produced an unexpected result: ${JSON.stringify(report)}`,
    );
  }
  if (
    serializePolicyEvaluation(report) !==
    serializePolicyEvaluation(JSON.parse(serializePolicyEvaluation(report)))
  ) {
    throw new Error("policy evaluation canonical serialization drifted");
  }
  return {
    ok: true,
    schemaVersion: POLICY_EVALUATION_SCHEMA_VERSION,
    policyId: parsePolicyConfig(policy).policyId,
    sampleStatus: parsedSample.status,
    evaluatedRules: report.evaluatedRules,
    violations: report.violations.length,
    unsupported: report.unsupported.length,
    remoteFetching: false,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/policy-evaluation.mjs validate",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`policy evaluation validation failed: ${error.message}`);
  process.exit(1);
}
