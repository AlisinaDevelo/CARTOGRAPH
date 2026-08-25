import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/policy-decision-drift/scenarios.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/policy-drift-evaluation-fixtures.v0.1.schema.json",
);
const runnerPath = resolve(
  repositoryRoot,
  "scripts/policy-drift-evaluation.mjs",
);

describe("policy and decision drift evaluation", () => {
  it("publishes the six curated scenario families and reviewer annotations", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      contract: string;
      evaluationId: string;
      decisionTarget: string;
      thresholds: { maxReviewerMinutes: number };
      cases: Array<{
        kind: string;
        expectedFindings: Array<{ id: string }>;
        reviewer: { falsePositiveCategory?: string };
      }>;
    };
    const schema = JSON.parse(
      readFileSync(fixtureSchemaPath, "utf8"),
    ) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(fixture)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(fixture).toMatchObject({
      contract: "cartograph.policy-drift-evaluation-fixtures",
      evaluationId: "p018-policy-decision-drift-v0-1",
      decisionTarget: "proceed",
      thresholds: { maxReviewerMinutes: 45 },
    });
    expect(fixture.cases.map((scenario) => scenario.kind)).toEqual([
      "decision-supersession",
      "removed-architecture",
      "policy-change",
      "unreferenced-addition",
      "exception",
      "mixed-schema",
    ]);
    expect(
      fixture.cases.flatMap((scenario) =>
        scenario.expectedFindings.map((finding) => finding.id),
      ),
    ).toHaveLength(6);
    expect(
      fixture.cases.filter(
        (scenario) => scenario.reviewer.falsePositiveCategory !== undefined,
      ),
    ).toHaveLength(2);
  });

  it("replays expected and observed drift findings with a milestone decision", () => {
    const validator = readFileSync(runnerPath, "utf8");
    expect(validator).not.toMatch(/\bfetch\b/u);
    expect(validator).not.toContain("child_process");
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", runnerPath, "validate"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      contract: "cartograph.policy-drift-evaluation",
      evaluationId: "p018-policy-decision-drift-v0-1",
      milestone: "Y2-Q3",
      cases: 6,
      expectedFindings: 6,
      observedFindings: 6,
      findingRecall: 1,
      missingFindings: 0,
      unexpectedFindings: 0,
      reviewerFalsePositiveCases: 2,
      reviewerFalsePositiveRate: 1 / 3,
      reviewerMinutes: 39,
      reviewerMedianMinutes: 6.5,
      decision: "proceed",
    });
  });
});
