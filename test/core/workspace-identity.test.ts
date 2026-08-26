import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  WorkspaceIdentityValidationError,
  composeWorkspaceIdentities,
  parseWorkspaceIdentityComposition,
  serializeWorkspaceIdentityComposition,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixture = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "test/fixtures/workspace-identity/composition.v0.1.json",
    ),
    "utf8",
  ),
) as { repositories: Record<string, unknown>[] };
const jsonSchema = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/workspace-identity.v0.1.schema.json"),
    "utf8",
  ),
) as object;
const graphSchema = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/graph-snapshot.v0.1.schema.json"),
    "utf8",
  ),
) as object & { $id: string };

const cloneFixture = (): { repositories: Record<string, unknown>[] } =>
  JSON.parse(JSON.stringify(fixture)) as {
    repositories: Record<string, unknown>[];
  };

const expectInvalid = (
  repositories: readonly unknown[],
  message: string,
): void => {
  expect(() => composeWorkspaceIdentities(repositories), message).toThrow(
    WorkspaceIdentityValidationError,
  );
};

describe("cross-repository workspace identity contract", () => {
  it("composes the fixture, validates the published schema, and surfaces each ambiguity", () => {
    const composition = composeWorkspaceIdentities(fixture.repositories);
    const ajv = new Ajv({ allErrors: true });
    ajv.addSchema(graphSchema);
    const validate = ajv.compile(jsonSchema);

    expect(validate(composition)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(composition.namespaces.map((entry) => entry.repositoryId)).toEqual([
      "cartograph",
      "cartograph-fork",
      "cartograph-mirror",
      "unavailable-repo",
    ]);
    expect(composition.ambiguities.map((ambiguity) => ambiguity.kind)).toEqual([
      "alias-collision",
      "duplicate-origin",
      "logical-name-collision",
      "origin-unavailable",
    ]);
    expect(
      composition.namespaces.find(
        (entry) => entry.repositoryId === "cartograph-fork",
      ),
    ).toMatchObject({
      resolution: "ambiguous",
      canonicalOrigin: "github.com/example/cartograph-fork",
      forkOf: "github.com/AlisinaDevelo/CARTOGRAPH",
    });
    expect(
      composition.namespaces.find(
        (entry) => entry.repositoryId === "unavailable-repo",
      )?.resolution,
    ).toBe("origin-unavailable");
    expect(
      new Set(composition.identities.map((entry) => entry.composedStableKey))
        .size,
    ).toBe(composition.identities.length);
  });

  it("is deterministic under repository and alias permutations", () => {
    const first = cloneFixture();
    const expected = serializeWorkspaceIdentityComposition(
      composeWorkspaceIdentities(first.repositories),
    );
    for (let offset = 0; offset < first.repositories.length; offset += 1) {
      const second = cloneFixture();
      second.repositories = [
        ...second.repositories.slice(offset),
        ...second.repositories.slice(0, offset),
      ];
      const cartograph = second.repositories.find(
        (entry) => entry.repositoryId === "cartograph",
      );
      if (!cartograph) throw new Error("fixture setup");
      const origin = cartograph.origin as Record<string, unknown>;
      origin.aliases = [...(origin.aliases as string[])].reverse();

      expect(
        serializeWorkspaceIdentityComposition(
          composeWorkspaceIdentities(second.repositories),
        ),
      ).toBe(expected);
    }
  });

  it("keeps relocation out of the namespace and retains fork metadata", () => {
    const source = cloneFixture().repositories[0];
    if (!source) throw new Error("fixture setup");
    const relocated = { ...source, localPath: "another/location" };
    const first = composeWorkspaceIdentities([source]);
    const second = composeWorkspaceIdentities([relocated]);
    expect(first.identities.map((entry) => entry.composedStableKey)).toEqual(
      second.identities.map((entry) => entry.composedStableKey),
    );
    expect(first.namespaces[0]?.namespace).toBe(
      second.namespaces[0]?.namespace,
    );
    expect(first.namespaces[0]?.localPath).not.toBe(
      second.namespaces[0]?.localPath,
    );
  });

  it("does not rewrite local stable keys when duplicate origins are ambiguous", () => {
    const input = cloneFixture().repositories.slice(0, 1);
    const duplicate = {
      ...input[0],
      repositoryId: "cartograph-copy",
      localPath: "repos/cartograph-copy",
      origin: {
        availability: "available",
        canonical: "git@github.com:AlisinaDevelo/CARTOGRAPH.git",
      },
    };
    input.push(duplicate);
    const before = JSON.stringify(input);
    const composition = composeWorkspaceIdentities(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(composition.ambiguities).toContainEqual(
      expect.objectContaining({ kind: "duplicate-origin" }),
    );
    expect(composition.identities.map((entry) => entry.localStableKey)).toEqual(
      ["module:src/index.ts", "module:src/index.ts"],
    );
    expect(
      new Set(composition.identities.map((entry) => entry.composedStableKey))
        .size,
    ).toBe(2);
    expect(composition.snapshots).toHaveLength(2);
  });

  it("accepts shorthand origins and explicitly reports unavailable metadata", () => {
    const source = cloneFixture().repositories[0];
    if (!source) throw new Error("fixture setup");
    const shorthand = {
      ...source,
      repositoryId: "shorthand",
      origin: "https://github.com/example/shorthand.git",
    };
    const unavailable = {
      ...source,
      repositoryId: "missing-origin",
      origin: { availability: "unavailable" },
    };
    const composition = composeWorkspaceIdentities([shorthand, unavailable]);
    expect(
      composition.namespaces.find((entry) => entry.repositoryId === "shorthand")
        ?.canonicalOrigin,
    ).toBe("github.com/example/shorthand");
    expect(
      composition.ambiguities.some(
        (ambiguity) =>
          ambiguity.kind === "origin-unavailable" &&
          ambiguity.repositoryIds.includes("missing-origin"),
      ),
    ).toBe(true);
  });

  it("rejects duplicate repository identities, invalid origins, and unsafe paths", () => {
    const source = cloneFixture().repositories[0];
    if (!source) throw new Error("fixture setup");
    expectInvalid([source, source], "duplicate repository identity");
    expectInvalid([{ ...source, localPath: "../outside" }], "parent traversal");
    expectInvalid(
      [
        {
          ...source,
          origin: { availability: "available", canonical: "file:///tmp/repo" },
        },
      ],
      "local origin",
    );
    expectInvalid(
      [
        {
          ...source,
          origin: {
            availability: "unavailable",
            canonical: "https://github.com/example/repo",
          },
        },
      ],
      "unavailable canonical origin",
    );
  });

  it("fails closed at the node resource boundary", () => {
    const source = cloneFixture().repositories[0];
    if (!source) throw new Error("fixture setup");
    expect(() =>
      composeWorkspaceIdentities([source], { maxNodes: 1 }),
    ).not.toThrow();
    expect(() => composeWorkspaceIdentities([source], { maxNodes: 0 })).toThrow(
      WorkspaceIdentityValidationError,
    );
  });

  it("round-trips and re-canonicalizes a composed artifact", () => {
    const composition = composeWorkspaceIdentities(fixture.repositories);
    const serialized = serializeWorkspaceIdentityComposition(composition);
    expect(serializeWorkspaceIdentityComposition(JSON.parse(serialized))).toBe(
      serialized,
    );
    expect(parseWorkspaceIdentityComposition(JSON.parse(serialized))).toEqual(
      composition,
    );
  });
});
