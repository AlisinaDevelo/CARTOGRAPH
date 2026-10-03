import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkBundle,
  createBundle,
  shareBundle,
  verifyBundle,
} from "../../src/bundle-command.js";
import { scanRepository, serializeScan } from "../../src/commands.js";
import { createAjv } from "../../scripts/json-schema.mjs";

const roots: string[] = [];
const temporary = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "cartograph-share-")));
  roots.push(path);
  return path;
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

// Assembled at runtime so no secret-shaped literal is committed.
const TOKEN = ["gh", "p_", "Q".repeat(36)].join("");
const HOME_PATH = ["/Us", "ers/alice/work/repo"].join("");

const allFiles = (root: string): string =>
  [
    "manifest.json",
    ...readdirSync(join(root, "artifacts")).map((name) => `artifacts/${name}`),
  ]
    .map((name) => readFileSync(join(root, name), "utf8"))
    .join("\n");

const setup = async (options: { reportText?: string } = {}) => {
  const directory = temporary();
  const snapshot = join(directory, "head.json");
  writeFileSync(
    snapshot,
    serializeScan(scanRepository({ root: "test/fixtures/typescript-express" })),
  );
  const report = join(directory, "report.md");
  writeFileSync(
    report,
    options.reportText ??
      `# Review\n\nToken leaked in CI: ${TOKEN}\nChecked out at ${HOME_PATH}\n`,
  );
  const config = join(directory, "config.json");
  writeFileSync(config, JSON.stringify({ include: ["src/**/*.ts"] }));
  const source = join(directory, "bundle");
  await createBundle({
    output: source,
    artifacts: [
      { role: "snapshot-head", path: snapshot },
      { role: "report-markdown", path: report },
      { role: "configuration", path: config },
    ],
    missing: [],
    toolVersion: "0.1.1",
  });
  const keyFile = join(directory, "share.key");
  writeFileSync(keyFile, Buffer.alloc(32, 9));
  return { directory, source, keyFile, snapshot, report };
};

describe("bundle check", () => {
  it("reports seeded secrets by location and never prints them", async () => {
    const { source } = await setup();
    const report = await checkBundle(source, { profile: "team" });
    expect(report.ok).toBe(false);
    expect(report.findings.map((item) => item.category).sort()).toEqual([
      "absolute-path",
      "access-token",
    ]);
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(JSON.stringify(report)).not.toContain(HOME_PATH);
    const validate = createAjv({ allErrors: true }).compile(
      JSON.parse(
        readFileSync(
          join(
            import.meta.dirname,
            "../../schema/bundle-sharing.v0.1.schema.json",
          ),
          "utf8",
        ),
      ) as object,
    );
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it("refuses an unverifiable bundle", async () => {
    const { source } = await setup();
    const artifact = readdirSync(join(source, "artifacts"))[0] as string;
    writeFileSync(join(source, "artifacts", artifact), "{}");
    await expect(checkBundle(source, { profile: "team" })).rejects.toThrow(
      /does not verify/u,
    );
  });
});

describe("bundle create with a profile", () => {
  it("writes nothing when the inputs are unsafe to share", async () => {
    const { directory, snapshot, report } = await setup();
    const output = join(directory, "refused");
    await expect(
      createBundle({
        output,
        artifacts: [
          { role: "snapshot-head", path: snapshot },
          { role: "report-markdown", path: report },
        ],
        missing: [],
        profile: "team",
        toolVersion: "0.1.1",
      }),
    ).rejects.toThrow(/not safe to share/u);
    expect(existsSync(output)).toBe(false);
  });
});

describe("bundle share", () => {
  it("redacts for a team and produces a verifiable, clean bundle", async () => {
    const { directory, source } = await setup();
    const output = join(directory, "team");
    const result = await shareBundle({
      input: source,
      output,
      profile: "team",
      toolVersion: "0.1.1",
    });
    expect(result).toMatchObject({
      ok: true,
      profile: "team",
      excludedRoles: [],
      pathsPseudonymized: 0,
    });
    expect(result.redactions).toBe(2);
    expect(await verifyBundle(output)).toMatchObject({ ok: true });
    expect((await checkBundle(output, { profile: "team" })).ok).toBe(true);
    const text = allFiles(output);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(HOME_PATH);
    expect(text).toContain("src/router.ts");
  });

  it("pseudonymizes paths and hosts and excludes local configuration for the public", async () => {
    const { directory, source, keyFile } = await setup();
    await expect(
      shareBundle({
        input: source,
        output: join(directory, "nokey"),
        profile: "public",
        toolVersion: "0.1.1",
      }),
    ).rejects.toThrow(/--key-file/u);
    const output = join(directory, "public");
    const result = await shareBundle({
      input: source,
      output,
      profile: "public",
      keyFile,
      toolVersion: "0.1.1",
    });
    expect(result.excludedRoles).toEqual(["configuration"]);
    expect(result.pathsPseudonymized).toBeGreaterThan(0);
    expect(await verifyBundle(output)).toMatchObject({ ok: true });
    expect((await checkBundle(output, { profile: "public" })).ok).toBe(true);
    const text = allFiles(output);
    expect(text).not.toContain("src/router.ts");
    expect(text).not.toContain("api.example.test");
    expect(text).not.toContain(TOKEN);
    const manifest = JSON.parse(
      readFileSync(join(output, "manifest.json"), "utf8"),
    ) as { missing: { role: string; reason: string }[] };
    expect(manifest.missing).toEqual([
      {
        role: "configuration",
        reason: "excluded by the public sharing profile",
      },
    ]);

    const again = join(directory, "public-again");
    await shareBundle({
      input: source,
      output: again,
      profile: "public",
      keyFile,
      toolVersion: "0.1.1",
    });
    expect(allFiles(again)).toBe(text);
  });

  it("fails closed when redaction would break a contract", async () => {
    const { directory, keyFile } = await setup();
    const snapshot = JSON.parse(
      serializeScan(
        scanRepository({ root: "test/fixtures/typescript-express" }),
      ),
    ) as { nodes: { id: string; stableKey: string }[] };
    // Two distinct leaked IDs redact to the same value, which the snapshot
    // contract rejects as a duplicate.
    let text = JSON.stringify(snapshot);
    snapshot.nodes.slice(0, 2).forEach((node, index) => {
      text = text.replaceAll(
        JSON.stringify(node.id),
        JSON.stringify(`module:${HOME_PATH}/f${index}.ts`),
      );
    });
    const path = join(directory, "leaky.json");
    writeFileSync(path, text);
    const source = join(directory, "leaky-bundle");
    await createBundle({
      output: source,
      artifacts: [{ role: "snapshot-head", path }],
      missing: [],
      toolVersion: "0.1.1",
    });
    const output = join(directory, "leaky-share");
    const error = await shareBundle({
      input: source,
      output,
      profile: "team",
      keyFile,
      toolVersion: "0.1.1",
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(HOME_PATH);
    expect(existsSync(output)).toBe(false);
  });
});
