import {
  exportCycloneDx,
  exportSarifLog,
  stableStringify,
  exportScipIndex,
  serializeGraphInterchange,
  serializeSarifLog,
  serializeScipIndex,
  type PolicyEvaluation,
} from "./core/index.js";
import { loadDiff, loadSnapshot, type PolicyInputKind } from "./commands.js";

export const EXPORT_FORMATS = [
  "graph-json",
  "json-ld",
  "edge-list",
  "scip",
  "cyclonedx",
] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const TOOL_NAME = "cartograph";

/** Serialize a snapshot file in one of the portable interchange formats. */
export async function exportSnapshotFile(
  input: string,
  format: ExportFormat,
  toolVersion: string,
): Promise<string> {
  const snapshot = await loadSnapshot(input);
  if (format === "cyclonedx")
    return `${stableStringify(
      exportCycloneDx(snapshot, { toolName: TOOL_NAME, toolVersion }),
    )}\n`;
  const serialized =
    format === "scip"
      ? serializeScipIndex(
          exportScipIndex(snapshot, { toolName: TOOL_NAME, toolVersion }).index,
        )
      : serializeGraphInterchange(
          snapshot,
          format === "graph-json" ? "json" : format,
        );
  return serialized.endsWith("\n") ? serialized : `${serialized}\n`;
}

/**
 * SARIF 2.1.0 log for a policy evaluation. Only line-local violations become
 * results; see docs/SARIF_INTERCHANGE.md for what is omitted and why.
 */
export async function policyEvaluationSarif(
  evaluation: PolicyEvaluation,
  input: string,
  inputKind: PolicyInputKind,
  toolVersion: string,
): Promise<string> {
  const graph =
    inputKind === "snapshot"
      ? { kind: "snapshot" as const, snapshot: await loadSnapshot(input) }
      : { kind: "diff" as const, diff: await loadDiff(input) };
  const log = exportSarifLog(evaluation, graph, {
    toolName: TOOL_NAME,
    toolVersion,
  });
  const serialized = serializeSarifLog(log);
  return serialized.endsWith("\n") ? serialized : `${serialized}\n`;
}
