import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  GraphSchemaVersionError,
  parseGraphSnapshot,
} from "../../src/index.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const scriptPath = resolve(repositoryRoot, "scripts/schema-compatibility.mjs");

describe("schema compatibility policy", () => {
  it("passes the checked-in manifest/runtime/schema compatibility gate", () => {
    const output = execFileSync(process.execPath, [scriptPath, "check"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      policyVersion: 1,
      snapshotVersion: 1,
      diffVersion: 1,
      diagnosticVersion: 1,
    });
  });

  it("rejects a legacy snapshot with an actionable migration error", async () => {
    const legacy = JSON.parse(
      await readFile(
        resolve(repositoryRoot, "test/fixtures/snapshots/legacy-v0.graph.json"),
        "utf8",
      ),
    ) as unknown;

    expect(() => parseGraphSnapshot(legacy)).toThrow(GraphSchemaVersionError);
    expect(() => parseGraphSnapshot(legacy)).toThrow(
      /supported version is 1.*migration/u,
    );
  });

  it("rejects an unreviewed version entry", async () => {
    const temporaryRoot = await mkdtemp(
      join(repositoryRoot, ".tmp-schema-compatibility-"),
    );
    try {
      await cp(
        resolve(repositoryRoot, "schema"),
        join(temporaryRoot, "schema"),
        {
          recursive: true,
        },
      );
      await cp(resolve(repositoryRoot, "src"), join(temporaryRoot, "src"), {
        recursive: true,
      });

      const policyPath = join(temporaryRoot, "schema/compatibility.json");
      const schemaPath = join(
        temporaryRoot,
        "schema/graph-snapshot.v0.1.schema.json",
      );
      const sourcePath = join(temporaryRoot, "src/core/schemas.ts");
      const policy = JSON.parse(await readFile(policyPath, "utf8")) as {
        contracts: {
          snapshot: {
            current: number;
            supportedReaders: number[];
          };
        };
      };
      policy.contracts.snapshot.current = 2;
      policy.contracts.snapshot.supportedReaders = [2];
      await writeFile(policyPath, JSON.stringify(policy, null, 2) + "\n");
      const schema = await readFile(schemaPath, "utf8");
      await writeFile(schemaPath, schema.replace('"const": 1', '"const": 2'));
      const source = await readFile(sourcePath, "utf8");
      await writeFile(
        sourcePath,
        source.replace(
          "GRAPH_SNAPSHOT_SCHEMA_VERSION = 1",
          "GRAPH_SNAPSHOT_SCHEMA_VERSION = 2",
        ),
      );

      expect(() =>
        execFileSync(
          process.execPath,
          [scriptPath, "check", "--root", temporaryRoot],
          { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" },
        ),
      ).toThrow(/not reviewed/u);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
