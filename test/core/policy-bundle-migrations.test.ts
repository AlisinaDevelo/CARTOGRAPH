import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  evaluatePolicyBundleMigration,
  PolicyBundleMigrationError,
  PolicyBundleMigrationReportSchema,
  PolicyBundleRevocationListSchema,
  serializePolicyBundleMigrationReport,
  policySourceDigest,
  type EvaluatePolicyBundleMigrationOptions,
  type PolicyBundle,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const baseBundle = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/policy-bundle.v0.1.json"),
    "utf8",
  ),
) as PolicyBundle;
const fixture = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "test/fixtures/policy-bundles/migrations.v0.1.json",
    ),
    "utf8",
  ),
) as {
  cases: Array<{
    id: string;
    scenario: string;
    targetPolicyVersion?: string;
    now?: string;
    createdAt?: string;
    expiresAt?: string;
    revokedDigests?: string[];
    selector?: string;
    ownerPresent?: boolean;
    expectedCodes: string[];
  }>;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const caseBundle = (scenario: (typeof fixture.cases)[number]): PolicyBundle => {
  const bundle = clone(baseBundle);
  if (scenario.createdAt) bundle.createdAt = scenario.createdAt;
  if (scenario.expiresAt) bundle.expiresAt = scenario.expiresAt;
  if (scenario.selector) {
    const firstRule = bundle.policy.source.rules[0];
    if (!firstRule) throw new Error("base bundle has no first rule");
    bundle.policy.source.rules[0] = {
      ...firstRule,
      selector: scenario.selector,
    };
    bundle.policy.source.digest = policySourceDigest(
      bundle.policy.source.rules,
    );
  }
  if (scenario.ownerPresent === false)
    delete (bundle as Record<string, unknown>).owner;
  return bundle;
};

describe("policy-bundle migrations", () => {
  it("covers version upgrade, expiry, revocation, selectors, and owners with digest-only reports", () => {
    for (const scenario of fixture.cases) {
      const report = evaluatePolicyBundleMigration(caseBundle(scenario), {
        ...({
          ...(scenario.targetPolicyVersion
            ? { targetPolicyVersion: scenario.targetPolicyVersion }
            : {}),
          ...(scenario.now ? { now: scenario.now } : {}),
          ...(scenario.revokedDigests
            ? { revokedDigests: scenario.revokedDigests }
            : {}),
        } satisfies EvaluatePolicyBundleMigrationOptions),
      });
      expect(report.findings.map((finding) => finding.code)).toEqual(
        scenario.expectedCodes,
      );
      expect(report.digestOnly).toBe(true);
      expect(serializePolicyBundleMigrationReport(report)).not.toContain(
        "policy.json",
      );
      expect(serializePolicyBundleMigrationReport(report)).not.toContain(
        "kind=endpoint",
      );
    }
  });

  it("refuses to enforce an unreviewed incompatible selector and permits an explicitly reviewed migration", () => {
    const scenario = fixture.cases.find(
      (candidate) => candidate.scenario === "incompatible-selector",
    );
    if (!scenario) throw new Error("incompatible selector fixture is missing");
    const bundle = caseBundle(scenario);

    expect(() =>
      evaluatePolicyBundleMigration(bundle, {
        mode: "enforce",
        now: "2026-08-24T00:00:00.000Z",
      }),
    ).toThrowError(PolicyBundleMigrationError);
    try {
      evaluatePolicyBundleMigration(bundle, {
        mode: "enforce",
        now: "2026-08-24T00:00:00.000Z",
      });
    } catch (error) {
      expect((error as PolicyBundleMigrationError).code).toBe(
        "enforcement-blocked",
      );
      expect((error as PolicyBundleMigrationError).report?.status).toBe(
        "review-required",
      );
    }

    const reviewed = evaluatePolicyBundleMigration(bundle, {
      mode: "enforce",
      reviewed: true,
      now: "2026-08-24T00:00:00.000Z",
    });
    expect(reviewed.enforceable).toBe(true);
    expect(reviewed.status).toBe("migration-required");
  });

  it("blocks expired, revoked, and ownerless bundles even when review is asserted", () => {
    const expired = clone(baseBundle);
    expired.createdAt = "2026-08-20T00:00:00.000Z";
    expired.expiresAt = "2026-08-23T23:59:59.000Z";
    expect(
      evaluatePolicyBundleMigration(expired, {
        reviewed: true,
        now: "2026-08-24T00:00:00.000Z",
      }).enforceable,
    ).toBe(false);

    expect(
      evaluatePolicyBundleMigration(baseBundle, {
        reviewed: true,
        revokedDigests: [baseBundle.policy.source.digest],
        now: "2026-08-24T00:00:00.000Z",
      }).status,
    ).toBe("blocked");

    const ownerless = clone(baseBundle);
    delete (ownerless as Record<string, unknown>).owner;
    expect(
      evaluatePolicyBundleMigration(ownerless, {
        reviewed: true,
        now: "2026-08-24T00:00:00.000Z",
      }).findings.map((finding) => finding.code),
    ).toEqual(["missing-owner"]);
  });

  it("validates revocation and report schemas", () => {
    expect(
      PolicyBundleRevocationListSchema.parse({
        schemaVersion: 1,
        revokedDigests: [baseBundle.policy.source.digest],
      }),
    ).toMatchObject({ schemaVersion: 1 });
    expect(() =>
      PolicyBundleRevocationListSchema.parse({
        schemaVersion: 1,
        revokedDigests: ["sha256:BAD"],
      }),
    ).toThrow();

    const report = evaluatePolicyBundleMigration(baseBundle, {
      now: "2026-08-24T00:00:00.000Z",
    });
    const schema = JSON.parse(
      readFileSync(
        resolve(
          repositoryRoot,
          "schema/policy-bundle-migration.v0.1.schema.json",
        ),
        "utf8",
      ),
    ) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(report)).toBe(true);
    expect(PolicyBundleMigrationReportSchema.parse(report)).toEqual(report);
  });
});
