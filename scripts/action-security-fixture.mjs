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
const actionReferences = (source) =>
  [...source.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);

const validatePolicy = (candidateWorkflow, candidateAction) => {
  requireText(
    candidateWorkflow,
    "on:\n  # Deliberately use pull_request",
    "fixture workflow",
  );
  requireText(
    candidateWorkflow,
    "permissions:\n  contents: read",
    "fixture workflow",
  );
  requireText(
    candidateWorkflow,
    "permissions:\n      contents: read",
    "job permissions",
  );
  requireText(
    candidateWorkflow,
    "ref: ${{ github.event.pull_request.head.sha }}",
    "exact head checkout",
  );
  requireText(
    candidateWorkflow,
    "persist-credentials: false",
    "credential persistence",
  );
  forbidText(candidateWorkflow, "pull_request_target", "fixture workflow");
  forbidText(candidateWorkflow, "secrets.", "fixture workflow");
  forbidText(candidateWorkflow, "github.token", "fixture workflow");
  forbidText(candidateAction, "pull_request_target", "composite action");
  forbidText(candidateAction, "secrets.", "composite action");
  forbidText(candidateAction, "github.token", "composite action");
  if (
    /^[ \t]*permissions:[ \t]*(?:write|write-all)[ \t]*$/mu.test(
      candidateWorkflow,
    )
  )
    fail("fixture workflow grants broad write permissions");
  if (
    /^[ \t]*[A-Za-z-]+:[ \t]*(?:write|write-all)[ \t]*$/mu.test(
      candidateWorkflow,
    )
  )
    fail("fixture workflow grants a write permission");
  for (const [label, source] of [
    ["fixture workflow", candidateWorkflow],
    ["composite action", candidateAction],
  ]) {
    for (const reference of actionReferences(source))
      if (!/@[0-9a-f]{40}$/iu.test(reference))
        fail(`${label} contains an unpinned Action reference: ${reference}`);
  }
  requireText(candidateAction, 'default: "7"', "retention default");
  requireText(candidateAction, 'default: "true"', "report upload default");
  requireText(candidateAction, 'default: "20"', "annotation limit default");
  requireText(candidateAction, "default: informational", "policy mode default");
  requireText(
    candidateAction,
    "npm ci --ignore-scripts",
    "dependency installation",
  );
  requireText(
    candidateAction,
    "CARTOGRAPH_RETENTION_DAYS",
    "retention validation",
  );
  requireText(
    candidateAction,
    "CARTOGRAPH_UPLOAD_REPORT",
    "report opt-out validation",
  );
  requireText(candidateAction, "CARTOGRAPH_POLICY_PATH", "policy path opt-in");
  requireText(
    candidateAction,
    "CARTOGRAPH_POLICY_MODE",
    "policy mode validation",
  );
  requireText(
    candidateAction,
    "CARTOGRAPH_REVIEW_CONTEXT_PATH",
    "review context opt-in",
  );
  requireText(
    candidateAction,
    "CARTOGRAPH_ANNOTATION_LIMIT",
    "annotation limit validation",
  );
  requireText(
    candidateAction,
    "annotation-limit must be an integer from 0 through 20",
    "annotation limit bound",
  );
  requireText(candidateAction, "--mode", "policy mode forwarding");
  requireText(candidateAction, "policy-exit-code", "policy status handoff");
  requireText(
    candidateAction,
    "Apply policy exit status",
    "policy status gate",
  );
  requireText(
    candidateAction,
    "if: inputs.upload-report == 'true'",
    "report upload opt-out",
  );
  requireText(candidateAction, "architecture-diff.json", "JSON artifact scope");
  requireText(candidateAction, "architecture-diff.html", "HTML artifact scope");
  requireText(
    candidateAction,
    "architecture-review.json",
    "review JSON artifact scope",
  );
  requireText(
    candidateAction,
    "architecture-review.html",
    "review HTML artifact scope",
  );
};

const expectPolicyRejection = (label, candidateWorkflow, candidateAction) => {
  try {
    validatePolicy(candidateWorkflow, candidateAction);
  } catch {
    return;
  }
  fail(`${label} policy mutation was accepted`);
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

validatePolicy(workflow, action);
expectPolicyRejection(
  "write permission",
  workflow.replace(
    "permissions:\n      contents: read",
    "permissions:\n      contents: read\n      actions: write",
  ),
  action,
);
expectPolicyRejection(
  "pull_request_target",
  workflow.replace("pull_request:", "pull_request_target:"),
  action,
);
expectPolicyRejection(
  "unpinned Action",
  workflow.replace(
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/checkout@main",
  ),
  action,
);
expectPolicyRejection(
  "secret-dependent analysis",
  `${workflow}\nenv:\n  CARTOGRAPH_TOKEN: \${{ secrets.BAD }}\n`,
  action,
);
expectPolicyRejection(
  "enforcing policy default",
  workflow,
  action.replace("default: informational", "default: enforce"),
);
requireText(docs, "Fork pull requests and permissions", "Action docs");
requireText(docs, "Pin and update policy", "Action docs");
requireText(docs, "Sensitive repositories", "Action retention docs");
requireText(docs, "source snippet", "Action redaction docs");
requireText(docs, "Evidence-backed line annotations", "Action annotation docs");
requireText(docs, "at most 20", "Action annotation cap docs");

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
