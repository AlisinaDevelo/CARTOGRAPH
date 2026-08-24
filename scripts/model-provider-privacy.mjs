#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  argumentValue("--fixture") ??
    "test/fixtures/model-provider-privacy/scenarios.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/model-provider-privacy-fixtures.v0.1.schema.json",
);

const expectedIds = new Set([
  "no-provider-default",
  "source-prompt-injection",
  "issue-prompt-injection",
  "secret-exfiltration",
  "untrusted-report",
  "malicious-suggestion",
  "provider-failure",
  "nondeterminism",
  "misleading-confidence",
  "consented-redacted-summary",
  "training-policy-unknown",
  "budget-exceeded",
]);
const mustDefer = new Set([
  "source-prompt-injection",
  "issue-prompt-injection",
  "secret-exfiltration",
  "untrusted-report",
  "malicious-suggestion",
  "provider-failure",
  "nondeterminism",
  "misleading-confidence",
  "training-policy-unknown",
  "budget-exceeded",
]);
const forbiddenMarker =
  /(BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:authorization|cookie|password|secret|token)\s*[:=]|https?:\/\/[^\s]*[?#]|\b(?:sk|pk|ghp|xox[baprs])-[-_A-Za-z0-9]+)/iu;

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));
const fail = (message) => {
  throw new Error(message);
};

const validate = () => {
  const fixture = readJson(fixturePath);
  const schema = readJson(schemaPath);
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );

  const ids = new Set();
  for (const scenario of fixture.cases) {
    if (ids.has(scenario.id)) fail(`duplicate scenario ID: ${scenario.id}`);
    ids.add(scenario.id);
    if (forbiddenMarker.test(scenario.syntheticMarker))
      fail(
        `fixture marker looks like live secret or remote content: ${scenario.id}`,
      );
    if (!scenario.noRawLeak)
      fail(`scenario does not prove noRawLeak: ${scenario.id}`);
    if (
      mustDefer.has(scenario.id) &&
      scenario.expectedDisposition !== "deferred"
    )
      fail(`adversarial scenario must defer: ${scenario.id}`);
    if (mustDefer.has(scenario.id) && scenario.networkAllowed)
      fail(`adversarial scenario cannot permit network: ${scenario.id}`);
    if (
      scenario.id === "no-provider-default" &&
      (scenario.expectedDisposition !== "local-only" || scenario.networkAllowed)
    )
      fail("no-provider-default must remain local-only");
    if (
      scenario.id === "consented-redacted-summary" &&
      (scenario.expectedDisposition !== "redact-and-send" ||
        scenario.redaction !== "applied" ||
        !scenario.networkAllowed)
    )
      fail(
        "consented-redacted-summary must be explicitly redacted and consented",
      );
  }
  const missing = [...expectedIds].filter((id) => !ids.has(id));
  const unexpected = [...ids].filter((id) => !expectedIds.has(id));
  if (missing.length > 0 || unexpected.length > 0)
    fail(
      `scenario set mismatch: missing=${missing.join(",")}; unexpected=${unexpected.join(",")}`,
    );

  const deferrals = fixture.cases.filter(
    (scenario) => scenario.expectedDisposition === "deferred",
  ).length;
  const redacted = fixture.cases.filter(
    (scenario) => scenario.expectedDisposition === "redact-and-send",
  ).length;
  const networkCases = fixture.cases.filter(
    (scenario) => scenario.networkAllowed,
  ).length;
  console.log(
    JSON.stringify({
      ok: true,
      schemaVersion: fixture.schemaVersion,
      contract: fixture.contract,
      cases: fixture.cases.length,
      deferrals,
      redacted,
      networkCases,
    }),
  );
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node scripts/model-provider-privacy.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  validate();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`model-provider privacy validation failed: ${message}`);
  process.exit(1);
}
