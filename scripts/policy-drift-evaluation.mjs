#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  GraphSchemaVersionError,
  diffGraphSnapshots,
  evaluatePolicyOnSnapshot,
  parseAdrReferenceDocument,
  stableStringify,
  validateAdrReferences,
} from "../src/core/index.ts";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  argumentValue("--fixture") ??
    "test/fixtures/policy-decision-drift/scenarios.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/policy-drift-evaluation-fixtures.v0.1.schema.json",
);
const reportSchemaPath = resolve(
  repositoryRoot,
  "schema/policy-drift-evaluation.v0.1.schema.json",
);

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));
const fail = (message) => {
  throw new Error(`cartograph.policy-drift validation failed: ${message}`);
};
const digest = (value) =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const compareStrings = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;
const rate = (numerator, denominator) =>
  denominator === 0 ? 1 : numerator / denominator;
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const canonicalFixture = (fixture) => ({
  ...fixture,
  cases: [...fixture.cases]
    .map((scenario) => ({
      ...scenario,
      expectedFindings: [...scenario.expectedFindings].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    }))
    .sort((left, right) => left.id.localeCompare(right.id)),
});

const sourceEvidence = (id, path = "src/index.ts", line = 1) => ({
  id: `evidence:${id}`,
  kind: "source",
  path,
  line,
  detector: "policy-drift-fixture@0.1.0",
  contentHash: `sha256:${"a".repeat(64)}`,
});

const node = (id, kind = "module", name = id) => ({ id, kind, name });

const edge = (from, to, kind = "imports") => ({
  from,
  to,
  kind,
  confidence: "certain",
  evidence: [sourceEvidence(`${from}:${to}:${kind}`)],
});

const snapshot = (commitSha, nodes, edges = [], diagnostics = []) => ({
  schemaVersion: 1,
  revision: { commitSha },
  nodes,
  edges,
  diagnostics,
});

const rule = (id, target, selector, assertion = "exists", extra = {}) => ({
  id,
  target,
  selector,
  assertion,
  ...extra,
});

const policy = (policyId, rules, extra = {}) => ({
  schemaVersion: 1,
  policyId,
  version: "1.0.0",
  mode: "enforce",
  rules,
  ...extra,
});

const binding = (id, ruleId, requirement, scope, referenceId) => ({
  schemaVersion: 1,
  contract: "cartograph.policy-adr-binding",
  id,
  ruleId,
  requirement,
  scope,
  referenceId,
});

const adrReference = (id, status, graphIds, extra = {}) => ({
  id,
  file: `docs/adr/${id.toLowerCase()}.md`,
  title: id,
  status,
  graphIds,
  ...extra,
});

const adrDocument = (references) => ({ schemaVersion: 1, references });

const finding = (id, category, severity, evidenceRefs, reason) => ({
  id,
  category,
  severity,
  evidenceRefs: [...new Set(evidenceRefs)].sort(compareStrings),
  reason,
});

const findingFromViolation = (
  violation,
  id,
  category,
  severity,
  reason = violation.reason,
) => finding(id, category, severity, violation.evidenceRefs, reason);

