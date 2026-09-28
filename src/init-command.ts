import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

// Must match the reviewed self-Action pin in docs/ACTION.md and the Action
// fixture; test/cli/init.test.ts keeps them in step.
export const ACTION_PIN = "addf08d96eb5be3f76e441fb879fe13352d8a871";
const CHECKOUT_PIN = "3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";

export const INIT_CONFIG_PATH = "cartograph.config.json";
export const INIT_POLICY_PATH = "cartograph.policy.json";
export const INIT_WORKFLOW_PATH = ".github/workflows/cartograph.yml";

const config = `${JSON.stringify({ schemaVersion: 1, include: ["."] }, null, 2)}\n`;

const policy = `${JSON.stringify(
  {
    policyId: "architecture",
    version: "0.1.0",
    mode: "informational",
    rules: [
      {
        id: "no-import-cycles",
        target: "edge",
        assertion: "acyclic",
        selector: { kind: "imports" },
      },
    ],
  },
  null,
  2,
)}\n`;

const workflow = `name: CARTOGRAPH architecture diff

on:
  # Deliberately pull_request: fork runs get a read-only token and no
  # repository secrets. Do not switch to a target-context trigger.
  pull_request:

permissions:
  contents: read

concurrency:
  group: cartograph-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  architecture:
    name: Architecture diff
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Check out pull-request head
        uses: actions/checkout@${CHECKOUT_PIN}
        with:
          persist-credentials: false
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha }}

      - name: Run CARTOGRAPH
        uses: AlisinaDevelo/CARTOGRAPH@${ACTION_PIN} # self-Action metadata verified
        with:
          comparison: merge-base
          policy: ${INIT_POLICY_PATH}
          # Switch to enforce once the informational report looks right.
          policy-mode: informational
`;

export type InitOptions = {
  root: string;
  force: boolean;
  workflow: boolean;
};

export type InitResult = {
  created: string[];
  replaced: string[];
  skipped: string[];
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
};

const writeFile = async (
  path: string,
  content: string,
  force: boolean,
): Promise<void> => {
  if (force && (await exists(path))) {
    const metadata = await lstat(path);
    if (!metadata.isFile())
      throw new Error(`refusing to replace a non-regular file: ${path}`);
  }
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      (force ? constants.O_TRUNC : constants.O_EXCL) |
      constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(content, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
};

/**
 * Write a starter config, an informational policy, and (optionally) the
 * pull-request workflow. Existing files are left alone unless `force` is set.
 */
export async function initRepository(
  options: InitOptions,
): Promise<InitResult> {
  const root = resolve(options.root);
  const files: [string, string][] = [
    [INIT_CONFIG_PATH, config],
    [INIT_POLICY_PATH, policy],
    ...(options.workflow
      ? ([[INIT_WORKFLOW_PATH, workflow]] as [string, string][])
      : []),
  ];
  const result: InitResult = { created: [], replaced: [], skipped: [] };
  for (const [relativePath, content] of files) {
    const path = join(root, relativePath);
    if (relative(root, path).startsWith(".."))
      throw new Error(`refusing to write outside the repository: ${path}`);
    const present = await exists(path);
    if (present && !options.force) {
      result.skipped.push(relativePath);
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, options.force);
    (present ? result.replaced : result.created).push(relativePath);
  }
  return result;
}
