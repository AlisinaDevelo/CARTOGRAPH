import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  importRuntimeTraceWithBudget,
  RuntimeTraceBudgetError,
  RuntimeTraceBudgetResultSchema,
  serializeRuntimeTraceBudgetResult,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const readJson = (relativePath: string): unknown =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const schema = readJson(
  "schema/runtime-trace-budgets.v0.1.schema.json",
) as object;
const sample = readJson("schema/runtime-trace-budgets.v0.1.json");
const otlp = readJson("schema/runtime-traces-otlp.v0.1.json") as {
  resourceSpans: Array<Record<string, unknown>>;
};

const twoTraceExport = () => {
  const fixture = clone(otlp);
  const firstResource = fixture.resourceSpans[0]!;
  const secondResource = clone(firstResource);
  const secondScopes = secondResource.scopeSpans as Array<
    Record<string, unknown>
  >;
  const secondSpans = secondScopes[0]!.spans as Array<Record<string, unknown>>;
  secondSpans[0]!.traceId = "fedcba9876543210fedcba9876543210";
  secondSpans[0]!.spanId = "fedcba9876543210";
  fixture.resourceSpans.push(secondResource);
  return fixture;
};

const expectCode = (operation: () => unknown, code: string): void => {
  try {
    operation();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeTraceBudgetError);
    expect((error as RuntimeTraceBudgetError).code).toBe(code);
  }
};

describe("runtime trace budgets", () => {
  it("validates the result schema, redacts input, and reports complete coverage", () => {
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(sample)).toBe(true);
    expect(validate.errors).toBeNull();
    const parsedSample = RuntimeTraceBudgetResultSchema.parse(sample);
    expect(parsedSample.coverage.complete).toBe(true);

    const secret = "TOP-SECRET-BUDGET-VALUE";
    const sensitive = clone(otlp);
    const firstResource = sensitive.resourceSpans[0]!;
    const scopes = firstResource.scopeSpans as Array<Record<string, unknown>>;
    const spans = scopes[0]!.spans as Array<Record<string, unknown>>;
    spans[0]!.name = `call-${secret}`;
    const result = importRuntimeTraceWithBudget(JSON.stringify(sensitive));
    expect(result.coverage).toMatchObject({
      complete: true,
      truncated: false,
      inputTraces: 1,
      retainedTraces: 1,
      droppedTraces: 0,
    });
    expect(result.redacted).toBe(true);
    expect(result.tempFiles).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(serializeRuntimeTraceBudgetResult(result)).toBe(
      serializeRuntimeTraceBudgetResult(
        JSON.parse(serializeRuntimeTraceBudgetResult(result)),
      ),
    );
  });

  it("truncates only explicitly and never reports incomplete coverage as complete", () => {
    const fixture = twoTraceExport();
    const policy = {
      maxTraces: 1,
      overflow: "truncate-incomplete" as const,
    };
    const result = importRuntimeTraceWithBudget(
      JSON.stringify(fixture),
      policy,
    );
    const reversed = importRuntimeTraceWithBudget(
      JSON.stringify({ resourceSpans: [...fixture.resourceSpans].reverse() }),
      policy,
    );
    expect(result.coverage).toMatchObject({
      complete: false,
      truncated: true,
      inputTraces: 2,
      retainedTraces: 1,
      droppedTraces: 1,
      droppedSpans: 1,
    });
    expect(result.diagnostics).toEqual([
      {
        code: "trace-count-truncated",
        message: "retained 1 of 2 traces; coverage is incomplete",
      },
    ]);
    expect(serializeRuntimeTraceBudgetResult(result)).toBe(
      serializeRuntimeTraceBudgetResult(reversed),
    );
  });

  it("fails closed with stable diagnostics for input, cardinality, time, and report limits", () => {
    const input = JSON.stringify(otlp);
    const twoTraces = JSON.stringify(twoTraceExport());
    expectCode(
      () => importRuntimeTraceWithBudget(input, { maxInputBytes: 1 }),
      "input-bytes-limit-exceeded",
    );
    expectCode(
      () =>
        importRuntimeTraceWithBudget(input, {
          maxAttributesPerRecord: 0,
        }),
      "attribute-limit-exceeded",
    );
    expectCode(
      () => importRuntimeTraceWithBudget(twoTraces, { maxSpans: 1 }),
      "span-limit-exceeded",
    );
    expectCode(
      () => importRuntimeTraceWithBudget(twoTraces, { maxTraces: 1 }),
      "trace-count-limit-exceeded",
    );
    expectCode(
      () => importRuntimeTraceWithBudget(input, { maxReportBytes: 1 }),
      "report-size-limit-exceeded",
    );
    let clockCalls = 0;
    expectCode(
      () =>
        importRuntimeTraceWithBudget(input, { maxAnalysisMs: 1 }, () =>
          clockCalls++ === 0 ? 0 : 2,
        ),
      "analysis-time-limit-exceeded",
    );
  });
});
