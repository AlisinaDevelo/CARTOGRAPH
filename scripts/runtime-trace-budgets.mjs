#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

import {
  DEFAULT_RUNTIME_TRACE_BUDGET_POLICY,
  importRuntimeTraceWithBudget,
  RuntimeTraceBudgetError,
  RuntimeTraceBudgetResultSchema,
  serializeRuntimeTraceBudgetResult,
} from "../src/core/runtime-trace-budgets.ts";

const repositoryRoot = resolve(process.cwd());
const readJson = (relativePath) =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

const expectError = (operation, code) => {
  try {
    operation();
    throw new Error(`expected ${code} budget error`);
  } catch (error) {
    if (!(error instanceof RuntimeTraceBudgetError) || error.code !== code) {
      throw error;
    }
  }
};

const twoTraceExport = (fixture) => {
  const second = clone(fixture.resourceSpans[0]);
  second.scopeSpans[0].spans[0].traceId = "fedcba9876543210fedcba9876543210";
  second.scopeSpans[0].spans[0].spanId = "fedcba9876543210";
  return { resourceSpans: [fixture.resourceSpans[0], second] };
};

const validate = () => {
  const schema = readJson("schema/runtime-trace-budgets.v0.1.schema.json");
  const sample = readJson("schema/runtime-trace-budgets.v0.1.json");
  const otlp = readJson("schema/runtime-traces-otlp.v0.1.json");
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(sample)) {
    throw new Error(
      `runtime trace budget JSON Schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }
  const parsedSample = RuntimeTraceBudgetResultSchema.parse(sample);
  if (
    parsedSample.coverage.complete !== true ||
    parsedSample.redacted !== true
  ) {
    throw new Error("budget sample did not declare complete redacted coverage");
  }

  const sensitive = clone(otlp);
  const secret = "TOP-SECRET-BUDGET-VALUE";
  sensitive.resourceSpans[0].scopeSpans[0].spans[0].name = `call-${secret}`;
  const serializedInput = JSON.stringify(sensitive);
  const complete = importRuntimeTraceWithBudget(serializedInput);
  if (
    !complete.coverage.complete ||
    complete.coverage.truncated ||
    complete.tempFiles ||
    JSON.stringify(complete).includes(secret)
  ) {
    throw new Error(
      "complete budget import violated redaction or coverage invariants",
    );
  }
  if (
    serializeRuntimeTraceBudgetResult(complete) !==
    serializeRuntimeTraceBudgetResult(
      JSON.parse(serializeRuntimeTraceBudgetResult(complete)),
    )
  ) {
    throw new Error("runtime trace budget result serialization drifted");
  }

  const twoTraces = twoTraceExport(otlp);
  const truncationPolicy = {
    ...DEFAULT_RUNTIME_TRACE_BUDGET_POLICY,
    maxTraces: 1,
    overflow: "truncate-incomplete",
  };
  const truncated = importRuntimeTraceWithBudget(
    JSON.stringify(twoTraces),
    truncationPolicy,
  );
  if (
    truncated.coverage.complete ||
    !truncated.coverage.truncated ||
    truncated.coverage.inputTraces !== 2 ||
    truncated.coverage.retainedTraces !== 1 ||
    truncated.coverage.droppedTraces !== 1 ||
    truncated.diagnostics[0]?.code !== "trace-count-truncated"
  ) {
    throw new Error(
      `truncation was reported unexpectedly: ${JSON.stringify(truncated.coverage)}`,
    );
  }
  const reversed = { resourceSpans: [...twoTraces.resourceSpans].reverse() };
  const reversedResult = importRuntimeTraceWithBudget(
    JSON.stringify(reversed),
    truncationPolicy,
  );
  if (
    serializeRuntimeTraceBudgetResult(truncated) !==
    serializeRuntimeTraceBudgetResult(reversedResult)
  ) {
    throw new Error("trace-count truncation was not deterministic");
  }

  expectError(
    () => importRuntimeTraceWithBudget(serializedInput, { maxInputBytes: 1 }),
    "input-bytes-limit-exceeded",
  );
  expectError(
    () =>
      importRuntimeTraceWithBudget(serializedInput, {
        maxAttributesPerRecord: 0,
      }),
    "attribute-limit-exceeded",
  );
  expectError(
    () =>
      importRuntimeTraceWithBudget(JSON.stringify(twoTraces), { maxTraces: 1 }),
    "trace-count-limit-exceeded",
  );
  expectError(
    () => importRuntimeTraceWithBudget(serializedInput, { maxReportBytes: 1 }),
    "report-size-limit-exceeded",
  );
  let clockCalls = 0;
  expectError(
    () =>
      importRuntimeTraceWithBudget(serializedInput, { maxAnalysisMs: 1 }, () =>
        clockCalls++ === 0 ? 0 : 2,
      ),
    "analysis-time-limit-exceeded",
  );

  return {
    ok: true,
    schemaVersion: parsedSample.schemaVersion,
    completeCoverage: complete.coverage.complete,
    truncatedCoverage: truncated.coverage.truncated,
    inputTraces: truncated.coverage.inputTraces,
    retainedTraces: truncated.coverage.retainedTraces,
    sensitiveValueRetained: false,
    tempFiles: false,
    network: false,
    collector: false,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/runtime-trace-budgets.mjs validate",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`runtime trace budget validation failed: ${error.message}`);
  process.exit(1);
}
