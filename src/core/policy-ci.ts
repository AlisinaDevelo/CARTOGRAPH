import type { PolicyEvaluation } from "./policy-evaluation.js";

export const POLICY_CI_MODES = ["informational", "enforce"] as const;
export type PolicyCiMode = (typeof POLICY_CI_MODES)[number];

/** Stable process statuses for the policy CI boundary. */
export const POLICY_CI_EXIT_CODES = {
  success: 0,
  toolError: 1,
  findings: 2,
} as const;

export const parsePolicyCiMode = (value: string): PolicyCiMode => {
  if (value === "informational" || value === "enforce") return value;
  throw new Error("policy mode must be informational or enforce");
};

/**
 * Informational checks never block a caller. Enforcing checks reserve code 2
 * for a valid report with findings; malformed policy/input and other tool
 * failures remain the CLI's general code-1 error boundary.
 */
export const policyCiExitCode = (
  mode: PolicyCiMode,
  report: Pick<PolicyEvaluation, "violations" | "unsupported">,
): number =>
  mode === "enforce" &&
  (report.violations.length > 0 || report.unsupported.length > 0)
    ? POLICY_CI_EXIT_CODES.findings
    : POLICY_CI_EXIT_CODES.success;
