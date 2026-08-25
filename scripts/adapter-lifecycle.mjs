#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  argumentValue("--fixture") ??
    "test/fixtures/adapter-lifecycle/scenarios.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/adapter-lifecycle.v0.1.schema.json",
);
const CONTRACT = "cartograph.adapter-lifecycle";

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

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const fail = (message, category = "policy", caseId = "policy") => {
  throw new Error(
    `${CONTRACT} validation failed [category=${category} case=${caseId}]: ${message}`,
  );
};

const containedPath = (value, label) => {
  if (typeof value !== "string" || value.length === 0)
    fail(`${label} must be a non-empty path`);
  const target = resolve(repositoryRoot, value);
  const targetRelative = relative(repositoryRoot, target);
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    value.startsWith("~") ||
    value.includes("\0") ||
    value.split(/[\\/]/u).includes("..") ||
    targetRelative === ".." ||
    targetRelative.startsWith(`..${sep}`) ||
    targetRelative.startsWith(sep)
  )
    fail(`${label} escapes the repository: ${value}`);
  if (!existsSync(target)) fail(`${label} does not exist: ${value}`);
  return target;
};

const requireIncludes = (values, expected, label) => {
  for (const value of expected)
    if (!values.includes(value)) fail(`${label} is missing ${value}`);
};

const validatePolicy = (fixture) => {
  const policy = fixture.policy;
  if (policy.ownership.primary === policy.ownership.backup)
    fail("primary owner and backup must be distinct");
  requireIncludes(
    policy.vulnerabilityIntake.requiredReportFields,
    ["affected-commit", "command-or-input", "operating-system", "impact"],
    "vulnerability report fields",
  );
  if (!/private/iu.test(policy.vulnerabilityIntake.privateRoute))
    fail("vulnerability intake must name a private route");
  if (
    !/do not open a public issue/iu.test(policy.vulnerabilityIntake.publicRule)
  )
    fail("vulnerability intake must not direct reporters to a public issue");
  if (!policy.vulnerabilityIntake.secretsProhibited)
    fail("vulnerability intake must prohibit secrets");

  const windows = policy.supportedVersionWindows;
  if (
    windows.stable.supportDays <= windows.experimental.supportDays ||
    windows.experimental.supportDays <= windows.unreleased.supportDays
  )
    fail(
      "support windows must narrow from stable to experimental to unreleased",
    );
  if (
    windows.stable.snapshotReadabilityDays <
    windows.experimental.snapshotReadabilityDays
  )
    fail("historical snapshot readability cannot shrink for stable adapters");

  const triggerIds = new Set();
  for (const trigger of policy.qualityRegressionTriggers) {
    if (triggerIds.has(trigger.id))
      fail(`duplicate quality trigger: ${trigger.id}`);
    triggerIds.add(trigger.id);
  }
  requireIncludes(
    [...triggerIds],
    [
      "precision-floor",
      "recall-floor",
      "evidence-completeness",
      "security-finding",
    ],
    "quality regression triggers",
  );
  const precision = policy.qualityRegressionTriggers.find(
    (trigger) => trigger.id === "precision-floor",
  );
  const recall = policy.qualityRegressionTriggers.find(
    (trigger) => trigger.id === "recall-floor",
  );
  if (precision?.threshold !== 0.9 || recall?.threshold !== 0.85)
    fail("quality floors drifted from the published support target");

  requireIncludes(
    policy.deprecationNotice.requiredFields,
    ["adapter-id", "reason", "effective-at", "replacement", "migration"],
    "deprecation notice fields",
  );
  if (policy.deprecationNotice.minimumNoticeDays < 30)
    fail("deprecation notice window is too short");
  if (!policy.archiveBehavior.preserveHistoricalSnapshots)
    fail("archive behavior must preserve historical snapshots");
  if (!policy.archiveBehavior.retainEvidence)
    fail("archive behavior must retain evidence");
  if (!policy.archiveBehavior.removeSupportClaim)
    fail("archive behavior must remove the active support claim");
  if (!policy.archiveBehavior.requireMigrationNote)
    fail("archive behavior must require a migration note");
  requireIncludes(
    policy.replacementGuidance.requiredFields,
    ["replacement-id", "scope", "migration"],
    "replacement guidance fields",
  );
  if (!policy.replacementGuidance.noImplicitPromotion)
    fail("replacement guidance must not imply promotion");
};

