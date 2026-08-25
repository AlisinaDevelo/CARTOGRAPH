/* global process */

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createGraphSnapshot,
  reconcileGraphNodeIdentities,
  serializeIdentityReconciliation,
  type IdentityPathHistory,
  type IdentityReconciliation,
} from "../src/core/index.js";

type IdentityCategory =
  | "line-move"
  | "file-move"
  | "supported-rename"
  | "duplicate-names"
  | "overloads"
  | "path-alias"
  | "ambiguous";

type CorpusNode = {
  id: string;
  stableKey: string;
  kind: "function";
  name: string;
  language: "typescript";
  location?: { path: string; line: number };
};

type CorpusEdge = {
  from: string;
  to: string;
  kind: "calls";
  confidence: "certain";
  evidence: [
    {
      id: string;
      kind: "source";
      path: string;
      line: number;
      detector: string;
      contentHash: string;
    },
  ];
};

type CorpusCase = {
  id: string;
  category: IdentityCategory;
  before: CorpusNode[];
  after: CorpusNode[];
  beforeEdges?: CorpusEdge[];
  afterEdges?: CorpusEdge[];
  pathHistory?: IdentityPathHistory[];
  expected?: {
    matches: number;
    added: number;
    removed: number;
    ambiguous: number;
    unsupported: number;
    methods?: string[];
    ambiguityReasons?: string[];
  };
};

type CorpusFixture = {
  schemaVersion: number;
  contract: string;
  seed: number;
  generator: {
    algorithm: string;
    iterations: number;
    maxCandidates: number;
    maxNodesPerSnapshot: number;
  };
  invariants: string[];
  regressions: CorpusCase[];
};

type CaseReport = {
  id: string;
  category: IdentityCategory;
  source: "curated" | "generated";
  beforeNodes: number;
  afterNodes: number;
  matches: number;
  expectedMatches: number;
  preserved: number;
  falseMatches: number;
  unmatched: number;
  added: number;
  removed: number;
  ambiguous: number;
  unsupported: number;
  methods: string[];
};

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/identity-corpus/scenarios.v0.1.json",
);
const sourceHash = "0".repeat(64);
const categories: IdentityCategory[] = [
  "line-move",
  "file-move",
  "supported-rename",
  "duplicate-names",
  "overloads",
  "path-alias",
  "ambiguous",
];

const expectedMatchesForCategory = (current: CorpusCase): number => {
  if (current.expected !== undefined) return current.expected.matches;
  if (
    current.category === "line-move" ||
    current.category === "file-move" ||
    current.category === "path-alias"
  )
    return 1;
  if (current.category === "supported-rename") return 2;
  if (current.category === "overloads")
    return Math.min(current.before.length, current.after.length);
  return 0;
};

class XorShift32 {
  private state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed <= 0 || seed > 0xffffffff)
      throw new Error(
        `identity corpus seed must be a positive uint32: ${seed}`,
      );
    this.state = seed >>> 0;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0 || 0x9e3779b9;
    return this.state;
  }

  int(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1)
      throw new Error(
        `identity corpus random bound must be positive: ${maxExclusive}`,
      );
    return this.next() % maxExclusive;
  }
}

const node = (
  id: string,
  stableKey: string,
  name: string,
  path: string,
  line: number,
): CorpusNode => ({
  id,
  stableKey,
  kind: "function",
  name,
  language: "typescript",
  location: { path, line },
});

const edge = (
  from: string,
  to: string,
  id: string,
  path: string,
): CorpusEdge => ({
  from,
  to,
  kind: "calls",
  confidence: "certain",
  evidence: [
    {
      id,
      kind: "source",
      path,
      line: 1,
      detector: "cartograph.identity-corpus@1",
      contentHash: sourceHash,
    },
  ],
});

