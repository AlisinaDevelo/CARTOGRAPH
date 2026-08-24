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

describe("read-only GitHub Action contract", () => {
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
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("github.event.pull_request.head.sha");
    expect(workflow).toContain(
      "AlisinaDevelo/CARTOGRAPH@629ee26cc179f08848b09f8c5caeaaf48f6e134c",
    );
    expect(workflow).not.toContain("pull_request_target");
  });

  it("keeps the fixture workflow and documentation informational", () => {
    const docs = read("docs/ACTION.md");
    const fixtureReadme = read("examples/github-action-fixture/README.md");

    expect(docs).toContain("does not\ncomment, label, merge, change issues");
    expect(docs).toContain("npm run action:validate");
    expect(fixtureReadme).toContain("read-only");
    expect(fixtureReadme).toContain("does not comment on the pull request");
  });
});
