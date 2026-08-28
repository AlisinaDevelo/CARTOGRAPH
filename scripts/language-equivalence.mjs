#!/usr/bin/env node
/* global URL, console, process */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";

import {
  ADAPTER_API_VERSION,
  analyzeTypeScriptRepository,
  createGraphSnapshot,
  createRustAdapter,
  reconcileGraphNodeIdentities,
  runAdapter,
  stableStringify,
} from "../src/index.js";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(
  argumentValue("--root") ??
    process.env.CARTOGRAPH_LANGUAGE_EQUIVALENCE_ROOT ??
    fileURLToPath(new URL("..", import.meta.url)),
);
const corpusPath = resolve(
  repositoryRoot,
  argumentValue("--corpus") ??
    "test/fixtures/language-equivalence/scenarios.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/language-equivalence.v0.1.schema.json",
);

const LANGUAGE_EQUIVALENCE_CONTRACT = "cartograph.language-equivalence";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DETECTOR_PATTERN = /@(?:[A-Za-z0-9._-]+)(?:\/|$)/u;

const fail = (message) => {
  throw new Error(message);
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const containedPath = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0)
    fail(`${label} must be a non-empty repository-relative path`);
  const candidate = resolve(repositoryRoot, value);
  const relativePath = relative(repositoryRoot, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  )
    fail(`${label} escapes the repository root: ${value}`);
  if (!existsSync(candidate)) fail(`${label} does not exist: ${value}`);
  return candidate;
};

const countBy = (items, key) => {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
};

const sorted = (values) =>
  [...values].sort((left, right) => left.localeCompare(right));

const sourceEvidenceIsComplete = (evidence) =>
  evidence.every(
    (entry) =>
      entry.kind === "source" &&
      typeof entry.detector === "string" &&
      DETECTOR_PATTERN.test(entry.detector) &&
      typeof entry.contentHash === "string" &&
      SHA256_PATTERN.test(
        entry.contentHash.startsWith("sha256:")
          ? entry.contentHash
          : `sha256:${entry.contentHash}`,
      ) &&
      (typeof entry.path === "string" || entry.location !== undefined) &&
      (Number.isInteger(entry.line) || entry.location?.line !== undefined),
  );

const graphSummary = (graph) => {
  const edgeEvidence = graph.edges.flatMap((edge) => edge.evidence);
  const diagnosticEvidence = graph.diagnostics.flatMap(
    (diagnostic) => diagnostic.evidence,
  );
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    diagnostics: graph.diagnostics.length,
    nodeCounts: countBy(graph.nodes, "kind"),
    edgeCounts: countBy(graph.edges, "kind"),
    diagnosticCodes: sorted(
      graph.diagnostics.map((diagnostic) => diagnostic.code),
    ),
    edgeEvidence: edgeEvidence.length,
    diagnosticEvidence: diagnosticEvidence.length,
    evidenceComplete:
      sourceEvidenceIsComplete(edgeEvidence) &&
      sourceEvidenceIsComplete(diagnosticEvidence),
  };
};

const adapterRequest = (rootDir, revision) => ({
  apiVersion: ADAPTER_API_VERSION,
  source: {
    rootDir,
    include: ["."],
    exclude: [],
    revision: { commitSha: revision },
  },
  config: {},
  resources: {
    maxFiles: 32,
    maxFileBytes: 16_384,
    maxSourceBytes: 65_536,
    maxInputBytes: 16_384,
    maxOutputBytes: 2 * 1024 * 1024,
    maxMemoryBytes: 1024 * 1024 * 1024,
    maxWallClockMs: 30_000,
  },
});

const analyze = (language, rootDir, caseId) => {
  if (language === "typescript") {
    return analyzeTypeScriptRepository({
      rootDir,
      include: ["."],
      exclude: [],
      extractors: ["typescript"],
      resources: {
        maxFiles: 32,
        maxFileBytes: 16_384,
        maxSourceBytes: 65_536,
        maxMemoryBytes: 1024 * 1024 * 1024,
        maxWallClockMs: 30_000,
        maxReportItems: 256,
      },
      revision: { commitSha: `language-equivalence-${caseId}-typescript` },
    });
  }
  return runAdapter(
    createRustAdapter(),
    adapterRequest(rootDir, `language-equivalence-${caseId}-rust`),
  ).graph;
};

const addDisagreement = (
  disagreements,
  category,
  caseId,
  language,
  reason,
  expected,
  actual,
) => {
  disagreements.push({
    category,
    case: caseId,
    language,
    reason,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
  });
};

