#!/usr/bin/env node

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(SCRIPT_DIR, "../roadmap/manifest.json");
const MANAGED_MARKER = "cartograph";
const EXPECTED_MILESTONES = 20;
const EXPECTED_LABELS = 36;
const EXPECTED_ISSUES = 179;
const EXPECTED_DEPENDENCY_EDGES = 514;
const MIN_ISSUES_PER_MILESTONE = 6;
const MAX_ISSUES_PER_MILESTONE = 15;
const MAX_DEPENDENCY_DEPTH = 54;
const MIN_P1_ISSUES = 70;
const EXPECTED_ROOT_ISSUE_ID = "F-001";
const EXPECTED_ROADMAP_HORIZON = Object.freeze({
  start: "2026-08-23",
  end: "2031-07-31",
  years: 5,
  milestones: EXPECTED_MILESTONES,
  issues: EXPECTED_ISSUES,
});
const EXPECTED_MILESTONE_DUE_DATES = Object.freeze([
  "2026-10-31",
  "2027-01-31",
  "2027-04-30",
  "2027-07-31",
  "2027-10-31",
  "2028-01-31",
  "2028-04-30",
  "2028-07-31",
  "2028-10-31",
  "2029-01-31",
  "2029-04-30",
  "2029-07-31",
  "2029-10-31",
  "2030-01-31",
  "2030-04-30",
  "2030-07-31",
  "2030-10-31",
  "2031-01-31",
  "2031-04-30",
  "2031-07-31",
]);
const FORBIDDEN_PUBLIC_ISSUE_FIELDS = Object.freeze([
  "agent",
  "model",
  "status",
  "context",
]);
const MIN_ACCEPTANCE_CRITERIA = 2;
const MIN_OUTCOME_CHARACTERS = 40;
const MIN_CRITERION_CHARACTERS = 20;
const MAX_GH_OUTPUT_BYTES = 4 * 1024 * 1024;
const GH_TIMEOUT_MS = 30_000;
const GH_MUTATION_INTERVAL_MS = 1_050;
const GH_SECONDARY_RATE_LIMIT_MAX_ATTEMPTS = 8;
const GH_SECONDARY_RATE_LIMIT_INITIAL_DELAY_MS = 60_000;
const GH_SECONDARY_RATE_LIMIT_MAX_DELAY_MS = 15 * 60_000;
const POST_APPLY_VERIFY_MAX_ATTEMPTS = 5;
const POST_APPLY_VERIFY_RETRY_DELAY_MS = 500;
const NATIVE_DEPENDENCY_CONCURRENCY = 4;
const MAX_NATIVE_DEPENDENCY_ROWS_PER_ISSUE = 100;
const MAX_NATIVE_DEPENDENCY_ROWS_TOTAL = 10_000;
const ALLOWED_LABEL_CATEGORIES = new Set(["area", "type", "priority"]);
const ALLOWED_PRIORITIES = new Set(["P0", "P1", "P2"]);
const ALLOWED_STATES = new Set(["open"]);
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

const usage = `Usage:
  node scripts/github-roadmap.mjs validate
  node scripts/github-roadmap.mjs plan --repo OWNER/REPO
  node scripts/github-roadmap.mjs apply --repo OWNER/REPO --confirm

Commands:
  validate       Validate the local manifest without using GitHub.
  plan           Read GitHub state through gh and emit create/update/noop operations.
  apply          Apply managed labels, milestones, and issues; requires --confirm.

The default command and --help are non-mutating. apply never deletes unmarked resources.
`;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const normalizeText = (value) =>
  String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();

const unique = (values) => [...new Set(values)];

const truncate = (value, limit = 800) => {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
};

const markerFor = (kind, id) => `<!-- ${MANAGED_MARKER}:${kind}-id=${id} -->`;

const issueMarker = (id) => markerFor("issue", id);

const managedIssueMarker = (id) => markerFor("managed-issue", id);

const milestoneMarker = (id) => markerFor("milestone", id);

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function exactMarkerLineCount(text, marker) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => line === marker).length;
}

function hasExactMarkerLine(text, marker) {
  return exactMarkerLineCount(text, marker) === 1;
}

function hasMarkerMention(text, marker) {
  return String(text ?? "").includes(marker);
}

function normalizedLabelNames(values) {
  return unique(
    values.filter(nonEmptyString).map((value) => String(value)),
  ).sort();
}

function sameLabelSet(left, right) {
  return (
    JSON.stringify(normalizedLabelNames(left)) ===
    JSON.stringify(normalizedLabelNames(right))
  );
}

function isRealIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

function milestoneDueOn(milestone) {
  return `${milestone.dueOn}T23:59:59Z`;
}

function remoteDueOnDate(remoteMilestone) {
  const dueOn = remoteMilestone?.due_on;
  return typeof dueOn === "string" ? dueOn.slice(0, 10) : "";
}

function parseRepo(value) {
  if (typeof value !== "string" || !repoPattern.test(value)) {
    throw new Error(
      "--repo must be in OWNER/REPO form using only GitHub-safe characters",
    );
  }
  return value;
}

