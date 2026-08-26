import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  WorkspaceBoundaryValidationError,
  parseWorkspaceBoundaryComposition,
  resolveWorkspaceBoundaries,
  serializeWorkspaceBoundaryComposition,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixture = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "test/fixtures/workspace-boundaries/request.v0.1.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;
const jsonSchema = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/workspace-boundaries.v0.1.schema.json"),
    "utf8",
  ),
) as object;

const cloneFixture = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;

describe("declared cross-repository workspace boundaries", () => {
  it("resolves explicit package/service declarations and validates the published schema", () => {
    const before = JSON.stringify(fixture);
    const composition = resolveWorkspaceBoundaries(fixture);
    expect(JSON.stringify(fixture)).toBe(before);

    const validate = new Ajv({ allErrors: true }).compile(jsonSchema);
    expect(validate(composition)).toBe(true);
    expect(validate.errors).toBeNull();

    const statuses = new Map(
      composition.resolutions.map((resolution) => [
        resolution.id,
        resolution.status,
      ]),
    );
    expect(statuses).toEqual(
      new Map([
        ["alpha-alias", "resolved"],
        ["alpha-ambiguous", "ambiguous"],
        ["alpha-core", "resolved"],
        ["alpha-cycle-back", "resolved"],
        ["alpha-external", "external"],
        ["alpha-local-monorepo", "resolved"],
        ["alpha-missing", "unavailable"],
        ["alpha-unsupported", "unsupported"],
        ["alpha-version-skew", "unavailable"],
        ["beta-alpha-api", "resolved"],
      ]),
    );
    expect(composition.edges).toHaveLength(5);
    expect(composition.cycles).toHaveLength(1);
    expect(composition.cycles[0]?.repositoryIds).toEqual(["alpha", "beta"]);

    const crossEdges = composition.edges.filter(
      (edge) => edge.scope === "cross-repository",
    );
    expect(crossEdges.length).toBeGreaterThan(0);
    for (const edge of crossEdges) {
      expect(edge.provenance.from.length).toBeGreaterThan(0);
      expect(edge.provenance.to.length).toBeGreaterThan(0);
      expect(
        edge.provenance.from.every(
          (source) => source.repositoryId === edge.fromRepository,
        ),
      ).toBe(true);
      expect(
        edge.provenance.to.every(
          (source) => source.repositoryId === edge.toRepository,
        ),
      ).toBe(true);
    }

    const alias = composition.resolutions.find(
      (resolution) => resolution.id === "alpha-alias",
    );
    expect(alias?.candidates[0]?.matchedBy).toBe("alias");
    expect(alias?.edge?.toRepository).toBe("beta");
    expect(
      composition.resolutions.find(
        (resolution) => resolution.id === "alpha-version-skew",
      )?.unresolvedReason,
    ).toContain("version-skew");
    expect(
      composition.resolutions.find(
        (resolution) => resolution.id === "alpha-missing",
      )?.unresolvedReason,
    ).toContain("declared but its snapshot is omitted");
  });

  it("is deterministic across repository, declaration, evidence, and reference order", () => {
    const first = cloneFixture();
    const second = cloneFixture();
    (second.repositories as unknown[]).reverse();
    (second.evidenceSources as unknown[]).reverse();
    (second.references as unknown[]).reverse();
    for (const repository of second.repositories as Record<string, unknown>[]) {
      (repository.declarations as unknown[]).reverse();
      const aliases = repository.aliases as unknown[] | undefined;
      aliases?.reverse();
    }
    expect(
      serializeWorkspaceBoundaryComposition(resolveWorkspaceBoundaries(first)),
    ).toBe(
      serializeWorkspaceBoundaryComposition(resolveWorkspaceBoundaries(second)),
    );
  });

  it("rejects unknown source declarations, unselected evidence, and unsafe resource options", () => {
    const unknownDeclaration = cloneFixture();
    const references = unknownDeclaration.references as Record<
      string,
      unknown
    >[];
    references[0] = { ...references[0], fromDeclarationId: "missing" };
    expect(() => resolveWorkspaceBoundaries(unknownDeclaration)).toThrow(
      WorkspaceBoundaryValidationError,
    );

    const unknownEvidence = cloneFixture();
    const unknownEvidenceReferences = unknownEvidence.references as Record<
      string,
      unknown
    >[];
    unknownEvidenceReferences[0] = {
      ...unknownEvidenceReferences[0],
      evidenceSourceIds: ["not-selected"],
    };
    expect(() => resolveWorkspaceBoundaries(unknownEvidence)).toThrow(
      WorkspaceBoundaryValidationError,
    );

    expect(() =>
      resolveWorkspaceBoundaries(fixture, { maxCandidates: 1 }),
    ).toThrow(/more than 1 candidates/u);
  });

  it("round-trips canonical compositions and rejects forged unresolved edges", () => {
    const composition = resolveWorkspaceBoundaries(fixture);
    expect(parseWorkspaceBoundaryComposition(composition)).toEqual(composition);
    expect(serializeWorkspaceBoundaryComposition(composition)).toBe(
      serializeWorkspaceBoundaryComposition(
        JSON.parse(JSON.stringify(composition)),
      ),
    );

    const forged = JSON.parse(JSON.stringify(composition)) as Record<
      string,
      unknown
    >;
    const resolutions = forged.resolutions as Record<string, unknown>[];
    resolutions[0] = {
      ...resolutions[0],
      status: "unavailable",
      edge: undefined,
      unresolvedReason: undefined,
    };
    expect(() => parseWorkspaceBoundaryComposition(forged)).toThrow(
      WorkspaceBoundaryValidationError,
    );

    const forgedProvenance = JSON.parse(JSON.stringify(composition)) as Record<
      string,
      unknown
    >;
    const forgedEdges = forgedProvenance.edges as Record<string, unknown>[];
    const firstEdge = forgedEdges[0]!;
    const provenance = firstEdge.provenance as Record<string, unknown>;
    const fromEvidence = provenance.from as Record<string, unknown>[];
    fromEvidence[0] = { ...fromEvidence[0], repositoryId: "beta" };
    expect(() => parseWorkspaceBoundaryComposition(forgedProvenance)).toThrow(
      /declaring provenance/u,
    );
  });
});