const supersessionScenario = () => {
  const after = snapshot("supersession-after", [node("module:payments")]);
  const document = adrDocument([
    adrReference("ADR-0001", "superseded", ["module:payments"]),
    adrReference("ADR-0002", "accepted", ["module:payments"], {
      supersedes: ["ADR-0001"],
    }),
  ]);
  const parsedDocument = parseAdrReferenceDocument(document);
  const validation = validateAdrReferences(parsedDocument, { snapshot: after });
  const policyInput = policy(
    "supersession-policy",
    [rule("payments-boundary", "node", { id: "module:payments" })],
    {
      adrBindings: [
        binding(
          "payments-binding",
          "payments-boundary",
          "boundary",
          { target: "node", selector: { id: "module:payments" } },
          "ADR-0001",
        ),
      ],
    },
  );
  const evaluation = evaluatePolicyOnSnapshot(policyInput, after, {
    adr: { document },
  });
  const oldReference = parsedDocument.references.find(
    (reference) => reference.id === "ADR-0001",
  );
  const replacement = parsedDocument.references.find((reference) =>
    reference.supersedes?.includes("ADR-0001"),
  );
  if (
    !validation.ok ||
    evaluation.status !== "passed" ||
    oldReference?.status !== "superseded" ||
    replacement?.status !== "accepted"
  )
    fail(
      "decision supersession fixture did not remain valid and deterministic",
    );
  return {
    findings: [
      finding(
        "adr-supersession:adr-0001",
        "decision-supersession",
        "warning",
        [
          "adr-reference:ADR-0001",
          "adr-reference:ADR-0002",
          "policy-adr-binding:payments-binding",
        ],
        "policy binding still points at a superseded decision; reviewer confirmation is required",
      ),
    ],
  };
};

const removedArchitectureScenario = () => {
  const before = snapshot("removed-before", [node("module:payments")]);
  const after = snapshot("removed-after", []);
  const document = adrDocument([
    adrReference("ADR-0001", "accepted", ["module:payments"]),
  ]);
  const policyInput = policy(
    "removed-architecture-policy",
    [rule("payments-boundary", "node", { id: "module:payments" })],
    {
      adrBindings: [
        binding(
          "payments-binding",
          "payments-boundary",
          "boundary",
          { target: "node", selector: { id: "module:payments" } },
          "ADR-0001",
        ),
      ],
    },
  );
  const diff = diffGraphSnapshots(before, after);
  const evaluation = evaluatePolicyOnSnapshot(policyInput, after, {
    adr: { document },
  });
  const validation = validateAdrReferences(
    parseAdrReferenceDocument(document),
    { snapshot: after },
  );
  const violation = evaluation.violations.find(
    (candidate) => candidate.id === "violation:adr-binding:payments-binding",
  );
  if (
    diff.summary.nodesRemoved !== 1 ||
    evaluation.status !== "violations" ||
    violation === undefined ||
    !validation.diagnostics.some(
      (diagnostic) => diagnostic.code === "ADR_REFERENCE_STALE_GRAPH_ID",
    )
  )
    fail("removed architecture fixture did not expose stale decision evidence");
  return {
    findings: [
      findingFromViolation(
        violation,
        "removed-architecture:module:payments",
        "removed-architecture",
        "error",
        "architecture was removed while its ADR and policy boundary still require it",
      ),
    ],
  };
};

const policyChangeScenario = () => {
  const before = snapshot(
    "policy-before",
    [node("module:payments"), node("module:billing")],
    [edge("module:payments", "module:billing", "unknown")],
  );
  const after = snapshot(
    "policy-after",
    [node("module:payments"), node("module:billing")],
    [edge("module:payments", "module:billing", "unknown")],
  );
  const beforePolicy = policy("policy-change", [
    rule("unknown-edge-review", "edge", { kind: "unknown" }, "count-at-most", {
      value: 1,
    }),
  ]);
  const afterPolicy = {
    ...beforePolicy,
    version: "1.1.0",
    rules: [rule("unknown-edge-review", "edge", { kind: "unknown" }, "absent")],
  };
  const beforeEvaluation = evaluatePolicyOnSnapshot(beforePolicy, before);
  const afterEvaluation = evaluatePolicyOnSnapshot(afterPolicy, after);
  const violation = afterEvaluation.violations.find(
    (candidate) => candidate.id === "violation:unknown-edge-review",
  );
  if (
    beforeEvaluation.status !== "passed" ||
    afterEvaluation.status !== "violations" ||
    violation === undefined ||
    stableStringify(beforePolicy.rules) === stableStringify(afterPolicy.rules)
  )
    fail("policy change fixture did not expose a changed rule outcome");
  return {
    findings: [
      findingFromViolation(
        violation,
        "policy-change:unknown-edge-review",
        "policy-change",
        "error",
        "the tightened policy changes a previously passing unknown-edge boundary into a violation",
      ),
    ],
  };
};

