import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  createPolicyBundle,
  CURRENT_POLICY_BUNDLE_COMPATIBILITY,
  importPolicyBundle,
  POLICY_BUNDLE_MEDIA_TYPE,
  PolicyBundleSchema,
  PolicyBundleVerificationError,
  policySourceDigest,
  serializePolicyBundle,
  verifyPolicyBundle,
  type PolicyBundle,
  type PolicyRule,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const samplePath = resolve(repositoryRoot, "schema/policy-bundle.v0.1.json");
const sample = JSON.parse(readFileSync(samplePath, "utf8")) as PolicyBundle;

const rules: PolicyRule[] = [
  {
    id: "endpoint-count",
    target: "node",
    selector: "kind=endpoint",
    assertion: "count-at-most",
    effect: "informational",
    value: 20,
  },
  {
    id: "unknown-edge-free",
    target: "edge",
    selector: "kind=unknown",
    assertion: "absent",
    effect: "enforce",
  },
];

const draft = () => ({
  bundleId: "team-architecture-policy",
  policy: {
    id: "architecture-policy",
    version: "1.2.0",
    source: {
      path: "./.cartograph/policy.json",
      mediaType: POLICY_BUNDLE_MEDIA_TYPE,
      rules,
    },
  },
  owner: "architecture-maintainers",
  createdAt: "2026-08-24T00:00:00.000Z",
  expiresAt: "2026-12-31T23:59:59.000Z",
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const expectVerificationError = (
  callback: () => unknown,
  code: PolicyBundleVerificationError["code"],
) => {
  try {
    callback();
    throw new Error("expected policy bundle verification to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyBundleVerificationError);
    expect((error as PolicyBundleVerificationError).code).toBe(code);
  }
};

describe("digest-bound policy bundles", () => {
  it("creates deterministic bundles and binds the digest to canonical rules", () => {
    const first = createPolicyBundle(draft());
    const second = createPolicyBundle(draft());

    expect(first).toEqual(second);
    expect(first.policy.source.path).toBe(".cartograph/policy.json");
    expect(first.policy.source.digest).toBe(policySourceDigest(rules));
    expect(serializePolicyBundle(first)).toBe(serializePolicyBundle(second));
    expect(first.authority).toEqual({
      network: false,
      filesystem: false,
      execution: false,
    });
  });

  it("verifies the checked-in bundle offline against current compatibility", () => {
    const verification = verifyPolicyBundle(sample, {
      now: "2026-08-24T00:00:00.000Z",
    });

    expect(verification.digest).toEqual({
      expected: sample.policy.source.digest,
      actual: sample.policy.source.digest,
      verified: true,
    });
    expect(verification.compatibility).toEqual({
      expected: CURRENT_POLICY_BUNDLE_COMPATIBILITY,
      actual: sample.compatibility,
      verified: true,
    });
    expect(verification.authority).toEqual({
      network: false,
      filesystem: false,
      execution: false,
    });
    expect(
      importPolicyBundle(sample, { now: "2026-08-24T00:00:00.000Z" }),
    ).toEqual(sample);
  });

  it("rejects tampered source content, expired bundles, and incompatible versions", () => {
    const tampered = clone(sample);
    const firstRule = tampered.policy.source.rules[0];
    if (!firstRule) throw new Error("sample bundle has no first rule");
    tampered.policy.source.rules[0] = {
      ...firstRule,
      selector: "kind=service",
    };
    expectVerificationError(
      () => verifyPolicyBundle(tampered, { now: "2026-08-24T00:00:00.000Z" }),
      "digest-mismatch",
    );

    const expired = clone(sample);
    expired.createdAt = "2026-08-20T00:00:00.000Z";
    expired.expiresAt = "2026-08-23T23:59:59.000Z";
    expectVerificationError(
      () => verifyPolicyBundle(expired, { now: "2026-08-24T00:00:00.000Z" }),
      "expired",
    );

    const incompatible = clone(sample);
    incompatible.compatibility.bundleVersion = 2;
    expectVerificationError(
      () =>
        verifyPolicyBundle(incompatible, { now: "2026-08-24T00:00:00.000Z" }),
      "incompatible",
    );
  });

  it("fails closed on authority grants and unknown fields", () => {
    const authorityGrant = clone(sample);
    authorityGrant.authority.network = true as never;
    expectVerificationError(
      () => verifyPolicyBundle(authorityGrant),
      "authority",
    );

    const unknownField = clone(sample) as PolicyBundle & {
      policy: PolicyBundle["policy"] & { source: { untrustedScript: string } };
    };
    unknownField.policy.source.untrustedScript = "require('child_process')";
    expectVerificationError(() => verifyPolicyBundle(unknownField), "invalid");

    expect(() =>
      PolicyBundleSchema.parse({
        ...sample,
        policy: {
          ...sample.policy,
          source: { ...sample.policy.source, path: "file:///tmp/policy.json" },
        },
      }),
    ).toThrow();
  });

  it("keeps the JSON Schema and runtime contract aligned", () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "schema/policy-bundle.v0.1.schema.json"),
        "utf8",
      ),
    ) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(sample)).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
