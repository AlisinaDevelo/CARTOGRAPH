import assert from "node:assert/strict";
import test from "node:test";

import manifest from "./manifest.json" with { type: "json" };
import {
  applyPlan,
  bodyForIssue,
  buildPlan,
  issueMarker,
  issueTitle,
} from "../scripts/github-roadmap.mjs";

const testManifest = {
  schemaVersion: 1,
  project: "CARTOGRAPH",
  managedMarker: "cartograph",
  defaultIssueState: "open",
  milestones: [
    {
      id: "T-Q1",
      title: "Test milestone",
      description: "Test outcome",
      state: "open",
    },
  ],
  labels: [
    {
      name: "area:test",
      category: "area",
      description: "Test area",
      color: "123456",
    },
    {
      name: "priority:P0",
      category: "priority",
      description: "Required test work",
      color: "DC2626",
    },
  ],
  issues: [
    {
      id: "T-001",
      title: "First test issue",
      problemOutcome: "First outcome",
      acceptanceCriteria: ["First criterion"],
      dependencies: ["T-002"],
      labels: ["area:test", "priority:P0"],
      priority: "P0",
      milestone: "T-Q1",
      state: "open",
    },
    {
      id: "T-002",
      title: "Second test issue",
      problemOutcome: "Second outcome",
      acceptanceCriteria: ["Second criterion"],
      dependencies: [],
      labels: ["area:test", "priority:P0"],
      priority: "P0",
      milestone: "T-Q1",
      state: "open",
    },
  ],
};

const milestone = testManifest.milestones[0];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyState() {
  return { labels: [], milestones: [], issues: [] };
}

function managedLabelState() {
  return testManifest.labels.map((label) => ({
    name: label.name,
    color: label.color,
    description: label.description,
  }));
}

function managedMilestoneState() {
  return [
    {
      number: 1,
      title: milestone.title,
      description: `<!-- cartograph:milestone-id=${milestone.id} -->\n\n${milestone.description}`,
      state: "open",
    },
  ];
}

function managedIssueState() {
  const issueNumbers = new Map([
    ["T-001", 101],
    ["T-002", 102],
  ]);
  return testManifest.issues.map((issue) => ({
    number: issueNumbers.get(issue.id),
    title: issueTitle(issue),
    user: { login: "MAINTAINER" },
    state: "open",
    body: bodyForIssue(issue, milestone, "OWNER/REPO", issueNumbers, true),
    labels: [...issue.labels].reverse().map((name) => ({ name })),
    milestone: { number: 1 },
  }));
}

function managedState() {
  return {
    labels: managedLabelState(),
    milestones: managedMilestoneState(),
    issues: managedIssueState(),
  };
}

function operationsFor(plan, resource, phase = "ensure") {
  return plan.operations.filter(
    (operation) => operation.resource === resource && operation.phase === phase,
  );
}

function createFakeGithub() {
  const state = emptyState();
  const calls = [];
  let nextMilestone = 1;
  let nextIssue = 101;

  const mutate = async (method, endpoint, payload, context) => {
    calls.push({
      method,
      endpoint,
      payload: clone(payload),
      context,
    });

    if (endpoint.endsWith("/labels")) {
      const created = {
        name: payload.name,
        color: payload.color,
        description: payload.description,
      };
      state.labels.push(created);
      return clone(created);
    }

    if (endpoint.endsWith("/milestones")) {
      const created = {
        number: nextMilestone++,
        title: payload.title,
        description: payload.description,
        state: payload.state,
      };
      state.milestones.push(created);
      return clone(created);
    }

    if (endpoint.endsWith("/issues")) {
      const created = {
        number: nextIssue++,
        title: payload.title,
        body: payload.body,
        user: { login: "MAINTAINER" },
        labels: payload.labels.map((name) => ({ name })),
        milestone: { number: payload.milestone },
        state: "open",
      };
      state.issues.push(created);
      return clone(created);
    }

    const issueMatch = endpoint.match(/\/issues\/(\d+)$/);
    if (issueMatch) {
      const issue = state.issues.find(
        (candidate) => candidate.number === Number(issueMatch[1]),
      );
      if (!issue) throw new Error(`fake issue not found: ${endpoint}`);
      if (payload.labels)
        issue.labels = payload.labels.map((name) => ({ name }));
      if (Object.hasOwn(payload, "milestone")) {
        issue.milestone =
          payload.milestone === null ? null : { number: payload.milestone };
      }
      Object.assign(issue, payload);
      return clone(issue);
    }

    throw new Error(`unexpected fake mutation: ${method} ${endpoint}`);
  };

  return {
    calls,
    state,
    mutate,
    fetchState: async () => clone(state),
  };
}

