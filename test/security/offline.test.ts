import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeTypeScriptRepository } from "../../src/analyzers/typescript.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("offline analysis boundary", () => {
  it("does not execute repository code or call fetch while scanning", async () => {
    const root = await mkdtemp(join(tmpdir(), "cartograph-offline-test-"));
    temporaryDirectories.push(root);
    const marker = join(root, "executed-by-analyzer");

    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
        },
      }),
      "utf8",
    );
    await writeFile(
      join(root, "untrusted.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(marker)}, "executed");`,
        'void fetch("https://example.invalid/must-not-run");',
        "export const value = 1;",
        "",
      ].join("\n"),
      "utf8",
    );

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network disabled in test"));

    const snapshot = analyzeTypeScriptRepository({
      rootDir: root,
      revision: { commitSha: "working-tree" },
    });

    expect(snapshot.revision.commitSha).toBe("working-tree");
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
