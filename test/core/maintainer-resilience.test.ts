import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/maintainer-resilience.mjs");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/maintainer-resilience/report.v0.1.json",
);

type MutableFixture = {
  dryRuns: Array<{
    actorIsRepositoryAuthor: boolean;
    commands: string[];
  }>;
};

const runValidator = (path = fixturePath): Record<string, unknown> =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [scriptPath, "validate", "--fixture", path],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    ),
  ) as Record<string, unknown>;

const withMutatedFixture = async (
  mutate: (fixture: MutableFixture) => void,
): Promise<void> => {
  const directory = await mkdtemp(
    join(repositoryRoot, ".tmp-maintainer-resilience-"),
  );
  const path = join(directory, "report.json");
  try {
    const fixture = JSON.parse(
      await readFile(fixturePath, "utf8"),
    ) as MutableFixture;
    mutate(fixture);
    await writeFile(path, JSON.stringify(fixture), "utf8");
    expect(() => runValidator(path)).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("maintainer resilience contract", () => {
  it("validates the six-role map and two completed non-author rehearsals", () => {
    expect(runValidator()).toMatchObject({
      ok: true,
      contract: "cartograph.maintainer-resilience",
      schemaVersion: 1,
      roles: 6,
      onboardingSteps: 12,
      dryRuns: 2,
      passedDryRuns: 2,
      unresolvedRisks: 7,
      staffedBackups: 0,
      network: false,
      sourcePayloads: false,
    });
  });

  it("keeps the public report explicit about the unresolved single-maintainer boundary", async () => {
    const report = await readFile(
      resolve(repositoryRoot, "docs/MAINTAINER_RESILIENCE.md"),
      "utf8",
    );
    expect(report).toContain("documented-unverified");
    expect(report).toContain("not an external contribution");
    expect(report).toContain("does not claim that the bus factor is");
    expect(report).toContain("resolved.");
  });

  it("rejects a rehearsal attributed to the repository author", async () => {
    await withMutatedFixture((fixture) => {
      fixture.dryRuns[0]!.actorIsRepositoryAuthor = true;
    });
  });

  it("rejects mutative or network commands in a dry-run record", async () => {
    await withMutatedFixture((fixture) => {
      fixture.dryRuns[0]!.commands.push("git push origin main");
    });
  });
});
