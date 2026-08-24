import { spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Ajv from "ajv";
import { afterEach, describe, expect, it } from "vitest";

import {
  PATCH_PREVIEW_CONTRACT,
  PATCH_PREVIEW_SCHEMA_VERSION,
  PatchPreviewError,
  PatchPreviewReportSchema,
  PatchPreviewRequestSchema,
  patchContentDigest,
  previewPatch,
  serializePatchPreviewReport,
} from "../../src/core/index.js";
import { revisionTemporaryPrefix } from "../../src/git/revision.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

const run = async (
  command: string,
  args: string[],
  cwd: string,
): Promise<string> =>
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString("utf8"));
      } else {
        reject(new Error(Buffer.concat(stderr).toString("utf8")));
      }
    });
  });

const createRepository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "cartograph-patch-preview-"));
  temporaryDirectories.push(root);
  await run("git", ["init", "-b", "main"], root);
  await run("git", ["config", "user.name", "CARTOGRAPH Test"], root);
  await run("git", ["config", "user.email", "test@example.invalid"], root);
  await writeFile(join(root, "README.md"), "original\n", "utf8");
  await run("git", ["add", "README.md"], root);
  await run("git", ["commit", "-m", "initial"], root);
  return root;
};

const revisionDirectories = async (root: string): Promise<string[]> =>
  (await readdir(tmpdir())).filter((entry) =>
    entry.startsWith(revisionTemporaryPrefix(root)),
  );

const expectNoNewRevisionDirectories = async (
  root: string,
  before: readonly string[],
): Promise<void> => {
  const after = await revisionDirectories(root);
  expect(after.filter((entry) => !before.includes(entry))).toEqual([]);
};

