import Ajv from "ajv";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  AdrReferenceDocumentSchema,
  AdrReferenceValidationError,
  GraphSnapshotSchema,
  parseAdrReferenceDocument,
  readAdrReferenceDocument,
  serializeAdrReferenceDocument,
  validateAdrReferences,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const schema = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/adr-reference.v0.1.schema.json"),
    "utf8",
  ),
) as object;
const sample = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/adr-reference.v0.1.json"),
    "utf8",
  ),
) as unknown;

describe("local ADR references", () => {
  it("validates the published schema and canonicalizes the sample", () => {
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(sample)).toBe(true);
    expect(validate.errors).toBeNull();

    const parsed = parseAdrReferenceDocument(sample);
    expect(parsed).toMatchObject({ schemaVersion: 1 });
    expect(parsed.references).toHaveLength(3);
    expect(
      parsed.references.every((reference) => reference.status === "accepted"),
    ).toBe(true);
    expect(serializeAdrReferenceDocument(parsed)).toBe(
      serializeAdrReferenceDocument(sample),
    );
  });

  it("rejects duplicate IDs, duplicate files, unknown statuses, and missing graph IDs", () => {
    expect(() =>
      parseAdrReferenceDocument({
        schemaVersion: 1,
        references: [
          {
            id: "ADR-0001",
            file: "docs/adr/one.md",
            title: "One",
            status: "accepted",
            graphIds: ["node-a"],
          },
          {
            id: "ADR-0001",
            file: "docs/adr/one.md",
            title: "Duplicate",
            status: "unknown",
            graphIds: [],
          },
        ],
      }),
    ).toThrow(AdrReferenceValidationError);

    expect(
      AdrReferenceDocumentSchema.safeParse({
        schemaVersion: 1,
        references: [
          {
            id: "ADR-0001",
            file: "docs/adr/one.md",
            title: "One",
            status: "accepted",
            graphIds: ["node-a", "node-a"],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("reads only a repository-local JSON reference file", () => {
    const root = mkdtempSync(join(tmpdir(), "cartograph-adr-test-"));
    try {
      writeFileSync(join(root, "adr.json"), JSON.stringify(sample), "utf8");
      expect(
        readAdrReferenceDocument(root, "adr.json").references,
      ).toHaveLength(3);
      expect(() => readAdrReferenceDocument(root, "../adr.json")).toThrow(
        /repository-relative local file/u,
      );
      expect(() =>
        readAdrReferenceDocument(root, "https://example.invalid/adr.json"),
      ).toThrow(/repository-relative local file/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects valid local metadata, missing and stale files, malformed files, and stale graph IDs", () => {
    const root = mkdtempSync(join(tmpdir(), "cartograph-adr-validation-"));
    try {
      mkdirSync(join(root, "docs/adr"), { recursive: true });
      writeFileSync(
        join(root, "docs/adr/valid.md"),
        "# Valid decision\n\n- Status: accepted\n",
        "utf8",
      );
      writeFileSync(
        join(root, "docs/adr/stale.md"),
        "# Old title\n\n- Status: accepted\n",
        "utf8",
      );
      writeFileSync(
        join(root, "docs/adr/malformed.md"),
        "# No lifecycle status\n",
        "utf8",
      );

      const document = parseAdrReferenceDocument({
        schemaVersion: 1,
        references: [
          {
            id: "ADR-valid",
            file: "docs/adr/valid.md",
            title: "Valid decision",
            status: "accepted",
            graphIds: ["node:node-a", "edge:node-a|calls|node-b"],
          },
          {
            id: "ADR-missing",
            file: "docs/adr/missing.md",
            title: "Missing decision",
            status: "proposed",
            graphIds: ["node:node-a"],
          },
          {
            id: "ADR-stale",
            file: "docs/adr/stale.md",
            title: "Current title",
            status: "accepted",
            graphIds: ["node:missing"],
          },
          {
            id: "ADR-malformed",
            file: "docs/adr/malformed.md",
            title: "No lifecycle status",
            status: "draft",
            graphIds: ["edge:malformed"],
          },
        ],
      });
      const snapshot = GraphSnapshotSchema.parse({
        revision: { commitSha: "fixture" },
        nodes: [
          { id: "node-a", kind: "module", name: "A" },
          { id: "node-b", kind: "module", name: "B" },
        ],
        edges: [
          {
            from: "node-a",
            to: "node-b",
            kind: "calls",
            confidence: "certain",
            evidence: [],
            unresolvedReason: "fixture edge",
          },
        ],
        diagnostics: [],
      });

      const result = validateAdrReferences(document, {
        root,
        snapshot,
        requiredGraphIds: ["node:node-a", "node:uncovered"],
      });
      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "ADR_REFERENCE_MISSING_GRAPH_ID",
        "ADR_REFERENCE_MALFORMED_FILE",
        "ADR_REFERENCE_MALFORMED_GRAPH_ID",
        "ADR_REFERENCE_MISSING_FILE",
        "ADR_REFERENCE_STALE_FILE",
        "ADR_REFERENCE_STALE_GRAPH_ID",
      ]);
      expect(
        validateAdrReferences(
          parseAdrReferenceDocument({
            schemaVersion: 1,
            references: [
              {
                id: "ADR-valid",
                file: "docs/adr/valid.md",
                title: "Valid decision",
                status: "accepted",
                graphIds: ["node:node-a", "edge:node-a|calls|node-b"],
              },
            ],
          }),
          { root, snapshot, requiredGraphIds: ["node:node-a"] },
        ),
      ).toEqual({ ok: true, diagnostics: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
