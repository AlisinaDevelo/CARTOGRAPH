#!/usr/bin/env node
/* global console, process */

import { Buffer } from "node:buffer";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  buildReviewSummary,
  parseGraphDiff,
  PolicyEvaluationSchema,
  serializeReviewSummary,
} from "../dist/core/index.js";
import {
  renderReviewSummaryHtml,
  renderReviewSummaryMarkdown,
} from "../dist/report/review.js";
import { renderHtmlReport } from "../dist/report/render.js";

const [
  jsonPath,
  htmlPath,
  summaryPath = "",
  artifactName = "report",
  uploadReport = "true",
  policyPath = "",
  reviewContextPath = "",
  reviewJsonPath = "",
  reviewHtmlPath = "",
] = process.argv.slice(2);
const MAX_REVIEW_CONTEXT_BYTES = 64 * 1024 * 1024;
const MAX_ANNOTATION_LIMIT = 20;

if (jsonPath === undefined || htmlPath === undefined) {
  throw new Error(
    "usage: action-report.mjs <graph-diff.json> <report.html> [summary-file] [artifact-name] [upload-report] [policy-report] [review-context] [review-json] [review-html]",
  );
}
if (uploadReport !== "true" && uploadReport !== "false")
  throw new Error("upload-report must be true or false");

const annotationLimitText = process.env.CARTOGRAPH_ANNOTATION_LIMIT ?? "20";
if (!/^(?:0|[1-9]|1[0-9]|20)$/u.test(annotationLimitText))
  throw new Error(
    `annotation-limit must be an integer from 0 through ${MAX_ANNOTATION_LIMIT}`,
  );
const annotationLimit = Number(annotationLimitText);

const escapeSummary = (value) =>
  value.replace(/[\\`*_{}[\]()#+.!|<>-]/gu, "\\$&").replace(/[\r\n]/gu, " ");

const escapeWorkflowCommand = (value) =>
  String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");

const boundedAnnotationText = (value, maximum = 160) =>
  String(value)
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, maximum);

const githubRunUrl = (() => {
  const server = process.env.GITHUB_SERVER_URL?.trim().replace(/\/+$/u, "");
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  const runId = process.env.GITHUB_RUN_ID?.trim();
  if (
    server === undefined ||
    repository === undefined ||
    runId === undefined ||
    !/^https:\/\/[A-Za-z0-9.-]+$/u.test(server) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !/^\d+$/u.test(runId)
  )
    return undefined;
  return `${server}/${repository}/actions/runs/${runId}`;
})();

const reportedEdges = (diff) => {
  const records = new Map();
  const add = (edge) => {
    const key = `${edge.from}\u0000${edge.kind}\u0000${edge.to}`;
    if (!records.has(key)) records.set(key, edge);
  };
  diff.edges.added.forEach(add);
  diff.edges.removed.forEach(add);
  diff.edges.changed.forEach((change) => add(change.after));
  diff.edges.rewired.forEach((change) => {
    add(change.before);
    add(change.after);
  });
  return [...records.values()];
};

const reportedDiagnostics = (diff) => {
  const records = new Map();
  const add = (diagnostic) => {
    if (!records.has(diagnostic.id)) records.set(diagnostic.id, diagnostic);
  };
  diff.diagnostics.added.forEach(add);
  diff.diagnostics.removed.forEach(add);
  diff.diagnostics.changed.forEach((change) => add(change.after));
  return [...records.values()];
};

const sourceLocation = (evidence) => {
  if (evidence.kind !== "source") return undefined;
  const path = evidence.location?.path ?? evidence.path;
  const line = evidence.location?.line ?? evidence.line;
  const endLine = evidence.location?.endLine ?? evidence.endLine;
  const column = evidence.location?.column ?? evidence.column;
  const endColumn = evidence.location?.endColumn ?? evidence.endColumn;
  if (
    path === undefined ||
    line === undefined ||
    !Number.isInteger(line) ||
    line < 1 ||
    (endLine !== undefined && (!Number.isInteger(endLine) || endLine < line)) ||
    (column !== undefined && (!Number.isInteger(column) || column < 1)) ||
    (endColumn !== undefined && (!Number.isInteger(endColumn) || endColumn < 1))
  )
    return undefined;
  const normalized = path.normalize("NFC").replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    normalized.startsWith("//") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/u.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part.length === 0)
  )
    return undefined;
  return { path: normalized, line, endLine, column, endColumn };
};

const annotationCandidates = (diff) => {
  const candidates = [];
  const seen = new Set();
  const add = (level, label, evidence, detail) => {
    const location = sourceLocation(evidence);
    if (location === undefined) return;
    const key = `${level}\u0000${label}\u0000${evidence.id}\u0000${location.path}\u0000${location.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      level,
      label: boundedAnnotationText(label, 80),
      message: boundedAnnotationText(detail),
      evidenceId: boundedAnnotationText(evidence.id, 120),
      ...location,
    });
  };
  const addEdge = (change, edge) => {
    const label = `${change} ${edge.kind} edge`;
    for (const evidence of edge.evidence)
      add(
        "notice",
        label,
        evidence,
        `${label}; confidence ${edge.confidence}; evidence-backed location`,
      );
  };
  for (const edge of diff.edges.added) addEdge("Added", edge);
  for (const edge of diff.edges.removed) addEdge("Removed", edge);
  for (const change of diff.edges.changed) addEdge("Changed", change.after);
  for (const change of diff.edges.rewired) {
    addEdge("Rewired before", change.before);
    addEdge("Rewired after", change.after);
  }
  const addDiagnostic = (change, diagnostic) => {
    const level =
      diagnostic.severity === "error" ? "error" : diagnostic.severity;
    const label = `${change} diagnostic ${diagnostic.code}`;
    for (const evidence of diagnostic.evidence)
      add(
        level === "info" ? "notice" : level,
        label,
        evidence,
        `${label}; evidence-backed location`,
      );
  };
  for (const diagnostic of diff.diagnostics.added)
    addDiagnostic("Added", diagnostic);
  for (const diagnostic of diff.diagnostics.removed)
    addDiagnostic("Removed", diagnostic);
  for (const change of diff.diagnostics.changed)
    addDiagnostic("Changed", change.after);
  const levelOrder = { error: 0, warning: 1, notice: 2 };
  return candidates.sort(
    (left, right) =>
      levelOrder[left.level] - levelOrder[right.level] ||
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      (left.endLine ?? left.line) - (right.endLine ?? right.line) ||
      left.label.localeCompare(right.label) ||
      left.evidenceId.localeCompare(right.evidenceId),
  );
};