async function loadManifest() {
  let source;
  try {
    source = await readFile(MANIFEST_PATH, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read ${MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(
      `cannot parse ${MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function validateManifest(manifest) {
  const errors = [];
  const milestoneIds = new Set();
  const milestoneTitles = new Set();
  const issueIds = new Set();
  const issueTitles = new Set();
  const labelNames = new Set();
  const globalIds = new Set();
  const dependencyEdges = [];
  const issueCountsByMilestone = new Map();
  const issueCountsByPriority = new Map();
  let lastIssueMilestoneIndex = -1;

  if (!isRecord(manifest)) {
    return {
      errors: ["manifest root must be an object"],
      summary: { milestones: 0, labels: 0, issues: 0, dependencyEdges: 0 },
    };
  }

  if (manifest.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }
  if (!nonEmptyString(manifest.project))
    errors.push("project must be nonempty");
  if (manifest.managedMarker !== MANAGED_MARKER) {
    errors.push(`managedMarker must be ${MANAGED_MARKER}`);
  }
  if (manifest.defaultIssueState !== "open") {
    errors.push("defaultIssueState must be open");
  }
  if (!isRecord(manifest.roadmapHorizon)) {
    errors.push("roadmapHorizon must be an object");
  } else {
    for (const [field, expected] of Object.entries(EXPECTED_ROADMAP_HORIZON)) {
      if (manifest.roadmapHorizon[field] !== expected) {
        errors.push(`roadmapHorizon.${field} must be ${expected}`);
      }
    }
  }

  const milestones = Array.isArray(manifest.milestones)
    ? manifest.milestones
    : [];
  const labels = Array.isArray(manifest.labels) ? manifest.labels : [];
  const issues = Array.isArray(manifest.issues) ? manifest.issues : [];

  if (!Array.isArray(manifest.milestones))
    errors.push("milestones must be an array");
  if (!Array.isArray(manifest.labels)) errors.push("labels must be an array");
  if (!Array.isArray(manifest.issues)) errors.push("issues must be an array");
  if (milestones.length !== EXPECTED_MILESTONES) {
    errors.push(
      `expected exactly ${EXPECTED_MILESTONES} milestones, found ${milestones.length}`,
    );
  }
  if (labels.length !== EXPECTED_LABELS) {
    errors.push(
      `expected exactly ${EXPECTED_LABELS} labels, found ${labels.length}`,
    );
  }
  if (issues.length !== EXPECTED_ISSUES) {
    errors.push(
      `expected exactly ${EXPECTED_ISSUES} issues, found ${issues.length}`,
    );
  }

  for (const [index, milestone] of milestones.entries()) {
    const prefix = `milestones[${index}]`;
    if (!isRecord(milestone)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    for (const field of ["id", "title", "description", "dueOn"]) {
      if (!nonEmptyString(milestone[field]))
        errors.push(`${prefix}.${field} must be nonempty`);
    }
    if (nonEmptyString(milestone.dueOn) && !isRealIsoDate(milestone.dueOn)) {
      errors.push(
        `${prefix}.dueOn must be a real date in strict YYYY-MM-DD format`,
      );
    }
    if (
      milestones.length === EXPECTED_MILESTONES &&
      milestone.dueOn !== EXPECTED_MILESTONE_DUE_DATES[index]
    ) {
      errors.push(
        `${prefix}.dueOn must be ${EXPECTED_MILESTONE_DUE_DATES[index] ?? "within the five-year horizon"}`,
      );
    }
    if (!ALLOWED_STATES.has(milestone.state)) {
      errors.push(`${prefix}.state must be open`);
    }
    const expectedYear = Math.floor(index / 4) + 1;
    const expectedQuarter = (index % 4) + 1;
    const expectedId = `Y${expectedYear}-Q${expectedQuarter}`;
    if (milestone.id !== expectedId) {
      errors.push(`${prefix}.id must be ${expectedId}`);
    }
    if (
      nonEmptyString(milestone.title) &&
      !milestone.title.startsWith(`Year ${expectedYear} Q${expectedQuarter} —`)
    ) {
      errors.push(
        `${prefix}.title must begin with Year ${expectedYear} Q${expectedQuarter} —`,
      );
    }
    if (
      nonEmptyString(milestone.description) &&
      !milestone.description.includes("Exit gate:")
    ) {
      errors.push(`${prefix}.description must include an Exit gate`);
    }
    if (nonEmptyString(milestone.id)) {
      if (milestoneIds.has(milestone.id))
        errors.push(`duplicate milestone id: ${milestone.id}`);
      if (globalIds.has(milestone.id))
        errors.push(`duplicate id across manifest: ${milestone.id}`);
      milestoneIds.add(milestone.id);
      globalIds.add(milestone.id);
    }
    if (nonEmptyString(milestone.title)) {
      if (milestoneTitles.has(milestone.title)) {
        errors.push(`duplicate milestone title: ${milestone.title}`);
      }
      milestoneTitles.add(milestone.title);
    }
  }

  for (const [index, label] of labels.entries()) {
    const prefix = `labels[${index}]`;
    if (!isRecord(label)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    for (const field of ["name", "category", "description", "color"]) {
      if (!nonEmptyString(label[field]))
        errors.push(`${prefix}.${field} must be nonempty`);
    }
    if (nonEmptyString(label.name)) {
      if (labelNames.has(label.name))
        errors.push(`duplicate label name: ${label.name}`);
      labelNames.add(label.name);
      const [category] = label.name.split(":", 1);
      if (!ALLOWED_LABEL_CATEGORIES.has(category)) {
        errors.push(
          `label ${label.name} uses an unsupported category: ${category}`,
        );
      }
      if (label.category !== category) {
        errors.push(`label ${label.name} category must be ${category}`);
      }
    }
    if (nonEmptyString(label.color) && !/^[0-9A-Fa-f]{6}$/.test(label.color)) {
      errors.push(`${prefix}.color must be a six-digit hex color without #`);
    }
  }

  const milestoneIdSet = new Set(milestoneIds);
  const issueIdsSeen = new Set();
  const issueIndexById = new Map();
  for (const [index, issue] of issues.entries()) {
    if (isRecord(issue) && nonEmptyString(issue.id)) {
      issueIds.add(issue.id);
      issueIndexById.set(issue.id, index);
    }
  }
  for (const [index, issue] of issues.entries()) {
    const prefix = `issues[${index}]`;
    if (!isRecord(issue)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    for (const field of FORBIDDEN_PUBLIC_ISSUE_FIELDS) {
      if (Object.hasOwn(issue, field)) {
        errors.push(
          `${prefix}.${field} is internal metadata and must be omitted`,
        );
      }
    }
    for (const field of [
      "id",
      "title",
      "problemOutcome",
      "priority",
      "milestone",
      "state",
    ]) {
      if (!nonEmptyString(issue[field]))
        errors.push(`${prefix}.${field} must be nonempty`);
    }
    if (nonEmptyString(issue.id)) {
      if (issueIdsSeen.has(issue.id))
        errors.push(`duplicate issue id: ${issue.id}`);
      if (globalIds.has(issue.id))
        errors.push(`duplicate id across manifest: ${issue.id}`);
      issueIdsSeen.add(issue.id);
      globalIds.add(issue.id);
    }
    if (nonEmptyString(issue.title)) {
      if (issueTitles.has(issue.title))
        errors.push(`duplicate issue title: ${issue.title}`);
      issueTitles.add(issue.title);
    }
    if (
      nonEmptyString(issue.problemOutcome) &&
      issue.problemOutcome.trim().length < MIN_OUTCOME_CHARACTERS
    ) {
      errors.push(
        `${prefix}.problemOutcome must contain at least ${MIN_OUTCOME_CHARACTERS} characters`,
      );
    }
    if (!ALLOWED_PRIORITIES.has(issue.priority)) {
      errors.push(`${prefix}.priority must be one of P0, P1, P2`);
    } else {
      issueCountsByPriority.set(
        issue.priority,
        (issueCountsByPriority.get(issue.priority) ?? 0) + 1,
      );
    }
    if (issue.state !== manifest.defaultIssueState) {
      errors.push(
        `${prefix}.state must equal defaultIssueState (${manifest.defaultIssueState})`,
      );
    }
    if (!milestoneIdSet.has(issue.milestone)) {
      errors.push(
        `${prefix}.milestone references unknown milestone ${issue.milestone}`,
      );
    } else {
      const milestoneIndex = milestones.findIndex(
        (milestone) => milestone.id === issue.milestone,
      );
      issueCountsByMilestone.set(
        issue.milestone,
        (issueCountsByMilestone.get(issue.milestone) ?? 0) + 1,
      );
      if (milestoneIndex < lastIssueMilestoneIndex) {
        errors.push(
          `${prefix}.milestone must not move backward in the five-year sequence`,
        );
      }
      lastIssueMilestoneIndex = Math.max(
        lastIssueMilestoneIndex,
        milestoneIndex,
      );
    }
    if (
      !Array.isArray(issue.acceptanceCriteria) ||
      issue.acceptanceCriteria.length < MIN_ACCEPTANCE_CRITERIA
    ) {
      errors.push(
        `${prefix}.acceptanceCriteria must contain at least ${MIN_ACCEPTANCE_CRITERIA} criteria`,
      );
    } else {
      issue.acceptanceCriteria.forEach((criterion, criterionIndex) => {
        if (!nonEmptyString(criterion)) {
          errors.push(
            `${prefix}.acceptanceCriteria[${criterionIndex}] must be nonempty`,
          );
        } else if (criterion.trim().length < MIN_CRITERION_CHARACTERS) {
          errors.push(
            `${prefix}.acceptanceCriteria[${criterionIndex}] must contain at least ${MIN_CRITERION_CHARACTERS} characters`,
          );
        }
      });
    }
    if (!Array.isArray(issue.dependencies)) {
      errors.push(`${prefix}.dependencies must be an array`);
    } else {
      const seenDependencies = new Set();
      if (
        issue.id === EXPECTED_ROOT_ISSUE_ID &&
        issue.dependencies.length !== 0
      ) {
        errors.push(`${prefix} root issue must not have dependencies`);
      }
      if (
        issue.id !== EXPECTED_ROOT_ISSUE_ID &&
        issue.dependencies.length === 0
      ) {
        errors.push(`${prefix} must depend on at least one earlier issue`);
      }
      for (const dependency of issue.dependencies) {
        if (!nonEmptyString(dependency)) {
          errors.push(`${prefix}.dependencies contains an empty ID`);
          continue;
        }
        if (seenDependencies.has(dependency)) {
          errors.push(`${prefix} repeats dependency ${dependency}`);
        }
        seenDependencies.add(dependency);
        dependencyEdges.push([issue.id, dependency]);
        if (dependency === issue.id)
          errors.push(`${prefix} cannot depend on itself`);
        if (!issueIds.has(dependency)) {
          errors.push(`${prefix} references unknown issue ${dependency}`);
        } else if (issueIndexById.get(dependency) >= index) {
          errors.push(
            `${prefix} dependency ${dependency} must appear earlier in manifest order`,
          );
        }
      }
    }
    if (!Array.isArray(issue.labels) || issue.labels.length === 0) {
      errors.push(`${prefix}.labels must contain at least one label`);
    } else {
      const seenLabels = new Set();
      const seenLabelCategories = new Set();
      for (const labelName of issue.labels) {
        if (!nonEmptyString(labelName)) {
          errors.push(`${prefix}.labels contains an empty label`);
          continue;
        }
        if (seenLabels.has(labelName))
          errors.push(`${prefix} repeats label ${labelName}`);
        seenLabels.add(labelName);
        if (!labelNames.has(labelName))
          errors.push(`${prefix} references unknown label ${labelName}`);
        const [category] = labelName.split(":", 1);
        seenLabelCategories.add(category);
        if (!ALLOWED_LABEL_CATEGORIES.has(category)) {
          errors.push(`${prefix} uses unsupported label category ${category}`);
        }
      }
      if (!issue.labels.includes(`priority:${issue.priority}`)) {
        errors.push(`${prefix}.labels must include priority:${issue.priority}`);
      }
      for (const requiredCategory of ALLOWED_LABEL_CATEGORIES) {
        if (!seenLabelCategories.has(requiredCategory)) {
          errors.push(
            `${prefix}.labels must include a ${requiredCategory}: label`,
          );
        }
      }
    }
  }

  for (const milestone of milestones) {
    const count = issueCountsByMilestone.get(milestone.id) ?? 0;
    if (count < MIN_ISSUES_PER_MILESTONE) {
      errors.push(
        `milestone ${milestone.id} must contain at least ${MIN_ISSUES_PER_MILESTONE} issue, found ${count}`,
      );
    }
    if (count > MAX_ISSUES_PER_MILESTONE) {
      errors.push(
        `milestone ${milestone.id} must contain at most ${MAX_ISSUES_PER_MILESTONE} issues, found ${count}`,
      );
    }
  }

  if (dependencyEdges.length !== EXPECTED_DEPENDENCY_EDGES) {
    errors.push(
      `expected exactly ${EXPECTED_DEPENDENCY_EDGES} dependency edges, found ${dependencyEdges.length}`,
    );
  }
  if ((issueCountsByPriority.get("P1") ?? 0) < MIN_P1_ISSUES) {
    errors.push(`expected at least ${MIN_P1_ISSUES} P1 issues`);
  }

  if (issueIds.size > 0) {
    const dependenciesByIssue = new Map([...issueIds].map((id) => [id, []]));
    for (const [issueId, dependency] of dependencyEdges) {
      if (dependenciesByIssue.has(issueId) && issueIds.has(dependency)) {
        dependenciesByIssue.get(issueId).push(dependency);
      }
    }
    const visiting = new Set();
    const visited = new Set();
    const stack = [];
    const visit = (id) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        const cycleStart = stack.indexOf(id);
        const cycle = [...stack.slice(cycleStart), id].join(" -> ");
        errors.push(`dependency cycle: ${cycle}`);
        return;
      }
      visiting.add(id);
      stack.push(id);
      for (const dependency of dependenciesByIssue.get(id) ?? [])
        visit(dependency);
      stack.pop();
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of issueIds) visit(id);

    const dependencyDepthByIssue = new Map();
    for (const issue of issues) {
      if (!isRecord(issue) || !nonEmptyString(issue.id)) continue;
      const dependencies = Array.isArray(issue.dependencies)
        ? issue.dependencies
        : [];
      const knownDepths = dependencies
        .map((dependency) => dependencyDepthByIssue.get(dependency))
        .filter(Number.isSafeInteger);
      dependencyDepthByIssue.set(
        issue.id,
        1 + (knownDepths.length > 0 ? Math.max(...knownDepths) : 0),
      );
    }
    const dependencyDepth = Math.max(0, ...dependencyDepthByIssue.values());
    if (dependencyDepth > MAX_DEPENDENCY_DEPTH) {
      errors.push(
        `dependency depth must be at most ${MAX_DEPENDENCY_DEPTH}, found ${dependencyDepth}`,
      );
    }
  }

  return {
    errors,
    summary: {
      milestones: milestones.length,
      labels: labels.length,
      issues: issues.length,
      dependencyEdges: dependencyEdges.length,
    },
  };
}

function validationFailure(result) {
  if (result.errors.length === 0) return null;
  return new Error(
    `manifest validation failed:\n${result.errors.map((error) => `- ${error}`).join("\n")}`,
  );
}

function printValidation(result) {
  if (result.errors.length > 0) {
    process.stderr.write(`${validationFailure(result).message}\n`);
    return;
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        manifest: MANIFEST_PATH,
        counts: result.summary,
      },
      null,
      2,
    )}\n`,
  );
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? "help";
  const options = { repo: null, confirm: false };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--confirm") {
      options.confirm = true;
      continue;
    }
    if (argument === "--repo") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--repo requires OWNER/REPO");
      }
      options.repo = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--repo=")) {
      options.repo = argument.slice("--repo=".length);
      continue;
    }
    if (argument.startsWith("-"))
      throw new Error(`unknown option: ${argument}`);
    positional.push(argument);
  }

  if (positional.length > 0)
    throw new Error(`unexpected argument: ${positional[0]}`);
  return { command, options };
}

function assertRepoOption(command, options) {
  if (options.repo === null)
    throw new Error(`${command} requires --repo OWNER/REPO`);
  return parseRepo(options.repo);
}

function appendBounded(buffer, chunk, maxBytes) {
  const next = Buffer.concat([
    buffer,
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
  ]);
  if (next.length > maxBytes)
    return { buffer: next.subarray(0, maxBytes), overflow: true };
  return { buffer: next, overflow: false };
}

function runGh(args, input = undefined) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    let settled = false;
    const child = spawn("gh", args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      if (!settled) child.kill("SIGTERM");
    }, GH_TIMEOUT_MS);

    const settleError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(error);
    };

    child.once("error", (error) => {
      settleError(new Error(`could not execute gh: ${error.message}`));
    });
    child.stdout.on("data", (chunk) => {
      const result = appendBounded(stdout, chunk, MAX_GH_OUTPUT_BYTES);
      stdout = result.buffer;
      overflow ||= result.overflow;
      if (overflow) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      const result = appendBounded(stderr, chunk, MAX_GH_OUTPUT_BYTES);
      stderr = result.buffer;
      overflow ||= result.overflow;
      if (overflow) child.kill("SIGTERM");
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (overflow) {
        rejectPromise(
          new Error(`gh output exceeded ${MAX_GH_OUTPUT_BYTES} bytes`),
        );
        return;
      }
      if (code !== 0) {
        const stderrText = stderr.toString("utf8");
        const detail = truncate(stderrText.trim());
        const suffix = detail.length > 0 ? `: ${detail}` : "";
        const commandError = new Error(
          `gh ${args.join(" ")} failed with ${signal ?? `exit ${code}`}${suffix}`,
        );
        commandError.ghStdout = stdout.toString("utf8");
        commandError.ghStderr = stderrText;
        commandError.ghExitCode = code;
        rejectPromise(commandError);
        return;
      }
      resolvePromise(stdout.toString("utf8"));
    });

    if (input === undefined) child.stdin.end();
    else child.stdin.end(JSON.stringify(input));
  });
}

async function ghJson(args, input, context) {
  const output = await runGh(args, input);
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(
      `${context} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function parseIncludedGhResponse(output, context = "gh api --include") {
  if (typeof output !== "string") {
    throw new Error(`${context} returned a non-string response`);
  }
  const boundary = /\r?\n\r?\n/u.exec(output);
  if (!boundary) throw new Error(`${context} returned no HTTP header block`);
  const headerBlock = output.slice(0, boundary.index);
  const body = output.slice(boundary.index + boundary[0].length);
  const [statusLine, ...headerLines] = headerBlock.split(/\r?\n/u);
  const statusMatch = statusLine.match(/^HTTP\/\S+\s+(\d{3})(?:\s|$)/u);
  if (!statusMatch) throw new Error(`${context} returned no HTTP status line`);
  const statusCode = Number(statusMatch[1]);
  const headers = {};
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error(`${context} returned a malformed HTTP header`);
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = Object.hasOwn(headers, name)
      ? `${headers[name]}, ${value}`
      : value;
  }
  return { body, headers, statusCode, statusLine };
}

