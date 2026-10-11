import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import * as api from "../../src/core/index.js";
import { createBundle, replayBundle } from "../../src/bundle-command.js";
import { createAjv } from "../../scripts/json-schema.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const script = join(repositoryRoot, "scripts/replay-offline-smoke.sh");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const run = (isolate?: string) => {
  const root = mkdtempSync(join(tmpdir(), "cartograph-offline-gate-"));
  roots.push(root);
  const work = join(root, "evidence");
  const env = { ...process.env };
  delete env.REPLAY_ISOLATE;
  if (isolate !== undefined) env.REPLAY_ISOLATE = isolate;
  const child = spawnSync("bash", [script, work], {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { child, work };
};

describe("offline replay smoke isolation gate", () => {
  it("rejects missing isolation before creating output", () => {
    const { child, work } = run();
    expect(child.status, child.stderr).toBe(2);
    expect(child.stderr).toContain("REPLAY_ISOLATE is required");
    expect(existsSync(work)).toBe(false);
  });

  it("rejects a prefix that leaves networking available and retains the probe", () => {
    const { child, work } = run("env");
    expect(child.status, child.stderr).toBe(2);
    expect(child.stderr).toContain("network isolation probe failed");
    expect(
      JSON.parse(readFileSync(join(work, "isolation.json"), "utf8")),
    ).toMatchObject({
      ok: false,
      control: { connected: true },
      isolated: { connected: true },
    });
    expect(existsSync(join(work, "consumer"))).toBe(false);
  });
});

type ReplayScenario = {
  id: string;
  directory: string;
  status: number;
  signature?: string;
  checks: string[];
};

type SmokeHelper = {
  REPLAY_AS_OF: string;
  createReplayCases: (
    core: typeof api,
    create: (
      output: string,
      artifacts: { role: string; path: string }[],
    ) => Promise<void>,
    directory: string,
  ) => Promise<ReplayScenario[]>;
  checkReplayResult: (
    scenario: ReplayScenario,
    child: { status: number },
    report: Awaited<ReturnType<typeof replayBundle>>,
  ) => void;
};

describe("signed offline replay fixture coverage", () => {
  it("covers complete signed/unsigned replay and separates trust, integrity and derivation failures", async () => {
    const helperPath = join(repositoryRoot, "scripts/replay-offline-smoke.mjs");
    const helper = (await import(
      pathToFileURL(helperPath).href
    )) as SmokeHelper;
    const root = mkdtempSync(join(tmpdir(), "cartograph-signed-replay-"));
    roots.push(root);
    const cases = await helper.createReplayCases(
      api,
      async (output, artifacts) => {
        await createBundle({
          output,
          artifacts,
          missing: [],
          toolVersion: "0.1.1",
        });
      },
      join(root, "cases"),
    );
    expect(cases.map((scenario) => scenario.id)).toEqual([
      "signed",
      "unsigned",
      "wrong-key",
      "untrusted-root",
      "changed-artifact",
      "derivation-mismatch",
    ]);
    const validate = createAjv({ allErrors: true }).compile(
      JSON.parse(
        readFileSync(
          join(repositoryRoot, "schema/bundle-replay.v0.1.schema.json"),
          "utf8",
        ),
      ) as object,
    );
    for (const scenario of cases) {
      const report = await replayBundle(
        join(scenario.directory, "bundle"),
        scenario.id === "unsigned"
          ? undefined
          : {
              signature: join(scenario.directory, "signature.json"),
              keyring: join(scenario.directory, "keyring.json"),
              trustRoots: [
                scenario.id === "untrusted-root"
                  ? "untrusted-fixture-root"
                  : "offline-replay-fixture-root",
              ],
              asOf: helper.REPLAY_AS_OF,
            },
      );
      expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
      expect(() =>
        helper.checkReplayResult(
          scenario,
          { status: report.ok ? 0 : 2 },
          report,
        ),
      ).not.toThrow();
      expect(
        report.checks.map((check) => `${check.role}:${check.status}`),
      ).toEqual(scenario.checks);
      expect(report.verification.signature?.code).toBe(scenario.signature);
      if (scenario.id === "derivation-mismatch") {
        expect(report.verification.ok).toBe(true);
        expect(report.checks[1]?.bundledSha256).not.toBe(
          report.checks[1]?.regeneratedSha256,
        );
      }
      const keyring = readFileSync(
        join(scenario.directory, "keyring.json"),
        "utf8",
      );
      const publicKey = (
        JSON.parse(keyring) as { keys: { publicKey: string }[] }
      ).keys[0]?.publicKey;
      expect(keyring).not.toContain("PRIVATE KEY");
      expect(JSON.stringify(report)).not.toContain(publicKey);
      expect(
        statSync(join(scenario.directory, "keyring.json")).mode & 0o777,
      ).toBe(0o600);
      expect(
        statSync(join(scenario.directory, "signature.json")).mode & 0o777,
      ).toBe(0o600);
    }
    expect(existsSync(join(root, "cases/producer"))).toBe(false);
  });
});
