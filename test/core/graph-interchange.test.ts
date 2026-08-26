import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  GraphInterchangeValidationError,
  parseGraphInterchange,
  parseGraphInterchangeEdgeList,
  parseGraphInterchangeJson,
  parseGraphInterchangeJsonLd,
  parseGraphSnapshot,
  serializeGraphInterchange,
  serializeGraphInterchangeEdgeList,
  serializeGraphInterchangeJson,
  serializeGraphInterchangeJsonLd,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtureRoot = resolve(repositoryRoot, "test/fixtures/graph-interchange");
const fixture = JSON.parse(
  readFileSync(resolve(fixtureRoot, "scenarios.v0.1.json"), "utf8"),
) as {
  snapshotFile: string;
  expected: {
    edgeIdentities: string[];
    evidenceIds: string[];
    evidenceReferences: string[];
    unresolvedReasons: string[];
  };
};
const snapshot = parseGraphSnapshot(
  JSON.parse(readFileSync(resolve(fixtureRoot, fixture.snapshotFile), "utf8")),
);

const edgeIdentities = (value: typeof snapshot): string[] =>
  value.edges
    .map((edge) => `${edge.from}|${edge.kind}|${edge.to}`)
    .sort((left, right) => left.localeCompare(right));

const evidenceRecords = (value: typeof snapshot) => [
  ...value.edges.flatMap((edge) => edge.evidence),
  ...value.diagnostics.flatMap((diagnostic) => diagnostic.evidence),
];

describe("graph interchange contract", () => {
  it("round-trips every format without inventing edges or dropping provenance", () => {
    for (const format of ["json", "json-ld", "edge-list"] as const) {
      const serialized = serializeGraphInterchange(snapshot, format);
      const roundTrip = parseGraphInterchange(serialized, format);
      expect(serializeGraphInterchange(roundTrip, format)).toBe(serialized);
      expect(edgeIdentities(roundTrip)).toEqual(
        [...fixture.expected.edgeIdentities].sort((left, right) =>
          left.localeCompare(right),
        ),
      );
      expect(
        evidenceRecords(roundTrip)
          .map((evidence) => evidence.id)
          .sort((left, right) => left.localeCompare(right)),
      ).toEqual(
        [...fixture.expected.evidenceIds].sort((left, right) =>
          left.localeCompare(right),
        ),
      );
      expect(
        evidenceRecords(roundTrip)
          .map((evidence) => evidence.reference)
          .filter((reference): reference is string => reference !== undefined)
          .sort((left, right) => left.localeCompare(right)),
      ).toEqual(
        [...fixture.expected.evidenceReferences].sort((left, right) =>
          left.localeCompare(right),
        ),
      );
      expect(
        roundTrip.edges
          .map((edge) => edge.unresolvedReason)
          .filter((reason): reason is string => reason !== undefined),
      ).toEqual(fixture.expected.unresolvedReasons);
    }

    const edgeList = serializeGraphInterchangeEdgeList(snapshot);
    expect(
      parseGraphInterchangeEdgeList(edgeList.replaceAll("\n", "\r\n")),
    ).toEqual(snapshot);
  });

  it("keeps JSON and JSON-LD schemas aligned with the canonical snapshot", () => {
    const ajv = new Ajv({ allErrors: true });
    const snapshotSchema = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "schema/graph-snapshot.v0.1.schema.json"),
        "utf8",
      ),
    ) as { $id: string };
    ajv.addSchema(snapshotSchema, snapshotSchema.$id);
    const interchangeSchema = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "schema/graph-interchange.v0.1.schema.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const validator = ajv.compile(interchangeSchema);
    expect(validator(JSON.parse(serializeGraphInterchangeJson(snapshot)))).toBe(
      true,
    );
    expect(
      validator(JSON.parse(serializeGraphInterchangeJsonLd(snapshot))),
    ).toBe(true);
    for (const line of serializeGraphInterchangeEdgeList(snapshot)
      .trimEnd()
      .split("\n")) {
      expect(validator(JSON.parse(line))).toBe(true);
    }
  });

  it("fails visibly on unsupported fields and tampered JSON-LD identities", () => {
    const json = JSON.parse(serializeGraphInterchangeJson(snapshot)) as {
      snapshot: Record<string, unknown>;
    };
    json.snapshot.unsupportedField = true;
    expect(() => parseGraphInterchangeJson(json)).toThrow(
      GraphInterchangeValidationError,
    );

    const jsonLd = JSON.parse(serializeGraphInterchangeJsonLd(snapshot)) as {
      edges: Array<Record<string, unknown>>;
    };
    const firstEdge = jsonLd.edges.at(0);
    if (!firstEdge) throw new Error("graph-interchange fixture test setup");
    firstEdge["@id"] = "cartograph:edge:sha256:" + "0".repeat(64);
    expect(() => parseGraphInterchangeJsonLd(jsonLd)).toThrow(
      /edge identity does not match/u,
    );

    const edgeList = serializeGraphInterchangeEdgeList(snapshot)
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const firstLine = edgeList.at(0);
    if (!firstLine) throw new Error("graph-interchange fixture test setup");
    firstLine.unsupportedField = true;
    expect(() =>
      parseGraphInterchangeEdgeList(
        `${edgeList.map((line) => JSON.stringify(line)).join("\n")}\n`,
      ),
    ).toThrow(GraphInterchangeValidationError);

    expect(() =>
      serializeGraphInterchange(snapshot, "unsupported" as never),
    ).toThrow(/unsupported graph interchange format/u);
  });

  it("replays the offline fixture validator", () => {
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/graph-interchange.mjs", "validate"],
        { cwd: repositoryRoot, encoding: "utf8" },
      ),
    ) as { ok: boolean; formats: Array<{ format: string }> };
    expect(output.ok).toBe(true);
    expect(output.formats.map((result) => result.format)).toEqual([
      "json",
      "json-ld",
      "edge-list",
    ]);
  });
});