async function ghJsonWithHeaders(args, input, context) {
  let output;
  try {
    output = await runGh(args, input);
  } catch (error) {
    if (error instanceof Error && typeof error.ghStdout === "string") {
      try {
        error.ghResponse = parseIncludedGhResponse(
          error.ghStdout,
          `${context} error response`,
        );
      } catch {
        // Preserve the original command failure when GitHub emitted no headers.
      }
    }
    throw error;
  }
  const response = parseIncludedGhResponse(output, context);
  try {
    return {
      data: JSON.parse(response.body),
      response,
    };
  } catch (error) {
    throw new Error(
      `${context} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function flattenPaginated(value) {
  if (!Array.isArray(value)) return [];
  if (value.every((page) => Array.isArray(page))) return value.flat();
  return value;
}

function flattenPaginatedStrict(value, context) {
  if (!Array.isArray(value)) {
    throw new Error(`${context} returned a non-array response`);
  }
  const rows = value.every((page) => Array.isArray(page))
    ? value.flat()
    : value;
  if (!rows.every(isRecord)) {
    throw new Error(`${context} returned a malformed row`);
  }
  return rows;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nativeIssueIdentity(issue, context) {
  const number = issue?.number;
  const id = issue?.id;
  if (!positiveSafeInteger(number)) {
    throw new Error(`${context} has no valid GitHub issue number`);
  }
  if (!positiveSafeInteger(id)) {
    throw new Error(`${context} has no valid GitHub issue database ID`);
  }
  return { number, id };
}

function nativeBlockedByRows(value, context) {
  const rows = flattenPaginatedStrict(value, context);
  if (rows.length > MAX_NATIVE_DEPENDENCY_ROWS_PER_ISSUE) {
    throw new Error(
      `${context} returned more than ${MAX_NATIVE_DEPENDENCY_ROWS_PER_ISSUE} rows`,
    );
  }
  const seen = new Set();
  return rows.map((row, index) => {
    const identity = nativeIssueIdentity(row, `${context} row ${index + 1}`);
    if (seen.has(identity.id)) {
      throw new Error(
        `${context} returned duplicate blocker database ID ${identity.id}`,
      );
    }
    seen.add(identity.id);
    return identity;
  });
}

async function fetchNativeBlockedBy(repo, issueNumber, context) {
  const raw = await ghJson(
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/issues/${issueNumber}/dependencies/blocked_by?per_page=100`,
    ],
    undefined,
    context,
  );
  return nativeBlockedByRows(raw, context);
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  };
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function blockedByRecords(state) {
  const records = state?.blockedBy;
  if (records === undefined || records === null) return [];
  if (Array.isArray(records)) {
    if (!records.every(isRecord)) {
      throw new Error("blocked_by discovery state contains a malformed record");
    }
    return records;
  }
  if (records instanceof Map) {
    const normalized = [...records.entries()].map(([key, blockers]) =>
      positiveSafeInteger(key)
        ? { issueNumber: key, blockers }
        : { issueId: key, blockers },
    );
    if (!normalized.every(isRecord)) {
      throw new Error("blocked_by discovery state contains a malformed record");
    }
    return normalized;
  }
  if (isRecord(records)) {
    const normalized = Object.entries(records).map(([key, blockers]) =>
      /^\d+$/u.test(key)
        ? { issueNumber: Number(key), blockers }
        : { issueId: key, blockers },
    );
    if (!normalized.every(isRecord)) {
      throw new Error("blocked_by discovery state contains a malformed record");
    }
    return normalized;
  }
  throw new Error("blocked_by discovery state must be an array or object");
}

