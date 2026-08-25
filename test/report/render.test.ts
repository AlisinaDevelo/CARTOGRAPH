import { describe, expect, it } from "vitest";

import {
  createGraphSnapshot,
  diffGraphSnapshots,
  parseAdrReferenceDocument,
} from "../../src/core/index.js";
import { buildAdrReport } from "../../src/report/adr.js";
import {
  renderDiff,
  renderHtmlReport,
  renderMarkdownReport,
  REPORT_LIMITS,
  REPORT_TOOL_VERSION,
} from "../../src/report/render.js";
import { ResourceLimitError } from "../../src/resources.js";

const hash = `sha256:${"a".repeat(64)}`;

const before = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "1".repeat(40) },
  nodes: [
    {
      id: "module:src/app.ts",
      kind: "module",
      name: "app",
      language: "typescript",
    },
  ],
  edges: [],
  diagnostics: [],
});

const after = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "2".repeat(40) },
  nodes: [
    {
      id: "module:src/app.ts",
      kind: "module",
      name: "app",
      language: "typescript",
    },
    {
      id: "external:https://payments.example",
      kind: "external_service",
      name: "<script>alert('report')</script>",
    },
  ],
  edges: [
    {
      from: "module:src/app.ts",
      to: "external:https://payments.example",
      kind: "requests",
      confidence: "certain",
      evidence: [
        {
          id: "evidence:request",
          kind: "source",
          path: "src/app.ts",
          line: 7,
          detector: "typescript-http@0.1.0",
          contentHash: hash,
        },
      ],
    },
  ],
  diagnostics: [],
});

const diff = diffGraphSnapshots(before, after);
const comparisonDiff = diffGraphSnapshots(before, after, {
  comparison: {
    mode: "merge-base",
    baseRef: "origin/main",
    headRef: "refs/pull/7/head",
    baseCommitSha: "1".repeat(40),
    headCommitSha: "2".repeat(40),
    mergeBaseSha: "1".repeat(40),
  },
});

const categoryBefore = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "3".repeat(40) },
  nodes: [
    { id: "shared", kind: "function", name: "before" },
    { id: "removed", kind: "function", name: "removed" },
    { id: "sink", kind: "service", name: "sink" },
  ],
  edges: [
    {
      from: "shared",
      to: "sink",
      kind: "calls",
      confidence: "inferred",
      evidence: [
        {
          id: "changed-edge",
          kind: "source",
          path: "src/app.ts",
          line: 1,
          detector: "test@1",
          contentHash: hash,
        },
      ],
    },
    {
      from: "removed",
      to: "sink",
      kind: "calls",
      confidence: "certain",
      evidence: [
        {
          id: "removed-edge",
          kind: "source",
          path: "src/old.ts",
          line: 1,
          detector: "test@1",
          contentHash: hash,
        },
      ],
    },
  ],
  diagnostics: [
    {
      id: "changed-diagnostic",
      code: "CHANGED",
      severity: "warning",
      message: "before",
    },
    {
      id: "removed-diagnostic",
      code: "REMOVED",
      severity: "info",
      message: "removed",
    },
  ],
});

const categoryAfter = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "4".repeat(40) },
  nodes: [
    { id: "shared", kind: "function", name: "after" },
    { id: "added", kind: "function", name: "added" },
    { id: "sink", kind: "service", name: "sink" },
  ],
  edges: [
    {
      from: "shared",
      to: "sink",
      kind: "calls",
      confidence: "certain",
      evidence: [
        {
          id: "changed-edge",
          kind: "source",
          path: "src/app.ts",
          line: 1,
          detector: "test@1",
          contentHash: hash,
        },
      ],
    },
    {
      from: "added",
      to: "sink",
      kind: "calls",
      confidence: "inferred",
      evidence: [],
      unresolvedReason: "<img src=remote onerror=alert(2)>",
    },
  ],
  diagnostics: [
    {
      id: "changed-diagnostic",
      code: "CHANGED",
      severity: "error",
      message: "after",
    },
    {
      id: "added-diagnostic",
      code: "ADDED",
      severity: "warning",
      message: "bad &ast; `code`\n\n# injected <img src=x onerror=alert(1)>",
      remediation: "Use a literal value before accepting this edge.",
    },
  ],
});

