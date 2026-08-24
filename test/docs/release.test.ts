import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

describe("release pipeline contract", () => {
  it("pins the tag workflow and keeps publication scoped", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toContain('tags:\n      - "v*.*.*"');
    expect(workflow).toContain(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    expect(workflow).toContain(
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    );
    expect(workflow).toContain("npm run check");
    expect(workflow).toContain("scripts/release-artifact.mjs");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("SHA256SUMS");
    expect(workflow).toContain(
      "actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a",
    );
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("attestations: write");
    expect(workflow).toContain("*.sbom.cdx.json");
    expect(workflow).toContain("*.provenance.json");
    expect(workflow).toContain("gh attestation verify");
    expect(workflow).toContain("release-metadata.json");
    expect(workflow).toContain("--verify-tag");
    expect(read("scripts/release-artifact.mjs")).toContain("contentSha256");
    expect(read("scripts/release-artifact.mjs")).toContain("normalizeSbom");
    expect(read("scripts/release-artifact.mjs")).toContain("provenanceName");
    expect(read("scripts/release-artifact.mjs")).toContain(
      "forbiddenPackagePath",
    );
    expect(workflow).not.toContain("npm publish");
  });

  it("keeps the release contract documented and generated output ignored", () => {
    const release = read("docs/RELEASE.md");
    const changelog = read("CHANGELOG.md");
    const ignore = read(".gitignore");
    expect(release).toContain("Rollback and recovery");
    expect(release).toContain("SHA256SUMS");
    expect(release).toContain("CycloneDX SBOM");
    expect(release).toContain("SLSA/in-toto provenance");
    expect(release).toContain("gh attestation verify");
    expect(changelog).toContain("## [0.1.0]");
    expect(ignore).toContain("dist/");
    expect(ignore).toContain("coverage/");
  });
});
