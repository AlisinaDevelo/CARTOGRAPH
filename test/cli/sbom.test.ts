import { describe, expect, it, vi } from "vitest";

import { createCli } from "../../src/cli.js";

describe("sbom link", () => {
  it("prints a link report for a snapshot, SBOM, and provenance", async () => {
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await createCli().parseAsync([
        "node",
        "cartograph",
        "sbom",
        "link",
        "--snapshot",
        "test/fixtures/sbom-link/graph.json",
        "--sbom",
        "test/fixtures/sbom-link/cyclonedx.json",
        "--provenance",
        "test/fixtures/sbom-link/slsa-provenance.json",
        "--alias",
        "real-fetch=fetch-alias",
      ]);
    } finally {
      vi.restoreAllMocks();
    }
    const report = JSON.parse(output) as {
      contract: string;
      sourceRevision: string;
      coverage: { linked: number };
    };
    expect(report.contract).toBe("cartograph.sbom-link");
    expect(report.sourceRevision).toBe("matches");
    expect(report.coverage.linked).toBe(8);
  });
});
