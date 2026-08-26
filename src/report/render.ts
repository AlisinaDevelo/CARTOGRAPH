import { Buffer } from "node:buffer";

import {
  GRAPH_DIFF_SCHEMA_VERSION,
  serializeGraphDiff,
  type Evidence,
  type GraphDiff,
  type GraphEdge,
  type GraphTopologySummary,
} from "../core/index.js";
import { assertReportItemLimit, ResourceLimitError } from "../resources.js";
import type { AdrCoverage, AdrReport, AdrReportReference } from "./adr.js";

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
  adrReport?: AdrReport,
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

  const adrCount =
    adrReport === undefined
      ? 0
      : adrReport.references.length +
        adrReport.references.reduce(
          (count, reference) =>
            count + reference.evidence.length + reference.diagnostics.length,
          0,
        ) +
        adrReport.diagnostics.length;
  assertReportItemLimit(
    nodeCount + edgeCount + diagnosticCount + adrCount,
    maximum,
  );
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

const markdownTopologyEdge = (
  edge: GraphTopologySummary["cycles"][number]["edges"][number],
): string => {
  const evidence = edge.evidence
    .map((item) => markdownCode(evidenceLabel(item)))
    .join(", ");
  return `- ${markdownCode(edge.from)} ${markdownCode(edge.kind)} ${markdownCode(edge.to)} — evidence: ${evidence || markdownCode("none")}`;
};

