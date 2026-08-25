import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/upgrade-policy.mjs");
const policyPath = resolve(repositoryRoot, "schema/upgrade-policy.v0.1.json");

const run = (path = policyPath) =>
  JSON.parse(
    execFileSync(process.execPath, [scriptPath, "validate", "--policy", path], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }),
  ) as {
    ok: boolean;
    contract: string;
    schemaVersion: number;
    policyId: string;
    checks: number;
    owner: string;
  };

const withMutatedPolicy = (
  mutate: (policy: Record<string, unknown>) => void,
  callback: (path: string) => void,
) => {
  const directory = mkdtempSync(join(tmpdir(), "cartograph-upgrade-policy-"));
  const path = join(directory, "policy.json");
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as Record<
    string,
    unknown
  >;
  mutate(policy);
  writeFileSync(path, JSON.stringify(policy));
  try {
    callback(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("upgrade policy", () => {
  it("cross-checks published support, compatibility, adapter, and ownership data", () => {
    expect(run()).toMatchObject({
      ok: true,
      contract: "cartograph.upgrade-policy",
      schemaVersion: 1,
      policyId: "cartograph-public-upgrade-policy",
      checks: 20,
      owner: "@AlisinaDevelo",
    });
  });

  it("fails when the policy drifts from the support matrix", () => {
    withMutatedPolicy(
      (policy) => {
        const support = policy.support as Record<string, unknown>;
        support.nodeMinimum = "99.0.0";
      },
      (path) => {
        expect(() => run(path)).toThrow(/support node minimum/u);
      },
    );
  });

  it("fails when the policy drifts from the adapter contract", () => {
    withMutatedPolicy(
      (policy) => {
        const compatibility = policy.compatibility as Record<string, unknown>;
        compatibility.adapterApi = 2;
      },
      (path) => {
        expect(() => run(path)).toThrow(/adapter schema apiVersion/u);
      },
    );
  });
});