function blockersForIssue(state, issue, remote) {
  const records = blockedByRecords(state);
  const record = records.find(
    (candidate) =>
      candidate?.issueId === issue.id ||
      (remote?.number !== undefined &&
        candidate?.issueNumber === remote.number),
  );
  if (!record) {
    if (remote && issue.dependencies.length > 0) {
      throw new Error(
        `blocked_by state for ${issue.id} was not discovered; refusing to assume an empty relationship set`,
      );
    }
    return [];
  }
  if (
    record.issueNumber !== undefined &&
    !positiveSafeInteger(record.issueNumber)
  ) {
    throw new Error(
      `blocked_by state for ${issue.id} has an invalid issue number`,
    );
  }
  if (
    remote?.number !== undefined &&
    record.issueNumber !== undefined &&
    record.issueNumber !== remote.number
  ) {
    throw new Error(
      `blocked_by state for ${issue.id} has a mismatched issue number`,
    );
  }
  if (!Array.isArray(record.blockers)) {
    throw new Error(`blocked_by state for ${issue.id} is not an array`);
  }
  return nativeBlockedByRows(
    record.blockers,
    `blocked_by state for ${issue.id}`,
  );
}

async function fetchGithubState(repo, manifest = null) {
  const [labels, milestones, issues] = await Promise.all([
    ghJson(
      ["api", "--paginate", "--slurp", `repos/${repo}/labels?per_page=100`],
      undefined,
      "label discovery",
    ),
    ghJson(
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repo}/milestones?state=all&per_page=100`,
      ],
      undefined,
      "milestone discovery",
    ),
    ghJson(
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repo}/issues?state=all&per_page=100`,
      ],
      undefined,
      "issue discovery",
    ),
  ]);

  const state = {
    labels: flattenPaginated(labels),
    milestones: flattenPaginated(milestones),
    issues: flattenPaginated(issues).filter((issue) => !issue.pull_request),
  };

  if (!manifest) return state;

  const milestoneById = managedMilestones(manifest, state.milestones);
  const issueById = managedIssues(
    manifest,
    state.issues,
    managedMilestoneNumbers(milestoneById),
  );
  const managedRemoteIssues = manifest.issues
    .map((issue) => ({ issue, remote: issueById.get(issue.id) }))
    .filter(
      ({ issue, remote }) => remote !== null && issue.dependencies.length > 0,
    );
  const blockedBy = await mapWithConcurrency(
    managedRemoteIssues,
    NATIVE_DEPENDENCY_CONCURRENCY,
    async ({ issue, remote }) => {
      const identity = nativeIssueIdentity(remote, `managed issue ${issue.id}`);
      return {
        issueId: issue.id,
        issueNumber: identity.number,
        blockers: await fetchNativeBlockedBy(
          repo,
          identity.number,
          `blocked_by discovery for ${issue.id}`,
        ),
      };
    },
  );
  const totalRows = blockedBy.reduce(
    (total, record) => total + record.blockers.length,
    0,
  );
  if (totalRows > MAX_NATIVE_DEPENDENCY_ROWS_TOTAL) {
    throw new Error(
      `blocked_by discovery returned more than ${MAX_NATIVE_DEPENDENCY_ROWS_TOTAL} rows`,
    );
  }

  return { ...state, blockedBy };
}

