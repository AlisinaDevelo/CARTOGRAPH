import assert from "node:assert/strict";
import test from "node:test";

import manifest from "./manifest.json" with { type: "json" };
import {
  applyPlan,
  bodyForIssue,
  buildPlan,
  issueMarker,
  issueTitle,
  validateManifest,
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
      dueOn: "2026-10-31",
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
  return { labels: [], milestones: [], issues: [], blockedBy: [] };
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
      due_on: `${milestone.dueOn}T23:59:59Z`,
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
    id: issueNumbers.get(issue.id) + 1_000,
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
    blockedBy: [
      {
        issueId: "T-001",
        issueNumber: 101,
        blockers: [],
      },
    ],
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
  let nextIssueDatabaseId = 1_001;

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
        due_on: payload.due_on,
        state: payload.state,
      };
      state.milestones.push(created);
      return clone(created);
    }

    const milestoneMatch = endpoint.match(/\/milestones\/(\d+)$/u);
    if (milestoneMatch) {
      const candidate = state.milestones.find(
        (item) => item.number === Number(milestoneMatch[1]),
      );
      if (!candidate) throw new Error(`fake milestone not found: ${endpoint}`);
      Object.assign(candidate, payload);
      return clone(candidate);
    }

    if (endpoint.endsWith("/issues")) {
      const created = {
        number: nextIssue++,
        id: nextIssueDatabaseId++,
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

    const blockedByMatch = endpoint.match(
      /\/issues\/(\d+)\/dependencies\/blocked_by$/u,
    );
    if (blockedByMatch) {
      const issueNumber = Number(blockedByMatch[1]);
      const issue = state.issues.find(
        (candidate) => candidate.number === issueNumber,
      );
      if (!issue) throw new Error(`fake issue not found: ${endpoint}`);
      if (!Number.isSafeInteger(payload.issue_id))
        throw new Error("fake blocked_by payload must use a database ID");
      const record = state.blockedBy.find(
        (candidate) => candidate.issueNumber === issueNumber,
      ) ?? { issueId: null, issueNumber, blockers: [] };
      if (!state.blockedBy.includes(record)) state.blockedBy.push(record);
      if (!record.blockers.some((blocker) => blocker.id === payload.issue_id)) {
        const blocker = state.issues.find(
          (candidate) => candidate.id === payload.issue_id,
        );
        if (!blocker) throw new Error("fake blocker database ID not found");
        record.blockers.push({ id: blocker.id, number: blocker.number });
      }
      return clone(record);
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
    fetchState: async () => {
      const discovered = clone(state);
      for (const issue of discovered.issues) {
        const roadmapId = issue.body?.match(
          /<!-- cartograph:issue-id=([^ ]+) -->/u,
        )?.[1];
        if (
          roadmapId &&
          !discovered.blockedBy.some(
            (record) => record.issueNumber === issue.number,
          )
        ) {
          discovered.blockedBy.push({
            issueId: roadmapId,
            issueNumber: issue.number,
            blockers: [],
          });
        }
      }
      return discovered;
    },
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

test("untrusted marker mentions are ignored while managed collisions fail closed", () => {
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
  const untrustedPlan = buildPlan(testManifest, inlineCollision, "OWNER/REPO");
  assert.equal(
    operationsFor(untrustedPlan, "issue").find(
      (operation) => operation.id === "T-001",
    ).action,
    "create",
  );

  const titleCollision = emptyState();
  titleCollision.issues = [
    {
      number: 901,
      title: "Unrelated issue",
      body: `${issueMarker("T-001")}\n${"<!-- cartograph:managed-issue-id=T-001 -->"}`,
      author_association: "OWNER",
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
      author_association: "OWNER",
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
      author_association: "OWNER",
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
    author_association: "OWNER",
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

test("apply retries post-write discovery for an eventually visible issue", async () => {
  const fake = createFakeGithub();
  const pauses = [];
  let discoveries = 0;
  const firstIssueTitle = issueTitle(testManifest.issues[0]);
  const fetchState = async () => {
    discoveries += 1;
    const state = await fake.fetchState();
    if (discoveries === 1) {
      state.issues = state.issues.filter(
        (issue) => issue.title !== firstIssueTitle,
      );
    }
    return state;
  };

  const first = await applyPlan(testManifest, "OWNER/REPO", emptyState(), {
    mutate: fake.mutate,
    fetchState,
    pause: async (milliseconds) => pauses.push(milliseconds),
  });

  assert.equal(discoveries, 2);
  assert.deepEqual(pauses, [500]);
  assert.ok(first.some((operation) => operation.action === "update"));

  const callCountAfterFirst = fake.calls.length;
  const second = await applyPlan(
    testManifest,
    "OWNER/REPO",
    clone(fake.state),
    fake,
  );
  assert.equal(fake.calls.length, callCountAfterFirst);
  assert.ok(second.every((operation) => operation.action === "noop"));
});

test("apply fails closed after bounded retries when a managed issue stays missing", async () => {
  const fake = createFakeGithub();
  const pauses = [];
  let discoveries = 0;
  const firstIssueTitle = issueTitle(testManifest.issues[0]);

  await assert.rejects(
    applyPlan(testManifest, "OWNER/REPO", emptyState(), {
      mutate: fake.mutate,
      fetchState: async () => {
        discoveries += 1;
        const state = clone(fake.state);
        state.issues = state.issues.filter(
          (issue) => issue.title !== firstIssueTitle,
        );
        return state;
      },
      pause: async (milliseconds) => pauses.push(milliseconds),
    }),
    /managed issue T-001 was not found after first pass/,
  );

  assert.equal(discoveries, 5);
  assert.deepEqual(pauses, [500, 500, 500, 500]);
});

test("milestones require strict real YYYY-MM-DD due dates", () => {
  for (const dueOn of ["2026-02-29", "2026-02-30", "2026-2-09", "2026-04-31"]) {
    const candidate = clone(testManifest);
    candidate.milestones[0].dueOn = dueOn;
    const result = validateManifest(candidate);
    assert.ok(
      result.errors.some((error) => error.includes("milestones[0].dueOn")),
      `expected ${dueOn} to be rejected`,
    );
  }

  const leapYear = clone(testManifest);
  leapYear.milestones[0].dueOn = "2028-02-29";
  assert.ok(
    !validateManifest(leapYear).errors.some((error) =>
      error.includes("milestones[0].dueOn"),
    ),
  );
});

test("milestone due_on plans and applies create, update, and noop states", async () => {
  const freshPlan = buildPlan(testManifest, emptyState(), "OWNER/REPO");
  const freshMilestone = operationsFor(freshPlan, "milestone")[0];
  assert.equal(freshMilestone.action, "create");
  assert.equal(freshMilestone.changes.due_on, "2026-10-31T23:59:59Z");

  const stale = managedState();
  stale.milestones[0].due_on = "2027-01-31T23:59:59Z";
  const stalePlan = buildPlan(testManifest, stale, "OWNER/REPO");
  const staleMilestone = operationsFor(stalePlan, "milestone")[0];
  assert.equal(staleMilestone.action, "update");
  assert.deepEqual(staleMilestone.changes.due_on, {
    from: "2027-01-31T23:59:59Z",
    to: "2026-10-31T23:59:59Z",
  });

  const fake = createFakeGithub();
  await applyPlan(testManifest, "OWNER/REPO", emptyState(), fake);
  const dueDateCreate = fake.calls.find(
    (call) =>
      call.method === "POST" &&
      call.endpoint.endsWith("/milestones") &&
      call.payload.due_on === "2026-10-31T23:59:59Z",
  );
  assert.ok(dueDateCreate);

  fake.state.milestones[0].due_on = "2027-01-31T23:59:59Z";
  const callsBeforeUpdate = fake.calls.length;
  const update = await applyPlan(
    testManifest,
    "OWNER/REPO",
    clone(fake.state),
    fake,
  );
  const dueDatePatch = fake.calls
    .slice(callsBeforeUpdate)
    .find(
      (call) =>
        call.method === "PATCH" &&
        call.endpoint.endsWith("/milestones/1") &&
        call.payload.due_on === "2026-10-31T23:59:59Z",
    );
  assert.ok(dueDatePatch);
  assert.ok(
    update.some(
      (operation) =>
        operation.resource === "milestone" && operation.action === "update",
    ),
  );

  const callsAfterUpdate = fake.calls.length;
  const second = await applyPlan(
    testManifest,
    "OWNER/REPO",
    clone(fake.state),
    fake,
  );
  assert.equal(fake.calls.length, callsAfterUpdate);
  assert.ok(second.every((operation) => operation.action === "noop"));
});

test("reconciliation preserves completed issue and milestone state", async () => {
  const fake = createFakeGithub();
  await applyPlan(testManifest, "OWNER/REPO", emptyState(), fake);
  fake.state.issues[0].body = fake.state.issues[0].body.replace(
    "- [ ] First criterion",
    "- [x] First criterion",
  );
  fake.state.milestones[0].state = "closed";
  for (const issue of fake.state.issues) issue.state = "closed";

  const closedPlan = buildPlan(testManifest, clone(fake.state), "OWNER/REPO");
  assert.ok(
    operationsFor(closedPlan, "milestone").every(
      (operation) => operation.action === "noop",
    ),
  );
  assert.ok(
    operationsFor(closedPlan, "issue").every(
      (operation) => operation.action === "noop",
    ),
  );

  const callCount = fake.calls.length;
  const applied = await applyPlan(
    testManifest,
    "OWNER/REPO",
    clone(fake.state),
    fake,
  );
  assert.equal(fake.calls.length, callCount);
  assert.ok(applied.every((operation) => operation.action === "noop"));
  assert.ok(fake.state.issues[0].body.includes("- [x] First criterion"));
});

test("reconciliation preserves checked acceptance progress on open issues", async () => {
  const fake = createFakeGithub();
  await applyPlan(testManifest, "OWNER/REPO", emptyState(), fake);
  fake.state.issues[0].body = fake.state.issues[0].body.replace(
    "- [ ] First criterion",
    "- [x] First criterion",
  );

  const progressPlan = buildPlan(testManifest, clone(fake.state), "OWNER/REPO");
  assert.equal(
    operationsFor(progressPlan, "issue", "dependencies").find(
      (operation) => operation.id === "T-001",
    ).action,
    "noop",
  );

  const callCount = fake.calls.length;
  const applied = await applyPlan(
    testManifest,
    "OWNER/REPO",
    clone(fake.state),
    fake,
  );
  assert.equal(fake.calls.length, callCount);
  assert.ok(applied.every((operation) => operation.action === "noop"));
  assert.ok(fake.state.issues[0].body.includes("- [x] First criterion"));
});

test("native blocked_by relationships use database IDs, are planned, and are idempotent", async () => {
  const fake = createFakeGithub();
  const first = await applyPlan(testManifest, "OWNER/REPO", emptyState(), fake);
  const dependencyCalls = fake.calls.filter((call) =>
    call.endpoint.includes("/dependencies/blocked_by"),
  );
  assert.equal(dependencyCalls.length, 1);
  assert.equal(dependencyCalls[0].method, "POST");
  assert.equal(
    dependencyCalls[0].endpoint,
    "repos/OWNER/REPO/issues/101/dependencies/blocked_by",
  );
  assert.equal(dependencyCalls[0].payload.issue_id, 1_002);
  assert.notEqual(dependencyCalls[0].payload.issue_id, 102);
  assert.ok(
    first.some(
      (operation) =>
        operation.phase === "native-dependencies" &&
        operation.resource === "blocked_by" &&
        operation.action === "create",
    ),
  );

  const stateWithNativeEdge = clone(fake.state);
  stateWithNativeEdge.blockedBy[0].blockers.push({ id: 9_999, number: 9_999 });
  const plan = buildPlan(testManifest, stateWithNativeEdge, "OWNER/REPO");
  const nativePlan = operationsFor(plan, "blocked_by", "native-dependencies");
  assert.equal(
    nativePlan.find((operation) => operation.id === "T-001->T-002").action,
    "noop",
  );

  const callsAfterFirst = fake.calls.length;
  const second = await applyPlan(
    testManifest,
    "OWNER/REPO",
    stateWithNativeEdge,
    fake,
  );
  assert.equal(fake.calls.length, callsAfterFirst);
  assert.ok(second.every((operation) => operation.action === "noop"));
  assert.ok(fake.calls.every((call) => call.method !== "DELETE"));
});

test("a concurrent native dependency create is re-read as a noop", async () => {
  const fake = createFakeGithub();
  let raced = false;
  const mutate = async (method, endpoint, payload, context) => {
    if (!raced && endpoint.includes("/dependencies/blocked_by")) {
      raced = true;
      await fake.mutate(method, endpoint, payload, context);
      throw new Error("simulated duplicate relationship race");
    }
    return fake.mutate(method, endpoint, payload, context);
  };

  const applied = await applyPlan(testManifest, "OWNER/REPO", emptyState(), {
    mutate,
    fetchState: fake.fetchState,
    fetchBlockedBy: async (_repo, issueNumber) =>
      clone(
        fake.state.blockedBy.find(
          (record) => record.issueNumber === issueNumber,
        )?.blockers ?? [],
      ),
  });

  assert.equal(raced, true);
  assert.ok(
    applied.some(
      (operation) =>
        operation.id === "T-001->T-002" && operation.action === "noop",
    ),
  );
});

test("native blocked_by state is bounded and fails closed on unsafe rows", () => {
  const tooMany = managedState();
  tooMany.blockedBy = [
    {
      issueId: "T-001",
      issueNumber: 101,
      blockers: Array.from({ length: 101 }, (_, index) => ({
        id: 10_000 + index,
        number: 20_000 + index,
      })),
    },
  ];
  assert.throws(
    () => buildPlan(testManifest, tooMany, "OWNER/REPO"),
    /more than 100 rows/,
  );

  const missingDatabaseId = managedState();
  delete missingDatabaseId.issues[1].id;
  assert.throws(
    () => buildPlan(testManifest, missingDatabaseId, "OWNER/REPO"),
    /managed issue T-002 has no valid GitHub issue database ID/,
  );

  const incompleteDiscovery = managedState();
  incompleteDiscovery.blockedBy = [];
  assert.throws(
    () => buildPlan(testManifest, incompleteDiscovery, "OWNER/REPO"),
    /was not discovered; refusing to assume an empty relationship set/,
  );
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
    36 + 20 + 179 + 514,
  );
});

test("the production manifest remains the validated roadmap source", () => {
  const validation = validateManifest(manifest);
  const issuesByMilestone = new Map(
    manifest.milestones.map((milestone) => [milestone.id, 0]),
  );
  for (const issue of manifest.issues) {
    issuesByMilestone.set(
      issue.milestone,
      (issuesByMilestone.get(issue.milestone) ?? 0) + 1,
    );
  }

  assert.deepEqual(validation.errors, []);
  assert.equal(manifest.milestones.length, 20);
  assert.equal(manifest.issues.length, 179);
  assert.equal(manifest.labels.length, 36);
  assert.equal(validation.summary.dependencyEdges, 514);
  assert.deepEqual(manifest.roadmapHorizon, {
    start: "2026-08-23",
    end: "2031-07-31",
    years: 5,
    milestones: 20,
    issues: 179,
  });
  assert.deepEqual(
    manifest.milestones.map((milestone) => milestone.id),
    Array.from(
      { length: 20 },
      (_, index) => `Y${Math.floor(index / 4) + 1}-Q${(index % 4) + 1}`,
    ),
  );
  assert.deepEqual(
    [...issuesByMilestone.values()],
    [8, 11, 9, 10, 9, 7, 7, 7, 7, 9, 8, 8, 13, 7, 15, 7, 8, 11, 12, 6],
  );
  assert.ok(
    manifest.issues.every(
      (issue) =>
        !["agent", "model", "status", "context"].some((field) =>
          Object.hasOwn(issue, field),
        ),
    ),
    "public roadmap entries must not expose internal routing metadata",
  );
});
