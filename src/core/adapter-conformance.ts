import { performance } from "node:perf_hooks";

import {
  parseAdapterInput,
  parseAdapterManifest,
  runAdapter,
  serializeAdapterOutput,
  type AdapterInput,
  type AdapterOutput,
  type CartographAdapter,
} from "./adapters.js";
import { reconcileGraphNodeIdentities } from "./identity.js";
import { stableStringify } from "./canonical.js";

export type AdapterConformanceExpectation = {
  readonly minNodes?: number;
  readonly minEdges?: number;
  readonly requiredDiagnosticCodes?: readonly string[];
  readonly unsupportedDiagnosticCodes?: readonly string[];
};

export type AdapterConformanceCase = {
  readonly id: string;
  readonly input: unknown;
  readonly expect?: AdapterConformanceExpectation;
};

export type AdapterConformanceIdentityCase = {
  readonly before: unknown;
  readonly after: unknown;
  readonly expectedMatches?: number;
  readonly maxAdded?: number;
  readonly maxRemoved?: number;
};

export type AdapterConformanceOptions = {
  readonly cases: readonly AdapterConformanceCase[];
  readonly identity?: AdapterConformanceIdentityCase;
  readonly repetitions?: number;
  readonly maxDurationMs?: number;
};

export type AdapterConformanceCaseReport = {
  readonly id: string;
  readonly nodes: number;
  readonly edges: number;
  readonly diagnostics: number;
  readonly diagnosticCodes: readonly string[];
  readonly deterministic: true;
  readonly evidenceComplete: true;
  readonly durationMs: number;
};

export type AdapterConformanceIdentityReport = {
  readonly matches: number;
  readonly ambiguous: number;
  readonly added: number;
  readonly removed: number;
};

export type AdapterConformanceReport = {
  readonly ok: true;
  readonly adapterId: string;
  readonly apiVersion: number;
  readonly cases: readonly AdapterConformanceCaseReport[];
  readonly deterministic: true;
  readonly evidenceComplete: true;
  readonly identity: AdapterConformanceIdentityReport | null;
  readonly performance: {
    readonly repetitions: number;
    readonly maxDurationMs: number;
    readonly maxObservedMs: number;
  };
};

export class AdapterConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterConformanceError";
  }
}

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new AdapterConformanceError(message);
};

const validateEvidenceCompleteness = (output: AdapterOutput): void => {
  const declared = new Map(
    output.evidence.map((evidence) => [evidence.id, evidence]),
  );
  assert(
    declared.size === output.evidence.length,
    "adapter output contains duplicate top-level evidence IDs",
  );

  const references = [
    ...output.graph.edges.flatMap((edge) => edge.evidence),
    ...output.graph.diagnostics.flatMap((diagnostic) => diagnostic.evidence),
    ...output.diagnostics.flatMap((diagnostic) => diagnostic.evidence),
  ];
  const referenced = new Set<string>();
  for (const evidence of references) {
    const canonical = declared.get(evidence.id);
    assert(
      canonical !== undefined,
      `adapter evidence ${evidence.id} is referenced but not declared at the output boundary`,
    );
    assert(
      stableStringify(canonical) === stableStringify(evidence),
      `adapter evidence ${evidence.id} differs between its declaration and reference`,
    );
    referenced.add(evidence.id);
  }
  for (const evidence of output.evidence) {
    assert(
      referenced.has(evidence.id),
      `adapter evidence ${evidence.id} is declared but not attached to a graph record or diagnostic`,
    );
  }
};

const validateDiagnostics = (
  output: AdapterOutput,
  expectation: AdapterConformanceExpectation | undefined,
): string[] => {
  const declared = new Set(
    output.capability.capabilities.flatMap(
      (capability) => capability.diagnosticCodes,
    ),
  );
  const diagnostics = [...output.graph.diagnostics, ...output.diagnostics];
  for (const diagnostic of diagnostics)
    assert(
      declared.has(diagnostic.code),
      `adapter diagnostic ${diagnostic.code} is not declared by a capability`,
    );

  const codes = diagnostics.map((diagnostic) => diagnostic.code);
  for (const code of expectation?.requiredDiagnosticCodes ?? [])
    assert(
      codes.includes(code),
      `adapter case is missing required diagnostic ${code}`,
    );
  for (const code of expectation?.unsupportedDiagnosticCodes ?? []) {
    const matches = diagnostics.filter(
      (diagnostic) => diagnostic.code === code,
    );
    assert(
      matches.length > 0,
      `adapter case is missing unsupported diagnostic ${code}`,
    );
    assert(
      matches.every((diagnostic) => diagnostic.severity !== "info"),
      `unsupported diagnostic ${code} must be warning or error severity`,
    );
  }
  return codes.sort();
};

const validateCaseExpectation = (
  output: AdapterOutput,
  expectation: AdapterConformanceExpectation | undefined,
): void => {
  assert(
    output.graph.nodes.length >= (expectation?.minNodes ?? 0),
    `adapter output has ${output.graph.nodes.length} nodes; expected at least ${expectation?.minNodes ?? 0}`,
  );
  assert(
    output.graph.edges.length >= (expectation?.minEdges ?? 0),
    `adapter output has ${output.graph.edges.length} edges; expected at least ${expectation?.minEdges ?? 0}`,
  );
};

