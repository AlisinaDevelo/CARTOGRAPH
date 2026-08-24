import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  reconcileRuntimeTrace,
  RUNTIME_RECONCILIATION_SCHEMA_VERSION,
  RuntimeReconciliationError,
  RuntimeReconciliationSchema,
  serializeRuntimeReconciliation,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const readJson = (relativePath: string): unknown =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
const schema = readJson(
  "schema/runtime-reconciliation.v0.1.schema.json",
) as object;
const sample = readJson("schema/runtime-reconciliation.v0.1.json");
const fixture = readJson("schema/runtime-reconciliation-fixture.v0.1.json") as {
  bindings: Array<Record<string, unknown>>;
};

describe("static/runtime reconciliation", () => {
  it("validates the published schema and classifies every fixture case", () => {
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(sample)).toBe(true);
    expect(validate.errors).toBeNull();

    const parsedSample = RuntimeReconciliationSchema.parse(sample);
    const result = reconcileRuntimeTrace(fixture);
    expect(result.schemaVersion).toBe(RUNTIME_RECONCILIATION_SCHEMA_VERSION);
    expect(result.summary).toEqual({
      staticEdges: 4,
      runtimeSpanEdges: 3,
      mappedSpans: 5,
      observedAndModeled: 1,
      modeledNotObserved: 1,
      observedButUnmodeled: 1,
      ambiguous: 1,
    });
    expect(result.records.map((record) => record.classification)).toEqual([
      "ambiguous",
      "modeled-not-observed",
      "observed-and-modeled",
      "observed-but-unmodeled",
    ]);
    expect(serializeRuntimeReconciliation(result)).toBe(
      serializeRuntimeReconciliation(parsedSample),
    );
  });

  it("links static evidence and trace provenance with explicit uncertainty", () => {
    const result = reconcileRuntimeTrace(fixture);
    const ambiguous = result.records.find(
      (record) => record.classification === "ambiguous",
    );
    const modeled = result.records.find(
      (record) => record.classification === "modeled-not-observed",
    );
    const observed = result.records.find(
      (record) => record.classification === "observed-and-modeled",
    );
    const unmodeled = result.records.find(
      (record) => record.classification === "observed-but-unmodeled",
    );

    expect(ambiguous).toMatchObject({
      uncertainty: "ambiguous",
      staticEdgeIds: [
        "edge:module:a|calls|module:b",
        "edge:module:a|imports|module:b",
      ],
      traceRefs: [
        "trace:0123456789abcdef0123456789abcdef:aaaaaaaaaaaaaaaa",
        "trace:0123456789abcdef0123456789abcdef:bbbbbbbbbbbbbbbb",
      ],
    });
    expect(modeled).toMatchObject({
      uncertainty: "unobserved",
      staticEvidenceRefs: ["static-evidence:edge-b-c"],
      traceRefs: [],
    });
    expect(observed).toMatchObject({
      uncertainty: "none",
      staticEvidenceRefs: ["static-evidence:edge-d-a"],
      traceRefs: [
        "trace:0123456789abcdef0123456789abcdef:dddddddddddddddd",
        "trace:0123456789abcdef0123456789abcdef:eeeeeeeeeeeeeeee",
      ],
    });
    expect(unmodeled).toMatchObject({
      uncertainty: "unmapped",
      staticEdgeIds: [],
      traceRefs: [
        "trace:0123456789abcdef0123456789abcdef:cccccccccccccccc",
        "trace:0123456789abcdef0123456789abcdef:dddddddddddddddd",
      ],
    });
    expect(serializeRuntimeReconciliation(result)).toBe(
      serializeRuntimeReconciliation(
        JSON.parse(serializeRuntimeReconciliation(result)),
      ),
    );
  });

  it("fails closed on unknown and duplicate bindings", () => {
    const unknownNode = structuredClone(fixture);
    unknownNode.bindings[0]!.nodeId = "missing-node";
    expect(() => reconcileRuntimeTrace(unknownNode)).toThrow(
      RuntimeReconciliationError,
    );
    expect(() => reconcileRuntimeTrace(unknownNode)).toThrow(
      /unknown static node/u,
    );

    const unknownSpan = structuredClone(fixture);
    unknownSpan.bindings[0]!.spanId = "ffffffffffffffff";
    expect(() => reconcileRuntimeTrace(unknownSpan)).toThrow(/unknown span/u);

    const duplicateBinding = structuredClone(fixture);
    duplicateBinding.bindings.push(duplicateBinding.bindings[0]!);
    expect(() => reconcileRuntimeTrace(duplicateBinding)).toThrow(
      /duplicate runtime span binding/u,
    );
  });
});
