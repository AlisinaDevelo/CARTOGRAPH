import { describe, expect, it } from "vitest";

import {
  createGraphSnapshot,
  reconcileGraphNodeIdentities,
  serializeIdentityReconciliation,
} from "../../src/core/index.js";

const sourceEvidence = (id: string) => ({
  id,
  kind: "source" as const,
  path: "src/caller.ts",
  line: 1,
  detector: "cartograph.identity-test@1",
  contentHash: "0".repeat(64),
});

type NodeOptions = {
  id: string;
  stableKey: string;
  name: string;
  path?: string;
  line?: number;
};

const node = ({ id, stableKey, name, path, line }: NodeOptions) => ({
  id,
  stableKey,
  kind: "function" as const,
  name,
  language: "typescript",
  ...(path && line !== undefined ? { location: { path, line } } : {}),
});

const snapshot = (
  nodes: readonly unknown[],
  edges: readonly Record<string, unknown>[] = [],
) =>
  createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha: "identity-test" },
    nodes,
    edges,
    diagnostics: [],
  });

describe("graph node identity reconciliation", () => {
  it("preserves exact identity when only a source line moves", () => {
    const before = snapshot([
      node({
        id: "before-node",
        stableKey: "function:src/a.ts:load",
        name: "load",
        path: "src/a.ts",
        line: 4,
      }),
    ]);
    const after = snapshot([
      node({
        id: "after-node",
        stableKey: "function:src/a.ts:load",
        name: "load",
        path: "src/a.ts",
        line: 19,
      }),
    ]);

    const result = reconcileGraphNodeIdentities(before, after);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      beforeStableKey: "function:src/a.ts:load",
      afterStableKey: "function:src/a.ts:load",
      method: "stable-key",
      confidence: "exact",
      signals: ["same-kind", "stable-key"],
    });
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("matches a unique same-name function after a file move", () => {
    const before = snapshot([
      node({
        id: "old-node",
        stableKey: "function:src/old.ts:load",
        name: "load",
      }),
    ]);
    const after = snapshot([
      node({
        id: "new-node",
        stableKey: "function:src/new.ts:load",
        name: "load",
      }),
    ]);

    const result = reconcileGraphNodeIdentities(before, after);

    expect(result.matches[0]).toMatchObject({
      beforeStableKey: "function:src/old.ts:load",
      afterStableKey: "function:src/new.ts:load",
      method: "same-name",
      confidence: "strong",
    });
    expect(result.ambiguous).toEqual([]);
  });

  it("matches a supported rename through an unchanged neighborhood", () => {
    const caller = node({
      id: "caller",
      stableKey: "function:src/caller.ts:run",
      name: "run",
    });
    const beforeTarget = node({
      id: "before-target",
      stableKey: "function:src/target.ts:load",
      name: "load",
    });
    const afterTarget = node({
      id: "after-target",
      stableKey: "function:src/target.ts:loadAll",
      name: "loadAll",
    });
    const before = snapshot(
      [caller, beforeTarget],
      [
        {
          from: caller.id,
          to: beforeTarget.id,
          kind: "calls",
          confidence: "certain",
          evidence: [sourceEvidence("caller-edge")],
        },
      ],
    );
    const after = snapshot(
      [caller, afterTarget],
      [
        {
          from: caller.id,
          to: afterTarget.id,
          kind: "calls",
          confidence: "certain",
          evidence: [sourceEvidence("caller-edge")],
        },
      ],
    );

    const result = reconcileGraphNodeIdentities(before, after);

    expect(result.matches).toHaveLength(2);
    const renamed = result.matches.find(
      (match) => match.before.id === "before-target",
    );
    expect(renamed).toMatchObject({
      beforeStableKey: "function:src/target.ts:load",
      afterStableKey: "function:src/target.ts:loadAll",
      method: "neighborhood",
      confidence: "strong",
    });
    expect(renamed?.signals).toContain("same-neighborhood");
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("reports equal candidates instead of guessing among duplicate names", () => {
    const before = snapshot([
      node({
        id: "before-a",
        stableKey: "function:src/a.ts:load",
        name: "load",
      }),
      node({
        id: "before-b",
        stableKey: "function:src/b.ts:load",
        name: "load",
      }),
    ]);
    const after = snapshot([
      node({
        id: "after-c",
        stableKey: "function:src/c.ts:load",
        name: "load",
      }),
      node({
        id: "after-d",
        stableKey: "function:src/d.ts:load",
        name: "load",
      }),
    ]);

    const result = reconcileGraphNodeIdentities(before, after);

    expect(result.matches).toEqual([]);
    expect(result.ambiguous).toHaveLength(2);
    expect(result.ambiguous.map((item) => item.reason)).toEqual([
      "equal-score",
      "equal-score",
    ]);
    expect(result.ambiguous[0]?.candidates).toHaveLength(2);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("serializes the same reconciliation regardless of graph ordering", () => {
    const before = snapshot([
      node({
        id: "before-node",
        stableKey: "function:src/old.ts:load",
        name: "load",
      }),
      node({
        id: "caller",
        stableKey: "function:src/caller.ts:run",
        name: "run",
      }),
    ]);
    const after = snapshot([
      node({
        id: "after-node",
        stableKey: "function:src/new.ts:load",
        name: "load",
      }),
      node({
        id: "caller",
        stableKey: "function:src/caller.ts:run",
        name: "run",
      }),
    ]);
    const reorderedBefore = snapshot([...before.nodes].reverse());
    const reorderedAfter = snapshot([...after.nodes].reverse());

    expect(
      serializeIdentityReconciliation(
        reconcileGraphNodeIdentities(before, after),
      ),
    ).toBe(
      serializeIdentityReconciliation(
        reconcileGraphNodeIdentities(reorderedBefore, reorderedAfter),
      ),
    );
  });
});
