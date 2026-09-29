import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createAjv } from "../../scripts/json-schema.mjs";
import {
  AssuranceBundleError,
  buildAssuranceBundle,
  createGraphSnapshot,
  diffGraphSnapshots,
  serializeGraphSnapshot,
  stableStringify,
  verifyAssuranceBundle,
} from "../../src/core/index.js";

const root = resolve(import.meta.dirname, "../..");
const snapshot = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "head" },
  nodes: [
    {
      id: "module:src/a.ts",
      stableKey: "module:src/a.ts",
      kind: "module",
      name: "a",
      location: { path: "src/a.ts", line: 1 },
    },
  ],
  edges: [],
});
const encoder = new TextEncoder();
const snapshotBytes = encoder.encode(serializeGraphSnapshot(snapshot));
const diffBytes = encoder.encode(
  stableStringify(diffGraphSnapshots(snapshot, snapshot)),
);
const reportBytes = encoder.encode("<!doctype html><title>report</title>\n");

const build = () =>
  buildAssuranceBundle(
    [
      { role: "report-html", content: reportBytes },
      { role: "snapshot-head", content: snapshotBytes },
      { role: "diff", content: diffBytes },
    ],
    {
      toolVersion: "0.1.1",
      requiredRoles: ["diff", "snapshot-head", "policy-evaluation"],
      missing: [{ role: "policy-evaluation", reason: "no policy configured" }],
    },
  );

const verify = (manifest: string, files: Map<string, Uint8Array>) => {
  const all = new Map(files);
  all.set("manifest.json", encoder.encode(manifest));
  return verifyAssuranceBundle([...all.keys()].sort(), (path) => {
    const content = all.get(path);
    if (content === undefined) throw new Error(path);
    return content;
  });
};

describe("assurance bundle", () => {
  it("builds byte-identical bundles from identical inputs, in any order", () => {
    const first = build();
    const second = buildAssuranceBundle(
      [
        { role: "diff", content: diffBytes },
        { role: "snapshot-head", content: snapshotBytes },
        { role: "report-html", content: reportBytes },
      ],
      {
        toolVersion: "0.1.1",
        requiredRoles: ["policy-evaluation", "snapshot-head", "diff"],
        missing: [
          { role: "policy-evaluation", reason: "no policy configured" },
        ],
      },
    );
    expect(second.manifest).toBe(first.manifest);
    expect([...second.files.keys()].sort()).toEqual(
      [...first.files.keys()].sort(),
    );
    expect(verify(first.manifest, first.files)).toMatchObject({
      ok: true,
      artifacts: 3,
      problems: [],
    });
  });

  it("matches the published manifest schema", () => {
    const validate = createAjv().compile(
      JSON.parse(
        readFileSync(
          resolve(root, "schema/assurance-bundle.v0.1.schema.json"),
          "utf8",
        ),
      ) as object,
    );
    expect(validate(JSON.parse(build().manifest))).toBe(true);
  });

  it("detects altered, substituted, missing, and unexpected files", () => {
    const { manifest, files } = build();
    const [snapshotPath] = [...files.keys()].filter((path) =>
      path.startsWith("artifacts/snapshot-head-"),
    );
    const [reportPath] = [...files.keys()].filter((path) =>
      path.startsWith("artifacts/report-html-"),
    );
    if (snapshotPath === undefined || reportPath === undefined)
      throw new Error("expected artifacts");
    const tampered = new Map(files);
    tampered.set(snapshotPath, diffBytes);
    tampered.delete(reportPath);
    tampered.set("artifacts/extra.json", encoder.encode("{}"));
    const problems = verify(manifest, tampered).problems.join("\n");
    expect(problems).toContain(`${snapshotPath} digest does not match`);
    expect(problems).toContain(`missing report-html artifact ${reportPath}`);
    expect(problems).toContain("unexpected file artifacts/extra.json");
  });

  it("rejects an edited manifest", () => {
    const { manifest, files } = build();
    const edited = manifest.replace('"0.1.1"', '"9.9.9"');
    expect(verify(edited, files).problems).toContain(
      "bundleId does not match the manifest contents",
    );
  });

  it("enforces contracts and missing-artifact semantics at build time", () => {
    expect(() =>
      buildAssuranceBundle([{ role: "diff", content: snapshotBytes }], {
        toolVersion: "0.1.1",
      }),
    ).toThrowError(AssuranceBundleError);
    expect(() =>
      buildAssuranceBundle(
        [{ role: "snapshot-head", content: snapshotBytes }],
        {
          toolVersion: "0.1.1",
          requiredRoles: ["diff"],
        },
      ),
    ).toThrow("required diff artifact is absent and not declared missing");
    expect(() =>
      buildAssuranceBundle([{ role: "diff", content: diffBytes }], {
        toolVersion: "0.1.1",
        missing: [{ role: "diff", reason: "not run" }],
      }),
    ).toThrow("diff is declared missing but is present");
  });
});
