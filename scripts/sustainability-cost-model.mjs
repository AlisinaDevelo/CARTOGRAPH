#!/usr/bin/env node
/* global URL, console, process */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const CONTRACT = "cartograph.sustainability-cost-model";
const SCHEMA_VERSION = 1;
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/sustainability-cost/report.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/sustainability-cost-model.v0.1.schema.json",
);

const expectedScenarioIds = [
  "oss-local-first",
  "funded-oss-stewardship",
  "hosted-team-expansion",
];
const expectedCategories = [
  "core-contracts",
  "roadmap-governance",
  "release-distribution",
  "dependency-upkeep",
  "support-burden",
  "security-response",
  "adapter-ownership",
  "ci-artifact",
  "approved-service-operations",
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

const assertEvidenceRef = (value, label) => {
  assertPublicText(value, label);
  if (/^[A-Z]+-[0-9]+$/u.test(value)) return;
  const relativePath = value.split("#", 1)[0];
  if (!existsSync(resolve(repositoryRoot, relativePath)))
    fail(
      `${label} does not resolve to a checked-in path or roadmap issue: ${value}`,
    );
};

const assertRange = (value, label) => {
  if (value.kind !== "estimated") return;
  if (value.min > value.max) fail(`${label} minimum exceeds maximum`);
};

const sumRange = (components, field) =>
  components.reduce(
    (result, component) => ({
      min: result.min + component[field].min,
      max: result.max + component[field].max,
    }),
    { min: 0, max: 0 },
  );

const equalRange = (left, right) =>
  left.kind === right.kind &&
  (left.kind === "deferred" ||
    (left.min === right.min && left.max === right.max));

const validateSemantics = (fixture) => {
  if (fixture.contract !== CONTRACT || fixture.schemaVersion !== SCHEMA_VERSION)
    fail("contract or schema version drifted");
  const scope = fixture.scope;
  if (
    !scope.publicOnly ||
    scope.network ||
    scope.sourceBodiesIncluded ||
    scope.privateDataIncluded ||
    scope.hiddenTelemetry ||
    scope.hostedExpansion !== "deferred"
  )
    fail(
      "scope must remain public-only, local, source-free, and deferred for hosted expansion",
    );

  const inputIds = new Set();
  for (const input of fixture.inputs) {
    if (inputIds.has(input.id)) fail(`duplicate input ID ${input.id}`);
    inputIds.add(input.id);
    assertPublicText(input.label, `input ${input.id}`);
    assertPublicText(input.limitation, `input ${input.id}`);
    for (const evidenceRef of input.evidenceRefs)
      assertEvidenceRef(evidenceRef, `input ${input.id} evidence`);
  }

  const scenarioIds = fixture.scenarios.map((scenario) => scenario.id);
  if (
    new Set(scenarioIds).size !== scenarioIds.length ||
    stableStringify(scenarioIds) !== stableStringify(expectedScenarioIds)
  )
    fail("scenario inventory drifted");

  const categorySet = new Set();
  for (const scenario of fixture.scenarios) {
    assertPublicText(scenario.label, `scenario ${scenario.id}`);
    for (const assumption of scenario.assumptions)
      assertPublicText(assumption, `scenario ${scenario.id} assumption`);
    for (const stopCondition of scenario.stopConditions)
      assertPublicText(stopCondition, `scenario ${scenario.id} stop condition`);
    for (const nonGoal of scenario.nonGoals)
      assertPublicText(nonGoal, `scenario ${scenario.id} non-goal`);
    for (const evidenceRef of scenario.evidenceRefs)
      assertEvidenceRef(evidenceRef, `scenario ${scenario.id} evidence`);

    const componentIds = new Set();
    for (const component of scenario.components) {
      if (componentIds.has(component.id))
        fail(`scenario ${scenario.id} has duplicate component ${component.id}`);
      componentIds.add(component.id);
      categorySet.add(component.category);
      assertPublicText(component.label, `component ${component.id}`);
      assertPublicText(component.assumption, `component ${component.id}`);
      for (const evidenceRef of component.evidenceRefs)
        assertEvidenceRef(evidenceRef, `component ${component.id} evidence`);
      if (scenario.estimateStatus === "estimated") {
        if (component.hours.kind !== "estimated")
          fail(`estimated scenario ${scenario.id} has deferred hours`);
        if (component.directCostUsd.kind !== "estimated")
          fail(`estimated scenario ${scenario.id} has deferred direct cost`);
        assertRange(component.hours, `component ${component.id} hours`);
        assertRange(
          component.directCostUsd,
          `component ${component.id} direct cost`,
        );
      } else if (
        component.hours.kind !== "deferred" ||
        component.directCostUsd.kind !== "deferred"
      ) {
        fail(
          `deferred scenario ${scenario.id} must defer every component range`,
        );
      }
    }
    if (
      stableStringify(
        [...categorySet].filter((category) =>
          scenario.components.some(
            (component) => component.category === category,
          ),
        ),
      ) === "[]"
    )
      fail(`scenario ${scenario.id} has no components`);
    if (categorySet.size !== expectedCategories.length)
      fail(`scenario ${scenario.id} component category count drifted`);
    for (const category of expectedCategories) {
      if (
        !scenario.components.some(
          (component) => component.category === category,
        )
      )
        fail(`scenario ${scenario.id} is missing ${category}`);
    }

    const expectedKind = scenario.estimateStatus;
    if (
      scenario.hours.kind !== expectedKind ||
      scenario.directCostUsd.kind !== expectedKind ||
      scenario.totalCostUsd.kind !== expectedKind
    )
      fail(`scenario ${scenario.id} range status drifted`);
    if (scenario.estimateStatus === "estimated") {
      assertRange(scenario.hours, `scenario ${scenario.id} hours`);
      assertRange(
        scenario.directCostUsd,
        `scenario ${scenario.id} direct cost`,
      );
      assertRange(scenario.totalCostUsd, `scenario ${scenario.id} total cost`);
      const hours = sumRange(scenario.components, "hours");
      const directCost = sumRange(scenario.components, "directCostUsd");
      if (!equalRange(scenario.hours, { kind: "estimated", ...hours }))
        fail(`scenario ${scenario.id} hours do not sum component ranges`);
      if (
        !equalRange(scenario.directCostUsd, {
          kind: "estimated",
          ...directCost,
        })
      )
        fail(
          `scenario ${scenario.id} direct cost does not sum component ranges`,
        );
      const total = {
        kind: "estimated",
        min:
          scenario.hours.min * scenario.laborRateUsdPerHour.min +
          scenario.directCostUsd.min,
        max:
          scenario.hours.max * scenario.laborRateUsdPerHour.max +
          scenario.directCostUsd.max,
      };
      if (!equalRange(scenario.totalCostUsd, total))
        fail(
          `scenario ${scenario.id} total cost does not include priced labor`,
        );
      if (
        scenario.laborRateUsdPerHour.min <= 0 ||
        scenario.laborRateUsdPerHour.min > scenario.laborRateUsdPerHour.max
      )
        fail(`scenario ${scenario.id} has an invalid priced labor range`);
    } else if (scenario.breakEven.kind !== "deferred") {
      fail(
        `deferred scenario ${scenario.id} needs a deferred break-even decision`,
      );
    }

    if (scenario.id === "oss-local-first") {
      if (
        scenario.decision !== "retain" ||
        scenario.fundingMode !== "unfunded" ||
        scenario.breakEven.kind !== "capacity-only" ||
        scenario.breakEven.thresholdUsdPerQuarter !== null
      )
        fail(
          "local-first scenario must remain a capacity-gated unfunded option",
        );
    }
    if (scenario.id === "funded-oss-stewardship") {
      if (
        scenario.decision !== "fund-if-capacity" ||
        scenario.fundingMode !== "sponsor-or-grant" ||
        scenario.breakEven.kind !== "budget-threshold" ||
        !(scenario.breakEven.thresholdUsdPerQuarter > 0)
      )
        fail("funded stewardship scenario needs a positive budget threshold");
    }
    if (scenario.id === "hosted-team-expansion") {
      if (
        scenario.estimateStatus !== "deferred" ||
        scenario.decision !== "defer" ||
        scenario.fundingMode !== "deferred" ||
        scenario.serviceOperationsApproved
      )
        fail("hosted expansion must remain deferred and unapproved");
    }
    if (
      scenario.breakEven.kind === "deferred" &&
      scenario.breakEven.thresholdUsdPerQuarter !== null
    )
      fail(`deferred scenario ${scenario.id} must not publish a threshold`);
  }

  if (
    stableStringify([...categorySet].sort()) !==
    stableStringify([...expectedCategories].sort())
  )
    fail("model category inventory drifted");

  const summary = fixture.summary;
  const estimatedScenarioCount = fixture.scenarios.filter(
    (scenario) => scenario.estimateStatus === "estimated",
  ).length;
  const deferredScenarioCount = fixture.scenarios.filter(
    (scenario) => scenario.estimateStatus === "deferred",
  ).length;
  const observedInputCount = fixture.inputs.filter(
    (input) => input.status === "observed",
  ).length;
  const planningInputCount = fixture.inputs.filter(
    (input) => input.status === "planning-range",
  ).length;
  const deferredInputCount = fixture.inputs.filter(
    (input) => input.status === "deferred",
  ).length;
  if (
    summary.scenarioCount !== fixture.scenarios.length ||
    summary.estimatedScenarioCount !== estimatedScenarioCount ||
    summary.deferredScenarioCount !== deferredScenarioCount ||
    summary.componentCategoryCount !== expectedCategories.length ||
    summary.inputCount !== fixture.inputs.length ||
    summary.observedInputCount !== observedInputCount ||
    summary.planningInputCount !== planningInputCount ||
    summary.deferredInputCount !== deferredInputCount
  )
    fail("summary counts drifted");
  if (
    !summary.publicOnly ||
    summary.network ||
    summary.sourceBodiesIncluded ||
    summary.privateDataIncluded ||
    summary.hiddenTelemetry ||
    !summary.volunteerLaborPriced
  )
    fail("summary violates the local-only or priced-labor boundary");

  for (const value of [
    fixture.modelId,
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
    modelId: fixture.modelId,
    asOf: fixture.asOf,
    inputs: fixture.inputs.length,
    scenarios: fixture.scenarios.length,
    estimatedScenarios: fixture.summary.estimatedScenarioCount,
    deferredScenarios: fixture.summary.deferredScenarioCount,
    categories: expectedCategories.length,
    volunteerLaborPriced: true,
    hostedExpansion: "deferred",
    network: false,
    sourceBodiesIncluded: false,
    digest: digest(stableStringify(fixture)),
  };
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node scripts/sustainability-cost-model.mjs validate [--fixture path]",
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