function managedMilestones(manifest, remoteMilestones) {
  const byId = new Map();
  for (const milestone of manifest.milestones) {
    const marker = milestoneMarker(milestone.id);
    const exactMatches = remoteMilestones.filter((candidate) =>
      hasExactMarkerLine(candidate.description, marker),
    );
    const nearMatches = remoteMilestones.filter(
      (candidate) =>
        hasMarkerMention(candidate.description, marker) &&
        !hasExactMarkerLine(candidate.description, marker),
    );
    if (nearMatches.length > 0) {
      throw new Error(
        `ownership marker collision for milestone ${milestone.id}`,
      );
    }
    const matches = exactMatches;
    if (matches.length > 1) {
      throw new Error(`multiple remote milestones match ${milestone.id}`);
    }
    byId.set(milestone.id, matches[0] ?? null);
  }
  return byId;
}

function managedMilestoneNumbers(milestoneById) {
  return new Set(
    [...milestoneById.values()]
      .map((milestone) => milestone?.number)
      .filter(Number.isInteger),
  );
}

function managedIssues(manifest, remoteIssues, milestoneNumbers) {
  const byId = new Map();
  for (const issue of manifest.issues) {
    const marker = issueMarker(issue.id);
    const ownershipCandidates = remoteIssues.filter(
      (candidate) =>
        hasMarkerMention(candidate.body, marker) &&
        (milestoneNumbers.has(candidate.milestone?.number) ||
          TRUSTED_AUTHOR_ASSOCIATIONS.has(candidate.author_association)),
    );
    const exactMatches = ownershipCandidates.filter((candidate) =>
      hasExactMarkerLine(candidate.body, marker),
    );
    const nearMatches = ownershipCandidates.filter(
      (candidate) => !hasExactMarkerLine(candidate.body, marker),
    );
    if (nearMatches.length > 0) {
      throw new Error(`ownership marker collision for ${issue.id}`);
    }
    const duplicateLine = ownershipCandidates.find(
      (candidate) => exactMarkerLineCount(candidate.body, marker) > 1,
    );
    if (duplicateLine) {
      throw new Error(`duplicate ownership marker for ${issue.id}`);
    }
    const matches = exactMatches;
    if (matches.length > 1) {
      throw new Error(`multiple remote issues match ${issue.id}`);
    }
    if (matches.length === 1) {
      const candidate = matches[0];
      const hasManagedMetadata =
        hasExactMarkerLine(candidate.body, managedIssueMarker(issue.id)) ||
        hasExactMarkerLine(candidate.body, `- Roadmap ID: ${issue.id}`);
      const hasManagedTitle =
        typeof candidate.title === "string" &&
        candidate.title.startsWith(`[${issue.id}] `);
      if (!hasManagedMetadata || !hasManagedTitle) {
        throw new Error(
          `remote issue does not have managed title metadata for ${issue.id}`,
        );
      }
      if (!milestoneNumbers.has(candidate.milestone?.number)) {
        throw new Error(
          `remote issue is not bound to a managed milestone for ${issue.id}`,
        );
      }
    }
    byId.set(issue.id, matches[0] ?? null);
  }
  return byId;
}

function milestoneDescription(milestone) {
  return `${milestoneMarker(milestone.id)}\n\n${milestone.description}`;
}

function labelMap(remoteLabels) {
  return new Map(
    remoteLabels
      .filter((label) => nonEmptyString(label.name))
      .map((label) => [label.name, label]),
  );
}

function issueLabelNames(remoteIssue) {
  if (!remoteIssue || !Array.isArray(remoteIssue.labels)) return [];
  return remoteIssue.labels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(nonEmptyString);
}

function desiredIssueLabels(manifestIssue, remoteIssue, managedLabelNames) {
  const existingUnmanaged = issueLabelNames(remoteIssue).filter(
    (label) => !managedLabelNames.has(label),
  );
  return normalizedLabelNames([...existingUnmanaged, ...manifestIssue.labels]);
}

function checkedAcceptanceCriteria(body) {
  const section = String(body ?? "").match(
    /## Acceptance criteria\s*\n([\s\S]*?)(?:\n## Dependencies|$)/u,
  )?.[1];
  if (!section) return new Set();
  return new Set(
    [...section.matchAll(/^- \[[xX]\] (.+)$/gmu)].map((match) =>
      match[1].trim(),
    ),
  );
}

function bodyForIssue(
  issue,
  milestone,
  repo,
  issueNumbers,
  linkDependencies,
  currentBody = "",
) {
  const dependencies =
    issue.dependencies.length === 0
      ? "- None."
      : issue.dependencies
          .map((dependency) => {
            const number = issueNumbers.get(dependency);
            if (linkDependencies && number !== undefined) {
              return `- [${dependency}](https://github.com/${repo}/issues/${number})`;
            }
            return `- ${dependency}`;
          })
          .join("\n");
  const checkedCriteria = checkedAcceptanceCriteria(currentBody);
  const criteria = issue.acceptanceCriteria
    .map(
      (criterion) =>
        `- [${checkedCriteria.has(criterion) ? "x" : " "}] ${criterion}`,
    )
    .join("\n");
  return [
    issueMarker(issue.id),
    managedIssueMarker(issue.id),
    markerFor("milestone", issue.milestone),
    "",
    "## Problem / outcome",
    issue.problemOutcome,
    "",
    "## Acceptance criteria",
    criteria,
    "",
    "## Dependencies",
    dependencies,
    "",
    "## Managed metadata",
    `- Roadmap ID: ${issue.id}`,
    `- Priority: ${issue.priority}`,
    `- Initial state: ${issue.state}`,
    `- Milestone: ${milestone.title}`,
    "",
  ].join("\n");
}

function issueTitle(issue) {
  return `[${issue.id}] ${issue.title}`;
}

function issueNumberMap(manifest, managed) {
  const map = new Map();
  for (const issue of manifest.issues) {
    const remote = managed.get(issue.id);
    if (remote?.number !== undefined) map.set(issue.id, remote.number);
  }
  return map;
}

function changesForIssue(issue, remote, milestoneNumber, labels) {
  if (!remote) {
    return {
      title: issueTitle(issue),
      labels,
      milestone: milestoneNumber,
      state: "open",
      bodyMode:
        issue.dependencies.length === 0
          ? "final"
          : "dependency-ids-before-second-pass",
    };
  }
  const changes = {};
  if (remote.title !== issueTitle(issue))
    changes.title = { from: remote.title, to: issueTitle(issue) };
  const currentLabels = normalizedLabelNames(issueLabelNames(remote));
  if (!sameLabelSet(currentLabels, labels)) {
    changes.labels = { from: currentLabels, to: labels };
  }
  const currentMilestone = remote.milestone?.number ?? null;
  if (currentMilestone !== milestoneNumber) {
    changes.milestone = { from: currentMilestone, to: milestoneNumber };
  }
  return changes;
}

function nativeDependencyOperationId(issueId, dependencyId) {
  return `${issueId}->${dependencyId}`;
}