const makeGeneratedCase = (
  category: IdentityCategory,
  index: number,
  random: XorShift32,
): CorpusCase => {
  const token = `${index}-${random.int(10_000)}`;
  const line = 2 + random.int(20);
  if (category === "line-move") {
    const name = `load${token}`;
    const stableKey = `function:src/line-${token}.ts:${name}`;
    return {
      id: `generated-${category}-${index}`,
      category,
      before: [
        node(`before-${token}`, stableKey, name, `src/line-${token}.ts`, line),
      ],
      after: [
        node(
          `after-${token}`,
          stableKey,
          name,
          `src/line-${token}.ts`,
          line + 30 + random.int(100),
        ),
      ],
    };
  }

  if (category === "file-move") {
    const name = `load${token}`;
    return {
      id: `generated-${category}-${index}`,
      category,
      before: [
        node(
          `before-${token}`,
          `function:src/old-${token}.ts:${name}`,
          name,
          `src/old-${token}.ts`,
          line,
        ),
      ],
      after: [
        node(
          `after-${token}`,
          `function:src/new-${token}.ts:${name}`,
          name,
          `src/new-${token}.ts`,
          line,
        ),
      ],
    };
  }

  if (category === "supported-rename") {
    const callerKey = `function:src/caller-${token}.ts:run`;
    const beforeTargetKey = `function:src/target-${token}.ts:load`;
    const afterTargetKey = `function:src/target-${token}.ts:loadAll`;
    return {
      id: `generated-${category}-${index}`,
      category,
      before: [
        node(`caller-${token}`, callerKey, "run", `src/caller-${token}.ts`, 1),
        node(
          `before-target-${token}`,
          beforeTargetKey,
          "load",
          `src/target-${token}.ts`,
          line,
        ),
      ],
      after: [
        node(`caller-${token}`, callerKey, "run", `src/caller-${token}.ts`, 1),
        node(
          `after-target-${token}`,
          afterTargetKey,
          "loadAll",
          `src/target-${token}.ts`,
          line,
        ),
      ],
      beforeEdges: [
        edge(
          `caller-${token}`,
          `before-target-${token}`,
          `rename-edge-${token}`,
          `src/caller-${token}.ts`,
        ),
      ],
      afterEdges: [
        edge(
          `caller-${token}`,
          `after-target-${token}`,
          `rename-edge-${token}`,
          `src/caller-${token}.ts`,
        ),
      ],
    };
  }

  if (category === "duplicate-names") {
    const count = 2 + random.int(2);
    return {
      id: `generated-${category}-${index}`,
      category,
      before: Array.from({ length: count }, (_, item) =>
        node(
          `before-${token}-${item}`,
          `function:src/duplicate-old-${token}-${item}.ts:load`,
          "load",
          `src/duplicate-old-${token}-${item}.ts`,
          line + item,
        ),
      ),
      after: Array.from({ length: count }, (_, item) =>
        node(
          `after-${token}-${item}`,
          `function:src/duplicate-new-${token}-${item}.ts:load`,
          "load",
          `src/duplicate-new-${token}-${item}.ts`,
          line + item,
        ),
      ),
    };
  }

  if (category === "overloads") {
    const overloads = ["string", "number"];
    const callers = overloads.map((kind) =>
      node(
        `caller-${token}-${kind}`,
        `function:src/caller-${token}-${kind}.ts:run`,
        `run${kind}`,
        `src/caller-${token}-${kind}.ts`,
        1,
      ),
    );
    const beforeTargets = overloads.map((kind, item) =>
      node(
        `before-${token}-${kind}`,
        `function:src/old-${token}.ts:parse#${kind}`,
        "parse",
        `src/old-${token}.ts`,
        line + item * 4,
      ),
    );
    const afterTargets = overloads.map((kind, item) =>
      node(
        `after-${token}-${kind}`,
        `function:src/new-${token}.ts:parse#${kind}`,
        "parse",
        `src/new-${token}.ts`,
        line + item * 4,
      ),
    );
    return {
      id: `generated-${category}-${index}`,
      category,
      before: [...callers, ...beforeTargets],
      after: [...callers, ...afterTargets],
      beforeEdges: overloads.map((kind) =>
        edge(
          `caller-${token}-${kind}`,
          `before-${token}-${kind}`,
          `overload-edge-${token}-${kind}`,
          `src/caller-${token}-${kind}.ts`,
        ),
      ),
      afterEdges: overloads.map((kind) =>
        edge(
          `caller-${token}-${kind}`,
          `after-${token}-${kind}`,
          `overload-edge-${token}-${kind}`,
          `src/caller-${token}-${kind}.ts`,
        ),
      ),
    };
  }

  if (category === "path-alias") {
    const beforePath = `packages\\legacy\\src\\resolve-${token}.ts`;
    const afterPath = `src/resolve-${token}.ts`;
    return {
      id: `generated-${category}-${index}`,
      category,
      before: [
        node(
          `before-${token}`,
          `function:packages/legacy/src/resolve-${token}.ts:resolve`,
          `resolveLegacy${token}`,
          beforePath,
          line,
        ),
      ],
      after: [
        node(
          `after-${token}`,
          `function:src/resolve-${token}.ts:resolve`,
          `resolveCurrent${token}`,
          afterPath,
          line,
        ),
      ],
      pathHistory: [{ beforePath, afterPath }],
    };
  }

  const count = 2;
  return {
    id: `generated-${category}-${index}`,
    category,
    before: Array.from({ length: count }, (_, item) =>
      node(
        `before-${token}-${item}`,
        `function:src/ambiguous-old-${token}-${item}.ts:load`,
        "load",
        `src/ambiguous-old-${token}-${item}.ts`,
        line + item,
      ),
    ),
    after: [
      node(
        `after-${token}`,
        `function:src/ambiguous-new-${token}.ts:load`,
        "load",
        `src/ambiguous-new-${token}.ts`,
        line,
      ),
    ],
  };
};

