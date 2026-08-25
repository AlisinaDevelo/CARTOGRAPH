/* global process */

import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runIdentityCorpus,
  type IdentityCorpusReport,
} from "./identity-corpus.js";

type QualitySource = "curated" | "generated";

type QualityBaseline = {
  schemaVersion: number;
  contract: string;
  corpusContract: string;
  corpusVersion: string;
  qualityDigest: string;
  summary: Record<
    QualitySource,
    {
      cases: number;
      preservationRate: number;
      falseMatchRate: number;
      ambiguityRate: number;
      unmatchedRate: number;
      unsupportedRate: number;
    }
  >;
  thresholds: {
    preservationRateMin: number;
    falseMatchRateMax: number;
    unmatchedRateMax: number;
    unsupportedRateMax: number;
  };
  exceptionPolicy: {
    active: boolean;
    requiredFields: string[];
    maximumDays: number;
  };
};

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const baselinePath = resolve(
  repositoryRoot,
  "test/fixtures/identity-corpus/quality-baseline.v0.1.json",
);
const sha256 = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

const fail = (message: string): never => {
  throw new Error(message);
};

export const loadIdentityQualityBaseline = (): QualityBaseline =>
  JSON.parse(readFileSync(baselinePath, "utf8")) as QualityBaseline;

const checkThresholds = (
  source: QualitySource,
  quality: IdentityCorpusReport["quality"][QualitySource],
  baseline: QualityBaseline,
): void => {
  const thresholds = baseline.thresholds;
  if (
    quality.preservationRate === null ||
    quality.preservationRate < thresholds.preservationRateMin
  )
    fail(`${source} preservation rate is below the release threshold`);
  if (quality.falseMatchRate > thresholds.falseMatchRateMax)
    fail(`${source} false-match rate exceeds the release threshold`);
  if (quality.unmatchedRate > thresholds.unmatchedRateMax)
    fail(`${source} unmatched rate exceeds the release threshold`);
  if (quality.unsupportedRate > thresholds.unsupportedRateMax)
    fail(`${source} unsupported rate exceeds the release threshold`);
};

export const runIdentityQuality = () => {
  const baseline = loadIdentityQualityBaseline();
  if (
    baseline.schemaVersion !== 1 ||
    baseline.contract !== "cartograph.identity-quality-baseline" ||
    baseline.corpusContract !== "cartograph.identity-corpus" ||
    baseline.corpusVersion !== "v0.1"
  )
    fail("identity quality baseline contract is unsupported");
  if (!/^sha256:[0-9a-f]{64}$/u.test(baseline.qualityDigest))
    fail("identity quality baseline digest is malformed");
  if (baseline.exceptionPolicy.active)
    fail("identity quality exception must be reviewed before activation");

  const corpus = runIdentityCorpus();
  const observedDigest = sha256(corpus.quality);
  if (observedDigest !== baseline.qualityDigest)
    fail(
      `identity quality baseline drift: expected ${baseline.qualityDigest}, observed ${observedDigest}`,
    );
  for (const source of ["curated", "generated"] as const) {
    const quality = corpus.quality[source];
    const expected = baseline.summary[source];
    if (quality.cases !== expected.cases)
      fail(`${source} identity quality case count drift`);
    for (const field of [
      "preservationRate",
      "falseMatchRate",
      "ambiguityRate",
      "unmatchedRate",
      "unsupportedRate",
    ] as const) {
      if (quality[field] !== expected[field])
        fail(`${source} identity quality ${field} drift`);
    }
    checkThresholds(source, quality, baseline);
  }

  return {
    ok: true as const,
    contract: "cartograph.identity-quality",
    corpusContract: corpus.contract,
    qualityDigest: observedDigest,
    thresholds: baseline.thresholds,
    curated: corpus.quality.curated,
    generated: corpus.quality.generated,
    byCategory: corpus.quality.byCategory,
    exceptionPolicy: baseline.exceptionPolicy,
  };
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  const report = runIdentityQuality();
  console.log(JSON.stringify(report));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath !== undefined) {
    appendFileSync(
      summaryPath,
      `## CARTOGRAPH identity quality gate\n\n- Baseline: \`${report.qualityDigest}\`\n- Curated preservation: ${report.curated.preservationRate}\n- Generated preservation: ${report.generated.preservationRate}\n- False-match rates: curated ${report.curated.falseMatchRate}, generated ${report.generated.falseMatchRate}\n- Result: passed\n`,
      "utf8",
    );
  }
}
