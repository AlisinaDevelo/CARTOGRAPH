import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  redactRuntimeTrace,
  RuntimeTraceRetentionStore,
  RuntimeTraceSafetyError,
  RuntimeTraceSafetyPolicySchema,
  RuntimeTraceSchema,
  serializeRuntimeTrace,
  serializeRuntimeTraceSafetyPolicy,
} from "../../src/core/index.js";
import { reconcileRuntimeTrace } from "../../src/core/runtime-reconciliation.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const readJson = (relativePath: string): unknown =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const schema = readJson(
  "schema/runtime-trace-safety.v0.1.schema.json",
) as object;
const sample = readJson("schema/runtime-trace-safety.v0.1.json");
const runtimeSample = readJson("schema/runtime-traces.v0.1.json");
const reconciliationFixture = readJson(
  "schema/runtime-reconciliation-fixture.v0.1.json",
);

describe("runtime trace safety policy", () => {
  it("validates the policy and redacts every retained free-text field", () => {
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(validate(sample)).toBe(true);
    expect(validate.errors).toBeNull();

    const policy = RuntimeTraceSafetyPolicySchema.parse(sample);
    const secret = "TOP-SECRET-BEARER-VALUE";
    const parsedRuntimeSample = RuntimeTraceSchema.parse(runtimeSample);
    const trace = RuntimeTraceSchema.parse({
      ...parsedRuntimeSample,
      spans: [
        {
          ...parsedRuntimeSample.spans[0]!,
          name: `GET /accounts?token=${secret}`,
          serviceName: `service-${secret}`,
          scopeName: `scope-${secret}`,
          scopeVersion: `version-${secret}`,
        },
      ],
    });
    const redacted = redactRuntimeTrace(trace, policy.redaction);
    const serialized = serializeRuntimeTrace(redacted);
    expect(serialized).not.toContain(secret);
    expect(redacted.spans[0]).toMatchObject({
      name: "[REDACTED]",
      serviceName: "[REDACTED]",
      scopeName: "[REDACTED]",
      scopeVersion: "[REDACTED]",
    });
    expect(serializeRuntimeTrace(redacted)).toBe(
      serializeRuntimeTrace(JSON.parse(serialized)),
    );
    expect(serializeRuntimeTraceSafetyPolicy(policy)).toBe(
      serializeRuntimeTraceSafetyPolicy(
        JSON.parse(serializeRuntimeTraceSafetyPolicy(policy)),
      ),
    );
  });

  it("bounds memory retention, TTL, eviction, and discard-after-read", () => {
    const policy = RuntimeTraceSafetyPolicySchema.parse(sample);
    const trace = RuntimeTraceSchema.parse(runtimeSample);
    let now = 0;
    const store = new RuntimeTraceRetentionStore(policy, () => now);

    store.put("read-once", trace, now);
    expect(store.size).toBe(1);
    expect(store.bytes).toBeGreaterThan(0);
    expect(store.get("read-once", now)).toBeDefined();
    expect(store.get("read-once", now)).toBeUndefined();

    store.put("expires", trace, now);
    now = policy.retention.ttlMs;
    expect(store.get("expires", now)).toBeUndefined();
    expect(store.size).toBe(0);

    const boundedPolicy = {
      ...policy,
      retention: {
        ...policy.retention,
        mode: "memory-only" as const,
        maxTraces: 1,
      },
    };
    const bounded = new RuntimeTraceRetentionStore(boundedPolicy, () => now);
    bounded.put("oldest", trace, now);
    bounded.put("newest", trace, now + 1);
    expect(bounded.size).toBe(1);
    expect(bounded.get("oldest", now + 1)).toBeUndefined();
    expect(bounded.get("newest", now + 1)).toBeDefined();
  });

  it("fails closed on unsafe policy, IDs, and byte limits", () => {
    const policy = RuntimeTraceSafetyPolicySchema.parse(sample);
    const trace = RuntimeTraceSchema.parse(runtimeSample);
    expect(() =>
      new RuntimeTraceRetentionStore(
        {
          ...policy,
          retention: { ...policy.retention, maxBytes: 1 },
        },
        () => 0,
      ).put("too-large", trace, 0),
    ).toThrow(RuntimeTraceSafetyError);
    expect(() =>
      new RuntimeTraceRetentionStore(policy).get("../outside"),
    ).toThrow(/non-path retention identifier/u);
    expect(() => new RuntimeTraceRetentionStore(policy).get("")).toThrow(
      />=1 characters/u,
    );
    expect(() =>
      RuntimeTraceSafetyPolicySchema.parse({
        ...policy,
        redaction: { fields: [], replacement: "[REDACTED]" },
      }),
    ).toThrow();
  });

  it("keeps sensitive values out of reconciliation evidence", () => {
    const secret = "TOP-SECRET-BEARER-VALUE";
    const fixture = clone(reconciliationFixture) as {
      runtimeTrace: Record<string, unknown>;
    };
    const runtimeTrace = fixture.runtimeTrace as {
      spans: Array<Record<string, unknown>>;
    };
    runtimeTrace.spans[0] = {
      ...runtimeTrace.spans[0],
      name: `root-${secret}`,
      serviceName: `service-${secret}`,
    };
    const reconciliation = reconcileRuntimeTrace(fixture);
    expect(JSON.stringify(reconciliation)).not.toContain(secret);
  });
});
