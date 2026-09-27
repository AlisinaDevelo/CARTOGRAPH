import { createAjv } from "../../scripts/json-schema.mjs";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanRepository } from "../../src/commands.js";
import {
  diffGraphSnapshots,
  evaluatePolicyOnDiff,
  evaluatePolicyOnSnapshot,
  parsePolicyConfig,
  type GraphSnapshot,
} from "../../src/core/index.js";
import {
  matchesPackagePattern,
  matchesPathPattern,
} from "../../src/core/policy-paths.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const roots: string[] = [];

const scan = (files: Record<string, string>): GraphSnapshot => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "cartograph-policy-paths-")),
  );
  roots.push(root);
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include: ["src"],
    }),
  );
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return scanRepository({ root });
};

const layered = {
  "src/ui/page.ts":
    'import { query } from "../db/client.js";\nimport express from "express";\nexport const page = (): unknown => [query(), express];\n',
  "src/api/server.ts":
    'import express from "express";\nexport const server = (): unknown => express;\n',
  "src/db/client.ts": "export const query = (): number => 1;\n",
};

const policy = (rules: unknown[]) =>
  parsePolicyConfig({
    policyId: "architecture",
    version: "1.0.0",
    mode: "enforce",
    rules,
  });

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("policy path patterns", () => {
  it("matches globs by segment", () => {
    expect(matchesPathPattern("src/ui/page.ts", "src/ui/**")).toBe(true);
    expect(matchesPathPattern("src/ui/a/b.ts", "src/ui/*")).toBe(false);
    expect(matchesPathPattern("src/ui/a/b.ts", "src/**/b.ts")).toBe(true);
    expect(matchesPathPattern("src/b.ts", "src/**/b.ts")).toBe(true);
    expect(matchesPathPattern("src/ui.ts", "src/ui?ts")).toBe(true);
    expect(matchesPathPattern("src/ui/x.ts", "src/ui?x.ts")).toBe(false);
    expect(matchesPathPattern("src/a+b.ts", "src/a+b.ts")).toBe(true);
    expect(matchesPackagePattern("lodash/fp", "lodash")).toBe(true);
    expect(matchesPackagePattern("lodash-es", "lodash")).toBe(false);
    expect(matchesPackagePattern("@scope/pkg/sub", "@scope/*")).toBe(true);
  });

  it("rejects unsafe or unsupported patterns", () => {
    for (const fromPath of ["/src/**", "../src/**", "src/{a,b}/**", "!src/**"])
      expect(() =>
        policy([
          {
            id: "bad",
            target: "edge",
            assertion: "absent",
            selector: { fromPath },
          },
        ]),
      ).toThrow();
  });

  it("reports layering violations with the offending edge", () => {
    const report = evaluatePolicyOnSnapshot(
      policy([
        {
          id: "ui-not-db",
          target: "edge",
          assertion: "absent",
          selector: {
            kind: "imports",
            fromPath: "src/ui/**",
            toPath: "src/db/**",
          },
        },
      ]),
      scan(layered),
    );
    expect(report.status).toBe("violations");
    expect(report.violations).toEqual([
      expect.objectContaining({
        ruleId: "ui-not-db",
        count: 1,
        matches: ["edge:module:src/ui/page.ts|imports|module:src/db/client.ts"],
      }),
    ]);
    expect(report.violations[0]?.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^evidence:source:src\/ui\/page\.ts:1:/u),
      ]),
    );
  });

  it("limits a package to one layer with an exclude pattern", () => {
    const report = evaluatePolicyOnSnapshot(
      policy([
        {
          id: "express-only-in-api",
          target: "edge",
          assertion: "absent",
          selector: {
            kind: "imports",
            toPackage: "express",
            fromPathExclude: "src/api/**",
          },
        },
      ]),
      scan(layered),
    );
    expect(report.violations.map((violation) => violation.matches)).toEqual([
      ["edge:module:src/ui/page.ts|imports|module:external:express"],
    ]);
  });

  it("selects nodes by path", () => {
    const report = evaluatePolicyOnSnapshot(
      policy([
        {
          id: "db-functions",
          target: "node",
          assertion: "count-at-most",
          value: 0,
          selector: { kind: "function", path: "src/db/**" },
        },
      ]),
      scan(layered),
    );
    expect(report.violations[0]?.matches).toEqual([
      "node:function:src/db/client.ts:query",
    ]);
  });

  it("fails acyclic rules once per cycle group and passes acyclic graphs", () => {
    const cyclic = scan({
      "src/core/a.ts":
        'import { b } from "./b.js";\nexport const a = (): number => b();\n',
      "src/core/b.ts":
        'import { a } from "./a.js";\nexport const b = (): number => (Date.now() < 0 ? a() : 0);\n',
      "src/app.ts":
        'import { a } from "./core/a.js";\nexport const app = (): number => a();\n',
    });
    const rule = {
      id: "core-acyclic",
      target: "edge",
      assertion: "acyclic",
      selector: { kind: "imports", fromPath: "src/core/**" },
    };
    const report = evaluatePolicyOnSnapshot(policy([rule]), cyclic);
    expect(report.violations).toEqual([
      expect.objectContaining({
        assertion: "acyclic",
        count: 1,
        expected: 0,
        matches: [
          "edge:module:src/core/a.ts|imports|module:src/core/b.ts",
          "edge:module:src/core/b.ts|imports|module:src/core/a.ts",
        ],
      }),
    ]);
    expect(report.violations[0]?.reason).toContain("module:src/core/a.ts");

    const acyclic = evaluatePolicyOnSnapshot(
      policy([
        { ...rule, selector: { kind: "imports", fromPath: "src/app.ts" } },
      ]),
      cyclic,
    );
    expect(acyclic.status).toBe("passed");

    expect(() =>
      policy([{ ...rule, target: "node", selector: { kind: "module" } }]),
    ).toThrow("acyclic assertion applies only to edge rules");
    expect(() => policy([{ ...rule, value: 1 }])).toThrow();
  });

  it("resolves unchanged endpoints from IDs when evaluating a diff", () => {
    const before = scan({
      "src/db/client.ts": "export const query = (): number => 1;\n",
    });
    const after = scan(layered);
    const report = evaluatePolicyOnDiff(
      policy([
        {
          id: "no-new-ui-db",
          target: "edge",
          assertion: "absent",
          selector: {
            kind: "imports",
            fromPath: "src/ui/**",
            toPath: "src/db/**",
          },
        },
      ]),
      diffGraphSnapshots(before, after),
    );
    expect(report.violations[0]?.matches).toEqual([
      "edge-added:edge:module:src/ui/page.ts|imports|module:src/db/client.ts",
    ]);

    // Removing the forbidden import is not a violation.
    const removal = evaluatePolicyOnDiff(
      policy([
        {
          id: "no-new-ui-db",
          target: "edge",
          assertion: "absent",
          selector: {
            kind: "imports",
            fromPath: "src/ui/**",
            toPath: "src/db/**",
          },
        },
      ]),
      diffGraphSnapshots(after, before),
    );
    expect(removal.status).toBe("passed");
  });

  it("keeps the JSON schema in step with the parser", () => {
    const validate = createAjv().compile(
      JSON.parse(
        readFileSync(
          resolve(repositoryRoot, "schema/policy.v0.1.schema.json"),
          "utf8",
        ),
      ) as object,
    );
    const valid = {
      schemaVersion: 1,
      policyId: "architecture",
      version: "1.0.0",
      rules: [
        {
          id: "layers",
          target: "edge",
          assertion: "acyclic",
          selector: { fromPath: "src/**", toPackage: "@scope/*" },
        },
        {
          id: "db",
          target: "node",
          assertion: "absent",
          selector: { path: "src/db/**", pathExclude: "src/db/index.ts" },
        },
      ],
    };
    expect(validate(valid)).toBe(true);
    expect(() => parsePolicyConfig(valid)).not.toThrow();
    for (const invalid of [
      {
        ...valid,
        rules: [
          { ...valid.rules[0], target: "node", selector: { kind: "module" } },
        ],
      },
      { ...valid, rules: [{ ...valid.rules[0], value: 1 }] },
      {
        ...valid,
        rules: [{ ...valid.rules[1], selector: { path: "../x/**" } }],
      },
    ]) {
      expect(validate(invalid)).toBe(false);
      expect(() => parsePolicyConfig(invalid)).toThrow();
    }
  });
});