const emitAnnotations = (candidates) => {
  const enabled =
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.CARTOGRAPH_EMIT_ANNOTATIONS === "true";
  const selected = candidates.slice(0, annotationLimit);
  if (enabled) {
    for (const annotation of selected) {
      const properties = [
        `file=${escapeWorkflowCommand(annotation.path)}`,
        `line=${annotation.line}`,
        ...(annotation.endLine === undefined
          ? []
          : [`endLine=${annotation.endLine}`]),
        ...(annotation.column === undefined
          ? []
          : [`col=${annotation.column}`]),
        ...(annotation.endColumn === undefined
          ? []
          : [`endColumn=${annotation.endColumn}`]),
        `title=${escapeWorkflowCommand(`CARTOGRAPH ${annotation.label}`)}`,
      ];
      console.log(
        `::${annotation.level} ${properties.join(",")}::${escapeWorkflowCommand(annotation.message)}`,
      );
    }
  }
  return {
    enabled,
    prepared: candidates.length,
    emitted: enabled ? selected.length : 0,
    cap: annotationLimit,
  };
};

const shortSha = (value) => value.slice(0, 12);

const source = await readFile(resolve(jsonPath), "utf8");
const diff = parseGraphDiff(JSON.parse(source));
let policy;
if (policyPath.length > 0) {
  try {
    policy = PolicyEvaluationSchema.parse(
      JSON.parse(await readFile(resolve(policyPath), "utf8")),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
const report = renderHtmlReport(diff);
await writeFile(resolve(htmlPath), report, { mode: 0o600 });

let reviewMarkdown = "";
if (reviewJsonPath.length > 0 || reviewHtmlPath.length > 0) {
  if (reviewJsonPath.length === 0 || reviewHtmlPath.length === 0)
    throw new Error("review-json and review-html must be supplied together");
  let context = {};
  if (reviewContextPath.length > 0) {
    if (
      isAbsolute(reviewContextPath) ||
      reviewContextPath.startsWith("~") ||
      reviewContextPath.split(/[\\/]+/u).some((part) => part === "..") ||
      /^[A-Za-z][A-Za-z\d+.-]*:/u.test(reviewContextPath)
    )
      throw new Error("review-context must be a repository-relative path");
    const repositoryRoot = resolve(process.cwd());
    const contextPath = resolve(repositoryRoot, reviewContextPath);
    const contextRelative = relative(repositoryRoot, contextPath);
    if (
      contextRelative === ".." ||
      contextRelative.startsWith(`..${sep}`) ||
      isAbsolute(contextRelative)
    )
      throw new Error(
        "review-context must stay inside the checked-out repository",
      );
    const metadata = await lstat(contextPath);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("review-context must be a regular non-symlink file");
    const realRepositoryRoot = await realpath(repositoryRoot);
    const realContextPath = await realpath(contextPath);
    const realRelative = relative(realRepositoryRoot, realContextPath);
    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${sep}`) ||
      isAbsolute(realRelative)
    )
      throw new Error(
        "review-context must resolve inside the checked-out repository",
      );
    if (metadata.size > MAX_REVIEW_CONTEXT_BYTES)
      throw new Error("review-context exceeds the 64 MiB input limit");
    const contextSource = await readFile(contextPath, "utf8");
    if (Buffer.byteLength(contextSource, "utf8") > MAX_REVIEW_CONTEXT_BYTES)
      throw new Error("review-context exceeds the 64 MiB input limit");
    const parsedContext = JSON.parse(contextSource);
    if (
      parsedContext === null ||
      typeof parsedContext !== "object" ||
      Array.isArray(parsedContext)
    )
      throw new Error("review-context must contain a JSON object");
    context = parsedContext;
  }
  const reviewInput = {
    schemaVersion: 1,
    contract: "cartograph.review-summary",
    diff,
    context: {
      ...context,
      ...(policy === undefined ? {} : { policy }),
    },
  };
  const review = buildReviewSummary(reviewInput);
  await writeFile(
    resolve(reviewJsonPath),
    `${serializeReviewSummary(review)}\n`,
    { mode: 0o600 },
  );
  await writeFile(resolve(reviewHtmlPath), renderReviewSummaryHtml(review), {
    mode: 0o600,
  });
  reviewMarkdown = renderReviewSummaryMarkdown(review);
}

const comparison = diff.comparison;
const edges = reportedEdges(diff);
const confidenceCounts = {
  certain: 0,
  inferred: 0,
  observed: 0,
  user_confirmed: 0,
};
for (const edge of edges) confidenceCounts[edge.confidence] += 1;
const diagnostics = reportedDiagnostics(diff);
const unresolvedDiagnostics = diagnostics.filter((diagnostic) =>
  /UNRESOLVED/u.test(diagnostic.code),
).length;
const unresolvedEdges = edges.filter(
  (edge) => edge.evidence.length === 0 || edge.unresolvedReason !== undefined,
).length;
const candidates = annotationCandidates(diff);
const annotationResult = emitAnnotations(candidates);
const summary = [
  "### CARTOGRAPH architecture diff",
  "",
  `- Mode: \`${escapeSummary(comparison?.mode ?? "direct")}\``,
  ...(comparison === undefined
    ? []
    : [
        `- Base: \`${escapeSummary(comparison.baseRef)}\` (\`${shortSha(comparison.baseCommitSha)}\`)`,
        `- Head: \`${escapeSummary(comparison.headRef)}\` (\`${shortSha(comparison.headCommitSha)}\`)`,
        ...(comparison.mergeBaseSha === undefined
          ? []
          : [`- Merge base: \`${shortSha(comparison.mergeBaseSha)}\``]),
      ]),
  `- Nodes: +${diff.summary.nodesAdded} / -${diff.summary.nodesRemoved} / ${diff.summary.nodesChanged} changed`,
  `- Edges: +${diff.summary.edgesAdded} / -${diff.summary.edgesRemoved} / ${diff.summary.edgesChanged} changed`,
  `- Diagnostics: +${diff.summary.diagnosticsAdded} / -${diff.summary.diagnosticsRemoved} / ${diff.summary.diagnosticsChanged} changed`,
  `- Edge confidence: certain ${confidenceCounts.certain}; inferred ${confidenceCounts.inferred}; observed ${confidenceCounts.observed}; user-confirmed ${confidenceCounts.user_confirmed}`,
  `- Unresolved edges: ${unresolvedEdges}`,
  `- Unresolved diagnostics: ${unresolvedDiagnostics}`,
  `- Line annotations: ${annotationResult.enabled ? `${annotationResult.emitted} emitted` : "emission disabled outside GitHub Actions"} (${annotationResult.prepared} prepared; cap ${annotationResult.cap})`,
  ...(policy === undefined
    ? []
    : [
        `- Policy mode: \`${escapeSummary(policy.mode)}\`; status: \`${escapeSummary(policy.status)}\``,
        `- Policy findings: ${policy.violations.length} violations; ${policy.unsupported.length} unsupported rules`,
      ]),
  ...(reviewMarkdown.length === 0 ? [] : ["", reviewMarkdown.trimEnd(), ""]),
  uploadReport === "true"
    ? githubRunUrl === undefined
      ? `- Static report: artifact \`${escapeSummary(artifactName)}\``
      : `- Static report: [artifact \`${escapeSummary(artifactName)}\`](${githubRunUrl})`
    : "- Static report upload: disabled by policy",
  "",
].join("\n");

if (summaryPath.length > 0)
  await writeFile(resolve(summaryPath), summary, "utf8");
else console.log(summary);
