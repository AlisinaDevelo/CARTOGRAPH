import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (relativePath: string): string =>
  readFileSync(resolve(repositoryRoot, relativePath), "utf8");

describe("public OSS and security baseline", () => {
  it("retains the public contribution, conduct, support, and reporting surfaces", () => {
    for (const relativePath of [
      "README.md",
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "SECURITY.md",
      "SUPPORT.md",
      "GOVERNANCE.md",
      "NOTICE",
      "docs/MAINTENANCE.md",
      ".github/CODEOWNERS",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/ISSUE_TEMPLATE/config.yml",
    ]) {
      expect(existsSync(resolve(repositoryRoot, relativePath))).toBe(true);
    }

    expect(read(".github/CODEOWNERS")).toContain("@AlisinaDevelo");
    expect(read(".github/ISSUE_TEMPLATE/config.yml")).toContain(
      "blank_issues_enabled: false",
    );
    expect(read("SECURITY.md")).toContain("private vulnerability reporting");
  });

  it("declares the protected checks and read-only workflow boundary", () => {
    const ci = read(".github/workflows/ci.yml");
    const codeql = read(".github/workflows/codeql.yml");
    const dependencyReview = read(".github/workflows/dependency-review.yml");
    const maintenance = read("docs/MAINTENANCE.md");

    expect(ci).toContain('"22.x"');
    expect(ci).toContain('"24.x"');
    expect(ci).toContain("npm ci --ignore-scripts");
    expect(ci).toContain("npm run test:coverage");
    expect(ci).toContain("npm pack --dry-run --ignore-scripts --json");
    expect(ci).not.toContain("pull_request_target");
    expect(codeql).toContain("security-events: write");
    expect(codeql).toContain("javascript-typescript");
    expect(dependencyReview).toContain("Review dependency changes");
    expect(dependencyReview).toContain("fail-on-severity: high");
    for (const context of [
      "Node 22.x",
      "Node 24.x",
      "Analyze (javascript-typescript)",
      "Review dependency changes",
    ]) {
      expect(maintenance).toContain(`\`${context}\``);
    }
  });

  it("documents dependency ownership and private disclosure routing", () => {
    const dependabot = read(".github/dependabot.yml");
    const maintenance = read("docs/MAINTENANCE.md");
    const security = read("SECURITY.md");

    expect(dependabot).toContain("package-ecosystem: npm");
    expect(dependabot).toContain("package-ecosystem: github-actions");
    expect(dependabot).toContain("interval: weekly");
    expect(dependabot).toContain("interval: monthly");
    expect(dependabot).toContain("default-days: 7");
    expect(maintenance).toContain("Dependabot owns update proposals");
    expect(maintenance).toContain("Security disclosure ownership");
    expect(maintenance).toContain("private vulnerability reporting");
    expect(maintenance).toContain("Major TypeScript");
    expect(security).toContain("do not open a public issue");
  });
});
