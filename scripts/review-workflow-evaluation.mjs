#!/usr/bin/env node
/* global URL, console, process */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const CONTRACT = "cartograph.review-workflow-evaluation";
const SCHEMA_VERSION = 1;
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultFixturePath = resolve(
  repositoryRoot,
  "test/fixtures/review-workflow-evaluation/report.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/review-workflow-evaluation.v0.1.schema.json",
);

const METRICS = [
  "triage-accuracy",
  "time-to-owner",
  "waiver-review-time",
  "stale-finding-rate",
  "reviewer-task-completion",
  "maintainer-load",
  "failure-recovery",
];
const THREATS = [
  "forgery",
  "replay",
  "broad-waiver",
  "owner-spoofing",
  "fork-pull-request",
  "compromised-key",
];
const OBSERVATION_KINDS = [
  "triage",
  "waiver-review",
  "stale-finding",
  "reviewer-task",
  "maintainer-load",
  "failure-recovery",
];
const RATIO_METRICS = new Set([
  "triage-accuracy",
  "stale-finding-rate",
  "reviewer-task-completion",
  "failure-recovery",
]);

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
const compareStrings = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;
const sorted = (values) => [...values].sort(compareStrings);
const requireClose = (actual, expected, label) => {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-12)
    fail(`${label} drifted: expected ${expected}, found ${actual}`);
};
const median = (values) => {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
};

const containedPath = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0)
    fail(`${label} must be a non-empty repository-relative path`);
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.startsWith("~") ||
    value.includes("\0")
  )
    fail(`${label} must be repository-relative: ${value}`);
  const withoutAnchor = value.split("#", 1)[0];
  const candidate = resolve(repositoryRoot, withoutAnchor);
  const relativePath = relative(repositoryRoot, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  )
    fail(`${label} escapes the repository: ${value}`);
  if (!existsSync(candidate)) fail(`${label} does not exist: ${value}`);
  return candidate;
};

const assertPublicText = (value, label) => {
  if (
    typeof value !== "string" ||
    /(?:\/Users\/|\/home\/|\/private\/|\/tmp\/|[A-Za-z]:\\|file:|https?:\/\/|password\s*=|BEGIN (?:RSA|OPENSSH) PRIVATE KEY|gh[pous]_[A-Za-z0-9]+)/iu.test(
      value,
    )
  )
    fail(
      `${label} contains a private path, remote reference, or secret marker`,
    );
};

const validateEvidenceRefs = (refs, label) => {
  for (const reference of refs) {
    assertPublicText(reference, label);
    if (reference.startsWith("command:")) {
      const command = reference.slice("command:".length).trim();
      if (
        command.length === 0 ||
        !command.startsWith("npm run ") ||
        /(?:curl|wget|git\s+(?:push|fetch|clone)|gh\s|npm\s+publish|>|>>|\btoken\b)/iu.test(
          command,
        )
      )
        fail(`${label} contains a non-local or mutative command: ${reference}`);
      continue;
    }
    containedPath(reference, label);
  }
};

const requireOrderedIds = (entries, label) => {
  const ids = entries.map((entry) => entry.id);
  if (stableStringify(ids) !== stableStringify(sorted(ids)))
    fail(`${label} must be ordered by identifier`);
  if (new Set(ids).size !== ids.length) fail(`${label} contains duplicates`);
};

const requireExactSet = (actual, expected, label) => {
  if (stableStringify(sorted(actual)) !== stableStringify(sorted(expected)))
    fail(`${label} set drifted`);
};

const compareThreshold = (operator, actual, target) => {
  if (operator === ">=") return actual >= target;
  if (operator === "<=") return actual <= target;
  return actual === target;
};

