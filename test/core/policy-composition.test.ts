import Ajv from "ajv";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  composePolicyConfig,
  PolicyCompositionError,
  PolicyCompositionSchema,
  serializePolicyComposition,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const compositionSchema = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/policy-composition.v0.1.schema.json"),
    "utf8",
  ),
) as object;
const policySchema = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/policy.v0.1.schema.json"),
    "utf8",
  ),
) as object;

type PolicyFile = Record<string, unknown>;

const rule = (
  id: string,
  assertion:
    "exists" | "absent" | "count-at-most" | "count-at-least" = "exists",
  selector: Record<string, string> = { kind: "endpoint" },
  value?: number,
): Record<string, unknown> => ({
  id,
  target: "node",
  selector,
  assertion,
  ...(value === undefined ? {} : { value }),
});

const policy = (
  policyId: string,
  rules: Record<string, unknown>[],
  options: Record<string, unknown> = {},
): PolicyFile => ({
  schemaVersion: 1,
  policyId,
  version: "1.0.0",
  rules,
  ...options,
});

const writePolicies = (
  files: Record<string, PolicyFile>,
): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "cartograph-policy-composition-"));
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(root, path), JSON.stringify(content), "utf8");
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

const expectCompositionError = (
  files: Record<string, PolicyFile>,
  rootPath: string,
  code: PolicyCompositionError["code"],
  evidence: string[],
): void => {
  const scenario = writePolicies(files);
  try {
    let thrown: unknown;
    try {
      composePolicyConfig(scenario.root, rootPath);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PolicyCompositionError);
    const compositionError = thrown as PolicyCompositionError;
    expect(compositionError.code).toBe(code);
    expect(compositionError.evidenceRefs.length).toBeGreaterThan(0);
    for (const reference of evidence) {
      expect(compositionError.evidenceRefs).toContain(reference);
    }
  } finally {
    scenario.cleanup();
  }
};

