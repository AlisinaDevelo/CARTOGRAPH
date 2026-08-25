/* global process */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  ADAPTER_API_VERSION,
  ADAPTER_COMPATIBILITY_REGISTRY,
  AdapterValidationError,
  negotiateAdapterCompatibility,
  parseAdapterInput,
  parseAdapterManifest,
  runAdapterConformance,
} from "cartograph-cli";

import adapter from "../adapter.mjs";

const cases = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../fixtures/cases.v0.1.json"),
    "utf8",
  ),
).cases;

const inputFor = (fixture) => ({
  apiVersion: ADAPTER_API_VERSION,
  source: {
    rootDir: process.cwd(),
    include: ["."],
    exclude: [],
    revision: { commitSha: `starter-${fixture}` },
  },
  config: { fixture },
  resources: {
    maxFiles: 128,
    maxFileBytes: 16_384,
    maxSourceBytes: 65_536,
    maxInputBytes: 16_384,
    maxOutputBytes: 2 * 1024 * 1024,
    maxMemoryBytes: 256 * 1024 * 1024,
    maxWallClockMs: 5_000,
  },
});

test("starter passes conformance, diagnostics, and determinism gates", () => {
  const report = runAdapterConformance(adapter, {
    cases: cases.map((entry) => ({
      id: entry.id,
      input: inputFor(entry.fixture),
      expect: entry.expect,
    })),
    repetitions: 2,
    maxDurationMs: 1_000,
  });
  assert.equal(report.adapterId, "cartograph.starter.example");
  assert.equal(report.cases.length, 3);
  assert.equal(report.deterministic, true);
  assert.equal(report.evidenceComplete, true);
  assert.deepEqual(report.cases[2].diagnosticCodes, [
    "UNSUPPORTED_STARTER_CONSTRUCT",
  ]);
});

test("starter negotiates current compatibility and rejects future capabilities", () => {
  const current = negotiateAdapterCompatibility(adapter.manifest, {
    ...ADAPTER_COMPATIBILITY_REGISTRY.current,
    allowExperimental: false,
  });
  assert.equal(current.state, "compatible");
  const rejected = negotiateAdapterCompatibility(adapter.manifest, {
    ...ADAPTER_COMPATIBILITY_REGISTRY.current,
    capabilityRegistryVersion:
      ADAPTER_COMPATIBILITY_REGISTRY.current.capabilityRegistryVersion + 1,
    allowExperimental: false,
  });
  assert.equal(rejected.state, "rejected");
});

test("starter rejects unsafe declarations and executable configuration", () => {
  assert.throws(
    () =>
      parseAdapterManifest({
        ...adapter.manifest,
        execution: { ...adapter.manifest.execution, network: true },
      }),
    AdapterValidationError,
  );
  assert.throws(
    () =>
      parseAdapterInput({ ...inputFor("empty"), config: { command: "node" } }),
    AdapterValidationError,
  );
});