test("fresh plan creates managed resources and schedules dependency linking", () => {
  const plan = buildPlan(testManifest, emptyState(), "OWNER/REPO");
  const labels = operationsFor(plan, "label");
  const milestones = operationsFor(plan, "milestone");
  const issues = operationsFor(plan, "issue");
  const dependencyPass = operationsFor(plan, "issue", "dependencies");

  assert.equal(labels.length, 2);
  assert.ok(labels.every((operation) => operation.action === "create"));
  assert.equal(milestones.length, 1);
  assert.equal(milestones[0].action, "create");
  assert.equal(
    issues.filter((operation) => operation.action === "create").length,
    2,
  );
  assert.equal(
    dependencyPass.find((operation) => operation.id === "T-001").action,
    "update",
  );
  assert.equal(
    dependencyPass.find((operation) => operation.id === "T-002").action,
    "noop",
  );
});

test("remote label permutations compare as a set and emit sorted payload labels", () => {
  const state = managedState();
  state.issues[0].labels = [
    { name: "priority:P0" },
    { name: "external-label" },
  ];
  const plan = buildPlan(testManifest, state, "OWNER/REPO");
  const issueOperations = operationsFor(plan, "issue");
  const firstIssue = issueOperations.find(
    (operation) => operation.id === "T-001",
  );

  assert.equal(firstIssue.action, "update");
  assert.deepEqual(firstIssue.changes.labels.to, [
    "area:test",
    "external-label",
    "priority:P0",
  ]);

  state.issues[0].labels = [
    { name: "external-label" },
    { name: "area:test" },
    { name: "priority:P0" },
  ];
  const normalizedPlan = buildPlan(testManifest, state, "OWNER/REPO");
  const normalizedFirstIssue = operationsFor(normalizedPlan, "issue").find(
    (operation) => operation.id === "T-001",
  );
  assert.equal(normalizedFirstIssue.action, "noop");
});

test("marker ownership requires an exact line and managed title metadata", () => {
  const inlineCollision = emptyState();
  inlineCollision.issues = [
    {
      number: 900,
      title: "Unrelated issue",
      body: `Unrelated text ${issueMarker("T-001")} in a sentence`,
      labels: [],
      milestone: null,
      state: "open",
    },
  ];
  assert.throws(
    () => buildPlan(testManifest, inlineCollision, "OWNER/REPO"),
    /ownership marker collision for T-001/,
  );

  const titleCollision = emptyState();
  titleCollision.issues = [
    {
      number: 901,
      title: "Unrelated issue",
      body: `${issueMarker("T-001")}\n${"<!-- cartograph:managed-issue-id=T-001 -->"}`,
      labels: [],
      milestone: null,
      state: "open",
    },
  ];
  assert.throws(
    () => buildPlan(testManifest, titleCollision, "OWNER/REPO"),
    /does not have managed title metadata for T-001/,
  );

  const duplicateCollision = emptyState();
  duplicateCollision.issues = [
    {
      number: 902,
      title: issueTitle(testManifest.issues[0]),
      body: bodyForIssue(
        testManifest.issues[0],
        milestone,
        "OWNER/REPO",
        new Map([["T-002", 903]]),
        true,
      ),
      labels: [],
      milestone: null,
      state: "open",
    },
    {
      number: 903,
      title: issueTitle(testManifest.issues[0]),
      body: bodyForIssue(
        testManifest.issues[0],
        milestone,
        "OWNER/REPO",
        new Map([["T-002", 904]]),
        true,
      ),
      labels: [],
      milestone: null,
      state: "open",
    },
  ];
  assert.throws(
    () => buildPlan(testManifest, duplicateCollision, "OWNER/REPO"),
    /multiple remote issues match T-001/,
  );
});

