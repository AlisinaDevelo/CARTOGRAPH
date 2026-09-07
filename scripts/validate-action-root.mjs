/* global process */

import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const fail = (message) => {
  throw new Error(`CARTOGRAPH action root validation failed: ${message}`);
};

const rootInput = process.env.CARTOGRAPH_ROOT_INPUT ?? ".";
const workspaceInput = process.env.GITHUB_WORKSPACE;

if (workspaceInput === undefined || workspaceInput.length === 0)
  fail("GITHUB_WORKSPACE is required");
if (/\0|[\r\n]/u.test(rootInput))
  fail("root must not contain control characters");

const normalizedRoot = rootInput.replaceAll("\\", "/");
if (
  isAbsolute(rootInput) ||
  /^(?:\/|[A-Za-z]:\/|\/\/)/u.test(normalizedRoot) ||
  /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalizedRoot)
)
  fail("root must be a repository-relative path");
if (normalizedRoot.split("/").includes(".."))
  fail("root must not contain parent-directory traversal");

try {
  const workspace = await realpath(workspaceInput);
  const candidate = await realpath(resolve(workspace, rootInput || "."));
  const outsideWorkspace = relative(workspace, candidate);
  if (
    outsideWorkspace !== "" &&
    (outsideWorkspace === ".." ||
      outsideWorkspace.startsWith(
        `..${process.platform === "win32" ? "\\" : "/"}`,
      ) ||
      isAbsolute(outsideWorkspace))
  )
    fail("root must resolve inside GITHUB_WORKSPACE");
  process.stdout.write(`${candidate}\n`);
} catch (error) {
  if (
    error instanceof Error &&
    error.message.startsWith("CARTOGRAPH action root")
  )
    throw error;
  fail("root must resolve to an existing path inside GITHUB_WORKSPACE");
}
