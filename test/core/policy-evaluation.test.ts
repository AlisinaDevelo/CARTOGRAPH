import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  diffGraphSnapshots,
  evaluatePolicy,
  evaluatePolicyOnDiff,
  evaluatePolicyOnSnapshot,
  GraphSnapshotSchema,
  PolicyEvaluationError,
  PolicyEvaluationSchema,
  serializePolicyEvaluation,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const schema = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/policy-evaluation.v0.1.schema.json"),
    "utf8",
  ),
) as object;
const sample = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/policy-evaluation.v0.1.json"),
    "utf8",
  ),
) as unknown;

const snapshot = (input: {
  commitSha: string;
  nodes?: unknown[];
  edges?: unknown[];
  diagnostics?: unknown[];
}) =>
  GraphSnapshotSchema.parse({
    revision: { commitSha: input.commitSha },
    nodes: input.nodes ?? [],
    edges: input.edges ?? [],
    diagnostics: input.diagnostics ?? [],
  });

const moduleNode = (id: string, name = id) => ({
  id,
  kind: "module" as const,
  name,
});

const endpointNode = (id: string) => ({
  id,
  kind: "endpoint" as const,
  name: id,
});

const unknownEdge = (from: string, to: string) => ({
  from,
  to,
  kind: "unknown" as const,
  confidence: "inferred" as const,
  evidence: [],
  unresolvedReason: "fixture edge",
});

