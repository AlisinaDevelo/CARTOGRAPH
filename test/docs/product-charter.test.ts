import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

describe("product charter contract", () => {
  it("publishes the support matrix owner and review process", () => {
    const charter = readRepositoryFile("docs/PRODUCT.md");
    const supportMatrix = readRepositoryFile("docs/SUPPORT_MATRIX.md");

    expect(charter).toContain("## Supported first slice");
    expect(charter).toContain("## Non-goals");
    expect(supportMatrix).toMatch(/^Owner: `[^`]+`$/mu);
    expect(supportMatrix).toMatch(/^Review cadence: .+$/mu);
    expect(supportMatrix).toContain("## Review process");
    expect(supportMatrix).toContain("Unsupported or unresolved");
    expect(supportMatrix).toContain("Evidence source");
  });
});
