import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  createPatchFilterReport,
  diffGraphSnapshots,
  evaluatePolicyOnDiff,
  parseGraphSnapshot,
  parsePatchFilterReport,
  serializePatchFilterReport,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = resolve(repositoryRoot, "test/fixtures/patch-filter");
const fixture = JSON.parse(
  readFileSync(resolve(fixtureRoot, "scenario.v0.1.json"), "utf8"),
) as {
  request: Record<string, unknown>;
  policy: Record<string, unknown>;
};

const build = (overrides: Record<string, unknown> = {}) => {
  const before = parseGraphSnapshot(
    JSON.parse(readFileSync(resolve(fixtureRoot, "before.graph.json"), "utf8")),
  );
  const after = parseGraphSnapshot(
    JSON.parse(readFileSync(resolve(fixtureRoot, "after.graph.json"), "utf8")),
  );
  const diff = diffGraphSnapshots(before, after);
  const policyEvaluation = evaluatePolicyOnDiff(fixture.policy, diff);
  return createPatchFilterReport({
    before,
    after,
    diff,
    request: { ...fixture.request, ...overrides },
    policyEvaluation,
  });
};

describe("patch-scoped graph and policy filtering", () => {
  it("selects rename evidence, one-hop context, and reports generated omissions", () => {
    const report = build();

    expect(report.selection.before.nodes.map((node) => node.id)).toEqual([
      "node-old",
      "node-context",
    ]);
    expect(report.selection.after.nodes.map((node) => node.id)).toEqual([
      "node-new",
      "node-context",
    ]);
    expect(report.selection.before.edges.map((edge) => edge.identity)).toEqual([
      "node-old|calls|node-context",
    ]);
    expect(report.selection.after.edges.map((edge) => edge.identity)).toEqual([
      "node-new|calls|node-context",
    ]);
    expect(report.selection.diff.identity.matches).toContain(
      "function:src/old.ts:handler=>function:src/new.ts:handler",
    );
    expect(report.omitted.files.map((file) => file.path)).toEqual([
      "generated/types.ts",
    ]);
    expect(
      report.omitted.regions.some(
        (region) =>
          region.identity === "file:generated/types.ts" &&
          region.reason === "generated-file",
      ),
    ).toBe(true);
    expect(report.policy).toMatchObject({
      source: "full-diff",
      status: "violations",
      preserved: true,
      omittedViolationIds: ["violation:unknown-edge-forbidden"],
    });
  });

  it("includes generated evidence only when explicitly requested", () => {
    const report = build({ includeGenerated: true });

    expect(report.omitted.files).toEqual([]);
    expect(report.selection.after.nodes.map((node) => node.id)).toContain(
      "node-generated",
    );
    expect(report.selection.after.edges.map((edge) => edge.identity)).toContain(
      "node-generated|unknown|node-context",
    );
    expect(report.policy.status).toBe("violations");
    expect(report.policy.omittedViolationIds).toEqual([]);
  });

  it("does not claim policy success when no full-diff evaluation is supplied", () => {
    const before = parseGraphSnapshot(
      JSON.parse(
        readFileSync(resolve(fixtureRoot, "before.graph.json"), "utf8"),
      ),
    );
    const after = parseGraphSnapshot(
      JSON.parse(
        readFileSync(resolve(fixtureRoot, "after.graph.json"), "utf8"),
      ),
    );
    const diff = diffGraphSnapshots(before, after);
    const report = createPatchFilterReport({
      before,
      after,
      diff,
      request: fixture.request,
    });

    expect(report.policy).toMatchObject({
      source: "not-provided",
      status: "not-provided",
      preserved: true,
    });
  });

  it("is deterministic and binds report serialization to its digest", () => {
    const first = build();
    const second = build();

    expect(serializePatchFilterReport(first)).toBe(
      serializePatchFilterReport(second),
    );
    expect(parsePatchFilterReport(first)).toEqual(first);
    expect(first.reportDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("fails closed on traversal, revision, and snapshot-policy conflicts", () => {
    expect(() =>
      build({
        changedFiles: [
          {
            path: "../outside.ts",
            status: "modified",
            generated: false,
          },
        ],
      }),
    ).toThrow(/patch filter request is invalid/u);

    const before = parseGraphSnapshot(
      JSON.parse(
        readFileSync(resolve(fixtureRoot, "before.graph.json"), "utf8"),
      ),
    );
    const after = parseGraphSnapshot(
      JSON.parse(
        readFileSync(resolve(fixtureRoot, "after.graph.json"), "utf8"),
      ),
    );
    const diff = diffGraphSnapshots(before, after);
    expect(() =>
      createPatchFilterReport({
        before,
        after,
        diff: { ...diff, fromRevision: { commitSha: "different" } },
        request: fixture.request,
      }),
    ).toThrow(/GraphDiff revisions must match/u);
    expect(() =>
      createPatchFilterReport({
        before,
        after,
        diff,
        request: fixture.request,
        policyEvaluation: {
          schemaVersion: 1,
          contract: "cartograph.policy-evaluation",
          policyId: "snapshot-policy",
          policyVersion: "1.0.0",
          inputKind: "snapshot",
          mode: "informational",
          status: "passed",
          evaluatedRules: 0,
          passedRules: 0,
          unsupportedRules: 0,
          violations: [],
          unsupported: [],
          exceptions: [],
        },
      }),
    ).toThrow(/full GraphDiff/u);
  });

  it("matches the published JSON Schema", () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "schema/patch-filter.v0.1.schema.json"),
        "utf8",
      ),
    ) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(build())).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
