import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createAjv } from "../../scripts/json-schema.mjs";
import {
  SbomLinkError,
  linkSbomToGraph,
  parseBuildProvenance,
  parseGraphSnapshot,
  parseSbom,
  type SbomComponentLink,
  type SbomLinkReport,
} from "../../src/core/index.js";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../fixtures/sbom-link", name),
      "utf8",
    ),
  ) as unknown;

const graph = parseGraphSnapshot(fixture("graph.json"));
const provenance = parseBuildProvenance(fixture("slsa-provenance.json"));
const link = (sbom: string): SbomLinkReport =>
  linkSbomToGraph(graph, parseSbom(fixture(sbom)), {
    provenance,
    aliases: { "real-fetch": "fetch-alias" },
  });
const byRef = (report: SbomLinkReport, ref: string): SbomComponentLink => {
  const found = report.components.find((item) => item.ref === ref);
  if (found === undefined) throw new Error(`no component ${ref}`);
  return found;
};
const schema = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../schema/sbom-link.v0.1.schema.json"),
    "utf8",
  ),
) as object;

describe("SBOM links from CycloneDX", () => {
  const report = link("cyclonedx.json");

  it("links packages by purl, decoding scoped names", () => {
    expect(byRef(report, "left-pad")).toMatchObject({
      status: "linked",
      targets: [
        {
          nodeId: "module:external:left-pad",
          method: "purl",
          confidence: "certain",
        },
      ],
    });
    expect(byRef(report, "scope-util").targets[0]?.nodeId).toBe(
      "module:external:@scope/util",
    );
    expect(byRef(report, "demo-lib").targets[0]?.nodeId).toBe(
      "package:packages/lib",
    );
    expect(report.root?.targets[0]?.nodeId).toBe("package:root");
  });

  it("links an alias only through an explicit mapping", () => {
    expect(byRef(report, "real-fetch").targets).toEqual([
      {
        nodeId: "module:external:fetch-alias",
        method: "alias",
        confidence: "certain",
      },
    ]);
    const plain = linkSbomToGraph(graph, parseSbom(fixture("cyclonedx.json")));
    expect(byRef(plain, "real-fetch")).toMatchObject({
      status: "unresolved",
      reason: "not-in-graph",
    });
  });

  it("links files and marks generated code with its declared source", () => {
    expect(byRef(report, "file-a").targets[0]?.nodeId).toBe("module:src/a.ts");
    expect(byRef(report, "file-gen")).toMatchObject({
      status: "linked",
      generated: true,
      targets: [
        { nodeId: "module:src/gen.ts", method: "file-path" },
        {
          nodeId: "module:src/schema.ts",
          method: "generated-source",
          confidence: "inferred",
        },
      ],
    });
    expect(byRef(report, "file-missing").reason).toBe("not-in-graph");
  });

  it("reports bundled, missing, foreign, ambiguous, and malformed components", () => {
    expect(byRef(report, "vendored")).toMatchObject({
      status: "unresolved",
      reason: "bundled-in-artifact",
      bundledIn: "demo-lib",
    });
    expect(byRef(report, "missing").reason).toBe("not-in-graph");
    expect(byRef(report, "requests").reason).toBe("unsupported-ecosystem");
    expect(byRef(report, "shared")).toMatchObject({
      status: "ambiguous",
      reason: "multiple-graph-objects",
    });
    expect(
      byRef(report, "shared").targets.map((item) => item.confidence),
    ).toEqual(["inferred", "inferred"]);
    expect(report.malformed).toEqual([
      { ref: "nameless", reason: "missing name" },
    ]);
    expect(report.graphOnly).toEqual([
      { nodeId: "module:external:graph-only-dep", reason: "not-in-sbom" },
    ]);
  });

  it("flags version skew without hiding the link", () => {
    expect(report.versionSkew).toEqual([
      { nodeId: "module:external:lodash", versions: ["4.17.20", "4.17.21"] },
    ]);
    expect(byRef(report, "lodash-old")).toMatchObject({
      status: "linked",
      reason: "version-skew",
    });
  });

  it("relates build subjects to components, packages, and the source revision", () => {
    expect(report.artifacts).toEqual([
      expect.objectContaining({
        name: "demo-app-1.2.0.tgz",
        components: ["root"],
        packageNode: "package:root",
        status: "linked",
      }),
      expect.objectContaining({
        name: "demo-lib-0.4.0.tgz",
        components: ["demo-lib"],
        packageNode: "package:packages/lib",
      }),
      expect.objectContaining({
        name: "unrelated-9.9.9.tgz",
        status: "unresolved",
        reason: "no-matching-component-or-package",
      }),
    ]);
    expect(report.sourceRevision).toBe("matches");
    const other = parseGraphSnapshot({
      ...(fixture("graph.json") as object),
      revision: { commitSha: "0".repeat(40) },
    });
    expect(
      linkSbomToGraph(other, parseSbom(fixture("cyclonedx.json")), {
        provenance,
      }).sourceRevision,
    ).toBe("differs");
  });

  it("counts only what it measured", () => {
    expect(report.coverage).toEqual({
      components: 13,
      linked: 8,
      ambiguous: 1,
      unresolved: 4,
      malformed: 1,
      graphExternalPackages: 6,
      graphExternalPackagesInSbom: 5,
    });
    const validate = createAjv({ allErrors: true }).compile(schema);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(link("cyclonedx.json"))).toBe(JSON.stringify(report));
  });
});

