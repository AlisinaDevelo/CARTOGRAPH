import { describe, expect, it } from "vitest";

import {
  ARCHITECTURE_QUERY_CONTRACT,
  createGraphSnapshot,
  executeArchitectureQuery,
  executeGraphQuery,
  parseGraphQueryLanguage,
  type ArchitectureQueryResult,
  type GraphNode,
  type GraphQueryResult,
} from "../../src/core/index.js";
import {
  renderArchitectureQueryMarkdown,
  renderGraphQueryMarkdown,
} from "../../src/report/query.js";

const snapshot = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "query-report" },
  nodes: [],
  edges: [],
  diagnostics: [],
});
const architecture = executeArchitectureQuery(snapshot, {
  schemaVersion: 1,
  contract: ARCHITECTURE_QUERY_CONTRACT,
  queryId: "query-report",
  operation: "cycles",
  selectors: { nodes: [{ kind: "module" }] },
});
const graph = executeGraphQuery(snapshot, parseGraphQueryLanguage("v1 nodes"));
const node = (id: string, path?: string): GraphNode => ({
  id,
  stableKey: id,
  kind: "module",
  name: id,
  ...(path === undefined ? {} : { location: { path, line: 3 } }),
});
const edge = {
  from: "module:src/a.ts",
  to: "module:src/b.ts",
  kind: "imports" as const,
  confidence: "certain" as const,
  evidence: [
    {
      id: "edge-a-b",
      kind: "source" as const,
      path: "src/a.ts",
      line: 2,
      detector: "query-report@1",
      contentHash: "a".repeat(64),
    },
  ],
};

describe("query Markdown for terminal output", () => {
  it("renders status and cycles with Markdown code spans", () => {
    const result: ArchitectureQueryResult = {
      ...architecture,
      cycles: [{ nodes: [edge.from, edge.to, edge.from], edges: [edge] }],
    };
    const before = JSON.stringify(result);
    expect(renderArchitectureQueryMarkdown(result)).toContain(
      "Status: `ok`\n\n## Cycles (1)\n\n- `module:src/a.ts` → `module:src/b.ts` → `module:src/a.ts`",
    );
    expect(renderArchitectureQueryMarkdown(result)).not.toContain("<code>");
    expect(JSON.stringify(result)).toBe(before);
  });

  it.each([
    ["a`b", "``a`b``"],
    ["`edge`", "`` `edge` ``"],
    ["a``b`c", "```a``b`c```"],
    ["``run```", "```` ``run``` ````"],
    ["```", "```` ``` ````"],
    ["  a\t\nb  ", "`a b`"],
    [" \t\n ", "` `"],
    ["<img src=x onerror=alert(1)>&\"'", "`<img src=x onerror=alert(1)>&\"'`"],
    [
      "[open](javascript:alert(1))*bold*",
      "`[open](javascript:alert(1))*bold*`",
    ],
  ])("keeps arbitrary node text inside a code span: %j", (value, expected) => {
    const markdown = renderGraphQueryMarkdown({
      ...graph,
      nodes: [node(value)],
    });
    expect(markdown).toContain(`- ${expected} module\n`);
  });

  it("uses Markdown spans for graph nodes, locations, edges and revisions", () => {
    const result: GraphQueryResult = {
      ...graph,
      target: "edges",
      nodes: [node(edge.from, "src/`a`.ts")],
      edges: [
        { ...edge, evidence: [{ ...edge.evidence[0]!, path: "src/<a>.ts" }] },
      ],
      revisions: { from: "base`revision", to: "head<revision>" },
    };
    const markdown = renderGraphQueryMarkdown(result);
    expect(markdown).toContain(
      "Revisions: ``base`revision`` → `head<revision>`",
    );
    expect(markdown).toContain(
      "- `module:src/a.ts` module at ``src/`a`.ts:3``",
    );
    expect(markdown).toContain(
      "- `module:src/a.ts` imports `module:src/b.ts` (`src/<a>.ts:2`)",
    );
    expect(markdown).not.toContain("<code>");
  });

  it("uses the same spans for changed identities and evidence paths", () => {
    const markdown = renderGraphQueryMarkdown({
      ...graph,
      target: "changes",
      changes: [
        {
          id: "node`change",
          kind: "node-added",
          revision: "to",
          evidencePaths: ["src/<new>.ts", "src/``quoted``.ts"],
        },
      ],
    });
    expect(markdown).toContain(
      "- node-added ``node`change`` (`src/<new>.ts`, ```src/``quoted``.ts```)",
    );
  });

  it.each(["architecture", "graph"] as const)(
    "keeps diagnostic markup and newlines literal in %s results",
    (kind) => {
      const diagnostics = [
        {
          id: "malicious-diagnostic",
          code: "CODE`<x>",
          severity: "warning" as const,
          message:
            "[open](javascript:alert(1)) <script>alert('x')</script>\n# injected *bold* `ticks` &lt; ~~strike~~",
        },
      ];
      const markdown =
        kind === "architecture"
          ? renderArchitectureQueryMarkdown({
              ...architecture,
              diagnostics: diagnostics.map((diagnostic) => ({
                ...diagnostic,
                source: "query",
                evidenceIds: [],
              })),
            })
          : renderGraphQueryMarkdown({ ...graph, diagnostics });
      expect(markdown).toContain(
        "- ``CODE`<x>`` (warning): \\[open\\](javascript:alert(1)) \\<script\\>alert('x')\\</script\\> # injected \\*bold\\* \\`ticks\\` \\&lt; \\~\\~strike\\~\\~\n",
      );
      expect(markdown).not.toContain("\n# injected");
      expect(markdown).not.toContain("<code>");
    },
  );

  it("keeps ordinary diagnostic prose and the result bound readable", () => {
    const markdown = renderGraphQueryMarkdown({
      ...graph,
      nodes: Array.from({ length: 201 }, (_, index) => node(`node-${index}`)),
      diagnostics: [
        {
          id: "no-path",
          code: "QUERY_PATH_NOT_FOUND",
          severity: "info",
          message: "No dependency path found.",
        },
      ],
    });
    expect(markdown).toContain("- `node-199` module");
    expect(markdown).not.toContain("- `node-200` module");
    expect(markdown).toContain(
      "- … 1 more (use `--format json` for all returned records)",
    );
    expect(markdown).toContain(
      "- `QUERY_PATH_NOT_FOUND` (info): No dependency path found.",
    );
  });
});