function nativeDependencyOperations(manifest, issueById, state) {
  const operations = [];
  for (const issue of manifest.issues) {
    const dependent = issueById.get(issue.id);
    const currentBlockers = dependent
      ? blockersForIssue(state, issue, dependent)
      : [];
    const currentBlockerIds = new Set(
      currentBlockers.map((blocker) => blocker.id),
    );
    for (const dependency of issue.dependencies) {
      const blocker = issueById.get(dependency);
      if (dependent) {
        nativeIssueIdentity(dependent, `managed issue ${issue.id}`);
      }
      if (blocker) {
        nativeIssueIdentity(blocker, `managed issue ${dependency}`);
      }
      const present = blocker !== null && currentBlockerIds.has(blocker.id);
      operations.push({
        phase: "native-dependencies",
        resource: "blocked_by",
        action: present ? "noop" : "create",
        id: nativeDependencyOperationId(issue.id, dependency),
        changes: {
          dependent: issue.id,
          blockedBy: dependency,
          issueNumber: dependent?.number ?? null,
          issueDatabaseId: dependent?.id ?? null,
          blockedByNumber: blocker?.number ?? null,
          blockedByDatabaseId: blocker?.id ?? null,
        },
      });
    }
  }
  return operations;
}

function buildPlan(manifest, state, repo) {
  const operations = [];
  const labelByName = labelMap(state.labels);
  const milestoneById = managedMilestones(manifest, state.milestones);
  const issueById = managedIssues(
    manifest,
    state.issues,
    managedMilestoneNumbers(milestoneById),
  );
  const issueNumbers = issueNumberMap(manifest, issueById);
  const issueIndexById = new Map(
    manifest.issues.map((issue, index) => [issue.id, index]),
  );
  const managedLabelNames = new Set(manifest.labels.map((label) => label.name));

  for (const label of manifest.labels) {
    const remote = labelByName.get(label.name);
    if (!remote) {
      operations.push({
        phase: "ensure",
        resource: "label",
        action: "create",
        id: label.name,
        changes: {
          name: label.name,
          color: label.color,
          description: label.description,
        },
      });
      continue;
    }
    const changes = {};
    if (
      String(remote.color ?? "").toUpperCase() !== label.color.toUpperCase()
    ) {
      changes.color = { from: remote.color, to: label.color };
    }
    if (String(remote.description ?? "") !== label.description) {
      changes.description = {
        from: remote.description ?? "",
        to: label.description,
      };
    }
    operations.push({
      phase: "ensure",
      resource: "label",
      action: Object.keys(changes).length > 0 ? "update" : "noop",
      id: label.name,
      changes,
    });
  }

  const milestoneNumbers = new Map();
  for (const milestone of manifest.milestones) {
    const remote = milestoneById.get(milestone.id);
    if (remote?.number !== undefined)
      milestoneNumbers.set(milestone.id, remote.number);
    if (!remote) {
      operations.push({
        phase: "ensure",
        resource: "milestone",
        action: "create",
        id: milestone.id,
        changes: {
          title: milestone.title,
          description: milestoneDescription(milestone),
          due_on: milestoneDueOn(milestone),
          state: "open",
        },
      });
      continue;
    }
    const changes = {};
    if (remote.title !== milestone.title)
      changes.title = { from: remote.title, to: milestone.title };
    if (
      normalizeText(remote.description) !==
      normalizeText(milestoneDescription(milestone))
    ) {
      changes.description = {
        from: remote.description ?? "",
        to: milestoneDescription(milestone),
      };
    }
    if (remoteDueOnDate(remote) !== milestone.dueOn) {
      changes.due_on = {
        from: remote.due_on ?? null,
        to: milestoneDueOn(milestone),
      };
    }
    operations.push({
      phase: "ensure",
      resource: "milestone",
      action: Object.keys(changes).length > 0 ? "update" : "noop",
      id: milestone.id,
      changes,
    });
  }

  for (const issue of manifest.issues) {
    const remote = issueById.get(issue.id);
    const milestoneNumber = milestoneNumbers.get(issue.milestone) ?? null;
    const labels = desiredIssueLabels(issue, remote, managedLabelNames);
    const changes = changesForIssue(issue, remote, milestoneNumber, labels);
    operations.push({
      phase: "ensure",
      resource: "issue",
      action: remote
        ? Object.keys(changes).length > 0
          ? "update"
          : "noop"
        : "create",
      id: issue.id,
      title: issueTitle(issue),
      changes,
    });

    const desiredBody = bodyForIssue(
      issue,
      manifest.milestones.find((milestone) => milestone.id === issue.milestone),
      repo,
      issueNumbers,
      true,
      remote?.body,
    );
    const currentBody = normalizeText(remote?.body);
    const dependencyTargetWillBeCreated = issue.dependencies.some(
      (dependency) =>
        issueById.get(dependency) === null &&
        issueIndexById.get(dependency) > issueIndexById.get(issue.id),
    );
    const bodyChanged = remote
      ? remote.state !== "closed" &&
        (currentBody !== normalizeText(desiredBody) ||
          dependencyTargetWillBeCreated)
      : dependencyTargetWillBeCreated;
    operations.push({
      phase: "dependencies",
      resource: "issue",
      action: bodyChanged ? "update" : "noop",
      id: issue.id,
      title: issueTitle(issue),
      changes: {
        body: bodyChanged
          ? "managed body or dependency links differ"
          : "managed body is current",
        dependencyCount: issue.dependencies.length,
        dependencyTargetWillBeCreated,
      },
    });
  }

  operations.push(...nativeDependencyOperations(manifest, issueById, state));

  return {
    operations,
    milestoneById,
    issueById,
    milestoneNumbers,
    issueNumbers,
    labelByName,
  };
}

function operationCounts(operations) {
  return operations.reduce(
    (counts, operation) => {
      counts[operation.action] = (counts[operation.action] ?? 0) + 1;
      return counts;
    },
    { create: 0, update: 0, noop: 0 },
  );
}

function printPlan(repo, plan) {
  process.stdout.write(
    `${JSON.stringify(
      {
        command: "plan",
        repo,
        counts: operationCounts(plan.operations),
        operations: plan.operations,
      },
      null,
      2,
    )}\n`,
  );
}

let lastGhMutationAt = 0;

function responseStatusCode(error) {
  if (!(error instanceof Error)) return null;
  if (Number.isInteger(error.ghResponse?.statusCode))
    return error.ghResponse.statusCode;
  const match = error.message.match(/HTTP\s+(\d{3})/iu);
  return match ? Number(match[1]) : null;
}

function responseHeader(error, name) {
  if (!(error instanceof Error)) return null;
  const value = error.ghResponse?.headers?.[name.toLowerCase()];
  return typeof value === "string" ? value : null;
}

function responseText(error) {
  if (!(error instanceof Error)) return "";
  return [error.message, error.ghStderr, error.ghResponse?.body]
    .filter((value) => typeof value === "string")
    .join("\n");
}

function retryAfterMilliseconds(error) {
  const headerValue = responseHeader(error, "retry-after");
  if (headerValue !== null) {
    const seconds = Number(headerValue.trim());
    if (Number.isSafeInteger(seconds) && seconds >= 0) return seconds * 1_000;
  }
  const source = headerValue ?? responseText(error);
  const match = source.match(
    /(?:retry-after\s*:\s*|retry after\s+)(\d+)(?:\s+seconds?)?/iu,
  );
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  return seconds * 1_000;
}

function rateLimitResetMilliseconds(error, now = Date.now()) {
  const remaining = responseHeader(error, "x-ratelimit-remaining");
  const reset = Number(responseHeader(error, "x-ratelimit-reset"));
  if (remaining !== "0" || !Number.isSafeInteger(reset)) return null;
  return Math.max(0, reset * 1_000 - now);
}

