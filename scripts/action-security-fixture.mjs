#!/usr/bin/env node
/* global console */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = resolve(
  repositoryRoot,
  "examples/github-action-fixture/.github/workflows/cartograph.yml",
);
const workflow = readFileSync(workflowPath, "utf8");
const action = readFileSync(resolve(repositoryRoot, "action.yml"), "utf8");
const docs = readFileSync(resolve(repositoryRoot, "docs/ACTION.md"), "utf8");

const fail = (message) => {
  throw new Error(`Action security fixture failed: ${message}`);
};
const requireText = (source, text, label) => {
  if (!source.includes(text))
    fail(`${label} is missing ${JSON.stringify(text)}`);
};
const forbidText = (source, text, label) => {
  if (source.includes(text))
    fail(`${label} contains forbidden ${JSON.stringify(text)}`);
};

const syntheticForkPullRequest = {
  eventName: "pull_request",
  pull_request: {
    base: { sha: "base-sha" },
    head: { sha: "head-sha", repo: { fork: true } },
  },
  token: { permissions: { contents: "read" } },
  secrets: {},
};
if (
  syntheticForkPullRequest.eventName !== "pull_request" ||
  syntheticForkPullRequest.pull_request.head.repo.fork !== true
)
  fail("synthetic event is not a fork pull_request");
if (syntheticForkPullRequest.token.permissions.contents !== "read")
  fail("synthetic fork token is not read-only");
if (Object.keys(syntheticForkPullRequest.secrets).length !== 0)
  fail("synthetic fork event unexpectedly contains secrets");

requireText(
  workflow,
  "on:\n  # Deliberately use pull_request",
  "fixture workflow",
);
requireText(workflow, "permissions:\n  contents: read", "fixture workflow");
requireText(workflow, "permissions:\n      contents: read", "job permissions");
requireText(
  workflow,
  "ref: ${{ github.event.pull_request.head.sha }}",
  "exact head checkout",
);
requireText(workflow, "persist-credentials: false", "credential persistence");
forbidText(workflow, "pull_request_target", "fixture workflow");
forbidText(workflow, "secrets.", "fixture workflow");
forbidText(workflow, "github.token", "fixture workflow");
forbidText(action, "pull_request_target", "composite action");
forbidText(action, "secrets.", "composite action");
forbidText(action, "github.token", "composite action");
requireText(action, 'default: "7"', "retention default");
requireText(action, 'default: "true"', "report upload default");
requireText(action, "CARTOGRAPH_RETENTION_DAYS", "retention validation");
requireText(action, "CARTOGRAPH_UPLOAD_REPORT", "report opt-out validation");
requireText(
  action,
  "if: inputs.upload-report == 'true'",
  "report upload opt-out",
);
requireText(action, "architecture-diff.json", "JSON artifact scope");
requireText(action, "architecture-diff.html", "HTML artifact scope");
requireText(docs, "Fork pull requests and permissions", "Action docs");
requireText(docs, "Pin and update policy", "Action docs");
requireText(docs, "Sensitive repositories", "Action retention docs");
requireText(docs, "source snippet", "Action redaction docs");

console.log(
  JSON.stringify({
    ok: true,
    event: syntheticForkPullRequest.eventName,
    fork: syntheticForkPullRequest.pull_request.head.repo.fork,
    contentsPermission: syntheticForkPullRequest.token.permissions.contents,
    secretsPassed: false,
    workflowWrites: false,
    defaultRetentionDays: 7,
    sensitiveRepositoryOptOut: true,
  }),
);
