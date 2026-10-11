import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCycloneDx16Validator,
  createInTotoStatementV1Validator,
  createSarif210Validator,
  verifyVendoredSchemas,
} from "../../scripts/vendored-schemas.mjs";
import { scanRepository } from "../../src/commands.js";

import {
  buildAssuranceBundle,
  exportBundleStatement,
  exportCycloneDx,
  exportSarifPolicyEvaluation,
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
const conformance = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../fixtures/ecosystem-mappings/conformance.v0.1.json",
    ),
    "utf8",
  ),
) as {
  sarif: { id: string; input: unknown; valid: boolean }[];
  statement: { id: string; input: unknown; valid: boolean }[];
};

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

  it("produces a Statement v1 conforming to the pinned required-field specification", () => {
    expect(createInTotoStatementV1Validator).toBeTypeOf("function");
    const built = buildAssuranceBundle(
      [
        {
          role: "snapshot-head",
          content: new TextEncoder().encode(serializeGraphSnapshot(snapshot)),
        },
      ],
      { toolVersion: "0.0.0" },
    );
    const validate = createInTotoStatementV1Validator();
    const manifest = JSON.parse(built.manifest) as Parameters<
      typeof exportBundleStatement
    >[0];
    expect(
      validate(exportBundleStatement(manifest, "a".repeat(64))),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  it.each(conformance.statement)(
    "checks Statement v1 regression $id",
    ({ input, valid }) => {
      expect(createInTotoStatementV1Validator).toBeTypeOf("function");
      const validate = createInTotoStatementV1Validator();
      expect(validate(input), JSON.stringify(validate.errors)).toBe(valid);
    },
  );
});

describe("upstream SARIF 2.1.0 schema", () => {
  it("accepts generated policy results against the official schema", () => {
    expect(createSarif210Validator).toBeTypeOf("function");
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../fixtures/sarif-interchange/round-trip.v0.1.json",
        ),
        "utf8",
      ),
    ) as { evaluation: unknown; snapshot: unknown };
    const exported = exportSarifPolicyEvaluation(
      fixture.evaluation,
      { kind: "snapshot", snapshot: fixture.snapshot },
      options,
    );
    const validate = createSarif210Validator();
    expect(validate(exported.log), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(conformance.sarif)(
    "checks upstream SARIF regression $id",
    ({ input, valid }) => {
      expect(createSarif210Validator).toBeTypeOf("function");
      const validate = createSarif210Validator();
      expect(validate(input), JSON.stringify(validate.errors)).toBe(valid);
    },
  );
});

it("replays the upstream and required-field conformance cases in the offline mapping gate", () => {
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/ecosystem-mappings.mjs", "validate"],
      { cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8" },
    ),
  ) as { conformance: { fixtureDigest: string } };
  expect(output).toMatchObject({
    ok: true,
    mappings: 5,
    conformance: {
      cases: 31,
      upstreamSchemas: ["sarif-2.1.0", "cyclonedx-1.6"],
      statement: "required-fields-valid",
    },
  });
  expect(output.conformance.fixtureDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
});

describe("upstream CycloneDX 1.6 schema", () => {
  const validate = createCycloneDx16Validator();

  it("keeps the vendored files byte-for-byte", () => {
    expect(verifyVendoredSchemas()).toEqual([
      "cyclonedx-1.6",
      "sarif-2.1.0",
      "in-toto-statement-v1-specification",
    ]);
  });

  it("accepts exports of the fixture graph and of real scans", () => {
    for (const graph of [
      snapshot,
      scanRepository({ root: "test/fixtures/lockfiles/npm" }),
      scanRepository({ root: "test/fixtures/typescript-express" }),
    ]) {
      const bom = exportCycloneDx(graph, options);
      expect(validate(bom), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("rejects a BOM that breaks the upstream contract", () => {
    const bom = exportCycloneDx(snapshot, options);
    const broken = {
      ...bom,
      components: [{ ...bom.components[0], name: undefined }],
    };
    expect(validate(JSON.parse(JSON.stringify(broken)))).toBe(false);
    expect(validate({ ...bom, specVersion: 1.6 })).toBe(false);
  });
});