const requestFor = async (
  root: string,
  overrides: Record<string, unknown> = {},
) => {
  const source = await readFile(join(root, "README.md"), "utf8");
  return {
    schemaVersion: PATCH_PREVIEW_SCHEMA_VERSION,
    contract: PATCH_PREVIEW_CONTRACT,
    previewId: "test-preview",
    sourceRef: "HEAD",
    operations: [
      {
        path: "README.md",
        expectedDigest: patchContentDigest(source),
        replacement: "previewed\n",
      },
    ],
    validationCommands: ["verify-patch"],
    ...overrides,
  };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("isolated patch previews", () => {
  it("applies digest-guarded operations only in a temporary tree", async () => {
    const root = await createRepository();
    const before = await readFile(join(root, "README.md"), "utf8");
    const beforeStatus = await run("git", ["status", "--porcelain=v1"], root);
    const report = await previewPatch({
      root,
      request: await requestFor(root),
    });

    expect(report).toMatchObject({
      status: "passed",
      sourceRef: "HEAD",
      originalDirty: false,
      worktreePreserved: true,
      requiresExplicitApplication: true,
      operations: [
        {
          path: "README.md",
          beforeDigest: patchContentDigest(before),
          afterDigest: patchContentDigest("previewed\n"),
        },
      ],
      validation: [{ command: "verify-patch", status: "passed" }],
    });
    expect(report.rollbackInstructions.length).toBeGreaterThan(1);
    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      before,
    );
    await expect(run("git", ["status", "--porcelain=v1"], root)).resolves.toBe(
      beforeStatus,
    );
  });

  it("records dirty provenance while preserving dirty content", async () => {
    const root = await createRepository();
    await writeFile(join(root, "README.md"), "dirty local edit\n", "utf8");
    const report = await previewPatch({
      root,
      request: await requestFor(root, {
        operations: [
          {
            path: "README.md",
            expectedDigest: patchContentDigest("original\n"),
            replacement: "previewed\n",
          },
        ],
      }),
    });

    expect(report.status).toBe("passed");
    expect(report.originalDirty).toBe(true);
    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "dirty local edit\n",
    );
  });

  it("fails closed on stale digests and missing targets without partial source changes", async () => {
    const root = await createRepository();
    const stale = await requestFor(root, {
      operations: [
        {
          path: "README.md",
          expectedDigest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          replacement: "unsafe\n",
        },
      ],
    });
    const conflict = await previewPatch({ root, request: stale });
    expect(conflict).toMatchObject({
      status: "conflict",
      conflictPath: "README.md",
      errorCode: "digest-conflict",
      operations: [],
    });

    const missing = await previewPatch({
      root,
      request: await requestFor(root, {
        operations: [
          {
            path: "missing.txt",
            expectedDigest:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            replacement: "missing\n",
          },
        ],
      }),
    });
    expect(missing).toMatchObject({
      status: "conflict",
      conflictPath: "missing.txt",
      errorCode: "invalid-target",
    });
    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "original\n",
    );
  });

  it("rejects traversal and duplicate paths before materialization", async () => {
    const root = await createRepository();
    await expect(
      previewPatch({
        root,
        request: await requestFor(root, {
          operations: [
            {
              path: "../outside.txt",
              expectedDigest: patchContentDigest("original\n"),
              replacement: "bad\n",
            },
          ],
        }),
      }),
    ).rejects.toThrowError(PatchPreviewError);
    await expect(
      previewPatch({
        root,
        request: await requestFor(root, {
          operations: [
            {
              path: "README.md",
              expectedDigest: patchContentDigest("original\n"),
              replacement: "one\n",
            },
            {
              path: "README.md",
              expectedDigest: patchContentDigest("original\n"),
              replacement: "two\n",
            },
          ],
        }),
      }),
    ).rejects.toThrowError(PatchPreviewError);
  });

  it("rejects archived symlinks and cleans the temporary revision on failure", async () => {
    const root = await createRepository();
    await symlink("/etc/passwd", join(root, "outside-link"));
    await run("git", ["add", "outside-link"], root);
    await run("git", ["commit", "-m", "add link"], root);
    const before = await revisionDirectories(root);

    await expect(
      previewPatch({
        root,
        request: await requestFor(root, {
          operations: [
            {
              path: "outside-link",
              expectedDigest: patchContentDigest("not-read"),
              replacement: "blocked\n",
            },
          ],
        }),
      }),
    ).rejects.toMatchObject({
      code: "materialization-failed",
    });
    await expectNoNewRevisionDirectories(root, before);
    expect((await lstat(join(root, "outside-link"))).isSymbolicLink()).toBe(
      true,
    );
  });

  it("enforces replacement ceilings and cleans the isolated revision", async () => {
    const root = await createRepository();
    const before = await revisionDirectories(root);
    await expect(
      previewPatch({
        root,
        request: await requestFor(root),
        resources: { maxReplacementBytes: 1 },
      }),
    ).rejects.toMatchObject({ code: "resource-limit" });
    await expectNoNewRevisionDirectories(root, before);
    await expect(readFile(join(root, "README.md"), "utf8")).resolves.toBe(
      "original\n",
    );
  });

  it("supports explicit validation disablement and preserves rollback instructions", async () => {
    const root = await createRepository();
    const report = await previewPatch({
      root,
      request: await requestFor(root),
      runValidation: false,
    });
    expect(report.status).toBe("passed");
    expect(report.validation).toEqual([
      {
        command: "verify-patch",
        status: "skipped",
        outputDigest: null,
        detail: "validation was explicitly disabled by the caller",
      },
    ]);
    expect(serializePatchPreviewReport(report)).toContain(
      "requiresExplicitApplication",
    );
  });

  it("keeps runtime and JSON Schemas aligned", async () => {
    const root = await createRepository();
    const request = await requestFor(root);
    expect(PatchPreviewRequestSchema.parse(request)).toEqual(request);
    const report = await previewPatch({ root, request });
    expect(PatchPreviewReportSchema.parse(report)).toEqual(report);
    const schema = JSON.parse(
      readFileSync(
        resolve(repositoryRoot, "schema/patch-preview-report.v0.1.schema.json"),
        "utf8",
      ),
    ) as object;
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(report)).toBe(true);
  });
});
