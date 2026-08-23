import {
  serializeGraphDiff,
  type Evidence,
  type GraphDiff,
  type GraphEdge,
} from "../core/index.js";

export type ReportFormat = "html" | "json" | "markdown";

type DiffSummary = {
  nodesAdded: number;
  nodesRemoved: number;
  nodesChanged: number;
  edgesAdded: number;
  edgesRemoved: number;
  edgesChanged: number;
  diagnosticsAdded: number;
  diagnosticsRemoved: number;
  diagnosticsChanged: number;
};

const summarize = (diff: GraphDiff): DiffSummary => ({
  nodesAdded: diff.nodes.added.length,
  nodesRemoved: diff.nodes.removed.length,
  nodesChanged: diff.nodes.changed.length,
  edgesAdded: diff.edges.added.length,
  edgesRemoved: diff.edges.removed.length,
  edgesChanged: diff.edges.changed.length,
  diagnosticsAdded: diff.diagnostics.added.length,
  diagnosticsRemoved: diff.diagnostics.removed.length,
  diagnosticsChanged: diff.diagnostics.changed.length,
});

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

const markdownDiagnostic = (
  diagnostic: GraphDiff["diagnostics"]["added"][number],
): string =>
  `- ${markdownCode(`${diagnostic.severity} ${diagnostic.code}`)} — ${markdownCode(diagnostic.message)}`;

export function renderMarkdownReport(diff: GraphDiff): string {
  const summary = summarize(diff);
  const lines = [
    "# Architecture diff",
    "",
    `From ${markdownCode(shortRevision(diff.fromRevision.commitSha))} to ${markdownCode(shortRevision(diff.toRevision.commitSha))}.`,
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
          `- ${markdownCode(edgeLabel(edge.after))} — ${changedPaths(edge.changes)}`,
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

  return `${lines.join("\n")}\n`;
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
): string =>
  `<strong>${escapeHtml(diagnostic.severity)} ${escapeHtml(diagnostic.code)}</strong>: ${escapeHtml(diagnostic.message)}`;

const htmlChanges = (changes: readonly { readonly path: string }[]): string =>
  changes.map((change) => `<code>${escapeHtml(change.path)}</code>`).join(", ");

export function renderHtmlReport(diff: GraphDiff): string {
  const summary = summarize(diff);
  const addedNodes = diff.nodes.added.map(htmlNode);
  const removedNodes = diff.nodes.removed.map(htmlNode);
  const changedNodes = diff.nodes.changed.map(
    (node) =>
      `<code>${escapeHtml(node.stableKey)}</code><div class="evidence">${htmlChanges(node.changes)}</div>`,
  );
  const changedEdges = diff.edges.changed.map(
    (edge) =>
      `${htmlEdge(edge.after)}<div class="evidence">changed: ${htmlChanges(edge.changes)}</div>`,
  );
  const addedDiagnostics = diff.diagnostics.added.map(htmlDiagnostic);
  const removedDiagnostics = diff.diagnostics.removed.map(htmlDiagnostic);
  const changedDiagnostics = diff.diagnostics.changed.map(
    (diagnostic) =>
      `<code>${escapeHtml(diagnostic.id)}</code><div class="evidence">${htmlChanges(diagnostic.changes)}</div>`,
  );

  return `<!doctype html>
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
  </style>
</head>
<body>
  <main>
    <h1>Architecture diff</h1>
    <p>From <code>${escapeHtml(shortRevision(diff.fromRevision.commitSha))}</code> to <code>${escapeHtml(shortRevision(diff.toRevision.commitSha))}</code>.</p>
    <section aria-labelledby="summary-heading">
      <h2 id="summary-heading">Summary</h2>
      <div class="summary">
        <div class="card">${plural(summary.nodesAdded, "node")} added<br>${plural(summary.nodesRemoved, "node")} removed<br>${plural(summary.nodesChanged, "node")} changed</div>
        <div class="card">${plural(summary.edgesAdded, "edge")} added<br>${plural(summary.edgesRemoved, "edge")} removed<br>${plural(summary.edgesChanged, "edge")} changed</div>
        <div class="card">${plural(summary.diagnosticsAdded, "diagnostic")} added<br>${plural(summary.diagnosticsRemoved, "diagnostic")} removed<br>${plural(summary.diagnosticsChanged, "diagnostic")} changed</div>
      </div>
    </section>
    <section><h2>Added nodes</h2>${htmlList(addedNodes)}</section>
    <section><h2>Removed nodes</h2>${htmlList(removedNodes)}</section>
    <section><h2>Changed nodes</h2>${htmlList(changedNodes)}</section>
    <section><h2>Added edges</h2>${htmlList(diff.edges.added.map(htmlEdge))}</section>
    <section><h2>Removed edges</h2>${htmlList(diff.edges.removed.map(htmlEdge))}</section>
    <section><h2>Changed edges</h2>${htmlList(changedEdges)}</section>
    <section><h2>Added diagnostics</h2>${htmlList(addedDiagnostics)}</section>
    <section><h2>Removed diagnostics</h2>${htmlList(removedDiagnostics)}</section>
    <section><h2>Changed diagnostics</h2>${htmlList(changedDiagnostics)}</section>
  </main>
</body>
</html>
`;
}

export function renderDiff(diff: GraphDiff, format: ReportFormat): string {
  switch (format) {
    case "html":
      return renderHtmlReport(diff);
    case "json":
      return `${serializeGraphDiff(diff)}\n`;
    case "markdown":
      return renderMarkdownReport(diff);
  }
}
