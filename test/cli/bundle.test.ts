import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBundle, verifyBundle } from "../../src/bundle-command.js";
import { scanRepository, serializeScan } from "../../src/commands.js";

const roots: string[] = [];
const temporary = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "cartograph-bundle-")));
  roots.push(path);
  return path;
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

const fixture = (): string => {
  const directory = temporary();
  const snapshotPath = join(directory, "head.json");
  writeFileSync(
    snapshotPath,
    serializeScan(scanRepository({ root: "test/fixtures/typescript-express" })),
  );
  return snapshotPath;
};

const readTree = (root: string): Record<string, string> =>
  Object.fromEntries(
    [
      "manifest.json",
      ...readdirSync(join(root, "artifacts")).map(
        (name) => `artifacts/${name}`,
      ),
    ]
      .sort()
      .map((name) => [name, readFileSync(join(root, name), "utf8")]),
  );

describe("bundle create and verify", () => {
  it("writes identical bundles and verifies them offline", async () => {
    const snapshot = fixture();
    const [first, second] = [temporary(), temporary()];
    for (const output of [first, second])
      await createBundle({
        output,
        artifacts: [{ role: "snapshot-head", path: snapshot }],
        missing: [],
        toolVersion: "0.1.1",
      });
    expect(readTree(first)).toEqual(readTree(second));
    expect(await verifyBundle(first)).toMatchObject({ ok: true, problems: [] });

    const artifact = readdirSync(join(first, "artifacts"))[0] as string;
    appendFileSync(join(first, "artifacts", artifact), " ");
    expect((await verifyBundle(first)).ok).toBe(false);
  });

  it("refuses symbolic links in a bundle and a non-empty output directory", async () => {
    const snapshot = fixture();
    const output = temporary();
    await createBundle({
      output,
      artifacts: [{ role: "snapshot-head", path: snapshot }],
      missing: [],
      toolVersion: "0.1.1",
    });
    symlinkSync(snapshot, join(output, "artifacts", "link.json"));
    await expect(verifyBundle(output)).rejects.toThrow("symbolic link");
    await expect(
      createBundle({
        output,
        artifacts: [{ role: "snapshot-head", path: snapshot }],
        missing: [],
        toolVersion: "0.1.1",
      }),
    ).rejects.toThrow("not empty");
  });
});
