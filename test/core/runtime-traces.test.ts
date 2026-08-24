import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseRuntimeTrace,
  parseRuntimeTraceJson,
  RUNTIME_TRACE_SCHEMA_VERSION,
  RuntimeTraceSchema,
  RuntimeTraceValidationError,
  serializeRuntimeTrace,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const schema = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/runtime-traces.v0.1.schema.json"),
    "utf8",
  ),
) as object;
const sample = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/runtime-traces.v0.1.json"),
    "utf8",
  ),
) as unknown;
const otlp = JSON.parse(
  readFileSync(
    resolve(repositoryRoot, "schema/runtime-traces-otlp.v0.1.json"),
    "utf8",
  ),
) as Record<string, unknown>;

const span = (overrides: Record<string, unknown> = {}) => ({
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  name: "GET /health",
  kind: 2,
  startTimeUnixNano: "100",
  endTimeUnixNano: "200",
  attributes: [],
  status: { code: 1 },
  ...overrides,
});

const exportWithSpans = (...spans: unknown[]) => ({
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "fixture-service" } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "fixture-scope", version: "1.0.0", attributes: [] },
          spans,
        },
      ],
    },
  ],
});

describe("local runtime trace import", () => {
  it("validates the normalized schema and parses the OTLP JSON fixture", () => {
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(sample)).toBe(true);
    expect(validate.errors).toBeNull();

    const normalized = parseRuntimeTrace(otlp);
    expect(normalized.schemaVersion).toBe(RUNTIME_TRACE_SCHEMA_VERSION);
    expect(normalized.format).toBe("otlp-json");
    expect(normalized.spans).toMatchObject([
      {
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        name: "GET /health",
        kind: "server",
        serviceName: "sample-service",
        status: "ok",
      },
    ]);
    expect(normalized.summary.discardedAttributes).toBe(5);
    expect(serializeRuntimeTrace(normalized)).not.toContain("discard-me");
    expect(RuntimeTraceSchema.parse(sample)).toEqual(sample);
  });

  it("sorts spans deterministically and canonicalizes identifiers and timestamps", () => {
    const normalized = parseRuntimeTrace(
      exportWithSpans(
        span({
          spanId: "fedcba9876543210",
          startTimeUnixNano: "0000000300",
          endTimeUnixNano: "0000000400",
          kind: "SPAN_KIND_CLIENT",
        }),
        span({
          traceId: "ABCDEF0123456789ABCDEF0123456789",
          spanId: "0011223344556677",
          startTimeUnixNano: 100,
          endTimeUnixNano: 200,
          kind: "SPAN_KIND_INTERNAL",
        }),
      ),
    );

    expect(normalized.spans.map((item) => item.traceId)).toEqual([
      "0123456789abcdef0123456789abcdef",
      "abcdef0123456789abcdef0123456789",
    ]);
    expect(normalized.spans[0]).toMatchObject({
      startTimeUnixNano: "300",
      endTimeUnixNano: "400",
      kind: "client",
    });
    expect(normalized.spans[1]).toMatchObject({
      startTimeUnixNano: "100",
      endTimeUnixNano: "200",
      kind: "internal",
    });
    expect(serializeRuntimeTrace(normalized)).toBe(
      serializeRuntimeTrace(JSON.parse(serializeRuntimeTrace(normalized))),
    );
  });

  it("fails safely on malformed JSON, invalid time ranges, and duplicate spans", () => {
    expect(() => parseRuntimeTraceJson("not-json")).toThrow(
      RuntimeTraceValidationError,
    );
    expect(() => parseRuntimeTraceJson("not-json")).toThrow(/not valid JSON/u);

    expect(() =>
      parseRuntimeTrace(exportWithSpans(span({ endTimeUnixNano: "99" }))),
    ).toThrow(/greater than or equal/u);
    expect(() => parseRuntimeTrace(exportWithSpans(span(), span()))).toThrow(
      /duplicate span identity/u,
    );
  });

  it("enforces byte, span, and per-record attribute budgets", () => {
    expect(() =>
      parseRuntimeTraceJson(JSON.stringify(exportWithSpans(span())), {
        maxBytes: 1,
      }),
    ).toThrow(/maxBytes/u);
    expect(() =>
      parseRuntimeTrace(exportWithSpans(span()), { maxSpans: 0 }),
    ).toThrow(RuntimeTraceValidationError);
    expect(() =>
      parseRuntimeTrace(
        exportWithSpans(
          span({
            attributes: [
              { key: "one", value: { stringValue: "1" } },
              { key: "two", value: { stringValue: "2" } },
            ],
          }),
        ),
        { maxAttributesPerRecord: 1 },
      ),
    ).toThrow(/maxAttributesPerRecord/u);
  });

  it("does not accept a non-OTLP root or arbitrary executable values", () => {
    expect(() => parseRuntimeTrace({ spans: [] })).toThrow(
      RuntimeTraceValidationError,
    );
    expect(() =>
      parseRuntimeTrace(
        exportWithSpans(
          span({
            attributes: [{ key: "execute", value: { stringValue: "node" } }],
          }),
        ),
      ),
    ).not.toThrow();
    expect(
      serializeRuntimeTrace(parseRuntimeTrace(exportWithSpans(span()))),
    ).not.toContain("execute");
  });
});
