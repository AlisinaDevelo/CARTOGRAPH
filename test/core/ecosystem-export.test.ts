import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildAssuranceBundle,
  exportBundleStatement,
  exportCycloneDx,
  npmPurl,
  parseGraphSnapshot,
  parseSbom,
  serializeGraphSnapshot,
} from "../../src/core/index.js";

const snapshot = parseGraphSnapshot(
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, "../fixtures/sbom-link/graph.json"),
      "utf8",
    ),
  ) as unknown,
);
const options = { toolName: "cartograph", toolVersion: "0.0.0" };

describe("CycloneDX export", () => {
  const bom = exportCycloneDx(snapshot, options);

  it("is deterministic, timestamp-free, and readable by the SBOM parser", () => {
    expect(exportCycloneDx(snapshot, options)).toEqual(bom);
    expect(JSON.stringify(bom)).not.toMatch(/timestamp/u);
    expect(bom.serialNumber).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(parseSbom(bom)).toMatchObject({
      format: "cyclonedx",
      specVersion: "1.6",
    });
  });

  it("exports packages only, with the root as the described component", () => {
    expect(bom.metadata.component).toMatchObject({
      type: "application",
      name: "demo-app",
      "bom-ref": "package:root",
    });
    expect(bom.components.map((item) => item["bom-ref"])).not.toContain(
      "module:src/a.ts",
    );
    expect(bom.components).toHaveLength(8);
    expect(bom.dependencies[0]).toMatchObject({ ref: "package:root" });
  });

  it("encodes scoped names in purls and records no versions", () => {
    expect(npmPurl("@scope/util")).toBe("pkg:npm/%40scope/util");
    expect(bom.components.every((item) => !item.purl.includes("@"))).toBe(true);
    expect(bom.components.some((item) => "version" in item)).toBe(false);
  });
});

describe("in-toto statement export", () => {
  it("lists the manifest and every artifact as digested subjects", () => {
    const built = buildAssuranceBundle(
      [
        {
          role: "snapshot-head",
          content: new TextEncoder().encode(serializeGraphSnapshot(snapshot)),
        },
      ],
      { toolVersion: "0.0.0" },
    );
    const manifest = JSON.parse(built.manifest) as Parameters<
      typeof exportBundleStatement
    >[0];
    const statement = exportBundleStatement(manifest, "a".repeat(64));
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.subject.map((item) => item.name)).toEqual([
      manifest.artifacts[0]?.path,
      "manifest.json",
    ]);
    expect(statement.predicate).toMatchObject({
      bundleId: manifest.bundleId,
      roles: ["snapshot-head"],
      sourceBodiesIncluded: false,
    });
  });
});
