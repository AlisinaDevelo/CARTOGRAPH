import Ajv from "ajv";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  LocalPolicyRuleSchema,
  PolicyConfigValidationError,
  parsePolicyConfig,
  readPolicyConfig,
  serializePolicyConfig,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const schema = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/policy.v0.1.schema.json"),
    "utf8",
  ),
) as object;
const sample = JSON.parse(
  readFileSync(resolve(repositoryRoot, "schema/policy.v0.1.json"), "utf8"),
) as unknown;

describe("local policy configuration", () => {
  it("validates the published schema and covers node, edge, and diff rules", () => {
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(sample)).toBe(true);
    expect(validate.errors).toBeNull();

    const parsed = parsePolicyConfig(sample);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      policyId: "baseline-local-policy",
      version: "0.1.0",
      mode: "informational",
    });
    expect(new Set(parsed.rules.map((rule) => rule.target))).toEqual(
      new Set(["node", "edge", "diff"]),
    );
    expect(serializePolicyConfig(parsed)).toBe(serializePolicyConfig(sample));
  });

  it("defaults to informational and rejects invalid or unbounded rule shapes", () => {
    const parsed = parsePolicyConfig({
      policyId: "local-policy",
      version: "1.0.0",
      rules: [
        {
          id: "endpoint-presence",
          target: "node",
          selector: { kind: "endpoint" },
          assertion: "exists",
        },
      ],
    });
    expect(parsed.mode).toBe("informational");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.scope).toBe("repository");
    expect(parsed.precedence).toBe(0);
    expect(parsed.overrideLimit).toBe(0);
    expect(parsed.includes).toEqual([]);

    expect(
      LocalPolicyRuleSchema.safeParse({
        id: "endpoint-count",
        target: "node",
        selector: { kind: "endpoint" },
        assertion: "count-at-most",
      }).success,
    ).toBe(false);
    expect(() =>
      parsePolicyConfig({
        schemaVersion: 1,
        policyId: "local-policy",
        version: "1.0.0",
        rules: [
          {
            id: "remote-rule",
            target: "node",
            selector: { kind: "endpoint", url: "https://example.invalid" },
            assertion: "exists",
          },
        ],
      }),
    ).toThrow(PolicyConfigValidationError);
  });

  it("reads only an in-repository local JSON policy file", () => {
    const root = mkdtempSync(join(tmpdir(), "cartograph-policy-test-"));
    try {
      writeFileSync(join(root, "policy.json"), JSON.stringify(sample), "utf8");
      expect(readPolicyConfig(root, "policy.json").policyId).toBe(
        "baseline-local-policy",
      );
      expect(() => readPolicyConfig(root, "../policy.json")).toThrow(
        /repository-relative local file/u,
      );
      expect(() =>
        readPolicyConfig(root, "https://example.invalid/policy.json"),
      ).toThrow(/repository-relative local file/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
