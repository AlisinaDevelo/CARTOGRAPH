import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ASSURANCE_BUNDLE_ROLES,
  checkBundleSharing,
  collectRepositoryPaths,
  createPathPseudonymizer,
  redactArtifactForSharing,
  type SharingArtifact,
  type SharingCategory,
  type SharingRole,
} from "../../src/core/index.js";
import { scanRepository, serializeScan } from "../../src/commands.js";

// Seeds are assembled at runtime so no secret-shaped literal is committed.
const join = (...parts: string[]): string => parts.join("");
export const SEEDS: Record<
  Exclude<
    SharingCategory,
    "unscannable" | "email" | "ip-address" | "external-url"
  >,
  string
> = {
  "private-key": join("-----BEGIN ", "RSA PRIVATE", " KEY-----"),
  "access-token": join("gh", "p_", "Z".repeat(36)),
  jwt: join("eyJ", "a".repeat(12), ".eyJ", "b".repeat(12), ".", "c".repeat(16)),
  "credential-assignment": join("pass", "word=", "hunter2hunter2"),
  "credential-url": join(
    "https://deploy",
    ":",
    "s3cr3tvalue",
    "@example.com/x",
  ),
  "absolute-path": join("/Us", "ers/alice/private/repo/src/a.ts"),
};

const ROLES = [
  ...(Object.keys(ASSURANCE_BUNDLE_ROLES) as SharingRole[]),
  "manifest" as const,
];
const isText = (role: SharingRole): boolean =>
  role === "report-html" || role === "report-markdown";
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const seeded = (role: SharingRole, value: string): SharingArtifact => ({
  path: `artifacts/${role}.x`,
  role,
  content: encode(
    isText(role)
      ? `# Report\n\nnote: ${value} end\n`
      : JSON.stringify({ nested: { list: ["ok", `see ${value} here`] } }),
  ),
});

describe("bundle sharing check", () => {
  for (const role of ROLES)
    it(`finds every seeded secret in a ${role} artifact without echoing it`, () => {
      for (const [category, value] of Object.entries(SEEDS)) {
        const report = checkBundleSharing([seeded(role, value)], {
          profile: "team",
        });
        expect(report.ok, `${role} ${category}`).toBe(false);
        expect(report.findings.map((item) => item.category)).toContain(
          category,
        );
        expect(JSON.stringify(report)).not.toContain(value);
        expect(report.findings[0]?.location).toBe(
          isText(role) ? "line:3" : "/nested/list/1",
        );
      }
    });

  it("checks key names as well as values", () => {
    const report = checkBundleSharing(
      [
        {
          path: "a.json",
          role: "adapter-manifest",
          content: encode(JSON.stringify({ [SEEDS["access-token"]]: 1 })),
        },
      ],
      { profile: "team" },
    );
    expect(report.findings.map((item) => item.location)).toEqual([
      `/${SEEDS["access-token"]}#key`,
    ]);
  });

  it("adds identifiers and remote hosts under the public profile", () => {
    const artifact: SharingArtifact = {
      path: "a.json",
      role: "decisions",
      content: encode(
        JSON.stringify({
          $schema: "https://json-schema.org/draft-07/schema#",
          owner: "alice@example.com",
          host: "10.1.2.3",
          link: "https://intranet.example.com/wiki",
          docs: "https://docs.example.org/a",
        }),
      ),
    };
    expect(checkBundleSharing([artifact], { profile: "team" }).ok).toBe(true);
    const report = checkBundleSharing([artifact], {
      profile: "public",
      allowedHosts: ["docs.example.org"],
    });
    expect(report.findings.map((item) => item.category).sort()).toEqual([
      "email",
      "external-url",
      "ip-address",
    ]);
  });

  it("fails closed on artifacts it cannot read", () => {
    let deep: unknown = "x";
    for (let depth = 0; depth < 300; depth += 1) deep = [deep];
    const report = checkBundleSharing(
      [
        { path: "a", role: "diff", content: new Uint8Array([0xff, 0xfe]) },
        { path: "b", role: "diff", content: encode("{not json") },
        { path: "c", role: "diff", content: encode(JSON.stringify(deep)) },
      ],
      { profile: "team" },
    );
    expect(report.findings.map((item) => item.category)).toEqual([
      "unscannable",
      "unscannable",
      "unscannable",
    ]);
  });

  it("does not flag a real scan under the team profile, and flags only its external host under public", () => {
    const snapshot = serializeScan(
      scanRepository({ root: "test/fixtures/typescript-express" }),
    );
    const artifacts: SharingArtifact[] = [
      { path: "s.json", role: "snapshot-head", content: encode(snapshot) },
    ];
    expect(checkBundleSharing(artifacts, { profile: "team" }).findings).toEqual(
      [],
    );
    const findings = checkBundleSharing(artifacts, {
      profile: "public",
    }).findings;
    expect(findings.length).toBeGreaterThan(0);
    expect(new Set(findings.map((item) => item.category))).toEqual(
      new Set(["external-url"]),
    );
    expect(
      checkBundleSharing(artifacts, {
        profile: "public",
        allowedHosts: ["api.example.test"],
      }).ok,
    ).toBe(true);
  });
});

