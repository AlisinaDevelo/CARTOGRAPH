import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ArchitectureImpactAssessmentSchema,
  assessArchitectureImpact,
  createGraphSnapshot,
  serializeArchitectureImpactAssessment,
} from "../../src/core/index.js";
import { ResourceLimitError } from "../../src/resources.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const evidence = (id: string, path = "src/handler.ts", line = 1) => ({
  id,
  kind: "source" as const,
  path,
  line,
  detector: "cartograph.impact-test@1",
  contentHash: "c".repeat(64),
});

const graph = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "impact-model-test" },
  nodes: [
    {
      id: "function:root",
      stableKey: "function:root",
      kind: "function",
      name: "root",
      language: "typescript",
    },
    {
      id: "function:child",
      stableKey: "function:child",
      kind: "function",
      name: "child",
      language: "typescript",
    },
    {
      id: "external_service:api",
      stableKey: "external_service:api",
      kind: "external_service",
      name: "api",
      language: "typescript",
    },
    {
      id: "queue:events",
      stableKey: "queue:events",
      kind: "queue",
      name: "events",
      language: "typescript",
    },
  ],
  edges: [
    {
      from: "function:root",
      to: "function:child",
      kind: "calls",
      confidence: "certain",
      evidence: [evidence("edge-root-child")],
    },
    {
      from: "function:child",
      to: "external_service:api",
      kind: "requests",
      confidence: "inferred",
      evidence: [evidence("edge-child-api")],
    },
    {
      from: "function:root",
      to: "queue:events",
      kind: "publishes",
      confidence: "inferred",
      evidence: [],
      unresolvedReason: "queue selected by deployment configuration",
    },
  ],
  diagnostics: [],
});

describe("architecture impact model", () => {
  it("preserves paths, confidence, evidence, and boundary uncertainty", () => {
    const assessment = assessArchitectureImpact(graph, {
      schemaVersion: 1,
      contract: "cartograph.architecture-impact",
      scenarioId: "boundary-test",
      change: {
        kind: "node-changed",
        roots: ["function:root"],
        evidenceIds: ["git:root-change"],
      },
      traversal: {
        direction: "forward",
        boundary: { stopNodeKinds: ["external_service"] },
      },
    });

    expect(assessment.affected.map((node) => node.id)).toEqual([
      "function:root",
      "function:child",
      "queue:events",
      "external_service:api",
    ]);
    expect(assessment.affected[3]).toMatchObject({
      confidence: "inferred",
      evidenceIds: ["edge-child-api", "edge-root-child", "git:root-change"],
      uncertainty: [
        {
          code: "boundary-stop",
          evidenceIds: ["edge-child-api"],
        },
      ],
    });
    expect(assessment.affected[2]?.uncertainty[0]?.code).toBe(
      "unresolved-edge",
    );
    expect(assessment.unknowns.map((unknown) => unknown.code)).toEqual([
      "boundary-stop",
      "unresolved-edge",
    ]);
    expect(ArchitectureImpactAssessmentSchema.parse(assessment)).toEqual(
      assessment,
    );
  });

  it("fails closed for unsupported changes and excluded edge kinds", () => {
    const unsupported = assessArchitectureImpact(graph, {
      schemaVersion: 1,
      contract: "cartograph.architecture-impact",
      scenarioId: "unsupported-test",
      change: { kind: "unsupported", roots: ["function:root"] },
      traversal: {},
    });
    expect(unsupported.affected).toEqual([]);
    expect(unsupported.unknowns[0]).toMatchObject({
      code: "unsupported-change",
      traversed: false,
    });

    const callsOnly = assessArchitectureImpact(graph, {
      schemaVersion: 1,
      contract: "cartograph.architecture-impact",
      scenarioId: "calls-only-test",
      change: { kind: "node-added", roots: ["function:root"] },
      traversal: { edgeKinds: ["calls"] },
    });
    expect(callsOnly.affected.map((node) => node.id)).toEqual([
      "function:root",
      "function:child",
    ]);
    expect(
      callsOnly.unknowns.filter(
        (unknown) => unknown.code === "edge-kind-excluded",
      ),
    ).toHaveLength(2);
  });

  it("is byte-stable under graph and scenario ordering changes", () => {
    const input = {
      schemaVersion: 1,
      contract: "cartograph.architecture-impact",
      scenarioId: "stable-test",
      change: { kind: "node-changed", roots: ["function:root"] },
      traversal: { direction: "forward", maxDepth: 1 },
    };
    const first = assessArchitectureImpact(graph, input);
    const reordered = createGraphSnapshot({
      ...graph,
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    });
    const second = assessArchitectureImpact(reordered, {
      ...input,
      change: { ...input.change, roots: ["function:root"] },
    });
    expect(serializeArchitectureImpactAssessment(first)).toBe(
      serializeArchitectureImpactAssessment(second),
    );
  });

  it("fails closed at the configured node and edge ceilings", () => {
    expect(() =>
      assessArchitectureImpact(graph, {
        schemaVersion: 1,
        contract: "cartograph.architecture-impact",
        scenarioId: "node-ceiling-test",
        change: { kind: "node-changed", roots: ["function:root"] },
        traversal: { maxNodes: 1 },
      }),
    ).toThrowError(
      new ResourceLimitError(
        "impact assessment exceeds the 1 node ceiling; reduce roots or maxDepth",
      ),
    );

    expect(() =>
      assessArchitectureImpact(graph, {
        schemaVersion: 1,
        contract: "cartograph.architecture-impact",
        scenarioId: "edge-ceiling-test",
        change: { kind: "node-changed", roots: ["function:root"] },
        traversal: { maxEdges: 1 },
      }),
    ).toThrowError(
      new ResourceLimitError(
        "impact assessment exceeds the 1 edge ceiling; reduce roots or maxDepth",
      ),
    );
  });

  it("publishes the checked-in golden evaluator without network or execution", () => {
    const script = readFileSync(
      resolve(repositoryRoot, "scripts/impact-evaluation.mjs"),
      "utf8",
    );
    expect(script).not.toMatch(/\bfetch\b/u);
    expect(script).not.toContain("child_process");
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve(repositoryRoot, "scripts/impact-evaluation.mjs"),
        "validate",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      contract: "cartograph.architecture-impact-evaluation",
      fixtureId: "q004-v0.1",
      cases: 6,
      falsePositives: 2,
      falseNegatives: 0,
      precision: 8 / 9,
      recall: 1,
      deterministic: true,
      readOnly: true,
    });
  });
});