describe("SBOM links from SPDX", () => {
  const report = link("spdx.json");

  it("reads the described package, purls, files, and CONTAINS relationships", () => {
    expect(report.sbom).toEqual({ format: "spdx", specVersion: "SPDX-2.3" });
    expect(report.root?.targets[0]?.nodeId).toBe("package:root");
    expect(byRef(report, "SPDXRef-lib").targets[0]?.nodeId).toBe(
      "package:packages/lib",
    );
    expect(byRef(report, "SPDXRef-vendored")).toMatchObject({
      reason: "bundled-in-artifact",
      bundledIn: "SPDXRef-lib",
    });
    expect(byRef(report, "SPDXRef-file-gen").generated).toBe(true);
    expect(report.malformed).toEqual([
      { ref: "SPDXRef-nameless", reason: "missing name" },
    ]);
    const validate = createAjv({ allErrors: true }).compile(schema);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("malformed SBOM and provenance input", () => {
  it.each([
    ["a non-object", []],
    ["an unknown format", { components: [] }],
    [
      "an unsupported CycloneDX version",
      { bomFormat: "CycloneDX", specVersion: "1.2" },
    ],
    ["an unsupported SPDX version", { spdxVersion: "SPDX-3.0" }],
  ])("rejects %s", (_label, value) => {
    expect(() => parseSbom(value)).toThrow(SbomLinkError);
  });

  it("rejects nesting deeper than the bound", () => {
    let components: unknown[] = [];
    for (let depth = 0; depth < 40; depth += 1)
      components = [{ name: `n${depth}`, components }];
    expect(() =>
      parseSbom({ bomFormat: "CycloneDX", specVersion: "1.6", components }),
    ).toThrow(/too deep/u);
  });

  it.each([
    ["a non-statement", { subject: [] }],
    [
      "a non-SLSA predicate",
      {
        _type: "https://in-toto.io/Statement/v1",
        predicateType: "https://example.invalid/other",
        subject: [],
      },
    ],
    [
      "a statement without SHA-256 subjects",
      {
        _type: "https://in-toto.io/Statement/v1",
        predicateType: "https://slsa.dev/provenance/v1",
        subject: [{ name: "a.tgz", digest: { sha1: "abc" } }],
      },
    ],
  ])("rejects provenance that is %s", (_label, value) => {
    expect(() => parseBuildProvenance(value)).toThrow(SbomLinkError);
  });
});
