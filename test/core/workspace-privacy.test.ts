import Ajv from "ajv";
import {
  access,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  WorkspacePrivacyValidationError,
  assessWorkspacePrivacy,
  assertWorkspacePrivacyPath,
  createWorkspacePrivacyBudget,
  parseWorkspacePrivacyAssessment,
  parseWorkspacePrivacyRequest,
  serializeWorkspacePrivacyAssessment,
  withWorkspacePrivacyTemporaryDirectory,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixture = JSON.parse(
  readFileSync(
    join(repositoryRoot, "test/fixtures/workspace-privacy/request.v0.1.json"),
    "utf8",
  ),
) as Record<string, unknown>;
const jsonSchema = JSON.parse(
  readFileSync(
    join(repositoryRoot, "schema/workspace-privacy.v0.1.schema.json"),
    "utf8",
  ),
) as object;

const cloneFixture = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;

const expectDiagnostic = (
  value: Record<string, unknown>,
  diagnostic: string,
): void => {
  try {
    parseWorkspacePrivacyRequest(value);
    throw new Error(`expected ${diagnostic}`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspacePrivacyValidationError);
    expect((error as WorkspacePrivacyValidationError).diagnostic).toBe(
      diagnostic,
    );
  }
};

describe("workspace privacy and resource boundary contract", () => {
  it("validates the mixed-trust fixture and publishes a deterministic assessment", () => {
    const request = parseWorkspacePrivacyRequest(fixture);
    const validate = new Ajv({ allErrors: true }).compile(jsonSchema);
    expect(validate(request)).toBe(true);
    expect(validate.errors).toBeNull();

    const assessment = assessWorkspacePrivacy(request);
    expect(validate(assessment)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(assessment).toMatchObject({
      status: "accepted",
      trustMode: "isolated-mixed",
      totals: {
        repositories: 2,
        nodes: 7,
        edges: 5,
        bytes: 2100,
        pathCount: 2,
        runtimeMetadataRecords: 2,
      },
      runtimeMetadata: { enabled: true, redacted: true },
    });
    expect(
      serializeWorkspacePrivacyAssessment(
        parseWorkspacePrivacyAssessment(
          JSON.parse(serializeWorkspacePrivacyAssessment(assessment)),
        ),
      ),
    ).toBe(serializeWorkspacePrivacyAssessment(assessment));
  });

  it("rejects malicious manifests, graph bombs, decompression bombs, and every bounded resource", () => {
    const duplicate = cloneFixture();
    const repositories = duplicate.repositories as Record<string, unknown>[];
    repositories[1] = { ...repositories[1], id: "cartograph" };
    expectDiagnostic(duplicate, "invalid-manifest");

    const cases: Array<
      [string, string, (value: Record<string, unknown>) => void]
    > = [
      [
        "nodes",
        "node-limit",
        (value) => {
          const limits = value.limits as Record<string, unknown>;
          limits.maxNodes = 1;
        },
      ],
      [
        "edges",
        "edge-limit",
        (value) => {
          const limits = value.limits as Record<string, unknown>;
          limits.maxEdges = 1;
        },
      ],
      [
        "bytes",
        "byte-limit",
        (value) => {
          const limits = value.limits as Record<string, unknown>;
          limits.maxBytes = 1;
        },
      ],
      [
        "compressed bytes",
        "compressed-byte-limit",
        (value) => {
          const limits = value.limits as Record<string, unknown>;
          limits.maxCompressedBytes = 1;
        },
      ],
      [
        "expanded bytes",
        "expanded-byte-limit",
        (value) => {
          const limits = value.limits as Record<string, unknown>;
          limits.maxExpandedBytes = 1;
        },
      ],
      [
        "decompression ratio",
        "decompression-limit",
        (value) => {
          const limits = value.limits as Record<string, unknown>;
          limits.maxExpansionRatio = 1;
        },
      ],
      [
        "depth",
        "depth-limit",
        (value) => {
          const limits = value.limits as Record<string, unknown>;
          limits.maxDepth = 1;
        },
      ],
      [
        "time",
        "time-limit",
        (value) => {
          const observed = value.observed as Record<string, unknown>;
          observed.wallClockMs = 31_000;
        },
      ],
      [
        "memory",
        "memory-limit",
        (value) => {
          const observed = value.observed as Record<string, unknown>;
          observed.memoryBytes = 2_000_000_000;
        },
      ],
      [
        "cache",
        "cache-limit",
        (value) => {
          const cache = value.cache as Record<string, unknown>;
          cache.bytes = 2_000_000;
        },
      ],
      [
        "report",
        "report-limit",
        (value) => {
          const report = value.report as Record<string, unknown>;
          report.bytes = 2_000_000;
        },
      ],
      [
        "temporary data",
        "temporary-data",
        (value) => {
          const cache = value.cache as Record<string, unknown>;
          cache.temporaryEntries = 1;
        },
      ],
    ];
    for (const [name, diagnostic, mutate] of cases) {
      const value = cloneFixture();
      mutate(value);
      expectDiagnostic(value, diagnostic);
      expect(name).toBeTruthy();
    }

    const graphBomb = cloneFixture();
    const graphRepositories = graphBomb.repositories as Record<
      string,
      unknown
    >[];
    graphRepositories[0] = {
      ...graphRepositories[0],
      snapshot: {
        ...(graphRepositories[0]?.snapshot as Record<string, unknown>),
        nodes: 200_001,
      },
    };
    expectDiagnostic(graphBomb, "node-limit");

    const decompressionBomb = cloneFixture();
    const decompressionRepositories = decompressionBomb.repositories as Record<
      string,
      unknown
    >[];
    decompressionRepositories[0] = {
      ...decompressionRepositories[0],
      snapshot: {
        ...(decompressionRepositories[0]?.snapshot as Record<string, unknown>),
        compressedBytes: 1,
        expandedBytes: 50_000,
      },
    };
    (decompressionBomb.limits as Record<string, unknown>).maxExpansionRatio = 1;
    expectDiagnostic(decompressionBomb, "decompression-limit");
  });

  it("rejects secret metadata, unsafe paths, disabled runtime metadata, and mixed trust without opt-in", () => {
    const secret = cloneFixture();
    const secretRepositories = secret.repositories as Record<string, unknown>[];
    secretRepositories[0] = {
      ...secretRepositories[0],
      metadata: { password: "not-retained" },
    };
    expectDiagnostic(secret, "secret-metadata");

    const exposed = cloneFixture();
    exposed.pathExposure = { mode: "none", maxPaths: 1, maxPathLength: 1024 };
    const exposedRepositories = exposed.repositories as Record<
      string,
      unknown
    >[];
    exposedRepositories[0] = {
      ...exposedRepositories[0],
      paths: ["src/index.ts"],
    };
    expectDiagnostic(exposed, "path-exposure");

    const unsafePath = cloneFixture();
    const unsafeRepositories = unsafePath.repositories as Record<
      string,
      unknown
    >[];
    unsafeRepositories[0] = {
      ...unsafeRepositories[0],
      paths: ["../outside"],
    };
    expectDiagnostic(unsafePath, "invalid-manifest");

    const runtime = cloneFixture();
    runtime.runtimeMetadata = {
      enabled: false,
      records: [{ key: "platform", value: "darwin" }],
    };
    expectDiagnostic(runtime, "runtime-metadata");

    const mixed = cloneFixture();
    mixed.allowMixedTrust = false;
    expectDiagnostic(mixed, "mixed-trust");
  });

  it("isolates partial failures and does not turn them into a complete assessment", () => {
    const partial = cloneFixture();
    const repositories = partial.repositories as Record<string, unknown>[];
    repositories.push({
      id: "unavailable",
      trust: "untrusted",
      status: "failed",
      metadata: {},
      paths: [],
      pathDigests: [],
      failureCode: "unavailable",
    });
    partial.allowPartial = true;
    const assessment = assessWorkspacePrivacy(partial);
    expect(assessment.status).toBe("partial");
    expect(assessment.diagnostics).toEqual([
      expect.objectContaining({
        code: "partial-failure",
        scope: "unavailable",
      }),
    ]);

    const rejected = cloneFixture();
    const rejectedRepositories = rejected.repositories as Record<
      string,
      unknown
    >[];
    rejectedRepositories.push(repositories[2] as Record<string, unknown>);
    expectDiagnostic(rejected, "partial-failure");
  });

  it("rejects symlink escapes and cleans temporary data on success and failure", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "cartograph-workspace-privacy-path-"),
    );
    const outside = await mkdtemp(
      join(tmpdir(), "cartograph-workspace-privacy-outside-"),
    );
    try {
      await writeFile(join(outside, "secret.txt"), "sensitive", "utf8");
      await symlink(outside, join(root, "linked"));
      expect(() => assertWorkspacePrivacyPath(root, "../outside")).toThrow(
        WorkspacePrivacyValidationError,
      );
      expect(() =>
        assertWorkspacePrivacyPath(root, "linked/secret.txt"),
      ).toThrow(WorkspacePrivacyValidationError);
      await mkdir(join(root, "safe"));
      expect(assertWorkspacePrivacyPath(root, "safe/file.json")).toBe(
        join(await realpath(root), "safe/file.json"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }

    let successfulDirectory = "";
    await withWorkspacePrivacyTemporaryDirectory(async (directory) => {
      successfulDirectory = directory;
      await writeFile(join(directory, "work.json"), "{}", "utf8");
    });
    await expect(access(successfulDirectory)).rejects.toThrow();

    let failedDirectory = "";
    await expect(
      withWorkspacePrivacyTemporaryDirectory((directory) => {
        failedDirectory = directory;
        throw new Error("partial failure");
      }),
    ).rejects.toThrow("partial failure");
    await expect(access(failedDirectory)).rejects.toThrow();
  });

  it("enforces wall-clock, memory, and cancellation budgets", () => {
    let now = 100;
    const budget = createWorkspacePrivacyBudget(
      parseWorkspacePrivacyRequest(fixture).limits,
      {
        clock: () => now,
        memoryBytes: () => 2_000_000_000,
      },
    );
    now += 31_000;
    expect(() => budget.check()).toThrowError(/wall-clock ceiling/u);

    const controller = new AbortController();
    controller.abort();
    const cancelled = createWorkspacePrivacyBudget(
      parseWorkspacePrivacyRequest(fixture).limits,
      { signal: controller.signal },
    );
    expect(() => cancelled.check()).toThrowError(/cancelled/u);
  });
});
