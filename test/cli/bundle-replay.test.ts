import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAjv } from "../../scripts/json-schema.mjs";

import { createBundle, replayBundle } from "../../src/bundle-command.js";
import {
  diffGraphSnapshots,
  evaluatePolicyOnDiff,
  evaluatePolicyOnSnapshot,
  serializeGraphDiff,
  serializeGraphSnapshot,
  serializePolicyEvaluation,
  stableStringify,
} from "../../src/core/index.js";
import {
  decisions,
  policy,
  snapshot as head,
} from "../core/control-evidence.fixtures.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

const base = { ...head, revision: { commitSha: "control-base" }, edges: [] };

const build = async (
  artifacts: Record<string, string>,
  missing: { role: string; reason: string }[] = [],
): Promise<string> => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "cartograph-replay-")),
  );
  roots.push(directory);
  const output = join(directory, "bundle");
  await createBundle({
    output,
    artifacts: Object.entries(artifacts).map(([role, text]) => {
      const path = join(directory, `${role}.json`);
      writeFileSync(path, text);
      return { role, path };
    }),
    missing,
    toolVersion: "0.1.1",
  });
  return output;
};

const diff = diffGraphSnapshots(base, head);
const AS_OF = "2030-06-01T00:00:00Z";
const complete = {
  "snapshot-base": serializeGraphSnapshot(base),
  "snapshot-head": serializeGraphSnapshot(head),
  diff: serializeGraphDiff(diff),
  policy: stableStringify(policy),
  decisions: stableStringify(decisions),
  "policy-evaluation": serializePolicyEvaluation(
    evaluatePolicyOnDiff(policy, diff, {
      asOf: AS_OF,
      adr: { document: decisions },
    }),
  ),
};

describe("bundle replay", () => {
  it("reproduces every derived artifact from the bundle alone, without the network", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network disabled in test"));
    const report = await replayBundle(await build(complete));
    expect(report.ok).toBe(true);
    expect(report.verification.ok).toBe(true);
    expect(report.checks.map((check) => [check.role, check.status])).toEqual([
      ["diff", "reproduced"],
      ["policy-evaluation", "reproduced"],
    ]);
    expect(report.checks[1]?.inputs).toEqual(["policy", "diff", "decisions"]);
    expect(report.sharing).toEqual({ profile: "team", ok: true, findings: 0 });
    expect(report.resources.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    const validate = createAjv({ allErrors: true }).compile(
      JSON.parse(
        readFileSync(
          join(
            import.meta.dirname,
            "../../schema/bundle-replay.v0.1.schema.json",
          ),
          "utf8",
        ),
      ) as object,
    );
    expect(
      validate(JSON.parse(JSON.stringify(report))),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  it("reports a derived artifact that its inputs do not reproduce", async () => {
    const stale = evaluatePolicyOnSnapshot(policy, base, { asOf: AS_OF });
    const report = await replayBundle(
      await build({
        "snapshot-head": complete["snapshot-head"],
        policy: complete.policy,
        "policy-evaluation": serializePolicyEvaluation(stale),
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual([
      expect.objectContaining({
        role: "policy-evaluation",
        status: "differs",
        inputs: ["policy", "snapshot-head"],
      }),
    ]);
    const check = report.checks[0];
    expect(check?.bundledSha256).not.toBe(check?.regeneratedSha256);
  });

  it("marks derived artifacts without their inputs as not replayable", async () => {
    const report = await replayBundle(
      await build({ diff: complete.diff, policy: complete.policy }),
    );
    expect(report.checks).toEqual([
      expect.objectContaining({ role: "diff", status: "not-replayable" }),
    ]);
    expect(report.ok).toBe(true);
  });

  it("stops at verification when the bundle has been altered", async () => {
    const bundle = await build(complete);
    const artifact = readdirSync(join(bundle, "artifacts"))[0] as string;
    writeFileSync(join(bundle, "artifacts", artifact), "{}");
    const report = await replayBundle(bundle);
    expect(report.ok).toBe(false);
    expect(report.verification.ok).toBe(false);
    expect(report.checks).toEqual([]);
  });
});
