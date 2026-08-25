import {
  ArchitectureQueryExplanationSchema,
  serializeArchitectureQueryExplanation,
  type ArchitectureQueryExplanation,
  type ArchitectureQueryExplanationUncertainty,
  type ArchitectureQueryEdge,
} from "../core/index.js";

export type QueryExplanationReportFormat = "json" | "markdown" | "html";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const markdownCode = (value: string): string =>
  `<code>${escapeHtml(value.replace(/\s+/gu, " ").trim())}</code>`;

const jsonCode = (value: unknown): string =>
  `<pre><code>${escapeHtml(JSON.stringify(value, null, 2))}</code></pre>`;

type ExplanationEdge = Pick<
  ArchitectureQueryEdge,
  "from" | "to" | "kind" | "evidence" | "unresolvedReason"
>;

const evidenceLabel = (edge: ExplanationEdge): string => {
  if (edge.evidence.length === 0)
    return `unresolved: ${edge.unresolvedReason ?? "missing evidence"}`;
  return edge.evidence
    .map((evidence) => {
      const location =
        evidence.path === undefined
          ? (evidence.reference ?? evidence.id)
          : `${evidence.path}${evidence.line === undefined ? "" : `:${evidence.line}`}`;
      return `${location} [${evidence.id}]`;
    })
    .join(", ");
};

const edgeLabel = (edge: ExplanationEdge): string =>
  `${edge.from} ${edge.kind} ${edge.to} — ${evidenceLabel(edge)}`;

const uncertaintyLabel = (
  item: ArchitectureQueryExplanationUncertainty,
): string => {
  const evidence =
    item.evidenceIds.length === 0
      ? "no evidence IDs"
      : `evidence: ${item.evidenceIds.join(", ")}`;
  return `${item.code} — ${item.message} (${evidence})`;
};

const metadataSummary = (explanation: ArchitectureQueryExplanation): string =>
  `policies ${explanation.summary.metadataPolicies}; ADR references ${explanation.summary.metadataDecisions}; ownership hints ${explanation.summary.metadataOwnershipHints}; metadata diagnostics ${explanation.summary.metadataDiagnostics}`;

export const renderArchitectureQueryExplanationMarkdown = (
  input: ArchitectureQueryExplanation,
): string => {
  const explanation = ArchitectureQueryExplanationSchema.parse(input);
  const { query, result, summary } = explanation;
  const lines = [
    "# Architecture query explanation",
    "",
    `Query ${markdownCode(query.queryId)} (${markdownCode(query.operation)}) — status ${markdownCode(result.status)}.`,
    `Tool ${markdownCode(explanation.tool.name)} ${markdownCode(explanation.tool.version)}; query schema ${markdownCode(String(explanation.tool.querySchemaVersion))}; result schema ${markdownCode(String(explanation.tool.resultSchemaVersion))}; capability registry ${markdownCode(String(explanation.tool.capabilityRegistryVersion))}.`,
    "",
    "## Query plan",
    "",
    "Normalized plan:",
    jsonCode(query),
    "",
    "## Limits",
    "",
    `- Depth ${markdownCode(String(explanation.limits.maxDepth))}; nodes ${markdownCode(String(explanation.limits.maxNodes))}; edges ${markdownCode(String(explanation.limits.maxEdges))}`,
    `- Time ${markdownCode(`${explanation.limits.maxTimeMs} ms`)}; output ${markdownCode(`${explanation.limits.maxResultBytes} bytes`)}`,
    "",
    "## Summary",
    "",
    `- ${summary.resultNodes} nodes; ${summary.resultEdges} edges; ${summary.pathCount} paths; ${summary.cycleCount} cycles; ${summary.boundaryCount} boundaries`,
    `- ${summary.diagnosticCount} diagnostics; ${summary.evidenceCount} evidence IDs; ${summary.missingEvidenceEdges} edges without evidence`,
    `- Edge kinds: ${summary.edgeKinds.length === 0 ? markdownCode("none") : summary.edgeKinds.map(markdownCode).join(", ")}`,
    `- Metadata: ${metadataSummary(explanation)}; ${summary.truncated ? "truncated" : "not truncated"}; ${summary.empty ? "empty result" : "non-empty result"}`,
  ];

  if (result.nodes.length > 0) {
    lines.push("", "## Result nodes", "");
    lines.push(
      ...result.nodes.map(
        (node) =>
          `- ${markdownCode(node.id)} — ${markdownCode(node.kind)}; ${markdownCode(node.name)}`,
      ),
    );
  }
  if (result.edges.length > 0) {
    lines.push("", "## Result edges", "");
    lines.push(
      ...result.edges.map((edge) => `- ${markdownCode(edgeLabel(edge))}`),
    );
  }
  if (result.paths.length > 0) {
    lines.push("", "## Result paths", "");
    for (const [index, path] of result.paths.entries()) {
      lines.push(
        `${index + 1}. ${path.nodes.map(markdownCode).join(" → ")} (${path.length} edges)`,
        ...path.edges.map((edge) => `   - ${markdownCode(edgeLabel(edge))}`),
      );
    }
  }
  if (result.cycles.length > 0) {
    lines.push("", "## Cycles", "");
    for (const cycle of result.cycles) {
      lines.push(
        `- ${cycle.nodes.map(markdownCode).join(" → ")}`,
        ...cycle.edges.map((edge) => `  - ${markdownCode(edgeLabel(edge))}`),
      );
    }
  }
  if (result.boundaries.length > 0) {
    lines.push("", "## Boundary crossings", "");
    lines.push(
      ...result.boundaries.map(
        (boundary) =>
          `- ${markdownCode(boundary.direction)}: ${markdownCode(boundary.insideNodeId)} ↔ ${markdownCode(boundary.outsideNodeId)} — ${markdownCode(edgeLabel(boundary.edge))}`,
      ),
    );
  }
  if (result.truncatedEdges.length > 0) {
    lines.push("", "## Truncated edges", "");
    lines.push(
      ...result.truncatedEdges.map(
        (edge) => `- ${markdownCode(edgeLabel(edge))}`,
      ),
    );
  }

  lines.push(
    "",
    "## Policy and ADR context",
    "",
    jsonCode(result.metadata ?? {}),
  );
  lines.push("", "## Uncertainty", "");
  if (explanation.uncertainty.length === 0) lines.push("- None reported.");
  else
    lines.push(
      ...explanation.uncertainty.map(
        (item) => `- ${markdownCode(uncertaintyLabel(item))}`,
      ),
    );
  lines.push(
    "",
    "## Contract",
    "",
    `- Explanation ${markdownCode(`${explanation.contract} v${explanation.schemaVersion}`)}; deterministic ${markdownCode(String(explanation.deterministic))}; read-only ${markdownCode(String(explanation.readOnly))}; network ${markdownCode(String(explanation.network))}; source bodies ${markdownCode(String(explanation.sourceBodiesIncluded))}`,
  );
  return `${lines.join("\n")}\n`;
};

