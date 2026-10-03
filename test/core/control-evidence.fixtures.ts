import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createGraphSnapshot,
  evaluatePolicyOnSnapshot,
  parseAdrReferenceDocument,
  parseArchitectureWaiver,
  parseCodeowners,
  parseControlMapping,
  parseOwnershipInput,
  parsePolicyConfig,
  resolveOwnership,
  FindingLifecycleInputSchema,
} from "../../src/core/index.js";

const root = resolve(import.meta.dirname, "../..");
const json = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(root, path), "utf8")) as unknown;

export const AS_OF = "2030-06-01T00:00:00Z";
const PERIOD = { from: "2030-01-01T00:00:00Z", to: "2030-12-31T23:59:59Z" };

const module = (path: string) => ({
  id: `module:${path}`,
  stableKey: `module:${path}`,
  kind: "module" as const,
  name: path,
  location: { path, line: 1 },
});

export const snapshot = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "control-fixture" },
  nodes: [module("src/api/a.ts"), module("src/db/b.ts")],
  edges: [
    {
      from: "module:src/api/a.ts",
      to: "module:src/db/b.ts",
      kind: "imports",
      confidence: "certain",
      evidence: [
        {
          id: "a-b",
          kind: "source",
          path: "src/api/a.ts",
          line: 1,
          detector: "test@1",
          contentHash: "e".repeat(64),
        },
      ],
    },
  ],
});

export const policy = parsePolicyConfig({
  policyId: "layers",
  version: "1.0.0",
  mode: "enforce",
  rules: [
    {
      id: "no-db-from-api",
      target: "edge",
      assertion: "absent",
      selector: {
        kind: "imports",
        fromPath: "src/api/**",
        toPath: "src/db/**",
      },
    },
    {
      id: "imports-exist",
      target: "edge",
      assertion: "exists",
      selector: { kind: "imports" },
    },
  ],
});

export const evaluation = evaluatePolicyOnSnapshot(policy, snapshot);

const adr = (id: string, status: string, extra: object = {}) => ({
  id,
  file: `docs/adr/${id}.md`,
  title: `Decision ${id}`,
  status,
  graphIds: ["module:src/api/a.ts"],
  ...extra,
});

export const decisions = parseAdrReferenceDocument({
  references: [
    adr("ADR-1", "accepted"),
    adr("ADR-2", "superseded"),
    adr("ADR-3", "rejected"),
    adr("ADR-4", "proposed"),
  ],
});

export const waiver = parseArchitectureWaiver(
  (
    json("test/fixtures/architecture-waivers/scenarios.v0.1.json") as {
      cases: { waivers: unknown[] }[];
    }
  ).cases[0]?.waivers[0],
);

export const findings = FindingLifecycleInputSchema.parse(
  (
    json("test/fixtures/finding-lifecycle/replay.v0.1.json") as {
      input: unknown;
    }
  ).input,
);

const control = (id: string, evidence: object[], extra: object = {}) => ({
  id,
  title: `Control ${id}`,
  objective: "API code reaches storage only through the data layer.",
  owner: "team-platform",
  scope: { description: "src/", paths: ["src/**"] },
  period: PERIOD,
  applicability: "full",
  evidence,
  ...extra,
});

const assertion = (assertedAt: string) => ({
  type: "owner-assertion",
  owner: "team-platform",
  statement: "Reviewed the layering exceptions this quarter.",
  assertedAt,
});

export const mapping = parseControlMapping({
  schemaVersion: 1,
  contract: "cartograph.control-mapping",
  controls: [
    control("C-supported", [
      { type: "policy-rule", policyId: "layers", ruleId: "imports-exist" },
      { type: "decision", decisionId: "ADR-1" },
      assertion("2030-03-01T00:00:00Z"),
    ]),
    control("C-violated", [
      { type: "policy-rule", policyId: "layers", ruleId: "no-db-from-api" },
    ]),
    control("C-gaps", [
      { type: "decision", decisionId: "ADR-2" },
      { type: "decision", decisionId: "ADR-4" },
      { type: "bundle-artifact", role: "review-summary" },
      { type: "waiver", waiverId: "no-such-waiver" },
      { type: "policy-rule", policyId: "other", ruleId: "x" },
    ]),
    control(
      "C-partial",
      [
        { type: "waiver", waiverId: "waiver-signed-active" },
        {
          type: "finding",
          findingId: "finding-api",
          expectedStates: ["remediated"],
        },
      ],
      {
        applicability: "partial",
        applicabilityNote:
          "Covers the API package only; workers are out of scope.",
      },
    ),
    control("C-asserted", [
      assertion("2030-02-01T00:00:00Z"),
      {
        type: "test",
        name: "layering integration suite",
        result: "pass",
        ranAt: "2030-05-01T00:00:00Z",
        reportedBy: "ci",
      },
    ]),
    control("C-na", [assertion("2030-02-01T00:00:00Z")], {
      applicability: "not-applicable",
      applicabilityNote: "No storage layer in this service.",
    }),
    control("C-expired-period", [assertion("2029-02-01T00:00:00Z")], {
      period: { from: "2029-01-01T00:00:00Z", to: "2029-12-31T23:59:59Z" },
    }),
    control("C-stale-assertion", [assertion("2029-11-01T00:00:00Z")]),
    control("C-conflicts", [
      { type: "decision", decisionId: "ADR-3" },
      {
        type: "finding",
        findingId: "finding-policy",
        expectedStates: ["remediated"],
      },
      {
        type: "test",
        name: "layering integration suite",
        result: "fail",
        ranAt: "2030-05-01T00:00:00Z",
        reportedBy: "ci",
      },
    ]),
    control("C-declared-missing", [{ type: "bundle-artifact", role: "diff" }]),
  ],
});

const ownershipFixture = json(
  "test/fixtures/ownership-resolution/report.v0.1.json",
) as {
  request: Record<string, unknown> & {
    sources: unknown[];
    sourceDiagnostics: unknown[];
  };
  codeowners: {
    id: string;
    repositoryId: string;
    path: string;
    revision: string;
    precedence: number;
    text: string;
  }[];
};
const codeowners = ownershipFixture.codeowners.map((entry) =>
  parseCodeowners(entry.text, entry),
);

/** The resolved ownership fixture: 10 targets, 2 gaps, 3 unresolvable. */
export const ownershipReport = resolveOwnership(
  parseOwnershipInput({
    ...ownershipFixture.request,
    sources: [
      ...ownershipFixture.request.sources,
      ...codeowners.map((entry) => entry.source),
    ],
    sourceDiagnostics: [
      ...ownershipFixture.request.sourceDiagnostics,
      ...codeowners.flatMap((entry) => entry.diagnostics),
    ],
  }),
);