function isSecondaryRateLimitError(error) {
  const statusCode = responseStatusCode(error);
  if (statusCode === 429) return true;
  if (statusCode !== 403) return false;
  const hasServerCooldown =
    retryAfterMilliseconds(error) !== null ||
    rateLimitResetMilliseconds(error) !== null;
  return (
    hasServerCooldown ||
    /secondary rate limit|temporarily blocked from content creation/iu.test(
      responseText(error),
    )
  );
}

async function withSecondaryRateLimitRetry(operation, context, runtime = {}) {
  const pause =
    runtime.pause ??
    ((milliseconds) =>
      new Promise((resolvePromise) =>
        setTimeout(resolvePromise, milliseconds),
      ));
  const maxAttempts =
    runtime.maxAttempts ?? GH_SECONDARY_RATE_LIMIT_MAX_ATTEMPTS;
  const initialDelayMs =
    runtime.initialDelayMs ?? GH_SECONDARY_RATE_LIMIT_INITIAL_DELAY_MS;
  const maxDelayMs = runtime.maxDelayMs ?? GH_SECONDARY_RATE_LIMIT_MAX_DELAY_MS;
  const now = runtime.now ?? Date.now;
  const onRetry =
    runtime.onRetry ??
    (({ delayMs, nextAttempt }) => {
      process.stderr.write(
        `GitHub rate limit while attempting ${context}; retrying in ${Math.ceil(delayMs / 1_000)}s (${nextAttempt}/${maxAttempts}).\n`,
      );
    });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSecondaryRateLimitError(error) || attempt === maxAttempts) {
        throw error;
      }
      const exponentialDelay = Math.min(
        maxDelayMs,
        initialDelayMs * 2 ** (attempt - 1),
      );
      const delayMs =
        retryAfterMilliseconds(error) ??
        rateLimitResetMilliseconds(error, now()) ??
        exponentialDelay;
      onRetry({
        attempt,
        context,
        delayMs,
        error,
        maxAttempts,
        nextAttempt: attempt + 1,
      });
      await pause(delayMs);
    }
  }

  throw new Error(`secondary rate-limit retry loop exhausted for ${context}`);
}

async function ghMutation(method, endpoint, payload, context) {
  return withSecondaryRateLimitRetry(async () => {
    const waitMilliseconds = Math.max(
      0,
      GH_MUTATION_INTERVAL_MS - (Date.now() - lastGhMutationAt),
    );
    if (waitMilliseconds > 0) {
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, waitMilliseconds),
      );
    }
    lastGhMutationAt = Date.now();
    const response = await ghJsonWithHeaders(
      ["api", "--include", "--method", method, "--input", "-", endpoint],
      payload,
      context,
    );
    return response.data;
  }, context);
}

function isRetryablePostApplyVerificationError(error) {
  if (!(error instanceof Error)) return false;
  return (
    /^managed (?:milestone|issue) .+ was not found after first pass$/u.test(
      error.message,
    ) ||
    /^remote issue is not bound to a managed milestone for .+$/u.test(
      error.message,
    )
  );
}

async function applyNativeDependencies(
  manifest,
  repo,
  issueById,
  state,
  mutate,
  fetchBlockedBy,
  applied,
) {
  const blockerIdsByIssue = new Map();
  for (const issue of manifest.issues) {
    const dependent = issueById.get(issue.id);
    if (!dependent) {
      throw new Error(
        `managed issue ${issue.id} was not found before native dependencies`,
      );
    }
    const identity = nativeIssueIdentity(
      dependent,
      `managed issue ${issue.id}`,
    );
    blockerIdsByIssue.set(
      issue.id,
      new Set(
        blockersForIssue(state, issue, dependent).map((blocker) => blocker.id),
      ),
    );
    for (const dependency of issue.dependencies) {
      const blocker = issueById.get(dependency);
      if (!blocker) {
        throw new Error(
          `managed dependency ${dependency} was not found before native dependencies for ${issue.id}`,
        );
      }
      const blockerIdentity = nativeIssueIdentity(
        blocker,
        `managed issue ${dependency}`,
      );
      const existingBlockers = blockerIdsByIssue.get(issue.id);
      if (existingBlockers.has(blockerIdentity.id)) {
        applied.push({
          phase: "native-dependencies",
          resource: "blocked_by",
          action: "noop",
          id: nativeDependencyOperationId(issue.id, dependency),
        });
        continue;
      }
      try {
        await mutate(
          "POST",
          `repos/${repo}/issues/${identity.number}/dependencies/blocked_by`,
          { issue_id: blockerIdentity.id },
          `add blocked_by ${issue.id} <- ${dependency}`,
        );
      } catch (error) {
        if (isSecondaryRateLimitError(error)) throw error;
        let observedAfterFailure;
        try {
          observedAfterFailure = await fetchBlockedBy(
            repo,
            identity.number,
            `verify blocked_by race for ${issue.id}`,
          );
        } catch {
          throw error;
        }
        if (
          !observedAfterFailure.some(
            (candidate) => candidate.id === blockerIdentity.id,
          )
        ) {
          throw error;
        }
        existingBlockers.add(blockerIdentity.id);
        applied.push({
          phase: "native-dependencies",
          resource: "blocked_by",
          action: "noop",
          id: nativeDependencyOperationId(issue.id, dependency),
        });
        continue;
      }
      existingBlockers.add(blockerIdentity.id);
      applied.push({
        phase: "native-dependencies",
        resource: "blocked_by",
        action: "create",
        id: nativeDependencyOperationId(issue.id, dependency),
      });
    }
  }
}

function verifyPostApplyState(manifest, refreshed) {
  const refreshedMilestones = managedMilestones(manifest, refreshed.milestones);
  for (const milestone of manifest.milestones) {
    if (!refreshedMilestones.get(milestone.id)) {
      throw new Error(
        `managed milestone ${milestone.id} was not found after first pass`,
      );
    }
  }

  const refreshedIssues = managedIssues(
    manifest,
    refreshed.issues,
    managedMilestoneNumbers(refreshedMilestones),
  );
  const refreshedNumbers = issueNumberMap(manifest, refreshedIssues);
  for (const issue of manifest.issues) {
    const remote = refreshedIssues.get(issue.id);
    if (!remote)
      throw new Error(
        `managed issue ${issue.id} was not found after first pass`,
      );
    const milestone = manifest.milestones.find(
      (candidate) => candidate.id === issue.milestone,
    );
    if (!milestone) {
      throw new Error(
        `managed milestone ${issue.milestone} is not in manifest`,
      );
    }
  }

  return {
    refreshedIssues,
    refreshedMilestones,
    refreshedNumbers,
    refreshedState: refreshed,
  };
}

