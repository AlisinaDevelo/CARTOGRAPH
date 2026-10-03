import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBundle } from "../../src/bundle-command.js";
import { evaluateControls } from "../../src/controls-command.js";
import { stableStringify } from "../../src/core/index.js";
import {
  AS_OF,
  decisions,
  evaluation,
  findings,
  mapping,
  policy,
  waiver,
} from "../core/control-evidence.fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

const setup = async () => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "cartograph-controls-")),
  );
  roots.push(directory);
  const write = (name: string, value: unknown): string => {
    const path = join(directory, name);
    writeFileSync(path, `${stableStringify(value)}\n`);
    return path;
  };
  const bundle = join(directory, "bundle");
  await createBundle({
    output: bundle,
    artifacts: [
      { role: "policy", path: write("policy.json", policy) },
      { role: "policy-evaluation", path: write("evaluation.json", evaluation) },
      { role: "decisions", path: write("decisions.json", decisions) },
      { role: "waiver", path: write("waiver.json", waiver) },
      { role: "finding-lifecycle", path: write("findings.json", findings) },
    ],
    missing: [{ role: "diff", reason: "no base revision" }],
    requiredRoles: [
      "policy",
      "policy-evaluation",
      "decisions",
      "waiver",
      "finding-lifecycle",
      "diff",
    ],
    toolVersion: "0.1.1",
  });
  return { directory, bundle, mappingPath: write("mapping.json", mapping) };
};

describe("controls evaluate", () => {
  it("evaluates a mapping against a verified bundle on disk", async () => {
    const { bundle, mappingPath } = await setup();
    const report = await evaluateControls({
      mapping: mappingPath,
      bundle,
      asOf: AS_OF,
    });
    expect(report.limitations[0]).toMatch(/not a certification/u);
    expect(report.summary).toEqual({
      supported: 2,
      "asserted-only": 1,
      gaps: 3,
      conflicting: 2,
      "out-of-period": 1,
      "not-applicable": 1,
    });
  });

  it("refuses a bundle that does not verify", async () => {
    const { bundle, mappingPath } = await setup();
    const artifact = readdirSync(join(bundle, "artifacts"))[0] as string;
    writeFileSync(join(bundle, "artifacts", artifact), "{}");
    await expect(
      evaluateControls({ mapping: mappingPath, bundle, asOf: AS_OF }),
    ).rejects.toThrow(/does not verify/u);
  });
});