const compareCounts = (
  disagreements,
  category,
  caseId,
  language,
  field,
  expected,
  actual,
) => {
  for (const [key, value] of Object.entries(expected)) {
    const observed = actual[key] ?? 0;
    if (observed !== value)
      addDisagreement(
        disagreements,
        category,
        caseId,
        language,
        `${field} count drift for ${key}`,
        value,
        observed,
      );
  }
};

const compareExpectation = (
  disagreements,
  current,
  language,
  graph,
  expectation,
) => {
  const summary = graphSummary(graph);
  compareCounts(
    disagreements,
    current.category,
    current.id,
    language,
    "node",
    expectation.nodeCounts,
    summary.nodeCounts,
  );
  compareCounts(
    disagreements,
    current.category,
    current.id,
    language,
    "edge",
    expectation.edgeCounts,
    summary.edgeCounts,
  );

  const expectedDiagnostics = sorted(expectation.diagnosticCodes);
  if (
    stableStringify(expectedDiagnostics) !==
    stableStringify(summary.diagnosticCodes)
  )
    addDisagreement(
      disagreements,
      current.category,
      current.id,
      language,
      "diagnostic code set drift",
      expectedDiagnostics,
      summary.diagnosticCodes,
    );

  if (summary.edgeEvidence < expectation.evidence.minEdgeEvidence)
    addDisagreement(
      disagreements,
      current.category,
      current.id,
      language,
      "edge evidence below declared minimum",
      expectation.evidence.minEdgeEvidence,
      summary.edgeEvidence,
    );
  if (summary.diagnosticEvidence < expectation.evidence.minDiagnosticEvidence)
    addDisagreement(
      disagreements,
      current.category,
      current.id,
      language,
      "diagnostic evidence below declared minimum",
      expectation.evidence.minDiagnosticEvidence,
      summary.diagnosticEvidence,
    );
  if (expectation.evidence.sourceBound && !summary.evidenceComplete)
    addDisagreement(
      disagreements,
      current.category,
      current.id,
      language,
      "source-bound evidence is incomplete",
      true,
      false,
    );
  return summary;
};

const findIdentityNode = (
  graph,
  side,
  language,
  caseId,
  disagreements,
  category,
) => {
  const node = graph.nodes.find(
    (candidate) =>
      candidate.kind === side.nodeKind &&
      candidate.name === side.nodeName &&
      candidate.location?.path === side.beforePath,
  );
  if (node !== undefined) return node;
  addDisagreement(
    disagreements,
    category,
    caseId,
    language,
    "identity source node is missing",
    `${side.nodeKind}:${side.nodeName}@${side.beforePath}`,
    graph.nodes
      .map((candidate) => `${candidate.kind}:${candidate.name}`)
      .sort(),
  );
  return undefined;
};

const evaluateIdentity = (
  disagreements,
  current,
  language,
  graph,
  side,
  expected,
) => {
  const beforeNode = findIdentityNode(
    graph,
    side,
    language,
    current.id,
    disagreements,
    current.category,
  );
  if (beforeNode === undefined) return undefined;

  const afterStableKey = `${beforeNode.kind}:${side.afterPath}:${beforeNode.name}`;
  const afterNode = {
    ...beforeNode,
    id: afterStableKey,
    stableKey: afterStableKey,
    location: beforeNode.location
      ? { ...beforeNode.location, path: side.afterPath }
      : { path: side.afterPath, line: 1 },
  };
  const before = createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha: `identity-before-${language}` },
    nodes: [beforeNode],
    edges: [],
    diagnostics: [],
  });
  const after = createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha: `identity-after-${language}` },
    nodes: [afterNode],
    edges: [],
    diagnostics: [],
  });
  const result = reconcileGraphNodeIdentities(before, after, {
    pathHistory: [{ beforePath: side.beforePath, afterPath: side.afterPath }],
  });
  const actual = {
    matches: result.matches.length,
    ambiguous: result.ambiguous.length,
    unsupported: result.unsupported.length,
    methods: result.matches.map((match) => match.method).sort(),
  };
  for (const [field, expectedValue] of [
    ["matches", expected.expectedMatches],
    ["ambiguous", expected.expectedAmbiguous],
    ["unsupported", expected.expectedUnsupported],
  ]) {
    if (actual[field] !== expectedValue)
      addDisagreement(
        disagreements,
        current.category,
        current.id,
        language,
        `identity ${field} drift`,
        expectedValue,
        actual[field],
      );
  }
  return actual;
};