const validateOptions = (
  options: AdapterConformanceOptions,
): {
  repetitions: number;
  maxDurationMs: number;
} => {
  const repetitions = options.repetitions ?? 2;
  const maxDurationMs = options.maxDurationMs ?? 1_000;
  assert(
    options.cases.length > 0,
    "adapter conformance requires at least one case",
  );
  assert(
    Number.isSafeInteger(repetitions) && repetitions >= 2,
    "adapter conformance repetitions must be a safe integer of at least 2",
  );
  assert(
    Number.isFinite(maxDurationMs) && maxDurationMs > 0,
    "adapter conformance maxDurationMs must be positive",
  );
  const ids = new Set<string>();
  for (const testCase of options.cases) {
    assert(
      testCase.id.trim().length > 0,
      "adapter conformance case IDs must not be empty",
    );
    assert(
      !ids.has(testCase.id),
      `duplicate adapter conformance case ID: ${testCase.id}`,
    );
    ids.add(testCase.id);
  }
  return { repetitions, maxDurationMs };
};

const runCase = (
  adapter: CartographAdapter,
  testCase: AdapterConformanceCase,
  repetitions: number,
  maxDurationMs: number,
): AdapterConformanceCaseReport => {
  const parsedInput: AdapterInput = parseAdapterInput(testCase.input);
  let firstOutput: AdapterOutput | undefined;
  let firstSerialized: string | undefined;
  let maxObservedMs = 0;
  for (let index = 0; index < repetitions; index += 1) {
    const started = performance.now();
    const output = runAdapter(adapter, parsedInput);
    const elapsed = performance.now() - started;
    maxObservedMs = Math.max(maxObservedMs, elapsed);
    assert(
      elapsed <= maxDurationMs,
      `adapter case ${testCase.id} exceeded the ${maxDurationMs}ms performance budget (${elapsed.toFixed(2)}ms)`,
    );
    const serialized = serializeAdapterOutput(output);
    if (firstOutput === undefined) {
      firstOutput = output;
      firstSerialized = serialized;
      validateEvidenceCompleteness(output);
      validateCaseExpectation(output, testCase.expect);
    } else {
      assert(
        serialized === firstSerialized,
        `adapter case ${testCase.id} produced nondeterministic output on repetition ${index + 1}`,
      );
    }
  }
  if (firstOutput === undefined || firstSerialized === undefined)
    throw new AdapterConformanceError(
      `adapter case ${testCase.id} did not run`,
    );
  return {
    id: testCase.id,
    nodes: firstOutput.graph.nodes.length,
    edges: firstOutput.graph.edges.length,
    diagnostics:
      firstOutput.graph.diagnostics.length + firstOutput.diagnostics.length,
    diagnosticCodes: validateDiagnostics(firstOutput, testCase.expect),
    deterministic: true,
    evidenceComplete: true,
    durationMs: Number(maxObservedMs.toFixed(3)),
  };
};

export const runAdapterConformance = (
  adapter: CartographAdapter,
  options: AdapterConformanceOptions,
): AdapterConformanceReport => {
  const { repetitions, maxDurationMs } = validateOptions(options);
  const manifest = parseAdapterManifest(adapter.manifest);
  const cases = options.cases.map((testCase) =>
    runCase(adapter, testCase, repetitions, maxDurationMs),
  );

  let identity: AdapterConformanceIdentityReport | null = null;
  if (options.identity !== undefined) {
    const before = runAdapter(adapter, options.identity.before);
    const after = runAdapter(adapter, options.identity.after);
    const reconciliation = reconcileGraphNodeIdentities(
      before.graph,
      after.graph,
    );
    const expectedMatches = options.identity.expectedMatches;
    if (expectedMatches !== undefined)
      assert(
        reconciliation.matches.length === expectedMatches,
        `adapter identity fixture produced ${reconciliation.matches.length} matches; expected ${expectedMatches}`,
      );
    const maxAdded = options.identity.maxAdded;
    if (maxAdded !== undefined)
      assert(
        reconciliation.added.length <= maxAdded,
        `adapter identity fixture produced ${reconciliation.added.length} added nodes; expected at most ${maxAdded}`,
      );
    const maxRemoved = options.identity.maxRemoved;
    if (maxRemoved !== undefined)
      assert(
        reconciliation.removed.length <= maxRemoved,
        `adapter identity fixture produced ${reconciliation.removed.length} removed nodes; expected at most ${maxRemoved}`,
      );
    identity = {
      matches: reconciliation.matches.length,
      ambiguous: reconciliation.ambiguous.length,
      added: reconciliation.added.length,
      removed: reconciliation.removed.length,
    };
  }

  return {
    ok: true,
    adapterId: manifest.id,
    apiVersion: manifest.apiVersion,
    cases,
    deterministic: true,
    evidenceComplete: true,
    identity,
    performance: {
      repetitions,
      maxDurationMs,
      maxObservedMs: Number(
        Math.max(...cases.map((testCase) => testCase.durationMs)).toFixed(3),
      ),
    },
  };
};