const markdownTopologySummary = (
  title: string,
  topology: GraphTopologySummary,
): string[] => {
  const lines = [
    `### ${title}`,
    "",
    `- ${plural(topology.cycles.length, "cycle")} summarized; ${plural(topology.layers.length, "layer")} configured; ${plural(topology.violations.length, "layer violation")} found`,
  ];
  if (topology.cycles.length > 0) {
    lines.push("", "#### Cycles", "");
    for (const cycle of topology.cycles) {
      lines.push(
        `- ${markdownCode(cycle.id)} — nodes: ${cycle.nodes.map(markdownCode).join(", ")}`,
        ...cycle.edges.map(markdownTopologyEdge),
      );
    }
  }
  if (topology.layers.length > 0) {
    lines.push("", "#### Configured layers", "");
    lines.push(
      ...topology.layers.map(
        (layer) =>
          `- ${markdownCode(layer.id)} (order ${layer.order}) — nodes: ${layer.nodeIds.length === 0 ? markdownCode("none") : layer.nodeIds.map(markdownCode).join(", ")}`,
      ),
    );
  }
  if (topology.violations.length > 0) {
    lines.push("", "#### Layer violations", "");
    for (const violation of topology.violations) {
      lines.push(
        `- ${markdownCode(violation.fromLayer)} → ${markdownCode(violation.toLayer)} — ${markdownCode(violation.id)}`,
        markdownTopologyEdge(violation.edge),
      );
    }
  }
  if (topology.diagnostics.length > 0) {
    lines.push("", "#### Topology diagnostics", "");
    lines.push(...topology.diagnostics.map(markdownDiagnostic));
  }
  return lines;
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

const markdownAdrReference = (reference: AdrReportReference): string[] => {
  const lines = [
    `- ${markdownCode(reference.id)} — ${markdownCode(reference.title)} (${markdownCode(reference.status)}); file: ${markdownCode(reference.file)}; change: ${markdownCode(reference.change)}; state: ${markdownCode(reference.state)}`,
  ];
  for (const evidence of reference.evidence) {
    const sources =
      evidence.sources.length === 0
        ? markdownCode("no source evidence")
        : evidence.sources.map(markdownCode).join(", ");
    lines.push(
      `  - graph ${markdownCode(evidence.graphId)} — ${markdownCode(evidence.relation)}; evidence: ${sources}`,
    );
  }
  for (const diagnostic of reference.diagnostics) {
    lines.push(
      `  - diagnostic ${markdownCode(diagnostic.code)} — ${markdownCode(diagnostic.message)}`,
    );
  }
  return lines;
};

const markdownCoverageKinds = (
  entries: AdrCoverage["nodes"]["byKind"],
): string =>
  entries
    .map(
      (entry) =>
        `${markdownCode(entry.kind)} ${entry.total} total/${entry.linked} linked/${entry.ambiguous} ambiguous/${entry.unlinked} unlinked`,
    )
    .join(", ");

const markdownAdrCoverage = (
  title: string,
  coverage: AdrCoverage,
): string[] => {
  const lines = [
    `### ${title}`,
    "",
    ...(coverage.snapshotRevision === undefined
      ? []
      : [`- Snapshot revision: ${markdownCode(coverage.snapshotRevision)}`]),
    `- ADR references: ${coverage.adrReferences.total} total; ${coverage.adrReferences.linked} linked; ${coverage.adrReferences.ambiguous} ambiguous; ${coverage.adrReferences.unlinked} unlinked`,
    `- Graph links: ${coverage.graphLinks.total} total; ${coverage.graphLinks.resolved} resolved; ${coverage.graphLinks.ambiguous} ambiguous; ${coverage.graphLinks.unresolved} unresolved`,
    `- Nodes: ${coverage.nodes.total} total; ${coverage.nodes.linked} linked; ${coverage.nodes.ambiguous} ambiguous; ${coverage.nodes.unlinked} unlinked`,
    `- Edges: ${coverage.edges.total} total; ${coverage.edges.linked} linked; ${coverage.edges.ambiguous} ambiguous; ${coverage.edges.unlinked} unlinked`,
    `- Node-kind counts: ${markdownCoverageKinds(coverage.nodes.byKind)}`,
    `- Edge-kind counts: ${markdownCoverageKinds(coverage.edges.byKind)}`,
    "",
    "#### ADR-to-graph index",
    "",
  ];
  for (const entry of coverage.adrToGraph) {
    lines.push(
      `- ${markdownCode(entry.id)} — ${markdownCode(entry.status)}; ${entry.links
        .map(
          (link) =>
            `${markdownCode(link.graphId)} (${markdownCode(link.resolution)}${link.targets.length === 0 ? "" : ` → ${link.targets.map((target) => markdownCode(target.id)).join(", ")}`})`,
        )
        .join(", ")}`,
    );
  }
  lines.push("", "#### Graph-to-ADR index", "");
  for (const entry of coverage.graphToAdr) {
    lines.push(
      `- ${markdownCode(entry.id)} (${markdownCode(entry.kind)}) — ADRs: ${entry.adrIds.length === 0 ? markdownCode("none") : entry.adrIds.map(markdownCode).join(", ")}; ambiguous ADRs: ${entry.ambiguousAdrIds.length === 0 ? markdownCode("none") : entry.ambiguousAdrIds.map(markdownCode).join(", ")}`,
    );
  }
  return lines;
};

const markdownAdrSection = (adrReport: AdrReport): string[] => {
  const { summary } = adrReport;
  const lines = [
    "",
    "## ADR references",
    "",
    `- ${plural(summary.added, "reference")} added; ${plural(summary.removed, "reference")} removed; ${plural(summary.changed, "reference")} changed; ${plural(summary.unchanged, "reference")} unchanged; ${plural(summary.stale, "reference")} stale`,
  ];
  const groups = [
    ["Added ADR references", "added"],
    ["Removed ADR references", "removed"],
    ["Changed ADR references", "changed"],
    ["Unchanged ADR references", "unchanged"],
  ] as const;
  for (const [title, change] of groups) {
    const references = adrReport.references.filter(
      (reference) => reference.change === change,
    );
    if (references.length === 0) continue;
    lines.push("", `### ${title}`, "");
    lines.push(...references.flatMap(markdownAdrReference));
  }
  const stale = adrReport.references.filter(
    (reference) => reference.state === "stale",
  );
  if (stale.length > 0) {
    lines.push("", "### Stale ADR references", "");
    lines.push(...stale.flatMap(markdownAdrReference));
  }
  const globalDiagnostics = adrReport.diagnostics.filter(
    (diagnostic) => diagnostic.referenceId === undefined,
  );
  if (globalDiagnostics.length > 0) {
    lines.push("", "### ADR validation diagnostics", "");
    lines.push(
      ...globalDiagnostics.map(
        (diagnostic) =>
          `- ${markdownCode(diagnostic.code)} — ${markdownCode(diagnostic.message)}`,
      ),
    );
  }
  if (adrReport.coverage !== undefined) {
    lines.push("", "### ADR coverage", "");
    if (adrReport.coverage.current !== undefined)
      lines.push(
        ...markdownAdrCoverage("Current snapshot", adrReport.coverage.current),
      );
    if (adrReport.coverage.previous !== undefined)
      lines.push(
        ...markdownAdrCoverage(
          "Previous snapshot",
          adrReport.coverage.previous,
        ),
      );
  }
  return lines;
};

export function renderMarkdownReport(
  diff: GraphDiff,
  adrReport?: AdrReport,
): string {
  assertReportCardinality(diff, undefined, adrReport);
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

  if (diff.topology !== undefined) {
    lines.push("", "## Topology", "");
    lines.push(...markdownTopologySummary("Before", diff.topology.before));
    lines.push(...markdownTopologySummary("After", diff.topology.after));
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

  if (adrReport !== undefined) lines.push(...markdownAdrSection(adrReport));

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

const htmlTopologyEdge = (
  edge: GraphTopologySummary["cycles"][number]["edges"][number],
): string =>
  `<code>${escapeHtml(edge.from)}</code> <strong>${escapeHtml(edge.kind)}</strong> <code>${escapeHtml(edge.to)}</code><div class="evidence">evidence: ${edge.evidence.length === 0 ? "none" : edge.evidence.map((item) => `<code>${escapeHtml(evidenceLabel(item))}</code>`).join(", ")}</div>`;

const htmlTopologySummary = (
  title: string,
  topology: GraphTopologySummary,
): string => {
  const cycles = topology.cycles.map(
    (cycle) =>
      `<li><code>${escapeHtml(cycle.id)}</code> — nodes: ${cycle.nodes.map((node) => `<code>${escapeHtml(node)}</code>`).join(", ")}<ul>${cycle.edges.map((edge) => `<li>${htmlTopologyEdge(edge)}</li>`).join("")}</ul></li>`,
  );
  const layers = topology.layers.map(
    (layer) =>
      `<li><code>${escapeHtml(layer.id)}</code> (order ${layer.order}) — nodes: ${layer.nodeIds.length === 0 ? "none" : layer.nodeIds.map((node) => `<code>${escapeHtml(node)}</code>`).join(", ")}</li>`,
  );
  const violations = topology.violations.map(
    (violation) =>
      `<li><code>${escapeHtml(violation.fromLayer)}</code> → <code>${escapeHtml(violation.toLayer)}</code> — <code>${escapeHtml(violation.id)}</code><ul><li>${htmlTopologyEdge(violation.edge)}</li></ul></li>`,
  );
  const diagnostics = topology.diagnostics.map(htmlDiagnostic);
  return `<section aria-label="Topology ${escapeHtml(title)}"><h3>${escapeHtml(title)}</h3><p>${plural(topology.cycles.length, "cycle")} summarized; ${plural(topology.layers.length, "layer")} configured; ${plural(topology.violations.length, "layer violation")} found.</p><h4>Cycles</h4>${htmlList(cycles)}<h4>Configured layers</h4>${htmlList(layers)}<h4>Layer violations</h4>${htmlList(violations)}<h4>Topology diagnostics</h4>${htmlList(diagnostics)}</section>`;
};

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

const htmlAdrReference = (reference: AdrReportReference): string => {
  const evidence = reference.evidence.map(
    (item) =>
      `<li>Graph <code>${escapeHtml(item.graphId)}</code> — <strong>${escapeHtml(item.relation)}</strong>; evidence: ${htmlList(item.sources.map((source) => `<code>${escapeHtml(source)}</code>`))}</li>`,
  );
  const diagnostics = reference.diagnostics.map(
    (diagnostic) =>
      `<li>Diagnostic <code>${escapeHtml(diagnostic.code)}</code>: ${escapeHtml(diagnostic.message)}</li>`,
  );
  return `<li><strong><code>${escapeHtml(reference.id)}</code></strong> — ${escapeHtml(reference.title)} (<code>${escapeHtml(reference.status)}</code>); file: <code>${escapeHtml(reference.file)}</code>; change: <code>${escapeHtml(reference.change)}</code>; state: <code>${escapeHtml(reference.state)}</code>${evidence.length === 0 ? "" : `<ul>${evidence.join("")}</ul>`}${diagnostics.length === 0 ? "" : `<ul>${diagnostics.join("")}</ul>`}</li>`;
};

const htmlAdrGroup = (
  title: string,
  references: readonly AdrReportReference[],
): string =>
  `<section aria-label="${escapeHtml(title)}"><h3>${escapeHtml(title)}</h3>${htmlList(references.map(htmlAdrReference))}</section>`;

const htmlCoverageKinds = (entries: AdrCoverage["nodes"]["byKind"]): string[] =>
  entries.map(
    (entry) =>
      `<code>${escapeHtml(entry.kind)}</code> ${entry.total} total/${entry.linked} linked/${entry.ambiguous} ambiguous/${entry.unlinked} unlinked`,
  );

const htmlAdrCoverage = (title: string, coverage: AdrCoverage): string => {
  const adrLinks = coverage.adrToGraph.map(
    (entry) =>
      `<li><code>${escapeHtml(entry.id)}</code> (${escapeHtml(entry.status)}): ${entry.links
        .map(
          (link) =>
            `<code>${escapeHtml(link.graphId)}</code> <strong>${escapeHtml(link.resolution)}</strong>${link.targets.length === 0 ? "" : ` → ${link.targets.map((target) => `<code>${escapeHtml(target.id)}</code>`).join(", ")}`}`,
        )
        .join(", ")}</li>`,
  );
  const graphLinks = coverage.graphToAdr.map(
    (entry) =>
      `<li><code>${escapeHtml(entry.id)}</code> (${escapeHtml(entry.kind)}): ADRs ${entry.adrIds.length === 0 ? "none" : entry.adrIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}; ambiguous ADRs ${entry.ambiguousAdrIds.length === 0 ? "none" : entry.ambiguousAdrIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}</li>`,
  );
  return `<section aria-label="${escapeHtml(title)}"><h3>${escapeHtml(title)}</h3>${coverage.snapshotRevision === undefined ? "" : `<p>Snapshot revision: <code>${escapeHtml(coverage.snapshotRevision)}</code></p>`}<div class="summary"><div class="card">ADR references: ${coverage.adrReferences.total} total<br>${coverage.adrReferences.linked} linked; ${coverage.adrReferences.ambiguous} ambiguous; ${coverage.adrReferences.unlinked} unlinked</div><div class="card">Graph links: ${coverage.graphLinks.total} total<br>${coverage.graphLinks.resolved} resolved; ${coverage.graphLinks.ambiguous} ambiguous; ${coverage.graphLinks.unresolved} unresolved</div><div class="card">Nodes: ${coverage.nodes.total} total<br>${coverage.nodes.linked} linked; ${coverage.nodes.ambiguous} ambiguous; ${coverage.nodes.unlinked} unlinked</div><div class="card">Edges: ${coverage.edges.total} total<br>${coverage.edges.linked} linked; ${coverage.edges.ambiguous} ambiguous; ${coverage.edges.unlinked} unlinked</div></div><p>Node-kind counts:</p>${htmlList(htmlCoverageKinds(coverage.nodes.byKind))}<p>Edge-kind counts:</p>${htmlList(htmlCoverageKinds(coverage.edges.byKind))}<h4>ADR-to-graph index</h4>${htmlList(adrLinks)}<h4>Graph-to-ADR index</h4>${htmlList(graphLinks)}</section>`;
};

const htmlAdrSection = (adrReport: AdrReport): string => {
  const { summary } = adrReport;
  const groups = [
    ["Added ADR references", "added"],
    ["Removed ADR references", "removed"],
    ["Changed ADR references", "changed"],
    ["Unchanged ADR references", "unchanged"],
  ] as const;
  const sections = groups.map(([title, change]) =>
    htmlAdrGroup(
      title,
      adrReport.references.filter((reference) => reference.change === change),
    ),
  );
  const stale = adrReport.references.filter(
    (reference) => reference.state === "stale",
  );
  if (stale.length > 0)
    sections.push(htmlAdrGroup("Stale ADR references", stale));
  const globalDiagnostics = adrReport.diagnostics.filter(
    (diagnostic) => diagnostic.referenceId === undefined,
  );
  if (globalDiagnostics.length > 0) {
    sections.push(
      htmlAdrGroup(
        "ADR validation diagnostics",
        globalDiagnostics.map((diagnostic) => ({
          id: diagnostic.code,
          file: diagnostic.file ?? "",
          title: diagnostic.message,
          status: "draft" as const,
          change: "unchanged" as const,
          state: "stale" as const,
          graphIds:
            diagnostic.graphId === undefined ? [] : [diagnostic.graphId],
          evidence: [],
          diagnostics: [diagnostic],
        })),
      ),
    );
  }
  const coverageSections =
    adrReport.coverage === undefined
      ? ""
      : `<h3>ADR coverage</h3>${adrReport.coverage.current === undefined ? "" : htmlAdrCoverage("Current snapshot", adrReport.coverage.current)}${adrReport.coverage.previous === undefined ? "" : htmlAdrCoverage("Previous snapshot", adrReport.coverage.previous)}`;
  return `<section aria-labelledby="adr-heading"><h2 id="adr-heading">ADR references</h2><div class="summary"><div class="card">${plural(summary.added, "reference")} added<br>${plural(summary.removed, "reference")} removed<br>${plural(summary.changed, "reference")} changed<br>${plural(summary.unchanged, "reference")} unchanged<br>${plural(summary.stale, "reference")} stale</div></div>${sections.join("")}${coverageSections}</section>`;
};

export function renderHtmlReport(
  diff: GraphDiff,
  adrReport?: AdrReport,
): string {
  assertReportCardinality(diff, undefined, adrReport);
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
  const topology =
    diff.topology === undefined
      ? ""
      : `<section aria-label="Topology"><h2>Topology</h2>${htmlTopologySummary("Before", diff.topology.before)}${htmlTopologySummary("After", diff.topology.after)}</section>`;

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
    ${topology}
    ${adrReport === undefined ? "" : htmlAdrSection(adrReport)}
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
  adrReport?: AdrReport,
): string {
  assertReportCardinality(diff, maxReportItems, adrReport);
  switch (format) {
    case "html":
      return renderHtmlReport(diff, adrReport);
    case "json": {
      const report = `${serializeGraphDiff(diff)}\n`;
      assertReportByteLimit(report);
      return report;
    }
    case "markdown":
      return renderMarkdownReport(diff, adrReport);
  }
}

export {
  renderArchitectureQueryExplanation,
  renderArchitectureQueryExplanationHtml,
  renderArchitectureQueryExplanationMarkdown,
  type QueryExplanationReportFormat,
} from "./query-explanation.js";
export {
  GRAPH_VIEW_CONTRACT,
  GRAPH_VIEW_MEDIA_TYPE,
  GRAPH_VIEW_MAX_BYTES,
  GRAPH_VIEW_MAX_EDGES,
  GRAPH_VIEW_MAX_NODES,
  GRAPH_VIEW_MAX_SAMPLE_IDS,
  GRAPH_VIEW_SCHEMA_VERSION,
  GraphViewConfidenceLegendSchema,
  GraphViewEdgeSchema,
  GraphViewError,
  GraphViewGroupSchema,
  GraphViewLayoutSchema,
  GraphViewLegendSchema,
  GraphViewNodeSchema,
  GraphViewOmittedCategorySchema,
  GraphViewOmittedContextSchema,
  GraphViewPointSchema,
  GraphViewReportSchema,
  GraphViewSelectionSchema,
  createGraphViewReport,
  parseGraphViewReport,
  renderGraphView,
  renderGraphViewHtml,
  renderGraphViewMarkdown,
  renderGraphViewReport,
  serializeGraphViewReport,
  type GraphViewConfidenceLegend,
  type GraphViewEdge,
  type GraphViewErrorCode,
  type GraphViewGroup,
  type GraphViewLayout,
  type GraphViewLegend,
  type GraphViewNode,
  type GraphViewOmittedCategory,
  type GraphViewOmittedContext,
  type GraphViewOptions,
  type GraphViewPoint,
  type GraphViewReport,
  type GraphViewReportFormat,
  type GraphViewSelection,
} from "./graph-view.js";
