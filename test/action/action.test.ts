import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (relativePath: string): string =>
  readFileSync(resolve(repositoryRoot, relativePath), "utf8");

const selfActionPin = (source: string): string => {
  const pins = [
    ...source.matchAll(
      /^\s*(?:-\s*)?uses:\s*AlisinaDevelo\/CARTOGRAPH@([0-9a-f]{40})\b/gmu,
    ),
  ].map((match) => match[1]);
  expect(pins).toHaveLength(1);
  const pin = pins[0];
  if (pin === undefined) throw new Error("self Action pin is missing");
  return pin;
};

const assertRunnableSelfActionPin = (pin: string): void => {
  execFileSync("git", ["cat-file", "-e", `${pin}^{commit}`], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
  execFileSync("git", ["cat-file", "-e", `${pin}:action.yml`], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
};

describe("read-only GitHub Action contract", () => {
  it("pins the documented self Action to a commit containing action metadata", () => {
    const docsPin = selfActionPin(read("docs/ACTION.md"));
    const workflowPin = selfActionPin(
      read("examples/github-action-fixture/.github/workflows/cartograph.yml"),
    );
    const readmePin = selfActionPin(read("README.md"));

    expect(workflowPin).toBe(docsPin);
    expect(readmePin).toBe(docsPin);
    expect(() => assertRunnableSelfActionPin(docsPin)).not.toThrow();
  });

  it("runs the Action security validator in the authoritative CI workflow", () => {
    expect(read(".github/workflows/ci.yml")).toContain(
      "      - name: Validate Action security fixture\n        run: npm run action:security:validate",
    );
  });

  it("uses exact pull-request revisions and a pinned artifact upload", () => {
    const action = read("action.yml");
    const workflow = read(
      "examples/github-action-fixture/.github/workflows/cartograph.yml",
    );

    expect(action).toContain("using: composite");
    expect(action).toContain("github.event.pull_request.base.sha");
    expect(action).toContain("github.event.pull_request.head.sha");
    expect(action).toContain("--comparison");
    expect(action).toContain("default: merge-base");
    expect(action).toContain('default: "7"');
    expect(action).toContain('default: "true"');
    expect(action).toContain("default: informational");
    expect(action).toContain("CARTOGRAPH_POLICY_PATH");
    expect(action).toContain("CARTOGRAPH_POLICY_MODE");
    expect(action).toContain("review-context");
    expect(action).toContain("CARTOGRAPH_REVIEW_CONTEXT_PATH");
    expect(action).toContain("--mode");
    expect(action).toContain("Upload policy evaluation");
    expect(action).toContain("if: inputs.upload-report == 'true'");
    expect(action).toContain("architecture-diff.json");
    expect(action).toContain("architecture-diff.html");
    expect(action).toContain("architecture-review.json");
    expect(action).toContain("architecture-review.html");
    expect(action).toContain("npm ci --ignore-scripts");
    expect(action).toContain(
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    );
    expect(action).toContain(
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    );
    expect(action).not.toContain("pull_request_target");
    expect(action).not.toContain("secrets.");
    expect(action).not.toContain("github.token");

    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("permissions:\n      contents: read");
    expect(workflow).toContain("pull_request");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("github.event.pull_request.head.sha");
    expect(workflow).toContain(
      "AlisinaDevelo/CARTOGRAPH@0491e7cdd8a558b025fc60a3897a01cf74577965",
    );
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("github.token");
  });

  it("keeps the fixture workflow and documentation informational", () => {
    const docs = read("docs/ACTION.md");
    const fixtureReadme = read("examples/github-action-fixture/README.md");
    const fixture = read("scripts/action-fixture.mjs");
    const securityFixture = read("scripts/action-security-fixture.mjs");

    expect(docs).toContain("never comments, labels, merges, changes issues");
    expect(docs).toContain("npm run action:validate");
    expect(docs).toContain("Fork pull requests and permissions");
    expect(docs).toContain("npm run action:security:validate");
    expect(docs).toContain("Sensitive repositories");
    expect(docs).toContain("source snippet");
    expect(fixtureReadme).toContain("read-only");
    expect(fixtureReadme).toContain("comment on the pull request");
    expect(fixtureReadme).toContain("no repository secrets");
    expect(fixtureReadme).toContain("upload-report: false");
    for (const scenario of [
      "malicious-package",
      "symlinked-output",
      "oversized-input",
      "cancelled analysis",
      "missing revision ref",
    ])
      expect(fixture).toContain(scenario);
    expect(securityFixture).toContain("actionReferences");
    expect(securityFixture).toContain("unpin");
    expect(securityFixture).toContain("write permission");
    expect(securityFixture).toContain("npm ci --ignore-scripts");
    expect(securityFixture).toContain("policy mode default");
  });
});