const unreferencedAdditionScenario = () => {
  const before = snapshot("addition-before", [node("module:payments")]);
  const after = snapshot("addition-after", [
    node("module:payments"),
    node("service:billing", "service", "billing"),
  ]);
  const diff = diffGraphSnapshots(before, after);
  const document = adrDocument([
    adrReference("ADR-0001", "accepted", ["module:payments"]),
  ]);
  const validation = validateAdrReferences(
    parseAdrReferenceDocument(document),
    { snapshot: after, requiredGraphIds: ["service:billing"] },
  );
  const added = diff.nodes.added.find(
    (candidate) => candidate.id === "service:billing",
  );
  if (
    added === undefined ||
    validation.ok ||
    !validation.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "ADR_REFERENCE_MISSING_GRAPH_ID" &&
        diagnostic.graphId === "service:billing",
    )
  )
    fail(
      "unreferenced addition fixture did not expose missing decision coverage",
    );
  return {
    findings: [
      finding(
        "unreferenced-addition:service:billing",
        "unreferenced-addition",
        "warning",
        [
          "node:service:billing",
          "diff:node-added:service:billing",
          "input:adr-reference-document",
        ],
        "new architecture was added without a local ADR reference covering its graph identity",
      ),
    ],
  };
};

const exceptionScenario = () => {
  const after = snapshot("exception-after", [node("module:payments")]);
  const document = adrDocument([
    adrReference("ADR-0001", "accepted", ["module:payments"]),
  ]);
  const policyInput = policy(
    "exception-policy",
    [rule("endpoint-required", "node", { kind: "endpoint" })],
    {
      exceptions: [
        {
          schemaVersion: 1,
          contract: "cartograph.policy-exception",
          id: "endpoint-migration",
          ruleId: "endpoint-required",
          scope: { target: "node", selector: { kind: "endpoint" } },
          rationale: "endpoint migration is scheduled",
          owner: "architecture-team",
          createdAt: "2028-01-01T00:00:00Z",
          expiresAt: "2028-12-31T00:00:00Z",
          adrReferenceId: "ADR-0001",
          precedence: 10,
        },
      ],
      adrBindings: [
        binding(
          "endpoint-exception",
          "endpoint-required",
          "exception",
          { target: "node", selector: { kind: "endpoint" } },
          "ADR-0001",
        ),
      ],
    },
  );
  const evaluation = evaluatePolicyOnSnapshot(policyInput, after, {
    asOf: "2028-06-01T00:00:00Z",
    adr: { document },
  });
  const exception = evaluation.exceptions.find(
    (candidate) => candidate.id === "exception:endpoint-migration",
  );
  if (
    evaluation.status !== "passed" ||
    exception?.status !== "active" ||
    exception.suppresses !== true
  )
    fail("exception fixture did not prove active, ADR-backed suppression");
  return {
    findings: [
      finding(
        "exception-suppressed:endpoint-required",
        "exception-handling",
        "info",
        exception.evidenceRefs,
        "an active ADR-backed exception suppresses the missing endpoint violation until its expiry window",
      ),
    ],
  };
};

const mixedSchemaScenario = () => {
  const before = snapshot("schema-before", [node("module:payments")]);
  const after = {
    schemaVersion: 2,
    revision: { commitSha: "schema-after" },
    nodes: [node("module:payments")],
    edges: [],
    diagnostics: [],
  };
  let schemaError;
  try {
    diffGraphSnapshots(before, after);
  } catch (error) {
    schemaError = error;
  }
  if (!(schemaError instanceof GraphSchemaVersionError))
    fail("mixed schema fixture did not fail closed at the version boundary");
  return {
    findings: [
      finding(
        "schema-mismatch:graph-snapshot",
        "schema-compatibility",
        "error",
        ["snapshot:before:1", "snapshot:after:2", "schema:graph-snapshot:1"],
        "mixed snapshot schema versions require an explicit migration before drift comparison",
      ),
    ],
  };
};