describe("bundle sharing redaction", () => {
  it("replaces detected values with category markers", () => {
    for (const role of ROLES)
      for (const value of Object.values(SEEDS)) {
        const artifact = seeded(role, value);
        const redacted = redactArtifactForSharing(artifact, {
          profile: "team",
        });
        expect(redacted.redactions).toBeGreaterThan(0);
        expect(redacted.content).not.toContain(value);
        expect(redacted.content).toContain("[REDACTED:");
        expect(
          checkBundleSharing(
            [{ ...artifact, content: encode(redacted.content) }],
            { profile: "team" },
          ).ok,
        ).toBe(true);
      }
  });
});

describe("path pseudonymization", () => {
  const key = new Uint8Array(32).fill(7);
  const snapshot = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../fixtures/snapshots/legacy-v0.graph.json",
      ),
      "utf8",
    ),
  ) as unknown;
  const artifacts: SharingArtifact[] = [
    {
      path: "s.json",
      role: "snapshot-head",
      content: encode(
        JSON.stringify({
          nodes: [
            {
              id: "module:src/api/users.ts",
              location: { path: "src/api/users.ts" },
            },
            { id: "module:index.ts", location: { path: "index.ts" } },
          ],
          legacy: snapshot,
        }),
      ),
    },
  ];

  it("is consistent, keyed, and keeps structure and extensions", () => {
    const paths = collectRepositoryPaths(artifacts);
    expect(paths).toContain("src/api/users.ts");
    const rewrite = createPathPseudonymizer(key, paths);
    const id = rewrite("module:src/api/users.ts");
    expect(id).toMatch(
      /^module:p[0-9a-f]{10}\/p[0-9a-f]{10}\/p[0-9a-f]{10}\.ts$/u,
    );
    expect(rewrite("src/api/users.ts")).toBe(id.slice("module:".length));
    expect(rewrite("src/api/**")).toMatch(
      /^p[0-9a-f]{10}\/p[0-9a-f]{10}\/\*\*$/u,
    );
    expect(rewrite("index.ts")).toMatch(/^p[0-9a-f]{10}\.ts$/u);
    expect(rewrite("see https://json-schema.org/src/api")).toBe(
      "see https://json-schema.org/src/api",
    );
    expect(rewrite("run")).toBe("run");
    const other = createPathPseudonymizer(new Uint8Array(32).fill(8), paths);
    expect(other("src/api/users.ts")).not.toBe(rewrite("src/api/users.ts"));
  });

  it("refuses a short key", () => {
    expect(() => createPathPseudonymizer(new Uint8Array(8), [])).toThrow(
      /at least 32 bytes/u,
    );
  });
});