async function applyPlan(manifest, repo, initialState, runtime = {}) {
  const mutate = runtime.mutate ?? ghMutation;
  const discover = runtime.fetchState ?? fetchGithubState;
  const fetchBlockedBy = runtime.fetchBlockedBy ?? fetchNativeBlockedBy;
  const pause =
    runtime.pause ??
    ((milliseconds) =>
      new Promise((resolvePromise) =>
        setTimeout(resolvePromise, milliseconds),
      ));
  const applied = [];
  const labelByName = labelMap(initialState.labels);
  const milestoneById = managedMilestones(manifest, initialState.milestones);
  const issueById = managedIssues(
    manifest,
    initialState.issues,
    managedMilestoneNumbers(milestoneById),
  );
  const managedLabelNames = new Set(manifest.labels.map((label) => label.name));
  const milestoneNumbers = new Map();

  for (const label of manifest.labels) {
    const remote = labelByName.get(label.name);
    if (!remote) {
      await mutate(
        "POST",
        `repos/${repo}/labels`,
        {
          name: label.name,
          color: label.color,
          description: label.description,
        },
        `create label ${label.name}`,
      );
      applied.push({
        phase: "ensure",
        resource: "label",
        action: "create",
        id: label.name,
      });
    } else {
      const changes = {};
      if (
        String(remote.color ?? "").toUpperCase() !== label.color.toUpperCase()
      )
        changes.color = label.color;
      if (String(remote.description ?? "") !== label.description)
        changes.description = label.description;
      if (Object.keys(changes).length > 0) {
        await mutate(
          "PATCH",
          `repos/${repo}/labels/${encodeURIComponent(label.name)}`,
          changes,
          `update label ${label.name}`,
        );
        applied.push({
          phase: "ensure",
          resource: "label",
          action: "update",
          id: label.name,
        });
      } else {
        applied.push({
          phase: "ensure",
          resource: "label",
          action: "noop",
          id: label.name,
        });
      }
    }
  }

  for (const milestone of manifest.milestones) {
    const remote = milestoneById.get(milestone.id);
    const payload = {
      title: milestone.title,
      description: milestoneDescription(milestone),
      due_on: milestoneDueOn(milestone),
      state: "open",
    };
    if (!remote) {
      const created = await mutate(
        "POST",
        `repos/${repo}/milestones`,
        payload,
        `create milestone ${milestone.id}`,
      );
      if (created.number === undefined)
        throw new Error(`create milestone ${milestone.id} returned no number`);
      milestoneNumbers.set(milestone.id, created.number);
      applied.push({
        phase: "ensure",
        resource: "milestone",
        action: "create",
        id: milestone.id,
      });
      continue;
    }
    milestoneNumbers.set(milestone.id, remote.number);
    const changes = {};
    if (remote.title !== payload.title) changes.title = payload.title;
    if (
      normalizeText(remote.description) !== normalizeText(payload.description)
    )
      changes.description = payload.description;
    if (remoteDueOnDate(remote) !== milestone.dueOn)
      changes.due_on = payload.due_on;
    if (Object.keys(changes).length > 0) {
      await mutate(
        "PATCH",
        `repos/${repo}/milestones/${remote.number}`,
        changes,
        `update milestone ${milestone.id}`,
      );
      applied.push({
        phase: "ensure",
        resource: "milestone",
        action: "update",
        id: milestone.id,
      });
    } else {
      applied.push({
        phase: "ensure",
        resource: "milestone",
        action: "noop",
        id: milestone.id,
      });
    }
  }

  const issueNumbers = issueNumberMap(manifest, issueById);
  for (const issue of manifest.issues) {
    const remote = issueById.get(issue.id);
    const labels = desiredIssueLabels(issue, remote, managedLabelNames);
    const milestoneNumber = milestoneNumbers.get(issue.milestone);
    if (milestoneNumber === undefined)
      throw new Error(`milestone ${issue.milestone} has no GitHub number`);
    if (!remote) {
      const created = await mutate(
        "POST",
        `repos/${repo}/issues`,
        {
          title: issueTitle(issue),
          body: bodyForIssue(
            issue,
            manifest.milestones.find(
              (milestone) => milestone.id === issue.milestone,
            ),
            repo,
            issueNumbers,
            true,
          ),
          labels,
          milestone: milestoneNumber,
        },
        `create issue ${issue.id}`,
      );
      if (created.number === undefined)
        throw new Error(`create issue ${issue.id} returned no number`);
      issueNumbers.set(issue.id, created.number);
      issueById.set(issue.id, created);
      applied.push({
        phase: "ensure",
        resource: "issue",
        action: "create",
        id: issue.id,
      });
      continue;
    }
    issueNumbers.set(issue.id, remote.number);
    const payload = {};
    if (remote.title !== issueTitle(issue)) payload.title = issueTitle(issue);
    if (!sameLabelSet(issueLabelNames(remote), labels)) payload.labels = labels;
    if ((remote.milestone?.number ?? null) !== milestoneNumber)
      payload.milestone = milestoneNumber;
    if (Object.keys(payload).length > 0) {
      await mutate(
        "PATCH",
        `repos/${repo}/issues/${remote.number}`,
        payload,
        `update issue ${issue.id}`,
      );
      applied.push({
        phase: "ensure",
        resource: "issue",
        action: "update",
        id: issue.id,
      });
    } else {
      applied.push({
        phase: "ensure",
        resource: "issue",
        action: "noop",
        id: issue.id,
      });
    }
  }

  let verified;
  for (
    let attempt = 0;
    attempt < POST_APPLY_VERIFY_MAX_ATTEMPTS;
    attempt += 1
  ) {
    try {
      verified = verifyPostApplyState(manifest, await discover(repo, manifest));
      break;
    } catch (error) {
      if (
        !isRetryablePostApplyVerificationError(error) ||
        attempt === POST_APPLY_VERIFY_MAX_ATTEMPTS - 1
      ) {
        throw error;
      }
      await pause(POST_APPLY_VERIFY_RETRY_DELAY_MS);
    }
  }

  if (!verified) throw new Error("post-apply verification did not complete");
  const { refreshedIssues, refreshedNumbers } = verified;
  await applyNativeDependencies(
    manifest,
    repo,
    refreshedIssues,
    verified.refreshedState,
    mutate,
    fetchBlockedBy,
    applied,
  );
  for (const issue of manifest.issues) {
    const remote = refreshedIssues.get(issue.id);
    const milestone = manifest.milestones.find(
      (candidate) => candidate.id === issue.milestone,
    );
    const desiredBody = bodyForIssue(
      issue,
      milestone,
      repo,
      refreshedNumbers,
      true,
      remote.body,
    );
    if (
      remote.state !== "closed" &&
      normalizeText(remote.body) !== normalizeText(desiredBody)
    ) {
      await mutate(
        "PATCH",
        `repos/${repo}/issues/${remote.number}`,
        { body: desiredBody },
        `resolve dependencies for issue ${issue.id}`,
      );
      applied.push({
        phase: "dependencies",
        resource: "issue",
        action: "update",
        id: issue.id,
      });
    } else {
      applied.push({
        phase: "dependencies",
        resource: "issue",
        action: "noop",
        id: issue.id,
      });
    }
  }

  return applied;
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (options.help || command === "help") {
    process.stdout.write(usage);
    return 0;
  }

  const manifest = await loadManifest();
  const validation = validateManifest(manifest);
  if (command === "validate") {
    printValidation(validation);
    return validation.errors.length === 0 ? 0 : 1;
  }
  const validationError = validationFailure(validation);
  if (validationError) throw validationError;

  if (command === "plan") {
    const repo = assertRepoOption(command, options);
    const state = await fetchGithubState(repo, manifest);
    printPlan(repo, buildPlan(manifest, state, repo));
    return 0;
  }

  if (command === "apply") {
    const repo = assertRepoOption(command, options);
    if (!options.confirm) {
      throw new Error(
        "apply is write-capable; pass --confirm explicitly to continue",
      );
    }
    const state = await fetchGithubState(repo, manifest);
    const applied = await applyPlan(manifest, repo, state);
    process.stdout.write(
      `${JSON.stringify(
        {
          command: "apply",
          repo,
          counts: operationCounts(applied),
          operations: applied,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  throw new Error(`unknown command: ${command}\n\n${usage}`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `github-roadmap: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}

export {
  applyPlan,
  bodyForIssue,
  buildPlan,
  fetchGithubState,
  hasExactMarkerLine,
  isRealIsoDate,
  issueMarker,
  issueTitle,
  loadManifest,
  main,
  managedIssues,
  parseIncludedGhResponse,
  validateManifest,
  withSecondaryRateLimitRetry,
};
