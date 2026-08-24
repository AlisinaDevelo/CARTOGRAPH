import { Buffer } from "node:buffer";

import {
  GRAPH_DIFF_SCHEMA_VERSION,
  serializeGraphDiff,
  type Evidence,
  type GraphDiff,
  type GraphEdge,
} from "../core/index.js";
import { assertReportItemLimit, ResourceLimitError } from "../resources.js";

export type ReportFormat = "html" | "json" | "markdown";

export const REPORT_TOOL_VERSION = "0.1.0";
export const REPORT_LIMITS = {
  maxNodes: 10_000,
  maxEdges: 20_000,
  maxDiagnostics: 5_000,
  maxBytes: 16 * 1024 * 1024,
} as const;

const assertReportCardinality = (
  diff: GraphDiff,
  maximum: number | undefined,
): void => {
  const nodeCount =
    diff.nodes.added.length +
    diff.nodes.removed.length +
    diff.nodes.changed.length +
    diff.identity.matches.length +
    diff.identity.ambiguous.length +
    diff.identity.unsupported.length;
  const edgeCount =
    diff.edges.added.length +
    diff.edges.removed.length +
    diff.edges.changed.length;
  const diagnosticCount =
    diff.diagnostics.added.length +
    diff.diagnostics.removed.length +
    diff.diagnostics.changed.length;

  const limits = [
    [nodeCount, REPORT_LIMITS.maxNodes, "node"],
    [edgeCount, REPORT_LIMITS.maxEdges, "edge"],
    [diagnosticCount, REPORT_LIMITS.maxDiagnostics, "diagnostic"],
  ] as const;
  for (const [count, limit, label] of limits) {
    if (count > limit) {
      throw new ResourceLimitError(
        `report exceeds the ${limit.toLocaleString("en-US")} ${label} report-cardinality ceiling; reduce the compared change set before rendering`,
      );
    }
  }

  assertReportItemLimit(nodeCount + edgeCount + diagnosticCount, maximum);
};

const assertReportByteLimit = (report: string): void => {
  const bytes = Buffer.byteLength(report, "utf8");
  if (bytes > REPORT_LIMITS.maxBytes) {
    throw new ResourceLimitError(
      `report exceeds the ${(REPORT_LIMITS.maxBytes / (1024 * 1024)).toLocaleString("en-US")} MiB output ceiling (${bytes.toLocaleString("en-US")} bytes); narrow the compared change set before rendering`,
    );
  }
};

