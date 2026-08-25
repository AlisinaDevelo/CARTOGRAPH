#!/usr/bin/env node
/* global console, process */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseGraphDiff, PolicyEvaluationSchema } from "../dist/core/index.js";
import { renderHtmlReport } from "../dist/report/render.js";

const [
  jsonPath,
  htmlPath,
  summaryPath = "",
  artifactName = "report",
  uploadReport = "true",
  policyPath = "",
] = process.argv.slice(2);

if (jsonPath === undefined || htmlPath === undefined) {
  throw new Error(
    "usage: action-report.mjs <graph-diff.json> <report.html> [summary-file] [artifact-name] [upload-report] [policy-report]",
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
  uploadReport === "true"
    ? `- Static report: artifact \`${escapeSummary(artifactName)}\``
    : "- Static report upload: disabled by policy",
  "",
].join("\n");

if (summaryPath.length > 0)
  await writeFile(resolve(summaryPath), summary, "utf8");
else console.log(summary);
