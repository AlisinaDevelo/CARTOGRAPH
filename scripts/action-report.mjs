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

if (jsonPath === undefined || htmlPath === undefined) {
  throw new Error(
    "usage: action-report.mjs <graph-diff.json> <report.html> [summary-file] [artifact-name] [upload-report] [policy-report] [review-context] [review-json] [review-html]",
  );
}
if (uploadReport !== "true" && uploadReport !== "false")
  throw new Error("upload-report must be true or false");

const escapeSummary = (value) =>
  value.replace(/[\\`*_{}[\]()#+.!|<>-]/gu, "\\$&").replace(/[\r\n]/gu, " ");

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
  ...(policy === undefined
    ? []
    : [
        `- Policy mode: \`${escapeSummary(policy.mode)}\`; status: \`${escapeSummary(policy.status)}\``,
        `- Policy findings: ${policy.violations.length} violations; ${policy.unsupported.length} unsupported rules`,
      ]),
  ...(reviewMarkdown.length === 0 ? [] : ["", reviewMarkdown.trimEnd(), ""]),
  uploadReport === "true"
    ? `- Static report: artifact \`${escapeSummary(artifactName)}\``
    : "- Static report upload: disabled by policy",
  "",
].join("\n");

if (summaryPath.length > 0)
  await writeFile(resolve(summaryPath), summary, "utf8");
else console.log(summary);
