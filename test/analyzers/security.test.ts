import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseGraphSnapshot,
  serializeGraphSnapshot,
} from "../../src/core/index.js";
import { analyzeTypeScriptRepository } from "../../src/analyzers/typescript.js";

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/secrets",
);

describe("analyzer output safety", () => {
  it("does not copy credentials, query strings, fragments, or source expressions", () => {
    const snapshot = parseGraphSnapshot(
      analyzeTypeScriptRepository(fixtureRoot),
    );
    const serialized = serializeGraphSnapshot(snapshot);

    expect(serialized).not.toContain("user:password");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("#fragment");
    expect(serialized).not.toContain("path-secret");
    expect(serialized).not.toContain("embedded-source-secret");
    expect(serialized).not.toContain("absolute-source-secret");
    expect(serialized).not.toContain("/Users/user");
    expect(serialized).not.toContain("secretHandlerExpression");
    expect(snapshot.edges).toContainEqual(
      expect.objectContaining({
        confidence: "certain",
        to: "external_service:https://api.example.test",
      }),
    );
  });
});
