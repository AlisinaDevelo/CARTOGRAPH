#!/usr/bin/env node
/* global console, process */

import {
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import Ajv from "ajv";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  argumentValue("--fixture") ??
    "test/fixtures/policy-composition/scenarios.v0.1.json",
);

const readJson = (filePath) =>
  JSON.parse(readFileSync(resolve(filePath), "utf8"));

const fail = (message) => {
  throw new Error(message);
};

const writeScenario = (files) => {
  const root = mkdtempSync(`${tmpdir()}/cartograph-policy-composition-`);
  for (const [filePath, content] of Object.entries(files)) {
    const target = resolve(root, filePath);
    const relativeTarget = relative(root, target);
    if (
      relativeTarget === ".." ||
      relativeTarget.startsWith(`..${sep}`) ||
      relativeTarget.startsWith(sep)
    ) {
      rmSync(root, { recursive: true, force: true });
      fail(`fixture file escapes temporary policy root: ${filePath}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(content), "utf8");
  }
  return root;
};

const validate = async () => {
  const fixture = readJson(fixturePath);
  const fixtureSchema = readJson(
    resolve(
      repositoryRoot,
      "schema/policy-composition-fixtures.v0.1.schema.json",
    ),
  );
  const compositionSchema = readJson(
    resolve(repositoryRoot, "schema/policy-composition.v0.1.schema.json"),
  );
  const policySchema = readJson(
    resolve(repositoryRoot, "schema/policy.v0.1.schema.json"),
  );
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validateFixture = ajv.compile(fixtureSchema);
  if (!validateFixture(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validateFixture.errors)}`,
    );
  ajv.addSchema(policySchema);
  const validateComposition = ajv.compile(compositionSchema);

  const {
    PolicyCompositionError,
    PolicyCompositionSchema,
    POLICY_COMPOSITION_CONTRACT,
    POLICY_COMPOSITION_SCHEMA_VERSION,
    composePolicyConfig,
    serializePolicyComposition,
  } = await import("../src/core/index.ts");

  const results = [];
  for (const fixtureCase of fixture.cases) {
    const root = writeScenario(fixtureCase.files);
    try {
      let composition;
      try {
        composition = composePolicyConfig(root, fixtureCase.root);
      } catch (error) {
        if (fixtureCase.expectation === "positive") throw error;
        if (!(error instanceof PolicyCompositionError))
          fail(
            `negative fixture ${fixtureCase.id} produced an untyped error: ${error.message}`,
          );
        if (error.code !== fixtureCase.errorCode)
          fail(
            `negative fixture ${fixtureCase.id} expected ${fixtureCase.errorCode}, found ${error.code}`,
          );
        for (const evidence of fixtureCase.evidenceIncludes ?? []) {
          if (!error.evidenceRefs.includes(evidence))
            fail(
              `negative fixture ${fixtureCase.id} is missing evidence ${evidence}`,
            );
        }
        if (error.evidenceRefs.length === 0)
          fail(`negative fixture ${fixtureCase.id} produced no evidence refs`);
        results.push({
          id: fixtureCase.id,
          expectation: fixtureCase.expectation,
          status: "rejected",
          code: error.code,
          evidenceRefs: error.evidenceRefs,
        });
        continue;
      }
      if (fixtureCase.expectation !== "positive")
        fail(`negative fixture ${fixtureCase.id} unexpectedly composed`);
      const parsed = PolicyCompositionSchema.parse(composition);
      if (!validateComposition(parsed))
        fail(
          `composition schema validation failed for ${fixtureCase.id}: ${JSON.stringify(validateComposition.errors)}`,
        );
      const ruleIds = parsed.policy.rules.map((rule) => rule.id);
      if (
        serializePolicyComposition(parsed) !==
        serializePolicyComposition(composition)
      )
        fail(`composition serialization drifted for ${fixtureCase.id}`);
      const repeated = composePolicyConfig(root, fixtureCase.root);
      if (
        serializePolicyComposition(parsed) !==
        serializePolicyComposition(repeated)
      )
        fail(`composition order is not deterministic for ${fixtureCase.id}`);
      if (
        JSON.stringify(ruleIds) !==
        JSON.stringify(fixtureCase.expectedRules ?? [])
      )
        fail(
          `fixture ${fixtureCase.id} expected rules ${JSON.stringify(fixtureCase.expectedRules)}, found ${JSON.stringify(ruleIds)}`,
        );
      if (parsed.overrides.length !== (fixtureCase.expectedOverrides ?? 0))
        fail(
          `fixture ${fixtureCase.id} expected ${fixtureCase.expectedOverrides ?? 0} overrides, found ${parsed.overrides.length}`,
        );
      results.push({
        id: fixtureCase.id,
        expectation: fixtureCase.expectation,
        status: "composed",
        sources: parsed.sources.length,
        rules: ruleIds,
        overrides: parsed.overrides.length,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      schemaVersion: POLICY_COMPOSITION_SCHEMA_VERSION,
      contract: POLICY_COMPOSITION_CONTRACT,
      cases: results,
      positiveCases: results.filter(
        (result) => result.expectation === "positive",
      ).length,
      negativeCases: results.filter(
        (result) => result.expectation === "negative",
      ).length,
    }),
  );
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/policy-composition.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  await validate();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`policy composition validation failed: ${message}`);
  process.exit(1);
}