const plural = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? "" : "s"}`;

const shortRevision = (commitSha: string): string => commitSha.slice(0, 12);

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const markdownCode = (value: string): string => {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return `<code>${escapeHtml(normalized)}</code>`;
};

const comparisonSummary = (diff: GraphDiff): string | undefined => {
  if (diff.comparison === undefined) return undefined;
  const mergeBase =
    diff.comparison.mergeBaseSha === undefined
      ? ""
      : `; merge base ${markdownCode(shortRevision(diff.comparison.mergeBaseSha))}`;
  return `Comparison ${markdownCode(diff.comparison.mode)}: ${markdownCode(diff.comparison.baseRef)} (${markdownCode(shortRevision(diff.comparison.baseCommitSha))}) → ${markdownCode(diff.comparison.headRef)} (${markdownCode(shortRevision(diff.comparison.headCommitSha))})${mergeBase}.`;
};

const evidenceLabel = (evidence: Evidence): string => {
  const location = evidence.location;
  const path = location?.path ?? evidence.path;
  const line = location?.line ?? evidence.line;
  const position =
    path === undefined
      ? (evidence.reference ?? evidence.id)
      : `${path}${line === undefined ? "" : `:${line}`}`;
  return evidence.detector === undefined
    ? position
    : `${position} (${evidence.detector})`;
};

const edgeLabel = (edge: GraphEdge): string =>
  `${edge.from} ${edge.kind} ${edge.to}`;

const markdownEdge = (edge: GraphEdge): string => {
  const evidence = edge.evidence
    .map((item) => markdownCode(evidenceLabel(item)))
    .join(", ");
  const basis =
    evidence ||
    markdownCode(`unresolved: ${edge.unresolvedReason ?? "unspecified"}`);
  return `- ${markdownCode(edge.from)} ${markdownCode(edge.kind)} ${markdownCode(edge.to)} — ${basis}`;
};

const changedPaths = (changes: readonly { readonly path: string }[]): string =>
  changes.map((change) => markdownCode(change.path)).join(", ");

const markdownIdentityMatch = (
  match: GraphDiff["identity"]["matches"][number],
): string =>
  `- ${markdownCode(match.beforeStableKey)} → ${markdownCode(match.afterStableKey)} — ${markdownCode(`${match.method}/${match.confidence}`)}; evidence: ${match.signals.map(markdownCode).join(", ")}`;

const markdownIdentityAmbiguity = (
  ambiguity: GraphDiff["identity"]["ambiguous"][number],
): string =>
  `- ${markdownCode(ambiguity.before.stableKey)} — ${markdownCode(ambiguity.reason)}; candidates: ${ambiguity.candidates.map((candidate) => markdownCode(candidate.afterStableKey)).join(", ")}`;

const markdownIdentityUnsupported = (
  candidate: GraphDiff["identity"]["unsupported"][number],
): string =>
  `- ${markdownCode(candidate.before.stableKey)} → ${markdownCode(candidate.after.stableKey)} — ${markdownCode(candidate.reason)}; score: ${markdownCode(String(candidate.score))}; evidence: ${candidate.signals.map(markdownCode).join(", ")}`;

const markdownDiagnostic = (
  diagnostic: GraphDiff["diagnostics"]["added"][number],
): string => {
  const remediation = diagnostic.remediation
    ? `; remediation: ${markdownCode(diagnostic.remediation)}`
    : "";
  return `- ${markdownCode(`${diagnostic.severity} ${diagnostic.code}`)} — ${markdownCode(diagnostic.message)}${remediation}`;
};

export function renderMarkdownReport(diff: GraphDiff): string {
  assertReportCardinality(diff, undefined);
  const summary = diff.summary;
  const lines = [
    "# Architecture diff",
    "",
    `From ${markdownCode(shortRevision(diff.fromRevision.commitSha))} to ${markdownCode(shortRevision(diff.toRevision.commitSha))}.`,
    ...(comparisonSummary(diff) === undefined ? [] : [comparisonSummary(diff)]),
    `Tool ${markdownCode(REPORT_TOOL_VERSION)}; GraphDiff schema ${markdownCode(String(GRAPH_DIFF_SCHEMA_VERSION))}; capability registry ${markdownCode(String(diff.capabilityRegistryVersion))}.`,
    "",
    "## Summary",
    "",
    `- ${plural(summary.nodesAdded, "node")} added; ${plural(summary.nodesRemoved, "node")} removed; ${plural(summary.nodesChanged, "node")} changed`,
    `- ${plural(summary.edgesAdded, "edge")} added; ${plural(summary.edgesRemoved, "edge")} removed; ${plural(summary.edgesChanged, "edge")} changed`,
    `- ${plural(summary.diagnosticsAdded, "diagnostic")} added; ${plural(summary.diagnosticsRemoved, "diagnostic")} removed; ${plural(summary.diagnosticsChanged, "diagnostic")} changed`,
  ];

  const nodeGroups = [
    ["Added nodes", diff.nodes.added] as const,
    ["Removed nodes", diff.nodes.removed] as const,
  ];
  for (const [title, nodes] of nodeGroups) {
    if (nodes.length === 0) continue;
    lines.push("", `## ${title}`, "");
    lines.push(
      ...nodes.map(
        (node) => `- ${markdownCode(node.name)} (${markdownCode(node.kind)})`,
      ),
    );
  }

  if (diff.nodes.changed.length > 0) {
    lines.push("", "## Changed nodes", "");
    lines.push(
      ...diff.nodes.changed.map(
        (node) =>
          `- ${markdownCode(node.stableKey)} — ${changedPaths(node.changes)}`,
      ),
    );
  }

  if (diff.identity.matches.length > 0) {
    lines.push("", "## Matched identities", "");
    lines.push(...diff.identity.matches.map(markdownIdentityMatch));
  }

  if (diff.identity.ambiguous.length > 0) {
    lines.push("", "## Ambiguous identities", "");
    lines.push(...diff.identity.ambiguous.map(markdownIdentityAmbiguity));
  }

  if (diff.identity.unsupported.length > 0) {
    lines.push("", "## Unsupported identities", "");
    lines.push(...diff.identity.unsupported.map(markdownIdentityUnsupported));
  }

  const edgeGroups = [
    ["Added edges", diff.edges.added] as const,
    ["Removed edges", diff.edges.removed] as const,
  ];
  for (const [title, edges] of edgeGroups) {
    if (edges.length === 0) continue;
    lines.push("", `## ${title}`, "", ...edges.map(markdownEdge));
  }

  if (diff.edges.changed.length > 0) {
    lines.push("", "## Changed edges", "");
    lines.push(
      ...diff.edges.changed.map(
        (edge) =>
          `- ${markdownCode(edgeLabel(edge.after))} — ${markdownCode(edge.classification)}; ${changedPaths(edge.changes)}`,
      ),
    );
  }

  if (diff.edges.rewired.length > 0) {
    lines.push("", "## Rewired edges", "");
    lines.push(
      ...diff.edges.rewired.map(
        (edge) =>
          `- ${markdownCode(edgeLabel(edge.before))} → ${markdownCode(edgeLabel(edge.after))} — ${markdownCode(edge.classification)}; ${changedPaths(edge.changes)}`,
      ),
    );
  }

  const diagnosticGroups = [
    ["Added diagnostics", diff.diagnostics.added] as const,
    ["Removed diagnostics", diff.diagnostics.removed] as const,
  ];
  for (const [title, diagnostics] of diagnosticGroups) {
    if (diagnostics.length === 0) continue;
    lines.push("", `## ${title}`, "");
    lines.push(...diagnostics.map(markdownDiagnostic));
  }

  if (diff.diagnostics.changed.length > 0) {
    lines.push("", "## Changed diagnostics", "");
    lines.push(
      ...diff.diagnostics.changed.map(
        (diagnostic) =>
          `- ${markdownCode(diagnostic.id)} — ${changedPaths(diagnostic.changes)}`,
      ),
    );
  }

  const report = `${lines.join("\n")}\n`;
  assertReportByteLimit(report);
  return report;
}

