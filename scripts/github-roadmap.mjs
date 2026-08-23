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
const EXPECTED_MILESTONES = 12;
const EXPECTED_ISSUES = 48;
const MAX_GH_OUTPUT_BYTES = 4 * 1024 * 1024;
const GH_TIMEOUT_MS = 30_000;
const GH_MUTATION_INTERVAL_MS = 1_050;
const ALLOWED_LABEL_CATEGORIES = new Set(["area", "type", "priority"]);
const ALLOWED_PRIORITIES = new Set(["P0", "P1", "P2"]);
const ALLOWED_STATES = new Set(["open"]);

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
    for (const field of ["id", "title", "description"]) {
      if (!nonEmptyString(milestone[field]))
        errors.push(`${prefix}.${field} must be nonempty`);
    }
    if (!ALLOWED_STATES.has(milestone.state)) {
      errors.push(`${prefix}.state must be open`);
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
    if (!ALLOWED_PRIORITIES.has(issue.priority)) {
      errors.push(`${prefix}.priority must be one of P0, P1, P2`);
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
    }
    if (
      !Array.isArray(issue.acceptanceCriteria) ||
      issue.acceptanceCriteria.length === 0
    ) {
      errors.push(
        `${prefix}.acceptanceCriteria must contain at least one criterion`,
      );
    } else {
      issue.acceptanceCriteria.forEach((criterion, criterionIndex) => {
        if (!nonEmptyString(criterion)) {
          errors.push(
            `${prefix}.acceptanceCriteria[${criterionIndex}] must be nonempty`,
          );
        }
      });
    }
    if (!Array.isArray(issue.dependencies)) {
      errors.push(`${prefix}.dependencies must be an array`);
    } else {
      const seenDependencies = new Set();
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
        if (!ALLOWED_LABEL_CATEGORIES.has(category)) {
          errors.push(`${prefix} uses unsupported label category ${category}`);
        }
      }
      if (!issue.labels.includes(`priority:${issue.priority}`)) {
        errors.push(`${prefix}.labels must include priority:${issue.priority}`);
      }
    }
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
        const detail = truncate(stderr.toString("utf8").trim());
        const suffix = detail.length > 0 ? `: ${detail}` : "";
        rejectPromise(
          new Error(
            `gh ${args.join(" ")} failed with ${signal ?? `exit ${code}`}${suffix}`,
          ),
        );
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

function flattenPaginated(value) {
  if (!Array.isArray(value)) return [];
  if (value.every((page) => Array.isArray(page))) return value.flat();
  return value;
}

async function fetchGithubState(repo) {
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

  return {
    labels: flattenPaginated(labels),
    milestones: flattenPaginated(milestones),
    issues: flattenPaginated(issues).filter((issue) => !issue.pull_request),
  };
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
    const exactMatches = remoteIssues.filter((candidate) =>
      hasExactMarkerLine(candidate.body, marker),
    );
    const nearMatches = remoteIssues.filter(
      (candidate) =>
        hasMarkerMention(candidate.body, marker) &&
        !hasExactMarkerLine(candidate.body, marker),
    );
    if (nearMatches.length > 0) {
      throw new Error(`ownership marker collision for ${issue.id}`);
    }
    const duplicateLine = remoteIssues.find(
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

function bodyForIssue(issue, milestone, repo, issueNumbers, linkDependencies) {
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
  const criteria = issue.acceptanceCriteria
    .map((criterion) => `- [ ] ${criterion}`)
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
    `- State: ${issue.state}`,
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
  if (remote.state !== "open")
    changes.state = { from: remote.state, to: "open" };
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
    if (remote.state !== "open")
      changes.state = { from: remote.state, to: "open" };
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
    );
    const currentBody = normalizeText(remote?.body);
    const dependencyTargetWillBeCreated = issue.dependencies.some(
      (dependency) =>
        issueById.get(dependency) === null &&
        issueIndexById.get(dependency) > issueIndexById.get(issue.id),
    );
    const bodyChanged = remote
      ? currentBody !== normalizeText(desiredBody) ||
        dependencyTargetWillBeCreated
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

async function ghMutation(method, endpoint, payload, context) {
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
  return ghJson(
    ["api", "--method", method, "--input", "-", endpoint],
    payload,
    context,
  );
}

async function applyPlan(manifest, repo, initialState, runtime = {}) {
  const mutate = runtime.mutate ?? ghMutation;
  const discover = runtime.fetchState ?? fetchGithubState;
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
    if (remote.state !== payload.state) changes.state = payload.state;
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
    if (remote.state !== "open") payload.state = "open";
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

  const refreshed = await discover(repo);
  const refreshedMilestones = managedMilestones(manifest, refreshed.milestones);
  const refreshedIssues = managedIssues(
    manifest,
    refreshed.issues,
    managedMilestoneNumbers(refreshedMilestones),
  );
  const refreshedNumbers = issueNumberMap(manifest, refreshedIssues);
  for (const issue of manifest.issues) {
    const remote = refreshedIssues.get(issue.id);
    const milestone = manifest.milestones.find(
      (candidate) => candidate.id === issue.milestone,
    );
    if (!remote)
      throw new Error(
        `managed issue ${issue.id} was not found after first pass`,
      );
    if (!milestone || !refreshedMilestones.get(milestone.id)) {
      throw new Error(
        `managed milestone ${issue.milestone} was not found after first pass`,
      );
    }
    const desiredBody = bodyForIssue(
      issue,
      milestone,
      repo,
      refreshedNumbers,
      true,
    );
    if (normalizeText(remote.body) !== normalizeText(desiredBody)) {
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
    const state = await fetchGithubState(repo);
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
    const state = await fetchGithubState(repo);
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
  hasExactMarkerLine,
  issueMarker,
  issueTitle,
  loadManifest,
  main,
  managedIssues,
  validateManifest,
};