const categoryDiff = diffGraphSnapshots(categoryBefore, categoryAfter);

describe("diff reports", () => {
  it("renders a concise deterministic Markdown report with evidence", () => {
    const report = renderMarkdownReport(diff);

    expect(report).toContain("Architecture diff");
    expect(report).toContain("1 node added");
    expect(report).toContain("1 edge added");
    expect(report).toContain("src/app.ts:7");
    expect(renderMarkdownReport(diff)).toBe(report);
  });

  it("renders comparison mode and exact ref context", () => {
    const markdown = renderMarkdownReport(comparisonDiff);
    const html = renderHtmlReport(comparisonDiff);

    expect(markdown).toContain("Comparison <code>merge-base</code>");
    expect(markdown).toContain("<code>origin/main</code>");
    expect(markdown).toContain("merge base <code>111111111111</code>");
    expect(html).toContain("Comparison <code>merge-base</code>");
    expect(html).toContain("merge base <code>111111111111</code>");
  });

  it("renders self-contained HTML that escapes repository-controlled text", () => {
    const report = renderHtmlReport(diff);

    expect(report).toContain("Content-Security-Policy");
    expect(report).toContain(`Tool <code>${REPORT_TOOL_VERSION}</code>`);
    expect(report).toContain("GraphDiff schema <code>1</code>");
    expect(report).toContain(
      '<a class="skip-link" href="#summary-heading">Skip to summary</a>',
    );
    expect(report).toContain('<main id="report" tabindex="-1">');
    expect(report).toContain('<section aria-label="Changed edges">');
    expect(report).toContain(
      "&lt;script&gt;alert(&#39;report&#39;)&lt;/script&gt;",
    );
    expect(report).not.toContain("<script>alert('report')</script>");
    expect(report).not.toMatch(/<(?:script|link|img)\b/iu);
    expect(report).not.toMatch(/\b(?:src|href)=["'][^#]/iu);
    expect(report).not.toMatch(/url\s*\(/iu);
  });

  it("renders every diff category and neutralizes Markdown injection", () => {
    const markdown = renderMarkdownReport(categoryDiff);
    const html = renderHtmlReport(categoryDiff);

    for (const heading of [
      "Changed nodes",
      "Changed edges",
      "Added diagnostics",
      "Removed diagnostics",
      "Changed diagnostics",
    ]) {
      expect(markdown).toContain(`## ${heading}`);
      expect(html).toContain(`<h2>${heading}</h2>`);
    }
    expect(markdown).not.toContain("\n# injected");
    expect(markdown).not.toContain("<img src=x");
    expect(markdown).not.toContain("<img src=remote");
    expect(markdown).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markdown).toContain(
      "remediation: <code>Use a literal value before accepting this edge.</code>",
    );
    expect(html).toContain(
      "Remediation: Use a literal value before accepting this edge.",
    );
  });

  it("renders deterministic ADR change states, graph evidence, and stale links", () => {
    const previous = parseAdrReferenceDocument({
      schemaVersion: 1,
      references: [
        {
          id: "ADR-0000",
          file: "docs/adr/0000-old.md",
          title: "Old decision",
          status: "deprecated",
          graphIds: ["module:src/app.ts"],
        },
        {
          id: "ADR-0001",
          file: "docs/adr/0001-payments.md",
          title: "Payments before",
          status: "proposed",
          graphIds: ["module:src/app.ts"],
        },
      ],
    });
    const current = parseAdrReferenceDocument({
      schemaVersion: 1,
      references: [
        {
          id: "ADR-0001",
          file: "docs/adr/0001-payments.md",
          title: "Payments <script>alert(1)</script>",
          status: "accepted",
          graphIds: ["external:https://payments.example"],
        },
        {
          id: "ADR-0002",
          file: "docs/adr/0002-missing.md",
          title: "Missing graph link",
          status: "draft",
          graphIds: ["node:missing"],
        },
      ],
    });
    const adrReport = buildAdrReport(diff, {
      current,
      previous,
      currentSnapshot: after,
      previousSnapshot: before,
    });

    expect(adrReport).toBeDefined();
    expect(adrReport?.summary).toEqual({
      added: 1,
      removed: 1,
      changed: 1,
      unchanged: 0,
      stale: 1,
    });
    expect(adrReport?.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ADR-0000", state: "removed" }),
        expect.objectContaining({
          id: "ADR-0001",
          state: "changed",
          evidence: [
            expect.objectContaining({
              graphId: "external:https://payments.example",
              relation: "added",
            }),
          ],
        }),
        expect.objectContaining({ id: "ADR-0002", state: "stale" }),
      ]),
    );

    const markdown = renderMarkdownReport(diff, adrReport);
    const html = renderHtmlReport(diff, adrReport);
    expect(markdown).toContain("## ADR references");
    expect(markdown).toContain("### Removed ADR references");
    expect(markdown).toContain("### Stale ADR references");
    expect(markdown).toContain("external:https://payments.example");
    expect(markdown).toContain("ADR_REFERENCE_STALE_GRAPH_ID");
    expect(markdown).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('aria-label="Stale ADR references"');
    expect(html).toContain("ADR_REFERENCE_STALE_GRAPH_ID");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(renderMarkdownReport(diff, adrReport)).toBe(markdown);
    expect(renderHtmlReport(diff, adrReport)).toBe(html);
  });

  it("uses canonical JSON as the machine-readable report", () => {
    const output = renderDiff(diff, "json");
    expect(JSON.parse(output)).toMatchObject({
      schemaVersion: 1,
      fromRevision: { commitSha: "1".repeat(40) },
      toRevision: { commitSha: "2".repeat(40) },
    });
    expect(output.endsWith("\n")).toBe(true);
  });

  it("fails closed before rendering an over-cardinality report", () => {
    expect(() => renderDiff(diff, "json", 0)).toThrowError(
      "report exceeds the 0 item report-cardinality ceiling",
    );
  });

  it("fails closed at per-category and output-byte ceilings", () => {
    const overNodes = {
      ...diff,
      nodes: {
        ...diff.nodes,
        added: Array.from(
          { length: REPORT_LIMITS.maxNodes + 1 },
          (_, index) => ({
            id: `node-${index}`,
            stableKey: `node-${index}`,
            kind: "function" as const,
            name: `node-${index}`,
          }),
        ),
      },
    } as unknown as typeof diff;
    const overEdges = {
      ...diff,
      edges: {
        ...diff.edges,
        added: Array.from(
          { length: REPORT_LIMITS.maxEdges + 1 },
          (_, index) => ({
            from: `node-${index}`,
            to: `node-${index + 1}`,
            kind: "calls" as const,
            confidence: "certain" as const,
            evidence: [],
            unresolvedReason: "fixture ceiling test",
          }),
        ),
      },
    } as unknown as typeof diff;
    const overDiagnostics = {
      ...diff,
      diagnostics: {
        ...diff.diagnostics,
        added: Array.from(
          { length: REPORT_LIMITS.maxDiagnostics + 1 },
          (_, index) => ({
            id: `diagnostic-${index}`,
            code: "TEST_LIMIT",
            severity: "warning" as const,
            message: "fixture ceiling test",
            evidence: [],
          }),
        ),
      },
    } as unknown as typeof diff;
    const overBytes = {
      ...diff,
      diagnostics: {
        ...diff.diagnostics,
        added: [
          {
            id: "large-diagnostic",
            code: "TEST_LIMIT",
            severity: "warning" as const,
            message: "x".repeat(REPORT_LIMITS.maxBytes),
            evidence: [],
          },
        ],
      },
    } as unknown as typeof diff;

    expect(() => renderDiff(overNodes, "html")).toThrowError(
      ResourceLimitError,
    );
    expect(() => renderDiff(overNodes, "html")).toThrow(
      /10,000 node report-cardinality ceiling/u,
    );
    expect(() => renderDiff(overEdges, "html")).toThrow(
      /20,000 edge report-cardinality ceiling/u,
    );
    expect(() => renderDiff(overDiagnostics, "html")).toThrow(
      /5,000 diagnostic report-cardinality ceiling/u,
    );
    expect(() => renderDiff(overBytes, "html")).toThrow(
      /16 MiB output ceiling/u,
    );
  });
});