describe("policy evaluation", () => {
  it("validates the published report schema and records stable violations", () => {
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(sample)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(PolicyEvaluationSchema.parse(sample).status).toBe("violations");

    const policy = {
      schemaVersion: 1,
      policyId: "local-policy",
      version: "1.0.0",
      rules: [
        {
          id: "endpoint-required",
          target: "node",
          selector: { kind: "endpoint" },
          assertion: "exists",
        },
        {
          id: "unknown-edge-forbidden",
          target: "edge",
          selector: { kind: "unknown" },
          assertion: "absent",
        },
      ],
    };
    const result = evaluatePolicyOnSnapshot(
      policy,
      snapshot({
        commitSha: "fixture",
        nodes: [moduleNode("module:a")],
        edges: [unknownEdge("module:a", "module:a")],
      }),
    );

    expect(result).toMatchObject({
      policyId: "local-policy",
      inputKind: "snapshot",
      status: "violations",
      evaluatedRules: 2,
      passedRules: 0,
      unsupportedRules: 0,
    });
    expect(result.violations.map((violation) => violation.id)).toEqual([
      "violation:endpoint-required",
      "violation:unknown-edge-forbidden",
    ]);
    expect(result.violations[0]?.evidenceRefs).toContain(
      "policy-rule:endpoint-required",
    );
    expect(result.violations[1]?.evidenceRefs).toContain(
      "edge:module:a|unknown|module:a",
    );
    expect(serializePolicyEvaluation(result)).toBe(
      serializePolicyEvaluation(JSON.parse(serializePolicyEvaluation(result))),
    );
  });

  it("evaluates changed nodes and diff records deterministically", () => {
    const before = snapshot({
      commitSha: "before",
      nodes: [moduleNode("module:a")],
    });
    const after = snapshot({
      commitSha: "after",
      nodes: [moduleNode("module:a"), endpointNode("endpoint:health")],
      diagnostics: [
        {
          id: "diagnostic:dynamic-import",
          code: "dynamic-import",
          severity: "warning",
          message: "dynamic import is unresolved",
          evidence: [],
        },
      ],
    });
    const diff = diffGraphSnapshots(before, after);
    const policy = {
      policyId: "diff-policy",
      version: "1.0.0",
      rules: [
        {
          id: "new-endpoint",
          target: "diff",
          selector: { kind: "node-added" },
          assertion: "exists",
        },
        {
          id: "changed-endpoint-count",
          target: "node",
          selector: { kind: "endpoint" },
          assertion: "count-at-most",
          value: 1,
        },
        {
          id: "dynamic-import-diagnostic",
          target: "diff",
          selector: { kind: "diagnostic-added", code: "dynamic-import" },
          assertion: "exists",
        },
      ],
    };

    const result = evaluatePolicyOnDiff(policy, diff);
    expect(result).toMatchObject({
      inputKind: "diff",
      status: "passed",
      evaluatedRules: 3,
      passedRules: 3,
      unsupportedRules: 0,
    });
    expect(result.violations).toEqual([]);
    expect(evaluatePolicy(policy, { kind: "diff", diff })).toEqual(result);
  });

  it("reports diff-only rules as explicit unsupported input on snapshots", () => {
    const result = evaluatePolicyOnSnapshot(
      {
        policyId: "diff-only-policy",
        version: "1.0.0",
        rules: [
          {
            id: "added-node-review",
            target: "diff",
            selector: { kind: "node-added" },
            assertion: "exists",
          },
        ],
      },
      snapshot({ commitSha: "fixture", nodes: [moduleNode("module:a")] }),
    );
    expect(result).toMatchObject({
      status: "unsupported",
      evaluatedRules: 1,
      passedRules: 0,
      unsupportedRules: 1,
    });
    expect(result.violations).toEqual([]);
    expect(result.unsupported[0]).toMatchObject({
      id: "unsupported:added-node-review",
      code: "unsupported-target",
      evidenceRefs: [
        "input:snapshot",
        "policy-rule:added-node-review",
        "policy:diff-only-policy",
      ],
    });
  });

  it("rejects unsupported evaluator input kinds instead of guessing", () => {
    expect(() =>
      evaluatePolicy(
        {
          policyId: "local-policy",
          version: "1.0.0",
          rules: [
            {
              id: "node-required",
              target: "node",
              selector: { kind: "module" },
              assertion: "exists",
            },
          ],
        },
        { kind: "other" } as never,
      ),
    ).toThrow(PolicyEvaluationError);
  });

  it("reports exception lifecycle and applies only the highest-precedence active exception", () => {
    const result = evaluatePolicyOnSnapshot(
      {
        schemaVersion: 1,
        policyId: "exception-policy",
        version: "1.0.0",
        mode: "enforce",
        rules: [
          {
            id: "endpoint-required",
            target: "node",
            selector: { kind: "endpoint" },
            assertion: "exists",
          },
        ],
        exceptions: [
          {
            schemaVersion: 1,
            contract: "cartograph.policy-exception",
            id: "active-high",
            ruleId: "endpoint-required",
            scope: { target: "node", selector: { kind: "endpoint" } },
            rationale: "migration is scheduled",
            owner: "architecture-team",
            createdAt: "2026-08-01T00:00:00.000Z",
            expiresAt: "2026-12-01T00:00:00.000Z",
            precedence: 20,
          },
          {
            schemaVersion: 1,
            contract: "cartograph.policy-exception",
            id: "expiring-low",
            ruleId: "endpoint-required",
            scope: { target: "node", selector: { kind: "endpoint" } },
            rationale: "migration is scheduled",
            owner: "architecture-team",
            createdAt: "2026-08-01T00:00:00.000Z",
            expiresAt: "2026-08-28T00:00:00.000Z",
            precedence: 10,
          },
          {
            schemaVersion: 1,
            contract: "cartograph.policy-exception",
            id: "expired",
            ruleId: "endpoint-required",
            scope: { target: "node", selector: { kind: "endpoint" } },
            rationale: "old migration",
            owner: "architecture-team",
            createdAt: "2026-08-01T00:00:00.000Z",
            expiresAt: "2026-08-23T00:00:00.000Z",
            precedence: 50,
          },
          {
            schemaVersion: 1,
            contract: "cartograph.policy-exception",
            id: "malformed",
            ruleId: "endpoint-required",
            scope: { target: "node", selector: { kind: "endpoint" } },
            rationale: "missing owner",
            createdAt: "2026-08-01T00:00:00.000Z",
            expiresAt: "2026-12-01T00:00:00.000Z",
          },
        ],
      },
      snapshot({
        commitSha: "exception-fixture",
        nodes: [moduleNode("module:a")],
      }),
      { asOf: "2026-08-24T00:00:00.000Z", expiringWithinDays: 7 },
    );

    expect(result).toMatchObject({
      mode: "enforce",
      status: "passed",
      evaluatedRules: 1,
      passedRules: 1,
      violations: [],
      asOf: "2026-08-24T00:00:00.000Z",
      exceptionWindowDays: 7,
    });
    expect(result.exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "exception:active-high",
          status: "active",
          suppresses: true,
        }),
        expect.objectContaining({
          id: "exception:expiring-low",
          status: "expiring",
          suppresses: false,
        }),
        expect.objectContaining({
          id: "exception:expired",
          status: "expired",
          suppresses: false,
        }),
        expect.objectContaining({
          id: "exception:malformed",
          status: "malformed",
          suppresses: false,
        }),
      ]),
    );
  });

  it("keeps expired and malformed exceptions from suppressing enforcing findings", () => {
    const result = evaluatePolicyOnSnapshot(
      {
        policyId: "expired-exception-policy",
        version: "1.0.0",
        mode: "enforce",
        rules: [
          {
            id: "endpoint-required",
            target: "node",
            selector: { kind: "endpoint" },
            assertion: "exists",
          },
        ],
        exceptions: [
          {
            schemaVersion: 1,
            contract: "cartograph.policy-exception",
            id: "expired",
            ruleId: "endpoint-required",
            scope: { target: "node", selector: { kind: "endpoint" } },
            rationale: "old migration",
            owner: "architecture-team",
            createdAt: "2026-08-01T00:00:00.000Z",
            expiresAt: "2026-08-23T00:00:00.000Z",
          },
          { id: "malformed", ruleId: "endpoint-required" },
        ],
      },
      snapshot({
        commitSha: "expired-fixture",
        nodes: [moduleNode("module:a")],
      }),
      { asOf: "2026-08-24T00:00:00.000Z" },
    );

    expect(result.status).toBe("violations");
    expect(result.violations.map((violation) => violation.id)).toEqual([
      "violation:endpoint-required",
    ]);
    expect(result.exceptions.map((exception) => exception.status)).toEqual([
      "expired",
      "malformed",
    ]);
    expect(result.exceptions.every((exception) => !exception.suppresses)).toBe(
      true,
    );
  });

  it("requires boundary ADR bindings and reports missing, stale, and mismatched references", () => {
    const policy = {
      policyId: "adr-boundary-policy",
      version: "1.0.0",
      rules: [
        {
          id: "core-module-required",
          target: "node" as const,
          selector: { id: "module:a" },
          assertion: "exists" as const,
        },
      ],
      adrBindings: [
        {
          schemaVersion: 1,
          contract: "cartograph.policy-adr-binding",
          id: "core-module-adr",
          ruleId: "core-module-required",
          requirement: "boundary",
          scope: { target: "node", selector: { id: "module:a" } },
          referenceId: "ADR-0001",
        },
      ],
    };
    const graph = snapshot({
      commitSha: "adr-boundary-fixture",
      nodes: [moduleNode("module:a"), moduleNode("module:b")],
    });
    const document = {
      schemaVersion: 1,
      references: [
        {
          id: "ADR-0001",
          file: "docs/adr/0001-typescript-first-semantic-adapter.md",
          title: "Start with a TypeScript 6 semantic adapter",
          status: "accepted",
          graphIds: ["module:b"],
        },
      ],
    };

    const missing = evaluatePolicyOnSnapshot(policy, graph);
    expect(missing.violations[0]).toMatchObject({
      id: "violation:adr-binding:core-module-adr",
      adrReferenceId: "ADR-0001",
      reason: "no local ADR reference document was supplied",
    });

    const mismatched = evaluatePolicyOnSnapshot(policy, graph, {
      adr: { document },
    });
    expect(mismatched.violations[0]?.id).toBe(
      "violation:adr-binding:core-module-adr",
    );
    expect(mismatched.violations[0]?.reason).toContain("does not cover");
    expect(mismatched.violations[0]?.evidenceRefs).toContain("node:module:a");

    const valid = evaluatePolicyOnSnapshot(
      {
        ...policy,
        adrBindings: [
          {
            ...policy.adrBindings[0],
            referenceId: "ADR-0002",
          },
        ],
      },
      graph,
      {
        adr: {
          document: {
            schemaVersion: 1,
            references: [
              {
                id: "ADR-0002",
                file: "docs/adr/0002-open-local-core.md",
                title: "Keep the complete local loop open",
                status: "accepted",
                graphIds: ["module:a"],
              },
            ],
          },
        },
      },
    );
    expect(valid.status).toBe("passed");
    expect(valid.violations).toEqual([]);
  });

  it("requires ADR references on planned exceptions and prevents mismatched suppression", () => {
    const basePolicy = {
      policyId: "adr-exception-policy",
      version: "1.0.0",
      mode: "enforce" as const,
      rules: [
        {
          id: "endpoint-required",
          target: "node" as const,
          selector: { kind: "endpoint" },
          assertion: "exists" as const,
        },
      ],
      adrBindings: [
        {
          schemaVersion: 1,
          contract: "cartograph.policy-adr-binding",
          id: "planned-endpoint-adr",
          ruleId: "endpoint-required",
          requirement: "planned-violation",
          scope: { target: "node", selector: { kind: "endpoint" } },
          referenceId: "ADR-0002",
        },
      ],
      exceptions: [
        {
          schemaVersion: 1,
          contract: "cartograph.policy-exception",
          id: "planned-endpoint",
          ruleId: "endpoint-required",
          scope: { target: "node", selector: { kind: "endpoint" } },
          rationale: "endpoint migration is scheduled",
          owner: "architecture-team",
          createdAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2026-12-01T00:00:00.000Z",
        },
      ],
    };
    const graph = snapshot({
      commitSha: "adr-exception-fixture",
      nodes: [moduleNode("module:a")],
    });
    const options = { asOf: "2026-08-24T00:00:00.000Z" };

    const missing = evaluatePolicyOnSnapshot(basePolicy, graph, options);
    expect(missing.status).toBe("violations");
    expect(missing.violations.map((violation) => violation.id)).toEqual([
      "violation:adr-binding:planned-endpoint-adr:planned-endpoint",
      "violation:endpoint-required",
    ]);
    expect(missing.violations[0]?.reason).toContain("ADR");
    expect(missing.exceptions[0]?.suppresses).toBe(false);

    const valid = evaluatePolicyOnSnapshot(
      {
        ...basePolicy,
        exceptions: [
          {
            ...basePolicy.exceptions[0],
            adrReferenceId: "ADR-0002",
          },
        ],
      },
      graph,
      {
        ...options,
        adr: {
          document: {
            schemaVersion: 1,
            references: [
              {
                id: "ADR-0002",
                file: "docs/adr/0002-open-local-core.md",
                title: "Keep the complete local loop open",
                status: "accepted",
                graphIds: ["module:a"],
              },
            ],
          },
        },
      },
    );
    expect(valid.status).toBe("passed");
    expect(valid.violations).toEqual([]);
    expect(valid.exceptions[0]).toMatchObject({
      adrReferenceId: "ADR-0002",
      suppresses: true,
    });
  });
});
