import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/change-control.mjs");
const registerPath = resolve(repositoryRoot, "schema/change-control.v0.1.json");

const temporaryRegister = async (): Promise<{
  root: string;
  path: string;
  value: Record<string, unknown>;
}> => {
  const root = await mkdtemp(join(repositoryRoot, ".tmp-change-control-"));
  const value = JSON.parse(await readFile(registerPath, "utf8")) as Record<
    string,
    unknown
  >;
  const path = join(root, "register.json");
  return { root, path, value };
};

describe("change-control validator", () => {
  it("validates the register and reports no overdue entries", () => {
    const output = execFileSync(
      process.execPath,
      [scriptPath, "validate", "--as-of", "2026-08-24"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      registerVersion: 1,
      entries: 9,
      deprecated: 1,
      removed: 0,
      overdue: [],
    });
  });

  it("fails a deprecated entry whose review date is overdue", async () => {
    const temporary = await temporaryRegister();
    try {
      const entries = temporary.value.entries as Array<Record<string, unknown>>;
      const entry = entries.find(
        (candidate) => candidate.status === "deprecated",
      );
      if (!entry) throw new Error("test register has no deprecated entry");
      entry.reviewDate = "2020-01-01";
      await writeFile(temporary.path, JSON.stringify(temporary.value), "utf8");
      expect(() =>
        execFileSync(
          process.execPath,
          [
            scriptPath,
            "validate",
            "--register",
            temporary.path,
            "--as-of",
            "2026-08-24",
          ],
          { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" },
        ),
      ).toThrow(/overdue change-control entries/u);
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });

  it("fails a removal that has no migration gate", async () => {
    const temporary = await temporaryRegister();
    try {
      const entries = temporary.value.entries as Array<Record<string, unknown>>;
      entries.push({
        id: "cli.removed-flag",
        kind: "cli-flag",
        status: "removed",
        introducedVersion: "0.1.0",
        owner: "cli-maintainers",
        reviewDate: "2027-06-30",
        replacement: "cli.scan-config",
        deprecationReason: "Replaced for a test.",
        deprecatedSince: "2026-08-24",
        removalGate: null,
      });
      await writeFile(temporary.path, JSON.stringify(temporary.value), "utf8");
      expect(() =>
        execFileSync(
          process.execPath,
          [
            scriptPath,
            "validate",
            "--register",
            temporary.path,
            "--as-of",
            "2026-08-24",
          ],
          { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" },
        ),
      ).toThrow(/schema validation failed/u);
    } finally {
      await rm(temporary.root, { recursive: true, force: true });
    }
  });
});