const validateTabletop = (current) => {
  const events = current.events;
  if (events[0]?.atHours !== 0)
    fail("timeline must begin at hour zero", current.category, current.id);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const next = events[index + 1];
    if (next !== undefined && event.atHours >= next.atHours)
      fail(
        "timeline events must be strictly ordered",
        current.category,
        current.id,
      );
    if (event.deadlineHours < event.atHours)
      fail(
        "event deadline cannot precede its start",
        current.category,
        current.id,
      );
    if (next !== undefined && event.deadlineHours > next.atHours)
      fail(
        "event deadline exceeds the next response boundary",
        current.category,
        current.id,
      );
    if (event.owner.trim().length === 0 || event.action.trim().length === 0)
      fail(
        "every event must name an owner and bounded action",
        current.category,
        current.id,
      );
  }
  if (events.at(-1)?.state !== current.expectedOutcome.finalState)
    fail(
      "timeline final state does not match expected outcome",
      current.category,
      current.id,
    );

  const templates = current.publicTemplates;
  for (const [name, template] of Object.entries(templates)) {
    if (!template.includes("{{adapterId}}"))
      fail(
        `${name} template must identify the adapter`,
        current.category,
        current.id,
      );
    if (
      /(?:\/Users\/|password=|BEGIN (?:RSA|OPENSSH) PRIVATE KEY|ghp_[A-Za-z0-9]+)/u.test(
        template,
      )
    )
      fail(
        `${name} template contains a source or secret disclosure`,
        current.category,
        current.id,
      );
  }
  requireIncludes(
    current.expectedOutcome.requiredActions,
    current.category === "abandoned-adapter"
      ? [
          "owner-gap-recorded",
          "deprecation-notice",
          "migration-note",
          "archive-preserves-snapshots",
        ]
      : [
          "private-intake",
          "containment",
          "advisory",
          "fix",
          "conformance-replay",
          "coordinated-disclosure",
        ],
    "tabletop required actions",
  );
  return {
    id: current.id,
    category: current.category,
    events: events.length,
    windowHours: events.at(-1)?.atHours ?? 0,
    states: events.map((event) => event.state),
    templateKeys: Object.keys(templates).sort(),
    finalState: current.expectedOutcome.finalState,
    noSourceLeak: current.expectedOutcome.noSourceLeak,
  };
};

export const validateAdapterLifecycle = () => {
  containedPath("test/fixtures/adapter-lifecycle", "fixture root");
  const fixture = readJson(fixturePath);
  const schema = readJson(schemaPath);
  const validator = new Ajv({ allErrors: true }).compile(schema);
  if (!validator(fixture))
    fail(`schema validation failed: ${JSON.stringify(validator.errors)}`);
  if (fixture.contract !== CONTRACT)
    fail(`unsupported contract: ${fixture.contract}`);

  validatePolicy(fixture);
  const categories = new Set();
  const cases = fixture.tabletops.map((current) => {
    if (categories.has(current.category))
      fail(`duplicate tabletop category: ${current.category}`);
    categories.add(current.category);
    return validateTabletop(current);
  });
  requireIncludes(
    [...categories],
    ["abandoned-adapter", "security-defect"],
    "tabletop categories",
  );

  return {
    ok: true,
    contract: fixture.contract,
    schemaVersion: fixture.schemaVersion,
    policyId: fixture.policyId,
    policyDigest: `sha256:${createHash("sha256")
      .update(stableStringify(fixture.policy))
      .digest("hex")}`,
    fixtureDigest: `sha256:${createHash("sha256")
      .update(stableStringify(fixture))
      .digest("hex")}`,
    summary: {
      cases: cases.length,
      events: cases.reduce((total, current) => total + current.events, 0),
      categories: [...categories].sort(),
      timelinesDeterministic: true,
      publicTemplates: cases.every(
        (current) => current.templateKeys.length === 3,
      ),
      noSourceLeaks: cases.every((current) => current.noSourceLeak),
      finalStates: Object.fromEntries(
        cases.map((current) => [current.id, current.finalState]),
      ),
    },
    cases,
  };
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node scripts/adapter-lifecycle.mjs validate [--root path] [--fixture path]",
    );
    process.exitCode = 2;
  } else {
    try {
      const report = validateAdapterLifecycle();
      console.log(JSON.stringify(report));
      const summaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (summaryPath !== undefined) {
        appendFileSync(
          summaryPath,
          `## CARTOGRAPH adapter lifecycle\n\n- Policy: ${report.policyId}\n- Tabletop cases: ${report.summary.cases}\n- Timed events: ${report.summary.events}\n- Categories: ${report.summary.categories.join(", ")}\n- Public templates complete: ${report.summary.publicTemplates}\n- Source leaks: ${report.summary.noSourceLeaks}\n- Result: passed\n`,
          "utf8",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`adapter-lifecycle validation failed: ${message}`);
      process.exitCode = 1;
    }
  }
}