describe("local policy composition", () => {
  it("selects deterministic authorized overrides and validates the published schema", () => {
    const scenario = writePolicies({
      "root.json": policy(
        "root-policy",
        [rule("root-sentinel", "exists", { kind: "module" })],
        {
          includes: [{ path: "child.json" }, { path: "base.json" }],
        },
      ),
      "base.json": policy(
        "base-policy",
        [
          rule("endpoint-limit", "count-at-most", { kind: "endpoint" }, 10),
          rule("endpoint-required"),
        ],
        { precedence: 10 },
      ),
      "child.json": policy(
        "child-policy",
        [
          rule("endpoint-limit", "count-at-most", { kind: "endpoint" }, 5),
          rule("endpoint-required"),
        ],
        { precedence: 20, overrideLimit: 1 },
      ),
    });
    try {
      const composition = composePolicyConfig(scenario.root, "root.json");
      const parsed = PolicyCompositionSchema.parse(composition);
      const ajv = new Ajv({ allErrors: true });
      ajv.addSchema(policySchema);
      const validate = ajv.compile(compositionSchema);

      expect(validate(parsed)).toBe(true);
      expect(validate.errors).toBeNull();
      expect(parsed.sources.map((source) => source.path)).toEqual([
        "base.json",
        "child.json",
        "root.json",
      ]);
      expect(parsed.policy.includes).toEqual([]);
      expect(parsed.policy.rules.map((item) => item.id)).toEqual([
        "endpoint-limit",
        "endpoint-required",
        "root-sentinel",
      ]);
      expect(parsed.overrides).toEqual([
        {
          ruleId: "endpoint-limit",
          winnerPath: "child.json",
          loserPath: "base.json",
          winnerPrecedence: 20,
          loserPrecedence: 10,
        },
      ]);
      expect(serializePolicyComposition(parsed)).toBe(
        serializePolicyComposition(
          composePolicyConfig(scenario.root, "root.json"),
        ),
      );
    } finally {
      scenario.cleanup();
    }
  });

  it("keeps contradictory selectors independent across scopes", () => {
    const scenario = writePolicies({
      "root.json": policy(
        "scope-root",
        [rule("root-rule", "exists", { kind: "module" })],
        {
          includes: [{ path: "frontend.json" }, { path: "backend.json" }],
        },
      ),
      "frontend.json": policy(
        "frontend-policy",
        [rule("frontend-endpoint", "exists")],
        { scope: "frontend" },
      ),
      "backend.json": policy(
        "backend-policy",
        [rule("backend-endpoint", "absent")],
        { scope: "backend" },
      ),
    });
    try {
      const composition = composePolicyConfig(scenario.root, "root.json");
      expect(composition.policy.rules.map((item) => item.id)).toEqual([
        "backend-endpoint",
        "frontend-endpoint",
        "root-rule",
      ]);
      expect(composition.overrides).toEqual([]);
    } finally {
      scenario.cleanup();
    }
  });

  it("rejects duplicate IDs, unauthorized overrides, ties, cycles, duplicates, and contradictions with evidence", () => {
    expectCompositionError(
      {
        "root.json": policy("duplicate-local", [
          rule("duplicate-rule"),
          rule("duplicate-rule", "absent"),
        ]),
      },
      "root.json",
      "duplicate-rule-id",
      ["policy-file:root.json", "policy-rule:duplicate-rule"],
    );
    expectCompositionError(
      {
        "root.json": policy("tie-root", [rule("root-rule")], {
          includes: [{ path: "left.json" }, { path: "right.json" }],
        }),
        "left.json": policy("left", [rule("shared-rule")], { precedence: 10 }),
        "right.json": policy("right", [rule("shared-rule", "absent")], {
          precedence: 10,
        }),
      },
      "root.json",
      "precedence-conflict",
      [
        "policy-file:left.json",
        "policy-file:right.json",
        "conflict:rule-id:shared-rule",
      ],
    );
    expectCompositionError(
      {
        "root.json": policy("override-root", [rule("root-rule")], {
          includes: [{ path: "base.json" }, { path: "child.json" }],
        }),
        "base.json": policy("base", [rule("shared-rule")], { precedence: 10 }),
        "child.json": policy("child", [rule("shared-rule", "absent")], {
          precedence: 20,
        }),
      },
      "root.json",
      "override-limit",
      [
        "policy-file:child.json",
        "policy-rule:shared-rule",
        "override-limit:child.json",
      ],
    );
    expectCompositionError(
      {
        "root.json": policy("cycle-root", [rule("root-rule")], {
          includes: [{ path: "child.json" }],
        }),
        "child.json": policy("cycle-child", [rule("child-rule")], {
          includes: [{ path: "root.json" }],
        }),
      },
      "root.json",
      "include-cycle",
      ["policy-file:root.json", "policy-file:child.json"],
    );
    expectCompositionError(
      {
        "root.json": policy("contradiction-root", [rule("root-rule")], {
          includes: [{ path: "required.json" }, { path: "forbidden.json" }],
        }),
        "required.json": policy("required", [rule("required-rule")]),
        "forbidden.json": policy("forbidden", [
          rule("forbidden-rule", "absent"),
        ]),
      },
      "root.json",
      "contradictory-rules",
      [
        "policy-rule:required-rule",
        "policy-rule:forbidden-rule",
        "policy-scope:repository",
      ],
    );
    expectCompositionError(
      {
        "root.json": policy("duplicate-include", [rule("root-rule")], {
          includes: [{ path: "base.json" }, { path: "base.json" }],
        }),
        "base.json": policy("base", [rule("base-rule")]),
      },
      "root.json",
      "duplicate-include",
      ["policy-file:root.json", "conflict:duplicate-include"],
    );
    expectCompositionError(
      {
        "root.json": policy("remote-include", [rule("root-rule")], {
          includes: [{ path: "https://example.invalid/policy.json" }],
        }),
      },
      "root.json",
      "invalid-source",
      ["policy-file:root.json"],
    );
  });

  it("turns an invalid root path into an evidence-bearing configuration error", () => {
    expectCompositionError(
      { "root.json": policy("root", [rule("root-rule")]) },
      "../root.json",
      "invalid-source",
      ["policy-path:../root.json"],
    );
  });
});
