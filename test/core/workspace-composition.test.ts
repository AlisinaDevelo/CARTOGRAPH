import Ajv from "ajv";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  WorkspaceCompositionValidationError,
  parseWorkspaceCompositionManifest,
  readWorkspaceCompositionManifest,
  serializeWorkspaceCompositionManifest,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixture = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "test/fixtures/workspace-composition/manifest.v0.1.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;
const jsonSchema = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/workspace-composition.v0.1.schema.json"),
    "utf8",
  ),
) as object;

const cloneFixture = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;

const expectInvalid = (
  mutate: (value: Record<string, unknown>) => void,
  message: string,
): void => {
  const value = cloneFixture();
  mutate(value);
  expect(() => parseWorkspaceCompositionManifest(value), message).toThrow(
    WorkspaceCompositionValidationError,
  );
};

describe("offline workspace composition contract", () => {
  it("accepts the minimal mixed-version fixture and validates the published schema", () => {
    const manifest = parseWorkspaceCompositionManifest(fixture);
    const validate = new Ajv({ allErrors: true }).compile(jsonSchema);

    expect(validate(manifest)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(manifest.repositories.map((repository) => repository.id)).toEqual([
      "cartograph",
      "sample-service",
    ]);
    expect(
      manifest.repositories.map(
        (repository) => repository.snapshot.adapterVersion,
      ),
    ).toEqual(["1.0.0", "1.2.0"]);
    expect(manifest.omissions.map((omission) => omission.id)).toEqual(["loom"]);
    expect(
      manifest.boundaries.find((boundary) => boundary.id === "cartograph-loom")
        ?.status,
    ).toBe("unresolved");
  });

  it("canonicalizes collection order and serializes byte-identically", () => {
    const first = cloneFixture();
    const repositories = first.repositories as Record<string, unknown>[];
    first.repositories = [...repositories].reverse();
    const boundaries = first.boundaries as Record<string, unknown>[];
    first.boundaries = [...boundaries].reverse();
    const omissions = first.omissions as Record<string, unknown>[];
    first.omissions = [...omissions].reverse();

    expect(serializeWorkspaceCompositionManifest(first)).toBe(
      serializeWorkspaceCompositionManifest(fixture),
    );
  });

  it("rejects duplicate identities and paths", () => {
    expectInvalid((value) => {
      const repositories = value.repositories as Record<string, unknown>[];
      repositories[1] = { ...repositories[1], id: "cartograph" };
    }, "duplicate repository identity");
    expectInvalid((value) => {
      const repositories = value.repositories as Record<string, unknown>[];
      repositories[1] = { ...repositories[1], localPath: "repos/cartograph" };
    }, "duplicate local path");
    expectInvalid((value) => {
      const repositories = value.repositories as Record<string, unknown>[];
      repositories[1] = {
        ...repositories[1],
        snapshot: {
          ...(repositories[1]?.snapshot as Record<string, unknown>),
          path: "snapshots/cartograph.json",
        },
      };
    }, "duplicate snapshot path");
  });

  it("rejects incompatible versions, path escapes, remote paths, and unbounded inputs", () => {
    expectInvalid((value) => {
      const repositories = value.repositories as Record<string, unknown>[];
      repositories[0] = {
        ...repositories[0],
        snapshot: {
          ...(repositories[0]?.snapshot as Record<string, unknown>),
          schemaVersion: 2,
        },
      };
    }, "incompatible schema");
    expectInvalid((value) => {
      const repositories = value.repositories as Record<string, unknown>[];
      repositories[0] = {
        ...repositories[0],
        snapshot: {
          ...(repositories[0]?.snapshot as Record<string, unknown>),
          adapterVersion: "2.0.0",
        },
      };
    }, "incompatible adapter");
    expectInvalid((value) => {
      const repositories = value.repositories as Record<string, unknown>[];
      repositories[0] = { ...repositories[0], localPath: "../outside" };
    }, "path escape");
    expectInvalid((value) => {
      const repositories = value.repositories as Record<string, unknown>[];
      repositories[0] = {
        ...repositories[0],
        localPath: "https://example.test",
      };
    }, "remote path");
    expectInvalid((value) => {
      const limits = value.limits as Record<string, unknown>;
      value.limits = { ...limits, maxTotalSnapshotBytes: 1 };
    }, "total resource ceiling");
    expectInvalid((value) => {
      const limits = value.limits as Record<string, unknown>;
      value.limits = { ...limits, maxRepositories: 1 };
    }, "repository resource ceiling");
  });

  it("requires explicit unresolved status for boundaries involving omissions", () => {
    expectInvalid((value) => {
      const boundaries = value.boundaries as Record<string, unknown>[];
      boundaries[1] = { ...boundaries[1], status: "declared" };
    }, "omission boundary status");
    expectInvalid((value) => {
      const boundaries = value.boundaries as Record<string, unknown>[];
      boundaries[0] = { ...boundaries[0], toRepository: "unknown" };
    }, "unknown boundary endpoint");
  });

  it("reads only a bounded local manifest and rejects path escapes", () => {
    const root = mkdtempSync(join(tmpdir(), "cartograph-workspace-manifest-"));
    try {
      writeFileSync(
        join(root, "workspace.json"),
        JSON.stringify(fixture),
        "utf8",
      );
      expect(readWorkspaceCompositionManifest(root, "workspace.json")).toEqual(
        parseWorkspaceCompositionManifest(fixture),
      );
      expect(() =>
        readWorkspaceCompositionManifest(root, "../workspace.json"),
      ).toThrow(WorkspaceCompositionValidationError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
