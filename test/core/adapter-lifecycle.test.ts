import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/adapter-lifecycle.mjs");

const runValidator = (root = repositoryRoot): string =>
  execFileSync(process.execPath, [scriptPath, "validate", "--root", root], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

const createTemporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(repositoryRoot, ".tmp-adapter-lifecycle-"));
  await cp(
    resolve(repositoryRoot, "test/fixtures/adapter-lifecycle"),
    join(root, "test/fixtures/adapter-lifecycle"),
    { recursive: true },
  );
  await cp(
    resolve(repositoryRoot, "schema/adapter-lifecycle.v0.1.schema.json"),
    join(root, "schema/adapter-lifecycle.v0.1.schema.json"),
  );
  return root;
};

describe("adapter lifecycle and security-response policy", () => {
  it("validates ownership, windows, triggers, and both timed tabletop exercises", () => {
    const first = JSON.parse(runValidator()) as {
      ok: boolean;
      policyId: string;
      summary: {
        cases: number;
        events: number;
        categories: string[];
        timelinesDeterministic: boolean;
        publicTemplates: boolean;
        noSourceLeaks: boolean;
        finalStates: Record<string, string>;
      };
    };
    const second = JSON.parse(runValidator()) as unknown;

    expect(first).toMatchObject({
      ok: true,
      policyId: "cartograph-adapter-lifecycle-v0.1",
      summary: {
        cases: 2,
        events: 10,
        categories: ["abandoned-adapter", "security-defect"],
        timelinesDeterministic: true,
        publicTemplates: true,
        noSourceLeaks: true,
        finalStates: {
          "abandoned-adapter": "archived",
          "security-defect": "active",
        },
      },
    });
    expect(second).toEqual(first);
  });

  it("fails closed with the tabletop category when its timeline drifts", async () => {
    const root = await createTemporaryRoot();
    try {
      const fixturePath = join(
        root,
        "test/fixtures/adapter-lifecycle/scenarios.v0.1.json",
      );
      const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
        tabletops: Array<{ id: string; events: unknown[] }>;
      };
      const abandoned = fixture.tabletops.find(
        (current) => current.id === "abandoned-adapter",
      );
      if (abandoned === undefined)
        throw new Error("abandoned tabletop missing");
      abandoned.events.reverse();
      await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

      expect(() => runValidator(root)).toThrow(
        /category=abandoned-adapter case=abandoned-adapter.*timeline/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