const htmlList = (items: readonly string[]): string =>
  items.length === 0
    ? '<p class="empty">None</p>'
    : `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;

const htmlEdge = (edge: Parameters<typeof edgeLabel>[0]): string =>
  `<code>${escapeHtml(edge.from)}</code> <strong>${escapeHtml(edge.kind)}</strong> <code>${escapeHtml(edge.to)}</code><div class="evidence">${escapeHtml(evidenceLabel(edge))}</div>`;

const htmlUncertainty = (
  item: ArchitectureQueryExplanationUncertainty,
): string =>
  `<li><strong>${escapeHtml(item.code)}</strong>: ${escapeHtml(item.message)}${item.evidenceIds.length === 0 ? "" : `<div class="evidence">Evidence: ${escapeHtml(item.evidenceIds.join(", "))}</div>`}</li>`;

export const renderArchitectureQueryExplanationHtml = (
  input: ArchitectureQueryExplanation,
): string => {
  const explanation = ArchitectureQueryExplanationSchema.parse(input);
  const { query, result, summary } = explanation;
  const paths = result.paths.map(
    (path, index) =>
      `<details><summary>Path ${index + 1}: ${path.nodes.map((node) => `<code>${escapeHtml(node)}</code>`).join(" → ")}</summary>${htmlList(path.edges.map(htmlEdge))}</details>`,
  );
  const cycles = result.cycles.map(
    (cycle) =>
      `<details><summary>Cycle: ${cycle.nodes.map((node) => `<code>${escapeHtml(node)}</code>`).join(" → ")}</summary>${htmlList(cycle.edges.map(htmlEdge))}</details>`,
  );
  const boundaries = result.boundaries.map(
    (boundary) =>
      `<li><strong>${escapeHtml(boundary.direction)}</strong>: <code>${escapeHtml(boundary.insideNodeId)}</code> ↔ <code>${escapeHtml(boundary.outsideNodeId)}</code>${htmlEdge(boundary.edge)}</li>`,
  );
  const report = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Architecture query explanation</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0 auto; max-width: 76rem; padding: 2rem; line-height: 1.5; }
    h1, h2, h3 { line-height: 1.2; }
    .summary { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); }
    .card { border: 1px solid #7777; border-radius: .5rem; padding: 1rem; }
    code { overflow-wrap: anywhere; }
    pre { overflow: auto; padding: 1rem; border: 1px solid #7777; border-radius: .5rem; }
    .evidence, .empty { color: #777; font-size: .9rem; }
    .uncertainty { border-left: .25rem solid #a45b00; padding-left: .75rem; }
    details { margin: .5rem 0; }
    summary { cursor: pointer; padding: .25rem; }
    .skip-link { position: absolute; left: -10000px; top: auto; }
    .skip-link:focus { left: 1rem; top: 1rem; background: Canvas; color: CanvasText; padding: .5rem .75rem; z-index: 1; }
  </style>
</head>
<body>
  <a class="skip-link" href="#summary-heading">Skip to summary</a>
  <main id="report" tabindex="-1">
    <h1>Architecture query explanation</h1>
    <p>Query <code>${escapeHtml(query.queryId)}</code> (<code>${escapeHtml(query.operation)}</code>) — status <strong>${escapeHtml(result.status)}</strong>.</p>
    <p>Tool <code>${escapeHtml(explanation.tool.name)}</code> <code>${escapeHtml(explanation.tool.version)}</code>; query schema <code>${explanation.tool.querySchemaVersion}</code>; result schema <code>${explanation.tool.resultSchemaVersion}</code>; capability registry <code>${explanation.tool.capabilityRegistryVersion}</code>.</p>
    <section aria-labelledby="plan-heading"><h2 id="plan-heading">Query plan</h2><details open><summary>Normalized plan</summary>${jsonCode(query)}</details></section>
    <section aria-labelledby="summary-heading"><h2 id="summary-heading">Summary</h2><div class="summary"><div class="card">${summary.resultNodes} nodes<br>${summary.resultEdges} edges<br>${summary.pathCount} paths</div><div class="card">${summary.cycleCount} cycles<br>${summary.boundaryCount} boundaries<br>${summary.diagnosticCount} diagnostics</div><div class="card">${summary.evidenceCount} evidence IDs<br>${summary.missingEvidenceEdges} edges without evidence<br>${summary.truncated ? "Truncated" : "Not truncated"}</div><div class="card">${escapeHtml(metadataSummary(explanation))}</div></div></section>
    <section aria-labelledby="limits-heading"><h2 id="limits-heading">Limits</h2><p>Depth <code>${explanation.limits.maxDepth}</code>; nodes <code>${explanation.limits.maxNodes}</code>; edges <code>${explanation.limits.maxEdges}</code>; time <code>${explanation.limits.maxTimeMs} ms</code>; output <code>${explanation.limits.maxResultBytes} bytes</code>.</p></section>
    <section aria-labelledby="nodes-heading"><h2 id="nodes-heading">Result nodes</h2>${htmlList(result.nodes.map((node) => `<code>${escapeHtml(node.id)}</code> — ${escapeHtml(node.kind)}; ${escapeHtml(node.name)}`))}</section>
    <section aria-labelledby="edges-heading"><h2 id="edges-heading">Result edges</h2>${htmlList(result.edges.map(htmlEdge))}</section>
    <section aria-labelledby="paths-heading"><h2 id="paths-heading">Result paths</h2>${htmlList(paths)}</section>
    <section aria-labelledby="cycles-heading"><h2 id="cycles-heading">Cycles</h2>${htmlList(cycles)}</section>
    <section aria-labelledby="boundaries-heading"><h2 id="boundaries-heading">Boundary crossings</h2>${htmlList(boundaries)}</section>
    <section aria-labelledby="truncated-heading"><h2 id="truncated-heading">Truncated edges</h2>${htmlList(result.truncatedEdges.map(htmlEdge))}</section>
    <section aria-labelledby="metadata-heading"><h2 id="metadata-heading">Policy and ADR context</h2><details><summary>Projected metadata</summary>${jsonCode(result.metadata ?? {})}</details></section>
    <section aria-labelledby="uncertainty-heading" class="uncertainty"><h2 id="uncertainty-heading">Uncertainty</h2>${htmlList(explanation.uncertainty.map(htmlUncertainty))}</section>
    <section aria-labelledby="contract-heading"><h2 id="contract-heading">Contract</h2><p><code>${escapeHtml(explanation.contract)}</code> v${explanation.schemaVersion}; deterministic ${explanation.deterministic}; read-only ${explanation.readOnly}; network ${explanation.network}; source bodies ${explanation.sourceBodiesIncluded}.</p></section>
  </main>
</body>
</html>
`;
  return report;
};

export const renderArchitectureQueryExplanation = (
  input: ArchitectureQueryExplanation,
  format: QueryExplanationReportFormat,
): string => {
  const explanation = ArchitectureQueryExplanationSchema.parse(input);
  if (format === "json")
    return `${serializeArchitectureQueryExplanation(explanation)}\n`;
  if (format === "html")
    return renderArchitectureQueryExplanationHtml(explanation);
  return renderArchitectureQueryExplanationMarkdown(explanation);
};