const htmlList = (items: readonly string[]): string =>
  items.length === 0
    ? '<p class="empty">None</p>'
    : `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;

const htmlEvidence = (edge: GraphEdge): string => {
  if (edge.evidence.length > 0) {
    return edge.evidence
      .map((item) => `<code>${escapeHtml(evidenceLabel(item))}</code>`)
      .join(", ");
  }
  return `<span class="unknown">unresolved: ${escapeHtml(edge.unresolvedReason ?? "unspecified")}</span>`;
};

const htmlEdge = (edge: GraphEdge): string =>
  `<code>${escapeHtml(edge.from)}</code> <strong>${escapeHtml(edge.kind)}</strong> <code>${escapeHtml(edge.to)}</code><div class="evidence">${htmlEvidence(edge)}</div>`;

const htmlNode = (node: GraphDiff["nodes"]["added"][number]): string =>
  `<code>${escapeHtml(node.name)}</code> <span class="kind">${escapeHtml(node.kind)}</span>`;

const htmlDiagnostic = (
  diagnostic: GraphDiff["diagnostics"]["added"][number],
): string => {
  const remediation = diagnostic.remediation
    ? `<div class="remediation">Remediation: ${escapeHtml(diagnostic.remediation)}</div>`
    : "";
  return `<strong>${escapeHtml(diagnostic.severity)} ${escapeHtml(diagnostic.code)}</strong>: ${escapeHtml(diagnostic.message)}${remediation}`;
};

const htmlChanges = (changes: readonly { readonly path: string }[]): string =>
  changes.map((change) => `<code>${escapeHtml(change.path)}</code>`).join(", ");

const htmlIdentityMatch = (
  match: GraphDiff["identity"]["matches"][number],
): string =>
  `<code>${escapeHtml(match.beforeStableKey)}</code> <strong>→</strong> <code>${escapeHtml(match.afterStableKey)}</code><div class="evidence">${escapeHtml(`${match.method}/${match.confidence}`)}; evidence: ${match.signals.map((signal) => escapeHtml(signal)).join(", ")}</div>`;

const htmlIdentityAmbiguity = (
  ambiguity: GraphDiff["identity"]["ambiguous"][number],
): string =>
  `<code>${escapeHtml(ambiguity.before.stableKey)}</code><div class="evidence">${escapeHtml(ambiguity.reason)}; candidates: ${ambiguity.candidates.map((candidate) => escapeHtml(candidate.afterStableKey)).join(", ")}</div>`;

const htmlIdentityUnsupported = (
  candidate: GraphDiff["identity"]["unsupported"][number],
): string =>
  `<code>${escapeHtml(candidate.before.stableKey)}</code> <strong>→</strong> <code>${escapeHtml(candidate.after.stableKey)}</code><div class="evidence">${escapeHtml(candidate.reason)}; score: ${escapeHtml(String(candidate.score))}; evidence: ${candidate.signals.map((signal) => escapeHtml(signal)).join(", ")}</div>`;

export function renderHtmlReport(diff: GraphDiff): string {
  assertReportCardinality(diff, undefined);
  const summary = diff.summary;
  const addedNodes = diff.nodes.added.map(htmlNode);
  const removedNodes = diff.nodes.removed.map(htmlNode);
  const changedNodes = diff.nodes.changed.map(
    (node) =>
      `<code>${escapeHtml(node.stableKey)}</code><div class="evidence">${htmlChanges(node.changes)}</div>`,
  );
  const matchedIdentities = diff.identity.matches.map(htmlIdentityMatch);
  const ambiguousIdentities = diff.identity.ambiguous.map(
    htmlIdentityAmbiguity,
  );
  const unsupportedIdentities = diff.identity.unsupported.map(
    htmlIdentityUnsupported,
  );
  const changedEdges = diff.edges.changed.map(
    (edge) =>
      `${htmlEdge(edge.after)}<div class="evidence">${escapeHtml(edge.classification)}: ${htmlChanges(edge.changes)}</div>`,
  );
  const rewiredEdges = diff.edges.rewired.map(
    (edge) =>
      `${htmlEdge(edge.before)} <strong>→</strong> ${htmlEdge(edge.after)}<div class="evidence">${escapeHtml(edge.classification)}: ${htmlChanges(edge.changes)}</div>`,
  );
  const addedDiagnostics = diff.diagnostics.added.map(htmlDiagnostic);
  const removedDiagnostics = diff.diagnostics.removed.map(htmlDiagnostic);
  const changedDiagnostics = diff.diagnostics.changed.map(
    (diagnostic) =>
      `<code>${escapeHtml(diagnostic.id)}</code><div class="evidence">${htmlChanges(diagnostic.changes)}</div>`,
  );

  const report = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>CARTOGRAPH architecture diff</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0 auto; max-width: 72rem; padding: 2rem; line-height: 1.5; }
    h1, h2 { line-height: 1.2; }
    .summary { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
    .card { border: 1px solid #7777; border-radius: .5rem; padding: 1rem; }
    code { overflow-wrap: anywhere; }
    .evidence, .kind, .empty { color: #777; font-size: .9rem; }
    .unknown { color: #a45b00; }
    .skip-link { position: absolute; left: -10000px; top: auto; }
    .skip-link:focus { left: 1rem; top: 1rem; background: Canvas; color: CanvasText; padding: .5rem .75rem; z-index: 1; }
  </style>
</head>
<body>
  <a class="skip-link" href="#summary-heading">Skip to summary</a>
  <main id="report" tabindex="-1">
    <h1>Architecture diff</h1>
    <p>From <code>${escapeHtml(shortRevision(diff.fromRevision.commitSha))}</code> to <code>${escapeHtml(shortRevision(diff.toRevision.commitSha))}</code>.</p>
    ${
      diff.comparison === undefined
        ? ""
        : `<p>Comparison <code>${escapeHtml(diff.comparison.mode)}</code>: <code>${escapeHtml(diff.comparison.baseRef)}</code> (${escapeHtml(shortRevision(diff.comparison.baseCommitSha))}) → <code>${escapeHtml(diff.comparison.headRef)}</code> (${escapeHtml(shortRevision(diff.comparison.headCommitSha))})${diff.comparison.mergeBaseSha === undefined ? "" : `; merge base <code>${escapeHtml(shortRevision(diff.comparison.mergeBaseSha))}</code>`}.</p>`
    }
    <p>Tool <code>${escapeHtml(REPORT_TOOL_VERSION)}</code>; GraphDiff schema <code>${escapeHtml(String(GRAPH_DIFF_SCHEMA_VERSION))}</code>; capability registry <code>${escapeHtml(String(diff.capabilityRegistryVersion))}</code>.</p>
    <section aria-labelledby="summary-heading">
      <h2 id="summary-heading">Summary</h2>
      <div class="summary">
        <div class="card">${plural(summary.nodesAdded, "node")} added<br>${plural(summary.nodesRemoved, "node")} removed<br>${plural(summary.nodesChanged, "node")} changed</div>
        <div class="card">${plural(summary.edgesAdded, "edge")} added<br>${plural(summary.edgesRemoved, "edge")} removed<br>${plural(summary.edgesChanged, "edge")} changed</div>
        <div class="card">${plural(summary.diagnosticsAdded, "diagnostic")} added<br>${plural(summary.diagnosticsRemoved, "diagnostic")} removed<br>${plural(summary.diagnosticsChanged, "diagnostic")} changed</div>
      </div>
    </section>
    <section aria-label="Added nodes"><h2>Added nodes</h2>${htmlList(addedNodes)}</section>
    <section aria-label="Removed nodes"><h2>Removed nodes</h2>${htmlList(removedNodes)}</section>
    <section aria-label="Changed nodes"><h2>Changed nodes</h2>${htmlList(changedNodes)}</section>
    <section aria-label="Matched identities"><h2>Matched identities</h2>${htmlList(matchedIdentities)}</section>
    <section aria-label="Ambiguous identities"><h2>Ambiguous identities</h2>${htmlList(ambiguousIdentities)}</section>
    <section aria-label="Unsupported identities"><h2>Unsupported identities</h2>${htmlList(unsupportedIdentities)}</section>
    <section aria-label="Added edges"><h2>Added edges</h2>${htmlList(diff.edges.added.map(htmlEdge))}</section>
    <section aria-label="Removed edges"><h2>Removed edges</h2>${htmlList(diff.edges.removed.map(htmlEdge))}</section>
    <section aria-label="Changed edges"><h2>Changed edges</h2>${htmlList(changedEdges)}</section>
    <section aria-label="Rewired edges"><h2>Rewired edges</h2>${htmlList(rewiredEdges)}</section>
    <section aria-label="Added diagnostics"><h2>Added diagnostics</h2>${htmlList(addedDiagnostics)}</section>
    <section aria-label="Removed diagnostics"><h2>Removed diagnostics</h2>${htmlList(removedDiagnostics)}</section>
    <section aria-label="Changed diagnostics"><h2>Changed diagnostics</h2>${htmlList(changedDiagnostics)}</section>
  </main>
</body>
</html>
`;
  assertReportByteLimit(report);
  return report;
}

export function renderDiff(
  diff: GraphDiff,
  format: ReportFormat,
  maxReportItems?: number,
): string {
  assertReportCardinality(diff, maxReportItems);
  switch (format) {
    case "html":
      return renderHtmlReport(diff);
    case "json": {
      const report = `${serializeGraphDiff(diff)}\n`;
      assertReportByteLimit(report);
      return report;
    }
    case "markdown":
      return renderMarkdownReport(diff);
  }
}
