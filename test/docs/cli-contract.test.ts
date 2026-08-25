import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("CLI contract", () => {
  it("documents the supported LTS policy, exit codes, and offline no-op scan", () => {
    const policy = readFileSync(resolve(repositoryRoot, "docs/CLI.md"), "utf8");
    const readme = readFileSync(resolve(repositoryRoot, "README.md"), "utf8");

    expect(policy).toContain("## Supported LTS policy");
    expect(policy).toContain("Node.js 22");
    expect(policy).toContain("Node.js 24");
    expect(policy).toContain("SUPPORT_MATRIX_UNSUPPORTED_ENVIRONMENT");
    expect(policy).toContain("## Exit codes");
    expect(policy).toContain("Exit code 0");
    expect(policy).toContain("Exit code 1");
    expect(policy).toContain("## Output and diagnostic streams");
    expect(policy).toContain("JSON report mode");
    expect(policy).toContain("redacted");
    expect(policy).toContain("## No-op scan boundary");
    expect(policy).toContain("does not execute repository code");
    expect(policy).toContain("## Revision comparison contract");
    expect(policy).toContain("--comparison merge-base");
    expect(policy).toContain("fetch-depth: 0");
    expect(policy).toContain("shallow");
    expect(policy).toContain("policy [root]");
    expect(policy).toContain("Exit code 2");
    expect(readme).toContain("[CLI runtime and exit policy](docs/CLI.md)");
    expect(readme).toContain("--comparison merge-base");
  });

  it("documents the executable policy and ADR adoption workflow", () => {
    const workflow = readFileSync(
      resolve(repositoryRoot, "docs/WORKFLOW.md"),
      "utf8",
    );
    const packageJson = JSON.parse(
      readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    for (const section of [
      "## 1. Scan a working tree",
      "## 2. Compare exact revisions and link decisions",
      "## 3. Observe policy before enforcing it",
      "## 4. Migrate historical snapshots explicitly",
      "## 5. Keep remediation review human-controlled",
      "## 6. Run the same path in CI",
      "## Limits and trust boundary",
    ])
      expect(workflow).toContain(section);
    expect(workflow).toContain("--adr adr.json");
    expect(workflow).toContain("ADR link as proof");
    expect(packageJson.scripts?.["workflow:validate"]).toBe(
      "node scripts/workflow-fixture.mjs",
    );
  });
});