export const loadIdentityCorpus = (): CorpusFixture =>
  JSON.parse(readFileSync(fixturePath, "utf8")) as CorpusFixture;

export const generateIdentityCorpus = (
  seed: number,
  iterations: number,
): CorpusCase[] => {
  const random = new XorShift32(seed);
  return Array.from({ length: iterations }, (_, index) =>
    makeGeneratedCase(categories[index % categories.length]!, index, random),
  );
};

const snapshotFor = (
  nodes: readonly CorpusNode[],
  edges: readonly CorpusEdge[] = [],
) =>
  createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha: "identity-corpus" },
    nodes,
    edges,
    diagnostics: [],
  });

const minimizedCase = (current: CorpusCase): string =>
  JSON.stringify({
    id: current.id,
    category: current.category,
    before: current.before.slice(0, 2),
    after: current.after.slice(0, 2),
    beforeEdges: current.beforeEdges?.slice(0, 2),
    afterEdges: current.afterEdges?.slice(0, 2),
    pathHistory: current.pathHistory,
  });

const failCase = (current: CorpusCase, message: string): never => {
  throw new Error(
    `${current.id}: ${message}; minimized=${minimizedCase(current)}`,
  );
};

const assertCaseAccounting = (
  current: CorpusCase,
  result: IdentityReconciliation,
): void => {
  const beforeKeys = new Set(current.before.map((item) => item.stableKey));
  const afterKeys = new Set(current.after.map((item) => item.stableKey));
  const matchedBefore = new Set(
    result.matches.map((item) => item.beforeStableKey),
  );
  const matchedAfter = new Set(
    result.matches.map((item) => item.afterStableKey),
  );
  if (matchedBefore.size !== result.matches.length)
    failCase(current, "a before identity matched more than once");
  if (matchedAfter.size !== result.matches.length)
    failCase(current, "an after identity matched more than once");
  const removed = new Set(result.removed.map((item) => item.stableKey));
  const added = new Set(result.added.map((item) => item.stableKey));
  for (const key of beforeKeys)
    if (!matchedBefore.has(key) && !removed.has(key))
      failCase(current, `before identity was not accounted for: ${key}`);
  for (const key of afterKeys)
    if (!matchedAfter.has(key) && !added.has(key))
      failCase(current, `after identity was not accounted for: ${key}`);
};

