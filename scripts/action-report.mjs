#!/usr/bin/env node
/* global console, process */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseGraphDiff } from "../dist/core/index.js";
import { renderHtmlReport } from "../dist/report/render.js";

const [jsonPath, htmlPath, summaryPath = "", artifactName = "report"] =
  process.argv.slice(2);

if (jsonPath === undefined || htmlPath === undefined) {
  throw new Error(
    "usage: action-report.mjs <graph-diff.json> <report.html> [summary-file] [artifact-name]",
  );
}

const escapeSummary = (value) =>
  value.replace(/[\\`*_{}[\]()#+.!|<>-]/gu, "\\$&").replace(/[\r\n]/gu, " ");

const shortSha = (value) => value.slice(0, 12);

const source = await readFile(resolve(jsonPath), "utf8");
const diff = parseGraphDiff(JSON.parse(source));
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
  `- Static report: artifact \`${escapeSummary(artifactName)}\``,
  "",
].join("\n");

if (summaryPath.length > 0)
  await writeFile(resolve(summaryPath), summary, "utf8");
else console.log(summary);
