import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/adoption-evaluation.mjs");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/adoption-evaluation/report.v0.1.json",
);

type MutableFixture = {
  method: {
    network: boolean;
  };
  runs: Array<{
    replayFixture: string;
    coverage: { unknownDiagnostics: number };
  }>;
};

const runValidator = (path = fixturePath): Record<string, unknown> =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [scriptPath, "validate", "--fixture", path],
      { cwd: repositoryRoot, encoding: "utf8" },
    ),
  ) as Record<string, unknown>;

const withMutatedFixture = async (
  mutate: (fixture: MutableFixture) => void,
): Promise<void> => {
  const directory = await mkdtemp(
    join(repositoryRoot, ".tmp-adoption-evaluation-"),
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

describe("repository adoption evaluation contract", () => {
  it("replays three pinned public records without collection", () => {
    expect(runValidator()).toMatchObject({
      ok: true,
      contract: "cartograph.repository-adoption-evaluation",
      schemaVersion: 1,
      evaluationId: "r017-v0.1",
      runs: 3,
      pinnedRevisions: 3,
      rerunnableRuns: 3,
      aggregateObservedRuns: 3,
      notObservedSizeRuns: 3,
      notObservedTimingRuns: 3,
      notObservedReviewerUsefulnessRuns: 3,
      network: false,
      sourceBodiesIncluded: false,
      credentialsUsed: false,
      hiddenTelemetry: false,
      userDataIncluded: false,
      adoptionClaim: "deferred",
    });
  });

  it("keeps the report honest about replay and interpretation", async () => {
    const report = await readFile(
      resolve(repositoryRoot, "docs/ADOPTION_EVALUATION.md"),
      "utf8",
    );
    expect(report).toContain("does not fetch a repository");
    expect(report).toContain("Not observed");
    expect(report).toContain("not evidence of market");
    expect(report).toContain("adoption");
    expect(report).toContain("support guarantee");
  });

  it("rejects a replay reference outside the checked-in compatibility record", async () => {
    await withMutatedFixture((fixture) => {
      fixture.runs[0]!.replayFixture = "https://example.invalid/source";
    });
  });

  it("rejects a network-enabled evaluation", async () => {
    await withMutatedFixture((fixture) => {
      fixture.method.network = true;
    });
  });

  it("rejects drift between unknown diagnostics and their categories", async () => {
    await withMutatedFixture((fixture) => {
      fixture.runs[2]!.coverage.unknownDiagnostics = 0;
    });
  });
});
