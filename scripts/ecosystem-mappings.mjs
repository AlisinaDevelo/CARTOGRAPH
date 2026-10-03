#!/usr/bin/env node
/* global console, process, TextEncoder, URL */
// V-003 ecosystem mapping corpus. Replays each supported mapping on checked-in
// fixtures and counts what is preserved, transformed, dropped, or ambiguous,
// so documented lossiness is measured rather than asserted.

import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildAssuranceBundle,
  exportBundleStatement,
  exportCycloneDx,
  exportSarifPolicyEvaluation,
  importSarifPolicyEvaluation,
  linkSbomToGraph,
  parseGraphSnapshot,
  parseRuntimeTrace,
  parseSbom,
  serializeGraphSnapshot,
} from "../src/core/index.ts";

const root = resolve(process.cwd());
const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const CONTRACT = "cartograph.ecosystem-mappings";
const fail = (message) => {
  throw new Error(`${CONTRACT} validation failed: ${message}`);
};

const sarif = () => {
  const fixture = read("test/fixtures/sarif-interchange/round-trip.v0.1.json");
  const exported = exportSarifPolicyEvaluation(
    fixture.evaluation,
    { kind: "snapshot", snapshot: fixture.snapshot },
    { toolName: "cartograph", toolVersion: "0.0.0" },
  );
  const imported = importSarifPolicyEvaluation(exported.log);
  const preserved = imported.mappings.filter((mapping) =>
    exported.mappings.some((item) => isDeepStrictEqual(item, mapping)),
  ).length;
  return {
    format: "sarif-2.1.0",
    direction: "bidirectional",
    fixture: "test/fixtures/sarif-interchange/round-trip.v0.1.json",
    unit: "policy violation",
    input: fixture.evaluation.violations.length,
    preserved,
    // Graph object references become SARIF physical locations.
    transformed: exported.mappings.length,
    dropped: exported.unsupported.length,
    ambiguous: 0,
  };
};

const cyclonedx = () => {
  const snapshot = parseGraphSnapshot(
    read("test/fixtures/sbom-link/graph.json"),
  );
  const bom = exportCycloneDx(snapshot, {
    toolName: "cartograph",
    toolVersion: "0.0.0",
  });
  const report = linkSbomToGraph(snapshot, parseSbom(bom));
  const nodeIdOf = (component) =>
    component.properties.find((item) => item.name === "cartograph:nodeId")
      ?.value;
  const back = new Map(report.components.map((item) => [item.ref, item]));
  const preserved = bom.components.filter((component) => {
    const link = back.get(component["bom-ref"]);
    return (
      link?.status === "linked" &&
      link.targets[0]?.nodeId === nodeIdOf(component)
    );
  }).length;
  const packages = bom.components.length + (bom.metadata.component ? 1 : 0);
  return {
    format: "cyclonedx-1.6",
    direction: "export, linked back",
    fixture: "test/fixtures/sbom-link/graph.json",
    unit: "graph node",
    input: snapshot.nodes.length,
    preserved: preserved + (report.root?.status === "linked" ? 1 : 0),
    // Scoped names are percent-encoded in purls.
    transformed: bom.components.filter(
      (component) => component.purl !== `pkg:npm/${component.name}`,
    ).length,
    // Modules, functions, and other non-package nodes have no component.
    dropped: snapshot.nodes.length - packages,
    ambiguous: report.components.filter((item) => item.status === "ambiguous")
      .length,
  };
};

const spdx = () => {
  const snapshot = parseGraphSnapshot(
    read("test/fixtures/sbom-link/graph.json"),
  );
  const report = linkSbomToGraph(
    snapshot,
    parseSbom(read("test/fixtures/sbom-link/spdx.json")),
  );
  return {
    format: "spdx-2.3",
    direction: "import (link)",
    fixture: "test/fixtures/sbom-link/spdx.json",
    unit: "SBOM element",
    input:
      report.components.length +
      report.malformed.length +
      (report.root ? 1 : 0),
    preserved:
      report.coverage.linked + (report.root?.status === "linked" ? 1 : 0),
    transformed: report.components.filter((item) =>
      item.targets.some((target) => target.method === "purl"),
    ).length,
    dropped: report.coverage.unresolved + report.coverage.malformed,
    ambiguous: report.coverage.ambiguous,
  };
};

const otlp = () => {
  const trace = parseRuntimeTrace(read("schema/runtime-traces-otlp.v0.1.json"));
  return {
    format: "otlp-json",
    direction: "import",
    fixture: "schema/runtime-traces-otlp.v0.1.json",
    unit: "span",
    input: trace.summary.inputSpans,
    preserved: trace.summary.normalizedSpans,
    // Resource and scope attributes are folded into span fields.
    transformed: trace.summary.normalizedSpans,
    dropped: trace.summary.inputSpans - trace.summary.normalizedSpans,
    ambiguous: 0,
    droppedAttributes: trace.summary.discardedAttributes,
  };
};

const inToto = () => {
  const snapshot = parseGraphSnapshot(
    read("test/fixtures/sbom-link/graph.json"),
  );
  const built = buildAssuranceBundle(
    [
      {
        role: "snapshot-head",
        content: new TextEncoder().encode(serializeGraphSnapshot(snapshot)),
      },
    ],
    { toolVersion: "0.0.0" },
  );
  const manifest = JSON.parse(built.manifest);
  const statement = exportBundleStatement(manifest, "0".repeat(64));
  const preserved = manifest.artifacts.filter((artifact) =>
    statement.subject.some(
      (subject) =>
        subject.name === artifact.path &&
        subject.digest.sha256 === artifact.sha256,
    ),
  ).length;
  return {
    format: "in-toto-statement-v1",
    direction: "export",
    fixture: "test/fixtures/sbom-link/graph.json",
    unit: "bundle artifact",
    input: manifest.artifacts.length,
    preserved,
    transformed: 0,
    // Media type and byte size are not in-toto subject fields.
    dropped: 0,
    ambiguous: 0,
    droppedFields: ["mediaType", "bytes", "label"],
  };
};

export const runEcosystemMappings = () => {
  const report = {
    schemaVersion: 1,
    contract: CONTRACT,
    mappings: [sarif(), cyclonedx(), spdx(), otlp(), inToto()],
  };
  for (const mapping of report.mappings) {
    const total = mapping.preserved + mapping.dropped + mapping.ambiguous;
    if (mapping.preserved > mapping.input || total > mapping.input + 1)
      fail(`${mapping.format} counts exceed its input`);
  }
  const expected = read("test/fixtures/ecosystem-mappings/expected.v0.1.json");
  if (!isDeepStrictEqual(report.mappings, expected.mappings))
    fail(
      `measured mappings differ from the expected fixture: ${JSON.stringify(report.mappings)}`,
    );
  return { ok: true, contract: CONTRACT, mappings: report.mappings.length };
};

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  if (process.argv[2] !== "validate") {
    console.error(
      "usage: node --import tsx scripts/ecosystem-mappings.mjs validate",
    );
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(runEcosystemMappings()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