const validateObservation = (observation) => {
  assertPublicText(
    observation.expected,
    `observation ${observation.id} expected`,
  );
  assertPublicText(
    observation.observed,
    `observation ${observation.id} observed`,
  );
  assertPublicText(observation.notes, `observation ${observation.id} notes`);
  validateEvidenceRefs(
    observation.evidenceRefs,
    `observation ${observation.id} evidence`,
  );
  if (observation.kind === "triage") {
    if (
      typeof observation.correct !== "boolean" ||
      !Number.isInteger(observation.durationMs) ||
      observation.durationMs < 1
    )
      fail(`triage observation ${observation.id} lacks correctness or timing`);
  }
  if (
    observation.kind === "waiver-review" &&
    (!Number.isInteger(observation.durationMs) || observation.durationMs < 1)
  )
    fail(`waiver observation ${observation.id} lacks review timing`);
  if (
    observation.kind === "stale-finding" &&
    typeof observation.stale !== "boolean"
  )
    fail(`stale-finding observation ${observation.id} lacks stale state`);
  if (
    observation.kind === "reviewer-task" &&
    typeof observation.completed !== "boolean"
  )
    fail(`reviewer-task observation ${observation.id} lacks completion state`);
  if (
    observation.kind === "maintainer-load" &&
    (!Number.isFinite(observation.maintainerMinutes) ||
      !(observation.maintainerMinutes > 0))
  )
    fail(`maintainer-load observation ${observation.id} lacks load timing`);
  if (
    observation.kind === "failure-recovery" &&
    (typeof observation.recovered !== "boolean" ||
      !Number.isInteger(observation.recoveryDurationMs) ||
      observation.recoveryDurationMs < 1)
  )
    fail(`failure-recovery observation ${observation.id} lacks recovery state`);
};

const deriveMeasurements = (observations) => {
  const byKind = (kind) => observations.filter((entry) => entry.kind === kind);
  const triage = byKind("triage");
  const waiver = byKind("waiver-review");
  const stale = byKind("stale-finding");
  const reviewer = byKind("reviewer-task");
  const maintainer = byKind("maintainer-load");
  const recovery = byKind("failure-recovery");
  const count = (items, predicate) => items.filter(predicate).length;
  return new Map([
    [
      "triage-accuracy",
      {
        value: count(triage, (entry) => entry.correct) / triage.length,
        numerator: count(triage, (entry) => entry.correct),
        denominator: triage.length,
        sampleCount: triage.length,
        scenarioRefs: triage.map((entry) => entry.id),
      },
    ],
    [
      "time-to-owner",
      {
        value: median(triage.map((entry) => entry.durationMs)),
        numerator: null,
        denominator: null,
        sampleCount: triage.length,
        scenarioRefs: triage.map((entry) => entry.id),
      },
    ],
    [
      "waiver-review-time",
      {
        value: median(waiver.map((entry) => entry.durationMs)),
        numerator: null,
        denominator: null,
        sampleCount: waiver.length,
        scenarioRefs: waiver.map((entry) => entry.id),
      },
    ],
    [
      "stale-finding-rate",
      {
        value: count(stale, (entry) => entry.stale) / stale.length,
        numerator: count(stale, (entry) => entry.stale),
        denominator: stale.length,
        sampleCount: stale.length,
        scenarioRefs: stale.map((entry) => entry.id),
      },
    ],
    [
      "reviewer-task-completion",
      {
        value: count(reviewer, (entry) => entry.completed) / reviewer.length,
        numerator: count(reviewer, (entry) => entry.completed),
        denominator: reviewer.length,
        sampleCount: reviewer.length,
        scenarioRefs: reviewer.map((entry) => entry.id),
      },
    ],
    [
      "maintainer-load",
      {
        value: median(maintainer.map((entry) => entry.maintainerMinutes)),
        numerator: null,
        denominator: null,
        sampleCount: maintainer.length,
        scenarioRefs: maintainer.map((entry) => entry.id),
      },
    ],
    [
      "failure-recovery",
      {
        value: count(recovery, (entry) => entry.recovered) / recovery.length,
        numerator: count(recovery, (entry) => entry.recovered),
        denominator: recovery.length,
        sampleCount: recovery.length,
        scenarioRefs: recovery.map((entry) => entry.id),
      },
    ],
  ]);
};