test("exact markers without a managed milestone fail closed", () => {
  const spoofedIssue = {
    number: 904,
    title: issueTitle(testManifest.issues[0]),
    user: { login: "OTHER" },
    body: bodyForIssue(
      testManifest.issues[0],
      milestone,
      "OWNER/REPO",
      new Map([["T-002", 905]]),
      true,
    ),
    labels: [],
    milestone: { number: 99 },
    state: "open",
  };

  assert.throws(
    () =>
      buildPlan(
        testManifest,
        {
          ...emptyState(),
          milestones: [
            {
              number: 99,
              title: "Unrelated milestone",
              description: "No managed marker",
              state: "open",
            },
          ],
          issues: [spoofedIssue],
        },
        "OWNER/REPO",
      ),
    /remote issue is not bound to a managed milestone for T-001/,
  );
});

test("apply creates dependency IDs first, links them in a second pass, and reruns as noops", async () => {
  const fake = createFakeGithub();
  const first = await applyPlan(testManifest, "OWNER/REPO", emptyState(), fake);
  const firstIssue = fake.state.issues.find(
    (issue) => issue.title === issueTitle(testManifest.issues[0]),
  );
  const secondIssue = fake.state.issues.find(
    (issue) => issue.title === issueTitle(testManifest.issues[1]),
  );
  const firstIssueCreate = fake.calls.find(
    (call) =>
      call.method === "POST" &&
      call.endpoint.endsWith("/issues") &&
      call.payload.title === issueTitle(testManifest.issues[0]),
  );
  const callCountAfterFirst = fake.calls.length;

  assert.equal(firstIssue.user.login, "MAINTAINER");

  assert.deepEqual(firstIssueCreate.payload.labels, [
    "area:test",
    "priority:P0",
  ]);
  assert.ok(
    firstIssue.body.includes(
      `https://github.com/OWNER/REPO/issues/${secondIssue.number}`,
    ),
  );
  assert.ok(
    first.some(
      (operation) =>
        operation.phase === "dependencies" && operation.action === "update",
    ),
  );

  const second = await applyPlan(
    testManifest,
    "OWNER/REPO",
    clone(fake.state),
    fake,
  );
  assert.equal(fake.calls.length, callCountAfterFirst);
  assert.ok(second.every((operation) => operation.action === "noop"));
});

test("the production issue order makes fresh dependency-body pass a noop", async () => {
  const freshPlan = buildPlan(manifest, emptyState(), "OWNER/REPO");
  assert.equal(
    operationsFor(freshPlan, "issue", "dependencies").filter(
      (operation) => operation.action === "update",
    ).length,
    0,
  );

  const fake = createFakeGithub();
  const first = await applyPlan(manifest, "OWNER/REPO", emptyState(), fake);
  const dependencyUpdates = first.filter(
    (operation) =>
      operation.phase === "dependencies" && operation.action === "update",
  );

  assert.equal(dependencyUpdates.length, 0);
  assert.equal(
    fake.calls.filter((call) => call.method === "POST").length,
    21 + 12 + 48,
  );
});

test("the production manifest remains the validated roadmap source", () => {
  assert.equal(manifest.milestones.length, 12);
  assert.equal(manifest.issues.length, 48);
});
