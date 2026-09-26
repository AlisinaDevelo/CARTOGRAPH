import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const validator = resolve(repositoryRoot, "scripts/validate-action-root.mjs");

const runValidator = (workspace: string, root: string): string =>
  execFileSync(process.execPath, [validator], {
    env: {
      ...process.env,
      CARTOGRAPH_ROOT_INPUT: root,
      GITHUB_WORKSPACE: workspace,
    },
    encoding: "utf8",
  });

describe("Action root boundary", () => {
  it("returns the canonical path for an in-workspace root", () => {
    const workspace = mkdtempSync(join(tmpdir(), "cartograph-action-root-"));
    try {
      mkdirSync(join(workspace, "nested"));
      expect(runValidator(workspace, "nested")).toBe(
        `${realpathSync(join(workspace, "nested"))}\n`,
      );
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it.each(["../outside", "/outside", "C:/outside", "file:///outside"])(
    "rejects unsafe root %s",
    (root) => {
      const workspace = mkdtempSync(join(tmpdir(), "cartograph-action-root-"));
      try {
        expect(() => runValidator(workspace, root)).toThrow();
      } finally {
        rmSync(workspace, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symlinks that escape the workspace or inject line breaks",
    () => {
      const workspace = mkdtempSync(join(tmpdir(), "cartograph-action-root-"));
      const outside = mkdtempSync(join(tmpdir(), "cartograph-action-out-"));
      try {
        symlinkSync(outside, join(workspace, "escape"));
        mkdirSync(join(workspace, "a\nCARTOGRAPH_INJECTED=1"));
        symlinkSync(
          join(workspace, "a\nCARTOGRAPH_INJECTED=1"),
          join(workspace, "newline"),
        );
        expect(() => runValidator(workspace, "escape")).toThrow();
        expect(() => runValidator(workspace, "newline")).toThrow();
      } finally {
        rmSync(workspace, { force: true, recursive: true });
        rmSync(outside, { force: true, recursive: true });
      }
    },
  );
});