const assertCategoryInvariant = (
  current: CorpusCase,
  result: IdentityReconciliation,
): void => {
  const methods = new Set(result.matches.map((item) => item.method));
  if (current.category === "line-move") {
    if (
      !result.matches.some((item) => item.method === "stable-key") ||
      result.added.length !== 0 ||
      result.removed.length !== 0
    )
      failCase(current, "line move did not preserve exact identity");
  } else if (current.category === "file-move") {
    if (
      !methods.has("same-name") ||
      result.added.length !== 0 ||
      result.removed.length !== 0
    )
      failCase(current, "file move did not select a unique same-name match");
  } else if (current.category === "supported-rename") {
    if (
      !methods.has("neighborhood") ||
      result.added.length !== 0 ||
      result.removed.length !== 0
    )
      failCase(current, "supported rename lacked a unique neighborhood match");
  } else if (
    current.category === "duplicate-names" ||
    current.category === "ambiguous"
  ) {
    if (result.ambiguous.length === 0 || result.matches.length !== 0)
      failCase(
        current,
        "ambiguous candidates were guessed instead of preserved",
      );
  } else if (current.category === "overloads") {
    if (result.matches.length < 4 || result.ambiguous.length !== 0)
      failCase(
        current,
        "overloads were not disambiguated by their neighborhoods",
      );
  } else if (
    current.category === "path-alias" &&
    (!methods.has("path-history") ||
      result.added.length !== 0 ||
      result.removed.length !== 0)
  ) {
    failCase(
      current,
      "path alias did not require and use normalized path history",
    );
  }
};

const evaluateCase = (
  current: CorpusCase,
  maxCandidates: number,
  maxNodesPerSnapshot: number,
  source: "curated" | "generated",
): CaseReport => {
  if (
    current.before.length > maxNodesPerSnapshot ||
    current.after.length > maxNodesPerSnapshot
  )
    failCase(current, "case exceeds the bounded node ceiling");
  const options =
    current.pathHistory === undefined
      ? { maxCandidates }
      : { maxCandidates, pathHistory: current.pathHistory };
  const result = reconcileGraphNodeIdentities(
    snapshotFor(current.before, current.beforeEdges),
    snapshotFor(current.after, current.afterEdges),
    options,
  );
  const reordered = reconcileGraphNodeIdentities(
    snapshotFor(
      [...current.before].reverse(),
      [...(current.beforeEdges ?? [])].reverse(),
    ),
    snapshotFor(
      [...current.after].reverse(),
      [...(current.afterEdges ?? [])].reverse(),
    ),
    options,
  );
  if (
    serializeIdentityReconciliation(result) !==
    serializeIdentityReconciliation(reordered)
  )
    failCase(current, "reconciliation changed when graph input order changed");
  assertCaseAccounting(current, result);
  assertCategoryInvariant(current, result);
  if (current.expected !== undefined) {
    const expected = current.expected;
    const actualMethods = result.matches.map((item) => item.method).sort();
    const expectedMethods = [...(expected.methods ?? [])].sort();
    const actualReasons = result.ambiguous.map((item) => item.reason).sort();
    const expectedReasons = [...(expected.ambiguityReasons ?? [])].sort();
    if (
      result.matches.length !== expected.matches ||
      result.added.length !== expected.added ||
      result.removed.length !== expected.removed ||
      result.ambiguous.length !== expected.ambiguous ||
      result.unsupported.length !== expected.unsupported ||
      JSON.stringify(actualMethods) !== JSON.stringify(expectedMethods) ||
      JSON.stringify(actualReasons) !== JSON.stringify(expectedReasons)
    )
      failCase(
        current,
        `expected ${JSON.stringify(expected)} but received ${JSON.stringify({
          matches: result.matches.length,
          added: result.added.length,
          removed: result.removed.length,
          ambiguous: result.ambiguous.length,
          unsupported: result.unsupported.length,
          methods: actualMethods,
          ambiguityReasons: actualReasons,
        })}`,
      );
  }
  return {
    id: current.id,
    category: current.category,
    source,
    beforeNodes: current.before.length,
    afterNodes: current.after.length,
    matches: result.matches.length,
    expectedMatches: expectedMatchesForCategory(current),
    preserved: Math.min(
      result.matches.length,
      expectedMatchesForCategory(current),
    ),
    falseMatches: Math.max(
      0,
      result.matches.length - expectedMatchesForCategory(current),
    ),
    unmatched: Math.max(
      0,
      expectedMatchesForCategory(current) - result.matches.length,
    ),
    added: result.added.length,
    removed: result.removed.length,
    ambiguous: result.ambiguous.length,
    unsupported: result.unsupported.length,
    methods: result.matches.map((item) => item.method),
  };
};

