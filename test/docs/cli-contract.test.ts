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
    expect(readme).toContain("[CLI runtime and exit policy](docs/CLI.md)");
    expect(readme).toContain("--comparison merge-base");
  });
});