const scenarioBuilders = {
  "decision-supersession": supersessionScenario,
  "removed-architecture": removedArchitectureScenario,
  "policy-change": policyChangeScenario,
  "unreferenced-addition": unreferencedAdditionScenario,
  exception: exceptionScenario,
  "mixed-schema": mixedSchemaScenario,
};

const expectedScenarioOrder = [
  "decision-supersession",
  "removed-architecture",
  "policy-change",
  "unreferenced-addition",
  "exception",
  "mixed-schema",
];

const compareFindingSets = (expected, observed) => {
  const expectedById = new Map(
    expected.map((candidate) => [candidate.id, candidate]),
  );
  const observedById = new Map(
    observed.map((candidate) => [candidate.id, candidate]),
  );
  const missing = [...expectedById.keys()]
    .filter((id) => !observedById.has(id))
    .sort(compareStrings);
  const unexpected = [...observedById.keys()]
    .filter((id) => !expectedById.has(id))
    .sort(compareStrings);
  const mismatched = [...expectedById.keys()]
    .filter((id) => {
      const expectedFinding = expectedById.get(id);
      const observedFinding = observedById.get(id);
      return (
        observedFinding !== undefined &&
        (expectedFinding.category !== observedFinding.category ||
          expectedFinding.severity !== observedFinding.severity)
      );
    })
    .sort(compareStrings);
  return {
    matched: expected.length - missing.length - mismatched.length,
    missing,
    unexpected,
    mismatched,
  };
};

const canonicalCaseResults = (results) =>
  [...results].sort((left, right) => left.id.localeCompare(right.id));