type QualityMetrics = {
  cases: number;
  beforeNodes: number;
  afterNodes: number;
  eligibleMatches: number;
  preserved: number;
  falseMatches: number;
  ambiguous: number;
  unmatched: number;
  unsupported: number;
  preservationRate: number | null;
  falseMatchRate: number;
  ambiguityRate: number;
  unmatchedRate: number;
  unsupportedRate: number;
};

const rate = (numerator: number, denominator: number): number =>
  Number((numerator / Math.max(1, denominator)).toFixed(4));

const summarizeQuality = (reports: readonly CaseReport[]): QualityMetrics => {
  const beforeNodes = reports.reduce(
    (sum, current) => sum + current.beforeNodes,
    0,
  );
  const afterNodes = reports.reduce(
    (sum, current) => sum + current.afterNodes,
    0,
  );
  const eligibleMatches = reports.reduce(
    (sum, current) => sum + current.expectedMatches,
    0,
  );
  const preserved = reports.reduce(
    (sum, current) => sum + current.preserved,
    0,
  );
  const falseMatches = reports.reduce(
    (sum, current) => sum + current.falseMatches,
    0,
  );
  const matched = reports.reduce((sum, current) => sum + current.matches, 0);
  const ambiguous = reports.reduce(
    (sum, current) => sum + current.ambiguous,
    0,
  );
  const unmatched = reports.reduce(
    (sum, current) => sum + current.unmatched,
    0,
  );
  const unsupported = reports.reduce(
    (sum, current) => sum + current.unsupported,
    0,
  );
  return {
    cases: reports.length,
    beforeNodes,
    afterNodes,
    eligibleMatches,
    preserved,
    falseMatches,
    ambiguous,
    unmatched,
    unsupported,
    preservationRate:
      eligibleMatches === 0 ? null : rate(preserved, eligibleMatches),
    falseMatchRate: rate(falseMatches, matched),
    ambiguityRate: rate(ambiguous, beforeNodes),
    unmatchedRate: rate(unmatched, eligibleMatches),
    unsupportedRate: rate(unsupported, beforeNodes),
  };
};

const qualityByCategory = (
  reports: readonly CaseReport[],
): Record<IdentityCategory, QualityMetrics> =>
  Object.fromEntries(
    categories.map((category) => [
      category,
      summarizeQuality(
        reports.filter((current) => current.category === category),
      ),
    ]),
  ) as Record<IdentityCategory, QualityMetrics>;

export type IdentityCorpusReport = ReturnType<typeof runIdentityCorpus>;

