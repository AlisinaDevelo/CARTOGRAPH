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
});
