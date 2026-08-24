import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("threat-model contract", () => {
  it("documents optional traces and the default offline boundary", () => {
    const threatModel = readFileSync(
      resolve(repositoryRoot, "docs/THREAT_MODEL.md"),
      "utf8",
    );

    expect(threatModel).toContain("## Optional runtime traces");
    expect(threatModel).toContain("## Default offline behavior");
    expect(threatModel).toContain("no network requests");
    expect(threatModel).toContain("no source execution");
    expect(threatModel).toContain("redaction");
    expect(threatModel).toContain("retention");
  });
});
