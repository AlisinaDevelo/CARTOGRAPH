import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCli } from "../../src/cli.js";
import { scanRepository } from "../../src/commands.js";
import {
  evaluatePolicyOnSnapshot,
  parseCartographConfig,
  parsePolicyConfig,
} from "../../src/core/index.js";
import {
  ACTION_PIN,
  INIT_CONFIG_PATH,
  INIT_POLICY_PATH,
  INIT_WORKFLOW_PATH,
} from "../../src/init-command.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const roots: string[] = [];

const emptyRoot = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cartograph-init-")));
  roots.push(root);
  return root;
};

const init = async (args: string[]): Promise<string> => {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  await createCli().parseAsync(["init", ...args], { from: "user" });
  vi.restoreAllMocks();
  return output;
};

const read = (root: string, path: string): string =>
  readFileSync(join(root, path), "utf8");

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("init command", () => {
  it("writes a config, policy, and workflow that the tool accepts", async () => {
    const root = emptyRoot();
    const output = await init([root]);
    expect(output).toContain(`created  ${INIT_CONFIG_PATH}`);
    expect(output).toContain(`created  ${INIT_WORKFLOW_PATH}`);

    expect(() =>
      parseCartographConfig(JSON.parse(read(root, INIT_CONFIG_PATH))),
    ).not.toThrow();
    const policy = parsePolicyConfig(JSON.parse(read(root, INIT_POLICY_PATH)));
    expect(policy.mode).toBe("informational");

    writeFileSync(join(root, "a.ts"), "export const a = (): number => 1;\n");
    expect(
      evaluatePolicyOnSnapshot(policy, scanRepository({ root })).status,
    ).toBe("passed");

    const workflow = read(root, INIT_WORKFLOW_PATH);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).toContain(`AlisinaDevelo/CARTOGRAPH@${ACTION_PIN}`);
    expect(workflow).toContain(`policy: ${INIT_POLICY_PATH}`);
  });

  it("keeps existing files unless --force is given", async () => {
    const root = emptyRoot();
    writeFileSync(join(root, INIT_POLICY_PATH), "{}\n");
    const output = await init([root, "--no-workflow"]);
    expect(output).toContain(`skipped  ${INIT_POLICY_PATH}`);
    expect(read(root, INIT_POLICY_PATH)).toBe("{}\n");
    expect(existsSync(join(root, INIT_WORKFLOW_PATH))).toBe(false);

    const forced = await init([root, "--force", "--no-workflow"]);
    expect(forced).toContain(`replaced ${INIT_POLICY_PATH}`);
    expect(() =>
      parsePolicyConfig(JSON.parse(read(root, INIT_POLICY_PATH))),
    ).not.toThrow();
  });

  it("uses the reviewed self-Action pin", () => {
    for (const path of [
      "docs/ACTION.md",
      "examples/github-action-fixture/.github/workflows/cartograph.yml",
    ])
      expect(readFileSync(join(repositoryRoot, path), "utf8")).toContain(
        `AlisinaDevelo/CARTOGRAPH@${ACTION_PIN}`,
      );
  });
});
