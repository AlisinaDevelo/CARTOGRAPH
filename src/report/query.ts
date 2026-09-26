import type {
  ArchitectureQueryEdge,
  ArchitectureQueryResult,
  GraphEdge,
  GraphNode,
  GraphQueryResult,
} from "../core/index.js";

// Query results can be large; the Markdown view lists at most this many
// records per section and says how many it left out. JSON output is complete.
const MAX_MARKDOWN_ITEMS = 200;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const code = (value: string): string =>
  `<code>${escapeHtml(value.replace(/\s+/gu, " ").trim())}</code>`;

const bounded = <T>(
  items: readonly T[],
  line: (item: T) => string,
): string[] => {
  const lines = items.slice(0, MAX_MARKDOWN_ITEMS).map(line);
  if (items.length > MAX_MARKDOWN_ITEMS)
    lines.push(
      `- … ${items.length - MAX_MARKDOWN_ITEMS} more (use \`--format json\` for the full result)`,
    );
  return lines;
};

const evidenceSuffix = (
  edge: Pick<GraphEdge | ArchitectureQueryEdge, "evidence">,
): string => {
  const first = edge.evidence[0];
  if (first === undefined) return "";
  const location = first.location ?? first;
  const path = "path" in location ? location.path : undefined;
  if (path === undefined) return "";
  const line = "line" in location ? location.line : undefined;
  return ` (${code(line === undefined ? path : `${path}:${line}`)})`;
};

const nodeLine = (node: GraphNode): string =>
  `- ${code(node.id)} ${escapeHtml(node.kind)}${node.location ? ` at ${code(`${node.location.path}:${node.location.line}`)}` : ""}`;

const edgeLine = (edge: GraphEdge | ArchitectureQueryEdge): string =>
  `- ${code(edge.from)} ${escapeHtml(edge.kind)} ${code(edge.to)}${evidenceSuffix(edge)}`;

const diagnosticLines = (
  diagnostics: readonly {
    code: string;
    severity: string;
    message: string;
  }[],
): string[] =>
  diagnostics.length === 0
    ? []
    : [
        "",
        "## Diagnostics",
        "",
        ...bounded(
          diagnostics,
          (diagnostic) =>
            `- ${code(diagnostic.code)} (${escapeHtml(diagnostic.severity)}): ${escapeHtml(diagnostic.message)}`,
        ),
      ];

export function renderArchitectureQueryMarkdown(
  result: ArchitectureQueryResult,
): string {
  const lines = [
    `# CARTOGRAPH query: ${escapeHtml(result.operation)}`,
    "",
    `Status: ${code(result.status)}${result.truncated ? " (truncated)" : ""}`,
  ];

  if (result.operation === "cycles") {
    lines.push("", `## Cycles (${result.cycles.length})`, "");
    if (result.cycles.length === 0) lines.push("No cycles found.");
    lines.push(
      ...bounded(
        result.cycles,
        (cycle) => `- ${cycle.nodes.map((node) => code(node)).join(" → ")}`,
      ),
    );
  } else if (result.operation === "dependency-path") {
    lines.push("", `## Paths (${result.paths.length})`, "");
    if (result.paths.length === 0) lines.push("No path found.");
    for (const path of result.paths.slice(0, MAX_MARKDOWN_ITEMS)) {
      lines.push(
        `- ${path.length} hop${path.length === 1 ? "" : "s"}: ${path.nodes.map((node) => code(node)).join(" → ")}`,
        ...path.edges.map((edge) => `  ${edgeLine(edge)}`),
      );
    }
  } else if (result.operation === "boundary-crossing") {
    lines.push("", `## Boundary crossings (${result.boundaries.length})`, "");
    lines.push(
      ...bounded(
        result.boundaries,
        (boundary) =>
          `- ${escapeHtml(boundary.direction)}: ${edgeLine(boundary.edge).slice(2)}`,
      ),
    );
  } else {
    lines.push("", `## Nodes (${result.nodes.length})`, "");
    lines.push(...bounded(result.nodes, nodeLine));
    if (result.edges.length > 0) {
      lines.push("", `## Edges (${result.edges.length})`, "");
      lines.push(...bounded(result.edges, edgeLine));
    }
  }

  lines.push(...diagnosticLines(result.diagnostics));
  return `${lines.join("\n")}\n`;
}

export function renderGraphQueryMarkdown(result: GraphQueryResult): string {
  const lines = [
    `# CARTOGRAPH query: ${escapeHtml(result.target)}`,
    "",
    `Status: ${code(result.status)}${result.truncated ? " (truncated)" : ""}`,
  ];
  if (result.revisions)
    lines.push(
      `Revisions: ${code(result.revisions.from)} → ${code(result.revisions.to)}`,
    );

  if (result.target === "changes") {
    lines.push("", `## Changes (${result.changes.length})`, "");
    lines.push(
      ...bounded(
        result.changes,
        (change) =>
          `- ${escapeHtml(change.kind)} ${code(change.id)}${change.evidencePaths.length > 0 ? ` (${change.evidencePaths.map((path) => code(path)).join(", ")})` : ""}`,
      ),
    );
  } else {
    lines.push("", `## Nodes (${result.nodes.length})`, "");
    lines.push(...bounded(result.nodes, nodeLine));
    if (result.target === "edges" || result.edges.length > 0) {
      lines.push("", `## Edges (${result.edges.length})`, "");
      lines.push(...bounded(result.edges, edgeLine));
    }
  }

  lines.push(...diagnosticLines(result.diagnostics));
  return `${lines.join("\n")}\n`;
}
