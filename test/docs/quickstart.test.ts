import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("quickstart and limitations guide", () => {
  it("links the clean-checkout quickstart and sample repository", () => {
    const readme = read("README.md");
    const guide = read("docs/QUICKSTART.md");
    const sample = read("examples/sample-repository/README.md");
    expect(readme).toContain("docs/QUICKSTART.md");
    expect(guide).toContain("node dist/cli.js scan examples/sample-repository");
    expect(guide).toContain("node dist/cli.js diff");
    expect(guide).toContain("ACTION.md");
    expect(sample).toContain("CARTOGRAPH quickstart");
  });

  it("covers privacy, unsupported input, configuration, and troubleshooting", () => {
    const guide = read("docs/QUICKSTART.md");
    expect(guide).toContain("Privacy and unsupported input");
    expect(guide).toContain("Configuration");
    expect(guide).toContain("Troubleshooting");
    expect(guide).toContain("SUPPORT_MATRIX.md");
    expect(guide).toContain("THREAT_MODEL.md");
    expect(guide).toContain("CONFIGURATION.md");
  });
});