const validateSemantics = (report) => {
  if (report.contract !== CONTRACT || report.schemaVersion !== SCHEMA_VERSION)
    fail("contract or schema version drifted");
  if (
    report.method.network ||
    report.method.sourceBodiesIncluded ||
    report.method.credentialsUsed ||
    report.method.hiddenTelemetry ||
    report.method.userDataIncluded ||
    report.method.execution
  )
    fail("method violates the offline, source-free, no-credential boundary");
  for (const limitation of report.method.limitations)
    assertPublicText(limitation, "method limitation");

  requireOrderedIds(report.observations, "observations");
  const kindCounts = new Map(OBSERVATION_KINDS.map((kind) => [kind, 0]));
  for (const observation of report.observations) {
    kindCounts.set(
      observation.kind,
      (kindCounts.get(observation.kind) ?? 0) + 1,
    );
    validateObservation(observation);
  }
  for (const kind of OBSERVATION_KINDS) {
    if ((kindCounts.get(kind) ?? 0) < 2)
      fail(`representative study requires at least two ${kind} observations`);
  }

  requireOrderedIds(report.thresholds, "thresholds");
  requireOrderedIds(report.measurements, "measurements");
  requireExactSet(
    report.thresholds.map((entry) => entry.id),
    METRICS,
    "threshold",
  );
  requireExactSet(
    report.measurements.map((entry) => entry.id),
    METRICS,
    "measurement",
  );
  const thresholds = new Map(
    report.thresholds.map((entry) => [entry.id, entry]),
  );
  const measurements = new Map(
    report.measurements.map((entry) => [entry.id, entry]),
  );
  const derived = deriveMeasurements(report.observations);
  const misses = [];
  const results = [];
  for (const metricId of METRICS) {
    const threshold = thresholds.get(metricId);
    const measurement = measurements.get(metricId);
    const expected = derived.get(metricId);
    if (
      threshold === undefined ||
      measurement === undefined ||
      expected === undefined
    )
      fail(`metric ${metricId} is missing`);
    if (measurement.unit !== threshold.unit)
      fail(`measurement ${metricId} unit does not match its threshold`);
    if (measurement.sampleCount !== expected.sampleCount)
      fail(`measurement ${metricId} sample count drifted`);
    if (
      stableStringify(sorted(measurement.scenarioRefs)) !==
      stableStringify(sorted(expected.scenarioRefs))
    )
      fail(`measurement ${metricId} scenario references drifted`);
    requireClose(measurement.value, expected.value, `measurement ${metricId}`);
    if (RATIO_METRICS.has(metricId)) {
      if (
        measurement.numerator !== expected.numerator ||
        measurement.denominator !== expected.denominator
      )
        fail(`measurement ${metricId} numerator or denominator drifted`);
    } else if (
      measurement.numerator !== null ||
      measurement.denominator !== null
    ) {
      fail(`measurement ${metricId} must not publish a ratio numerator`);
    }
    const passed = compareThreshold(
      threshold.operator,
      measurement.value,
      threshold.target,
    );
    const expectedStatus = passed ? "pass" : "miss";
    if (measurement.status !== expectedStatus)
      fail(`measurement ${metricId} status does not match its threshold`);
    if (measurement.basis !== "synthetic" && measurement.basis !== "observed")
      fail(`measurement ${metricId} has an unknown evidence basis`);
    validateEvidenceRefs(
      measurement.evidenceRefs,
      `measurement ${metricId} evidence`,
    );
    assertPublicText(measurement.notes, `measurement ${metricId} notes`);
    if (measurement.status === "miss") misses.push(metricId);
    results.push({
      id: metricId,
      value: measurement.value,
      target: threshold.target,
      operator: threshold.operator,
      status: measurement.status,
      basis: measurement.basis,
      sampleCount: measurement.sampleCount,
    });
  }

  requireOrderedIds(report.securityReview.threats, "security threats");
  requireExactSet(
    report.securityReview.threats.map((entry) => entry.id),
    THREATS,
    "security threat",
  );
  const threatCounts = { blocked: 0, deferred: 0, miss: 0 };
  for (const threat of report.securityReview.threats) {
    threatCounts[threat.status] += 1;
    assertPublicText(threat.description, `threat ${threat.id} description`);
    assertPublicText(threat.attack, `threat ${threat.id} attack`);
    assertPublicText(
      threat.expectedControl,
      `threat ${threat.id} expected control`,
    );
    assertPublicText(threat.notes, `threat ${threat.id} notes`);
    validateEvidenceRefs(threat.evidenceRefs, `threat ${threat.id} evidence`);
  }
  const securitySummary = report.securityReview.summary;
  if (
    securitySummary.threatCount !== report.securityReview.threats.length ||
    securitySummary.blockedCount !== threatCounts.blocked ||
    securitySummary.deferredCount !== threatCounts.deferred ||
    securitySummary.missCount !== threatCounts.miss
  )
    fail("security summary counts drifted");
  const expectedSecurityConclusion =
    threatCounts.miss > 0
      ? "fail"
      : threatCounts.deferred > 0
        ? "limited"
        : "pass";
  if (report.securityReview.conclusion !== expectedSecurityConclusion)
    fail("security conclusion does not match threat outcomes");

  if (
    stableStringify(sorted(report.decision.failedMetrics)) !==
    stableStringify(sorted(misses))
  )
    fail("decision failed metric list does not match measurement misses");
  if (report.publicReport.decision !== report.decision.outcome)
    fail("public report decision does not match the gate decision");
  if (report.publicReport.securityOutcome !== report.decision.securityOutcome)
    fail("public report security outcome does not match the gate decision");
  if (report.decision.securityOutcome !== report.securityReview.conclusion)
    fail("decision security outcome does not match the security review");

  const allObserved = report.measurements.every(
    (measurement) => measurement.basis === "observed",
  );
  const expectedOutcome =
    report.securityReview.conclusion === "fail"
      ? "redesign"
      : misses.length > 0
        ? "narrow"
        : allObserved
          ? "graduate"
          : "defer";
  if (report.decision.outcome !== expectedOutcome)
    fail(
      `decision outcome must be ${expectedOutcome} for the observed evidence`,
    );
  if (
    report.decision.outcome === "defer" &&
    !/synthetic|independent|observed/iu.test(report.decision.rationale)
  )
    fail("defer decision must explain the evidence limitation");
  assertPublicText(report.decision.rationale, "decision rationale");
  assertPublicText(report.decision.allowedScope, "decision allowed scope");
  for (const requirement of report.decision.requiredBeforeChange)
    assertPublicText(requirement, "decision requirement");

  validateEvidenceRefs([report.publicReport.path], "public report path");
  const reportDigest = digest(stableStringify(report));
  const publicReport = readFileSync(
    containedPath(report.publicReport.path, "public report path"),
    "utf8",
  );
  for (const marker of [
    report.evaluationId,
    `Report digest: ${reportDigest}`,
    `Decision: ${report.decision.outcome}`,
    `Security outcome: ${report.decision.securityOutcome}`,
    ...METRICS,
    ...THREATS,
  ]) {
    if (!publicReport.includes(marker))
      fail(`public report is missing ${marker}`);
  }

  for (const field of ["source", "reference", "transformation"])
    assertPublicText(report.provenance[field], `provenance ${field}`);

  return {
    ok: true,
    contract: report.contract,
    schemaVersion: report.schemaVersion,
    evaluationId: report.evaluationId,
    observations: report.observations.length,
    measurements: results,
    failedMetrics: misses,
    securityThreats: report.securityReview.threats.length,
    securityBlocked: threatCounts.blocked,
    securityDeferred: threatCounts.deferred,
    securityMisses: threatCounts.miss,
    decision: report.decision.outcome,
    securityOutcome: report.decision.securityOutcome,
    network: false,
    sourceBodiesIncluded: false,
    credentialsUsed: false,
    hiddenTelemetry: false,
    digest: reportDigest,
  };
};

export const validate = (fixturePath = defaultFixturePath) => {
  const report = readJson(fixturePath);
  const schema = readJson(schemaPath);
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(
    schema,
  );
  if (!validateSchema(report))
    fail(`schema validation failed: ${JSON.stringify(validateSchema.errors)}`);
  return validateSemantics(report);
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node scripts/review-workflow-evaluation.mjs validate [--fixture path]",
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