const validate = () => {
  const fixture = readJson(fixturePath);
  const fixtureSchema = readJson(fixtureSchemaPath);
  const reportSchema = readJson(reportSchemaPath);
  const ajv = new Ajv({ allErrors: true });
  const validateFixture = ajv.compile(fixtureSchema);
  const validateReport = ajv.compile(reportSchema);
  if (!validateFixture(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validateFixture.errors)}`,
    );
  if (
    fixture.cases.map((scenario) => scenario.kind).join(",") !==
    expectedScenarioOrder.join(",")
  )
    fail("curated scenario order changed");
  if (fixture.cases.length !== expectedScenarioOrder.length)
    fail(`expected ${expectedScenarioOrder.length} curated scenarios`);

  const caseResults = [];
  for (const scenario of fixture.cases) {
    const builder = scenarioBuilders[scenario.kind];
    if (builder === undefined) fail(`unknown scenario kind: ${scenario.kind}`);
    const observed = builder().findings;
    const comparison = compareFindingSets(scenario.expectedFindings, observed);
    if (
      comparison.missing.length > 0 ||
      comparison.unexpected.length > 0 ||
      comparison.mismatched.length > 0
    )
      fail(
        `scenario ${scenario.id} finding drift: ${JSON.stringify(comparison)}`,
      );
    if (
      scenario.reviewer.disposition === "overridden" &&
      scenario.reviewer.falsePositiveCategory === undefined
    )
      fail(
        `scenario ${scenario.id} override is missing a false-positive category`,
      );
    if (
      scenario.reviewer.disposition !== "overridden" &&
      scenario.reviewer.falsePositiveCategory !== undefined
    )
      fail(
        `scenario ${scenario.id} has a false-positive category without an override`,
      );
    caseResults.push({
      id: scenario.id,
      kind: scenario.kind,
      expectedFindings: scenario.expectedFindings,
      observedFindings: observed,
      matchedFindings: comparison.matched,
      missingFindings: comparison.missing,
      unexpectedFindings: comparison.unexpected,
      mismatchedFindings: comparison.mismatched,
      reviewerMinutes: scenario.reviewer.minutes,
      reviewerSteps: scenario.reviewer.steps,
      reviewerDisposition: scenario.reviewer.disposition,
      ...(scenario.reviewer.falsePositiveCategory === undefined
        ? {}
        : { falsePositiveCategory: scenario.reviewer.falsePositiveCategory }),
    });
  }

  const orderedResults = canonicalCaseResults(caseResults);
  const expectedFindings = orderedResults.reduce(
    (total, result) => total + result.expectedFindings.length,
    0,
  );
  const observedFindings = orderedResults.reduce(
    (total, result) => total + result.observedFindings.length,
    0,
  );
  const matchedFindings = orderedResults.reduce(
    (total, result) => total + result.matchedFindings,
    0,
  );
  const missingFindings = orderedResults.reduce(
    (total, result) => total + result.missingFindings.length,
    0,
  );
  const unexpectedFindings = orderedResults.reduce(
    (total, result) => total + result.unexpectedFindings.length,
    0,
  );
  const mismatchedFindings = orderedResults.reduce(
    (total, result) => total + result.mismatchedFindings.length,
    0,
  );
  const reviewerMinutes = orderedResults.map(
    (result) => result.reviewerMinutes,
  );
  const reviewerSteps = orderedResults.reduce(
    (total, result) => total + result.reviewerSteps,
    0,
  );
  const reviewerDispositionCounts = Object.fromEntries(
    ["accepted", "overridden", "rejected", "unreviewed"].map((disposition) => [
      disposition,
      orderedResults.filter(
        (result) => result.reviewerDisposition === disposition,
      ).length,
    ]),
  );
  const categoryMap = new Map();
  for (const result of orderedResults) {
    const category = result.falsePositiveCategory;
    if (category === undefined) continue;
    const existing = categoryMap.get(category) ?? {
      category,
      count: 0,
      caseIds: [],
    };
    existing.count += 1;
    existing.caseIds.push(result.id);
    categoryMap.set(category, existing);
  }
  const falsePositiveCategories = [...categoryMap.values()]
    .map((entry) => ({ ...entry, caseIds: entry.caseIds.sort(compareStrings) }))
    .sort((left, right) => compareStrings(left.category, right.category));
  const reviewerFalsePositiveCases = falsePositiveCategories.reduce(
    (total, entry) => total + entry.count,
    0,
  );
  const summary = {
    cases: orderedResults.length,
    expectedFindings,
    observedFindings,
    matchedFindings,
    missingFindings,
    unexpectedFindings,
    mismatchedFindings,
    findingRecall: rate(matchedFindings, expectedFindings),
    reviewerFalsePositiveCases,
    reviewerFalsePositiveRate: rate(
      reviewerFalsePositiveCases,
      orderedResults.length,
    ),
    falsePositiveCategories,
    reviewerEffort: {
      cases: orderedResults.length,
      totalMinutes: reviewerMinutes.reduce((total, value) => total + value, 0),
      meanMinutes:
        reviewerMinutes.reduce((total, value) => total + value, 0) /
        reviewerMinutes.length,
      medianMinutes: median(reviewerMinutes),
      totalSteps: reviewerSteps,
      evidenceReviewed: matchedFindings,
      evidenceReviewRate: rate(matchedFindings, expectedFindings),
      dispositions: reviewerDispositionCounts,
    },
  };
  const thresholds = fixture.thresholds;
  const thresholdResults = [
    {
      id: "scenario-coverage",
      status:
        summary.cases === expectedScenarioOrder.length ? "passed" : "failed",
      observed: summary.cases,
      required: expectedScenarioOrder.length,
    },
    {
      id: "finding-recall",
      status:
        summary.findingRecall >= thresholds.minFindingRecall
          ? "passed"
          : "failed",
      observed: summary.findingRecall,
      required: thresholds.minFindingRecall,
    },
    {
      id: "unexpected-finding-rate",
      status:
        rate(unexpectedFindings, observedFindings) <=
        thresholds.maxUnexpectedFindingRate
          ? "passed"
          : "failed",
      observed: rate(unexpectedFindings, observedFindings),
      required: thresholds.maxUnexpectedFindingRate,
    },
    {
      id: "reviewer-false-positive-rate",
      status:
        summary.reviewerFalsePositiveRate <=
        thresholds.maxReviewerFalsePositiveRate
          ? "passed"
          : "failed",
      observed: summary.reviewerFalsePositiveRate,
      required: thresholds.maxReviewerFalsePositiveRate,
    },
    {
      id: "reviewer-effort",
      status:
        summary.reviewerEffort.totalMinutes <= thresholds.maxReviewerMinutes
          ? "passed"
          : "failed",
      observed: summary.reviewerEffort.totalMinutes,
      required: thresholds.maxReviewerMinutes,
    },
    {
      id: "evidence-review",
      status:
        summary.reviewerEffort.evidenceReviewRate >=
        thresholds.minEvidenceReviewRate
          ? "passed"
          : "failed",
      observed: summary.reviewerEffort.evidenceReviewRate,
      required: thresholds.minEvidenceReviewRate,
    },
    {
      id: "schema-boundary",
      status:
        orderedResults.some((result) => result.kind === "mixed-schema") &&
        orderedResults
          .find((result) => result.kind === "mixed-schema")
          ?.observedFindings.some(
            (findingResult) =>
              findingResult.category === "schema-compatibility",
          )
          ? "passed"
          : "failed",
      observed: "mixed-schema rejection is explicit",
      required: "mixed-schema rejection is explicit",
    },
  ];
  const gatePassed = thresholdResults.every(
    (result) => result.status === "passed",
  );
  const decision = gatePassed ? "proceed" : "hold";
  const decisionReason = gatePassed
    ? "curated drift findings are fully reproduced, reviewer noise is categorized within the declared bound, and mixed schema input fails closed"
    : "at least one policy/decision drift or reviewer-effort gate missed its declared threshold";
  if (decision !== fixture.decisionTarget)
    fail(
      `fixture expected decision ${fixture.decisionTarget}, found ${decision}`,
    );

  const reportWithoutDigest = {
    schemaVersion: 1,
    contract: "cartograph.policy-drift-evaluation",
    evaluationId: fixture.evaluationId,
    evaluatedAt: fixture.evaluatedAt,
    fixtureDigest: digest(stableStringify(canonicalFixture(fixture))),
    decision,
    decisionReason,
    thresholds,
    summary,
    caseResults: orderedResults,
    milestoneExit: {
      milestone: "Y2-Q3",
      gate: "policy-decision-drift",
      decision,
      rationale: decisionReason,
      criteria: thresholdResults,
    },
  };
  const report = {
    ...reportWithoutDigest,
    reportDigest: digest(stableStringify(reportWithoutDigest)),
  };
  if (!validateReport(report))
    fail(
      `report schema validation failed: ${JSON.stringify(validateReport.errors)}`,
    );
  if (digest(stableStringify(reportWithoutDigest)) !== report.reportDigest)
    fail("report digest does not bind the report fields");
  const reversedFixture = {
    ...fixture,
    cases: [...fixture.cases].reverse(),
  };
  if (
    digest(stableStringify(canonicalFixture(reversedFixture))) !==
    report.fixtureDigest
  )
    fail("fixture digest changed with scenario order");

  console.log(
    JSON.stringify({
      ok: true,
      schemaVersion: report.schemaVersion,
      contract: report.contract,
      evaluationId: report.evaluationId,
      milestone: report.milestoneExit.milestone,
      cases: summary.cases,
      expectedFindings,
      observedFindings,
      findingRecall: summary.findingRecall,
      missingFindings,
      unexpectedFindings,
      reviewerFalsePositiveCases,
      reviewerFalsePositiveRate: summary.reviewerFalsePositiveRate,
      reviewerMinutes: summary.reviewerEffort.totalMinutes,
      reviewerMedianMinutes: summary.reviewerEffort.medianMinutes,
      falsePositiveCategories,
      decision,
      fixtureDigest: report.fixtureDigest,
      reportDigest: report.reportDigest,
    }),
  );
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/policy-drift-evaluation.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  validate();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