export const runIdentityCorpus = (): {
  ok: true;
  contract: string;
  seed: number;
  generator: CorpusFixture["generator"];
  invariants: number;
  regressionCases: number;
  generatedCases: number;
  minimizedFailures: number;
  quality: {
    totalCases: number;
    totalNodes: number;
    matchedNodes: number;
    ambiguousNodes: number;
    unsupportedNodes: number;
    matchRate: number;
    ambiguityRate: number;
    categories: Record<IdentityCategory, number>;
    curated: QualityMetrics;
    generated: QualityMetrics;
    byCategory: {
      curated: Record<IdentityCategory, QualityMetrics>;
      generated: Record<IdentityCategory, QualityMetrics>;
    };
  };
} => {
  const fixture = loadIdentityCorpus();
  if (
    fixture.schemaVersion !== 1 ||
    fixture.contract !== "cartograph.identity-corpus"
  )
    throw new Error("identity corpus fixture contract is unsupported");
  if (fixture.generator.algorithm !== "xorshift32-v1")
    throw new Error("identity corpus generator algorithm is unsupported");
  if (fixture.regressions.length < categories.length)
    throw new Error("identity corpus is missing minimized regression fixtures");
  const regressionReports = fixture.regressions.map((current) =>
    evaluateCase(
      current,
      fixture.generator.maxCandidates,
      fixture.generator.maxNodesPerSnapshot,
      "curated",
    ),
  );
  const generated = generateIdentityCorpus(
    fixture.seed,
    fixture.generator.iterations,
  );
  const generatedReports = generated.map((current) =>
    evaluateCase(
      current,
      fixture.generator.maxCandidates,
      fixture.generator.maxNodesPerSnapshot,
      "generated",
    ),
  );
  const reports = [...regressionReports, ...generatedReports];
  const totalNodes = reports.reduce(
    (sum, current) => sum + current.beforeNodes + current.afterNodes,
    0,
  );
  const matchedNodes = reports.reduce(
    (sum, current) => sum + current.matches,
    0,
  );
  const ambiguousNodes = reports.reduce(
    (sum, current) => sum + current.ambiguous,
    0,
  );
  const unsupportedNodes = reports.reduce(
    (sum, current) => sum + current.unsupported,
    0,
  );
  const categoriesResult = Object.fromEntries(
    categories.map((category) => [
      category,
      reports.filter((current) => current.category === category).length,
    ]),
  ) as Record<IdentityCategory, number>;
  const beforeNodes = reports.reduce(
    (sum, current) => sum + current.beforeNodes,
    0,
  );
  return {
    ok: true,
    contract: fixture.contract,
    seed: fixture.seed,
    generator: fixture.generator,
    invariants: fixture.invariants.length,
    regressionCases: regressionReports.length,
    generatedCases: generatedReports.length,
    minimizedFailures: 0,
    quality: {
      totalCases: reports.length,
      totalNodes,
      matchedNodes,
      ambiguousNodes,
      unsupportedNodes,
      matchRate: Number((matchedNodes / Math.max(1, beforeNodes)).toFixed(4)),
      ambiguityRate: Number(
        (ambiguousNodes / Math.max(1, beforeNodes)).toFixed(4),
      ),
      categories: categoriesResult,
      curated: summarizeQuality(
        reports.filter((current) => current.source === "curated"),
      ),
      generated: summarizeQuality(
        reports.filter((current) => current.source === "generated"),
      ),
      byCategory: {
        curated: qualityByCategory(
          reports.filter((current) => current.source === "curated"),
        ),
        generated: qualityByCategory(
          reports.filter((current) => current.source === "generated"),
        ),
      },
    },
  };
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  const report = runIdentityCorpus();
  console.log(JSON.stringify(report));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath !== undefined) {
    appendFileSync(
      summaryPath,
      `## CARTOGRAPH identity corpus\n\n- Seed: \`${report.seed}\`\n- Generated cases: ${report.generatedCases}\n- Minimized regression fixtures: ${report.regressionCases}\n- Match rate: ${report.quality.matchRate}\n- Ambiguity rate: ${report.quality.ambiguityRate}\n- Result: passed\n`,
      "utf8",
    );
  }
}
