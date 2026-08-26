import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("HTML report accessibility fixture", () => {
  it("covers changed nodes, diagnostics, evidence links, and keyboard affordances", () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/accessibility-fixture.mjs", "validate"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      contract: "cartograph.report-accessibility-fixture",
      fixtureId: "d020-v0.1",
      changedNodes: 1,
      addedDiagnostics: 1,
      evidenceLinks: 3,
      navigationLinks: 15,
      network: false,
      sourceBodiesIncluded: false,
    });
  });
});
