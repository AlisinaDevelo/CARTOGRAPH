import { createHash } from "node:crypto";

import {
  diffGraphSnapshots,
  parseGraphDiff,
  serializeGraphDiff,
} from "./diff.js";
import {
  PolicyEvaluationSchema,
  evaluatePolicyOnDiff,
  evaluatePolicyOnSnapshot,
  serializePolicyEvaluation,
} from "./policy-evaluation.js";
import { parseGraphSnapshot } from "./canonical.js";
import type { AssuranceBundleRole } from "./assurance-bundle.js";

export const BUNDLE_REPLAY_SCHEMA_VERSION = 1 as const;
export const BUNDLE_REPLAY_CONTRACT = "cartograph.bundle-replay" as const;

export type ReplayCheck = {
  role: AssuranceBundleRole;
  /** What the check regenerated it from. */
  inputs: AssuranceBundleRole[];
  status: "reproduced" | "differs" | "not-replayable" | "failed";
  reason?: string;
  bundledSha256?: string;
  regeneratedSha256?: string;
};

export type ReplayArtifacts = Partial<
  Record<AssuranceBundleRole, readonly unknown[]>
>;

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const single = (
  artifacts: ReplayArtifacts,
  role: AssuranceBundleRole,
): unknown => (artifacts[role]?.length === 1 ? artifacts[role][0] : undefined);

const compareCanonical = (
  role: AssuranceBundleRole,
  inputs: AssuranceBundleRole[],
  bundled: string,
  regenerate: () => string,
): ReplayCheck => {
  let regenerated: string;
  try {
    regenerated = regenerate();
  } catch (error) {
    return {
      role,
      inputs,
      status: "failed",
      reason: `regeneration failed: ${error instanceof Error ? (error.message.split("\n")[0] ?? "error") : "error"}`,
    };
  }
  const bundledSha256 = sha256(bundled);
  const regeneratedSha256 = sha256(regenerated);
  return {
    role,
    inputs,
    status: bundledSha256 === regeneratedSha256 ? "reproduced" : "differs",
    bundledSha256,
    regeneratedSha256,
  };
};

/**
 * Regenerate every derived artifact a bundle declares from the bundle's own
 * inputs and compare canonical bytes: the diff from its two snapshots, and
 * each policy evaluation from its policy, its declared input, its recorded
 * `asOf` and exception window, and the bundled decisions. Nothing outside the
 * bundle is read. A derived artifact without its inputs is reported as
 * not replayable rather than passed.
 */
export const replayBundleArtifacts = (
  artifacts: ReplayArtifacts,
): ReplayCheck[] => {
  const checks: ReplayCheck[] = [];

  for (const diff of artifacts.diff ?? []) {
    const base = single(artifacts, "snapshot-base");
    const head = single(artifacts, "snapshot-head");
    const inputs: AssuranceBundleRole[] = ["snapshot-base", "snapshot-head"];
    if (base === undefined || head === undefined) {
      checks.push({
        role: "diff",
        inputs,
        status: "not-replayable",
        reason:
          "the bundle needs exactly one snapshot-base and one snapshot-head",
      });
      continue;
    }
    checks.push(
      compareCanonical(
        "diff",
        inputs,
        serializeGraphDiff(parseGraphDiff(diff)),
        () =>
          serializeGraphDiff(
            diffGraphSnapshots(
              parseGraphSnapshot(base),
              parseGraphSnapshot(head),
            ),
          ),
      ),
    );
  }

  for (const value of artifacts["policy-evaluation"] ?? []) {
    const evaluation = PolicyEvaluationSchema.parse(value);
    const policy = (artifacts.policy ?? []).find(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as { policyId?: unknown }).policyId === evaluation.policyId,
    );
    const inputRole: AssuranceBundleRole =
      evaluation.inputKind === "diff" ? "diff" : "snapshot-head";
    const input = single(artifacts, inputRole);
    const decisions = single(artifacts, "decisions");
    const inputs: AssuranceBundleRole[] = [
      "policy",
      inputRole,
      ...(decisions === undefined ? [] : (["decisions"] as const)),
    ];
    if (policy === undefined || input === undefined) {
      checks.push({
        role: "policy-evaluation",
        inputs,
        status: "not-replayable",
        reason:
          policy === undefined
            ? `the bundle has no policy ${evaluation.policyId}`
            : `the bundle needs exactly one ${inputRole}`,
      });
      continue;
    }
    const options = {
      ...(evaluation.asOf === undefined ? {} : { asOf: evaluation.asOf }),
      ...(evaluation.exceptionWindowDays === undefined
        ? {}
        : { expiringWithinDays: evaluation.exceptionWindowDays }),
      ...(decisions === undefined ? {} : { adr: { document: decisions } }),
    };
    checks.push(
      compareCanonical(
        "policy-evaluation",
        inputs,
        serializePolicyEvaluation(evaluation),
        () =>
          serializePolicyEvaluation(
            evaluation.inputKind === "diff"
              ? evaluatePolicyOnDiff(policy, input, options)
              : evaluatePolicyOnSnapshot(policy, input, options),
          ),
      ),
    );
  }
  return checks;
};