const validateSchemaAndLoad = () => {
  const corpus = readJson(corpusPath);
  const schema = readJson(schemaPath);
  const validator = new Ajv({ allErrors: true }).compile(schema);
  if (!validator(corpus))
    fail(
      `${LANGUAGE_EQUIVALENCE_CONTRACT} schema validation failed: ${JSON.stringify(validator.errors)}`,
    );
  return corpus;
};

export const validateLanguageEquivalence = () => {
  const corpus = validateSchemaAndLoad();
  if (corpus.contract !== LANGUAGE_EQUIVALENCE_CONTRACT)
    fail(`unsupported language-equivalence contract: ${corpus.contract}`);
  const disagreements = [];
  const cases = [];
  let evidenceComplete = true;
  let identityMatches = 0;

  for (const current of corpus.cases) {
    const roots = {
      typescript: containedPath(
        current.typescript.root,
        `${current.id}.typescript.root`,
      ),
      rust: containedPath(current.rust.root, `${current.id}.rust.root`),
    };
    const graphs = {
      typescript: analyze("typescript", roots.typescript, current.id),
      rust: analyze("rust", roots.rust, current.id),
    };
    const summaries = {
      typescript: compareExpectation(
        disagreements,
        current,
        "typescript",
        graphs.typescript,
        current.typescriptExpected,
      ),
      rust: compareExpectation(
        disagreements,
        current,
        "rust",
        graphs.rust,
        current.rustExpected,
      ),
    };
    evidenceComplete =
      evidenceComplete &&
      summaries.typescript.evidenceComplete &&
      summaries.rust.evidenceComplete;

    let identity;
    if (current.identity !== undefined) {
      identity = {
        typescript: evaluateIdentity(
          disagreements,
          current,
          "typescript",
          graphs.typescript,
          current.identity.typescript,
          current.identity,
        ),
        rust: evaluateIdentity(
          disagreements,
          current,
          "rust",
          graphs.rust,
          current.identity.rust,
          current.identity,
        ),
      };
      identityMatches +=
        (identity.typescript?.matches ?? 0) + (identity.rust?.matches ?? 0);
    }

    cases.push({
      id: current.id,
      category: current.category,
      relation: current.relation,
      typescript: summaries.typescript,
      rust: summaries.rust,
      ...(identity === undefined ? {} : { identity }),
      intentionalDifferences: current.intentionalDifferences,
    });
  }

  const report = {
    ok: disagreements.length === 0,
    contract: corpus.contract,
    schemaVersion: corpus.schemaVersion,
    corpusId: corpus.corpusId,
    corpusDigest: `sha256:${createHash("sha256")
      .update(stableStringify(corpus))
      .digest("hex")}`,
    languages: ["rust", "typescript"],
    cases,
    summary: {
      cases: cases.length,
      equivalent: cases.filter((current) => current.relation === "equivalent")
        .length,
      intentionalDifference: cases.filter(
        (current) => current.relation === "intentional-difference",
      ).length,
      disagreements: disagreements.length,
      evidenceComplete,
      identityMatches,
    },
    ...(disagreements.length === 0
      ? {}
      : { disagreementDetails: disagreements }),
  };

  if (disagreements.length > 0) {
    const details = disagreements
      .map(
        (item) =>
          `[category=${item.category} case=${item.case} language=${item.language}] ${item.reason}`,
      )
      .join("; ");
    const error = new Error(
      `${LANGUAGE_EQUIVALENCE_CONTRACT} validation failed: ${details}`,
    );
    error.disagreements = disagreements;
    throw error;
  }
  return report;
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node --import tsx scripts/language-equivalence.mjs validate [--root path] [--corpus path]",
    );
    process.exitCode = 2;
  } else {
    try {
      const report = validateLanguageEquivalence();
      console.log(JSON.stringify(report));
      const summaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (summaryPath !== undefined) {
        appendFileSync(
          summaryPath,
          `## CARTOGRAPH language equivalence\n\n- Corpus: ${report.corpusId}\n- Cases: ${report.summary.cases}\n- Equivalent: ${report.summary.equivalent}\n- Intentional differences: ${report.summary.intentionalDifference}\n- Identity matches: ${report.summary.identityMatches}\n- Evidence complete: ${report.summary.evidenceComplete}\n- Result: passed\n`,
          "utf8",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`language-equivalence validation failed: ${message}`);
      process.exitCode = 1;
    }
  }
}
