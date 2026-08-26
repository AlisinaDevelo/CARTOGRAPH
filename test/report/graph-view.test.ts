import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  createGraphViewReport,
  GraphViewError,
  parseGraphSnapshot,
  parseGraphViewReport,
  renderGraphViewHtml,
  renderGraphViewMarkdown,
  serializeGraphViewReport,
} from "../../src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = resolve(repositoryRoot, "test/fixtures/graph-view");
const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

const snapshotInput = readJson(resolve(fixtureRoot, "snapshot.v0.1.json"));
const snapshot = parseGraphSnapshot(snapshotInput);
const scenario = readJson(resolve(fixtureRoot, "scenarios.v0.1.json")) as {
  scenarios: Array<{ query: Record<string, unknown> }>;
};
const query = scenario.scenarios[0]?.query;
if (!query) throw new Error("graph-view fixture query is missing");

const build = (input = snapshot) =>
  createGraphViewReport({
    snapshot: input,
    query,
    viewId: "test-graph-view",
  });

describe("filtered graph views", () => {
  it("preserves selected typed edges and reviewer-visible legends", () => {
    const report = build();

    expect(report.nodes.map((node) => node.id)).toEqual([
      "database:orders",
      "external:billing",
      "function:handler",
      "module:api",
      "service:payments",
    ]);
    expect(report.edges.map((edge) => edge.identity)).toEqual([
      "function:handler|calls|service:payments",
      "module:api|contains|function:handler",
      "service:payments|reads|database:orders",
      "service:payments|requests|external:billing",
    ]);
    expect(report.edges.find((edge) => edge.kind === "requests")).toMatchObject(
      {
        confidence: "user_confirmed",
        unresolved: true,
        unresolvedReason:
          "fixture intentionally omits the external request evidence",
      },
    );
    expect(report.legend.confidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "certain", count: 1 }),
        expect.objectContaining({ value: "inferred", count: 1 }),
        expect.objectContaining({ value: "observed", count: 1 }),
        expect.objectContaining({ value: "user_confirmed", count: 1 }),
      ]),
    );
    expect(report.legend.unresolvedEdges).toMatchObject({
      count: 1,
      identities: ["service:payments|requests|external:billing"],
    });
    expect(report.legend.omittedContext).toMatchObject({
      nodes: { count: 1, sampleIds: ["file:omitted"] },
      edges: { count: 0 },
      diagnostics: { count: 1, sampleIds: ["diagnostic:omitted"] },
    });
    expect(report.semantics.layout).toBe("presentation-only");
    expect(report.layout.semantics).toContain(
      "do not encode dependency strength",
    );
  });

  it("keeps selection semantics stable when input ordering changes", () => {
    const reordered = parseGraphSnapshot({
      ...(snapshotInput as Record<string, unknown>),
      nodes: [...(snapshotInput as { nodes: unknown[] }).nodes].reverse(),
      edges: [...(snapshotInput as { edges: unknown[] }).edges].reverse(),
      diagnostics: [
        ...(snapshotInput as { diagnostics: unknown[] }).diagnostics,
      ].reverse(),
    });
    const first = build();
    const second = build(reordered);

    expect(serializeGraphViewReport(first)).toBe(
      serializeGraphViewReport(second),
    );
    expect(first.selectionDigest).toBe(second.selectionDigest);
    expect(first.groups.map((group) => group.nodeIds)).toEqual(
      second.groups.map((group) => group.nodeIds),
    );
  });

  it("renders self-contained Markdown and HTML without external execution", () => {
    const report = build();
    const markdown = renderGraphViewMarkdown(report);
    const html = renderGraphViewHtml(report);

    expect(markdown).toContain("## Legend");
    expect(markdown).toContain("## Typed edges");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("presentation aids only");
    expect(html).not.toMatch(/<\/?(?:script|img|link)\b/iu);
    expect(html).toContain("service:payments|requests|external:billing");
  });

  it("binds report parsing to the report and selection digests", () => {
    const report = build();
    expect(parseGraphViewReport(report)).toEqual(report);
    expect(report.reportDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    expect(() =>
      parseGraphViewReport({
        ...report,
        selectionDigest: "sha256:" + "0".repeat(64),
      }),
    ).toThrow(GraphViewError);
  });

  it("rejects diff queries because a change result has no graph layout", () => {
    expect(() =>
      createGraphViewReport({
        snapshot,
        query: {
          schemaVersion: 1,
          contract: "cartograph.graph-query-language",
          queryId: "changes-only",
          target: "changes",
          predicates: [],
          traversal: {
            enabled: false,
            direction: "forward",
            edgeKinds: ["calls"],
            maxDepth: 0,
            includeUnresolved: true,
          },
          limits: {
            maxDepth: 1,
            maxNodes: 1,
            maxEdges: 1,
            maxChanges: 1,
            maxTimeMs: 100,
            maxResultBytes: 1024,
          },
        },
      }),
    ).toThrow(/node or edge query/u);
  });

  it("matches the published JSON Schema", () => {
    const schema = readJson(
      resolve(repositoryRoot, "schema/graph-view.v0.1.schema.json"),
    ) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(build())).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
