import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import Ajv from "ajv";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const entrypoint = resolve(repositoryRoot, "src/cli.ts");
const baseFixturePath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-fixture.v0.1.json",
);
const reportSchemaPath = resolve(
  repositoryRoot,
  "schema/runtime-reconciliation-report.v0.1.schema.json",
);
const temporaryDirectories: string[] = [];

type ProcessResult = {
  code: number | null;
  stderr: string;
  stdout: string;
};

async function runEntrypoint(args: string[]): Promise<ProcessResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", entrypoint, ...args],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolveResult({
        code,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      }),
    );
  });
}

const rawKind = (kind: string): number =>
  ({
    unspecified: 0,
    internal: 1,
    server: 2,
    client: 3,
    producer: 4,
    consumer: 5,
  })[kind] ?? 0;

const rawStatus = (status: string): number =>
  ({ unset: 0, error: 1, ok: 2 })[status] ?? 0;

async function createInputs(): Promise<{
  root: string;
  snapshot: string;
  trace: string;
  bindings: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "cartograph-runtime-cli-"));
  temporaryDirectories.push(root);
  const base = JSON.parse(await readFile(baseFixturePath, "utf8")) as {
    staticSnapshot: unknown;
    runtimeTrace: {
      spans: Array<Record<string, unknown>>;
    };
    bindings: unknown;
  };
  const secret = "TOP-SECRET-RUNTIME";
  const spans = base.runtimeTrace.spans.map((span) => ({
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId === undefined
      ? {}
      : { parentSpanId: span.parentSpanId }),
    name: `${String(span.name)}-${secret}`,
    kind: rawKind(String(span.kind)),
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    attributes: [
      { key: "service.name", value: { stringValue: `service-${secret}` } },
      { key: "credential", value: { stringValue: secret } },
    ],
    status: { code: rawStatus(String(span.status)) },
  }));
  await Promise.all([
    writeFile(
      join(root, "snapshot.json"),
      JSON.stringify(base.staticSnapshot),
      "utf8",
    ),
    writeFile(
      join(root, "bindings.json"),
      JSON.stringify(base.bindings),
      "utf8",
    ),
    writeFile(
      join(root, "trace.json"),
      JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: `resource-${secret}` },
                },
              ],
            },
            scopeSpans: [{ scope: { name: "local-test" }, spans }],
          },
        ],
      }),
      "utf8",
    ),
  ]);
  return {
    root,
    snapshot: join(root, "snapshot.json"),
    trace: join(root, "trace.json"),
    bindings: join(root, "bindings.json"),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("explicit local runtime reconciliation CLI", () => {
  it("joins only explicit local artifacts, keeps provenance separate, and redacts runtime text", async () => {
    const inputs = await createInputs();
    const result = await runEntrypoint([
      "reconcile-runtime",
      "--snapshot",
      inputs.snapshot,
      "--trace",
      inputs.trace,
      "--bindings",
      inputs.bindings,
      "--max-traces",
      "100000",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("TOP-SECRET-RUNTIME");
    const report = JSON.parse(result.stdout) as {
      localOnly?: boolean;
      static?: { source?: string; digest?: string };
      runtime?: { source?: string; digest?: string; redacted?: boolean };
      bindings?: { source?: string; count?: number };
      uncertainty?: { none?: number; unmapped?: number };
      diagnostics?: Array<{ source?: string; code?: string }>;
      limits?: { bounded?: boolean; observed?: { outputRecords?: number } };
      retention?: {
        mode?: string;
        persisted?: boolean;
        retainedTracesAfterRead?: number;
        maxTraces?: number;
      };
    };
    const validate = new Ajv({ allErrors: true }).compile(
      JSON.parse(await readFile(reportSchemaPath, "utf8")) as object,
    );
    expect(validate(report)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(report).toMatchObject({
      localOnly: true,
      static: { source: "explicit-local-file" },
      runtime: {
        source: "explicit-local-file",
        redacted: true,
      },
      bindings: { source: "explicit-local-file", count: 5 },
      limits: { bounded: true },
      retention: {
        mode: "discard-after-read",
        persisted: false,
        retainedTracesAfterRead: 0,
        maxTraces: 10_000,
      },
    });
    expect(report.static?.digest).not.toBe(report.runtime?.digest);
    expect(report.runtime?.redacted).toBe(true);
    expect(report.uncertainty?.none).toBeGreaterThan(0);
    expect(report.uncertainty?.unmapped).toBeGreaterThan(0);
    expect(
      report.diagnostics?.some((item) => item.source === "reconciliation"),
    ).toBe(true);
    expect(report.limits?.observed?.outputRecords).toBe(4);
  });

  it("fails closed before parsing when the explicit runtime byte budget is exceeded", async () => {
    const inputs = await createInputs();
    const result = await runEntrypoint([
      "reconcile-runtime",
      "--snapshot",
      inputs.snapshot,
      "--trace",
      inputs.trace,
      "--bindings",
      inputs.bindings,
      "--max-input-bytes",
      "1",
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cartograph [resource-limit]");
    expect(result.stderr).not.toContain("TOP-SECRET-RUNTIME");
  });

  it("fails closed when the report cardinality ceiling is below the local result", async () => {
    const inputs = await createInputs();
    const result = await runEntrypoint([
      "reconcile-runtime",
      "--snapshot",
      inputs.snapshot,
      "--trace",
      inputs.trace,
      "--bindings",
      inputs.bindings,
      "--max-report-items",
      "1",
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cartograph [resource-limit]");
  });
});
