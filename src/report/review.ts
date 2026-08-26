import { Buffer } from "node:buffer";

import {
  parseReviewSummaryReport,
  serializeReviewSummary,
  type ReviewSummaryFinding,
} from "../core/index.js";
import { ResourceLimitError } from "../resources.js";

export type ReviewSummaryReportFormat = "html" | "json" | "markdown";

export const REVIEW_SUMMARY_REPORT_LIMITS = {
  maxBytes: 16 * 1024 * 1024,
} as const;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const markdownCode = (value: string): string =>
  `\`${value.replace(/[\\`]/gu, (character) => `\\${character}`)}\``;

const shortRevision = (value: string): string => value.slice(0, 12);

const plural = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? "" : "s"}`;

const evidence = (refs: readonly string[]): string =>
  refs.length === 0 ? "none" : refs.map(markdownCode).join(", ");

const ownerText = (finding: ReviewSummaryFinding): string => {
  const owner = finding.owner;
  const refs =
    owner.refs.length === 0 ? "none" : owner.refs.map(markdownCode).join(", ");
  const source =
    owner.source === undefined
      ? ""
      : `; source ${markdownCode(owner.source.id)} ${markdownCode(owner.source.path)} rule ${markdownCode(owner.source.ruleId)} (${markdownCode(owner.source.matchedPath)})`;
  return `${markdownCode(owner.status)}; refs: ${refs}${source}`;
};

const waiverText = (finding: ReviewSummaryFinding): string => {
  const waiver = finding.waiver;
  const id = waiver.id === undefined ? "" : ` ${markdownCode(waiver.id)}`;
  const expiry =
    waiver.expiresAt === undefined
      ? ""
      : `; expires ${markdownCode(waiver.expiresAt)} (${markdownCode(waiver.expiryState)})`;
  return `${markdownCode(waiver.status)}${id} code ${markdownCode(waiver.code)}${expiry}`;
};

const policyText = (finding: ReviewSummaryFinding): string => {
  if (finding.policy === undefined) return "not provided";
  const policy = finding.policy;
  return `${markdownCode(policy.policyId)}@${markdownCode(policy.policyVersion)} ${markdownCode(policy.mode)} ${markdownCode(policy.status)}${policy.ruleId === undefined ? "" : `; rule ${markdownCode(policy.ruleId)}`}${policy.violationId === undefined ? "" : `; violation ${markdownCode(policy.violationId)}`}`;
};

const findingMarkdown = (finding: ReviewSummaryFinding): string[] => {
  const lines = [
    `### ${markdownCode(finding.id)} — ${finding.title}`,
    "",
    `- Severity: ${markdownCode(finding.severity)}; kind: ${markdownCode(finding.kind)}; change: ${markdownCode(finding.change)}`,
    `- Lifecycle: ${finding.lifecycleState === undefined ? "not provided" : markdownCode(finding.lifecycleState)}`,
    `- Owner: ${ownerText(finding)}`,
    `- Waiver: ${waiverText(finding)}`,
    `- Policy: ${policyText(finding)}`,
    `- ADR references: ${finding.adrIds.length === 0 ? "none" : finding.adrIds.map(markdownCode).join(", ")}`,
    `- Drift codes: ${finding.driftCodes.length === 0 ? "none" : finding.driftCodes.map(markdownCode).join(", ")}`,
    `- Evidence: ${evidence(finding.evidenceRefs)}`,
  ];
  if (finding.nextStepIds.length > 0)
    lines.push(
      `- Next steps: ${finding.nextStepIds.map(markdownCode).join(", ")}`,
    );
  return lines;
};

const assertOutputLimit = (output: string): void => {
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes > REVIEW_SUMMARY_REPORT_LIMITS.maxBytes)
    throw new ResourceLimitError(
      `review summary report exceeds the ${REVIEW_SUMMARY_REPORT_LIMITS.maxBytes} byte output limit`,
    );
};

export function renderReviewSummaryMarkdown(value: unknown): string {
  const report = parseReviewSummaryReport(value);
  const comparison = report.comparison;
  const lines = [
    "# CARTOGRAPH review summary",
    "",
    `Status: ${markdownCode(report.status)}; from ${markdownCode(shortRevision(report.fromRevision.commitSha))} to ${markdownCode(shortRevision(report.toRevision.commitSha))}.`,
    ...(comparison === undefined
      ? []
      : [
          `Comparison: ${markdownCode(comparison.mode)}; base ${markdownCode(comparison.baseRef)} (${markdownCode(shortRevision(comparison.baseCommitSha))}) → head ${markdownCode(comparison.headRef)} (${markdownCode(shortRevision(comparison.headCommitSha))})${comparison.mergeBaseSha === undefined ? "" : `; merge base ${markdownCode(shortRevision(comparison.mergeBaseSha))}`}.`,
        ]),
    "",
    "## Summary",
    "",
    `- ${plural(report.summary.findings, "finding")}: ${report.summary.new} new, ${report.summary.changed} changed, ${report.summary.accepted} accepted, ${report.summary.removed} removed, ${report.summary.unchanged} unchanged`,
    `- Owners: ${report.summary.ownerless} ownerless; ${report.summary.ambiguousOwners} ambiguous or unavailable`,
    `- Waivers: ${report.summary.waiverActive} active; ${report.summary.waiverExpiring} expiring; ${report.summary.waiverExpired} expired; ${report.summary.waiverInvalid} invalid`,
    `- Policy: ${report.summary.policyViolations} violations; ${report.summary.policyUnsupported} unsupported`,
    `- ADR: ${report.summary.adrStale} stale references; ${report.summary.evidenceRefs} evidence references`,
    `- Actionable next steps: ${report.summary.actionable}`,
  ];

  if (report.findings.length > 0) {
    lines.push("", "## Findings", "");
    for (const finding of report.findings)
      lines.push(...findingMarkdown(finding), "");
  }

  lines.push("## Next steps", "");
  if (report.nextSteps.length === 0) lines.push("No next steps.");
  else
    lines.push(
      ...report.nextSteps.map(
        (step) =>
          `- ${markdownCode(step.id)} — ${step.title}: ${step.action} (${markdownCode(step.severity)}; mutates: ${markdownCode(String(step.mutates))}; evidence: ${evidence(step.evidenceRefs)})`,
      ),
    );

  lines.push(
    "",
    "## Context",
    "",
    `- Policy: ${report.context.policy.available ? "available" : "not provided"}; ${report.context.policy.violations} violations; ${report.context.policy.unsupported} unsupported; ${report.context.policy.exceptions} exceptions`,
    `- Lifecycle: ${report.context.lifecycle.available ? "available" : "not provided"}; ${report.context.lifecycle.findings} findings; ${report.context.lifecycle.events} events; ${report.context.lifecycle.diagnostics} diagnostics`,
    `- Ownership: ${report.context.ownership.available ? "available" : "not provided"}; ${report.context.ownership.targets} targets; ${report.context.ownership.resolved} resolved; ${report.context.ownership.unowned} unowned; ${report.context.ownership.ambiguous} ambiguous`,
    `- Waivers: ${report.context.waivers.available ? "available" : "not provided"}; ${report.context.waivers.total} total; ${report.context.waivers.driftDiagnostics} drift diagnostics`,
    `- ADR: ${report.context.adr.available ? `${report.context.adr.references.length} references` : "not provided"}`,
  );
  if (report.artifacts.length > 0) {
    lines.push("", "## Local artifacts", "");
    lines.push(
      ...report.artifacts.map(
        (artifact) =>
          `- ${markdownCode(artifact.id)} — ${artifact.label} (${markdownCode(artifact.kind)}): ${markdownCode(artifact.path)}`,
      ),
    );
  }
  lines.push(
    "",
    "## Contract",
    "",
    `- ${markdownCode(report.contract)} media type ${markdownCode(report.mediaType)}; deterministic: ${markdownCode(String(report.provenance.deterministic))}; read-only: ${markdownCode(String(report.provenance.readOnly))}; network: ${markdownCode(String(report.provenance.network))}; authority granted: ${markdownCode(String(report.provenance.authorityGranted))}; automatic actions: ${markdownCode(String(report.provenance.automaticActions))}`,
    "",
  );
  const output = `${lines.join("\n")}\n`;
  assertOutputLimit(output);
  return output;
}

const htmlList = (items: readonly string[]): string =>
  items.length === 0
    ? '<p class="empty">None</p>'
    : `<ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;

const htmlOwner = (finding: ReviewSummaryFinding): string => {
  const owner = finding.owner;
  const refs =
    owner.refs.length === 0 ? "none" : owner.refs.map(escapeHtml).join(", ");
  const source =
    owner.source === undefined
      ? ""
      : `; source <code>${escapeHtml(owner.source.id)}</code> <code>${escapeHtml(owner.source.path)}</code> rule <code>${escapeHtml(owner.source.ruleId)}</code> (${escapeHtml(owner.source.matchedPath)})`;
  return `<code>${escapeHtml(owner.status)}</code>; refs: ${refs}${source}`;
};

const htmlFinding = (finding: ReviewSummaryFinding): string => {
  const waiver = finding.waiver;
  const policy = finding.policy;
  return `<article class="finding"><h3><code>${escapeHtml(finding.id)}</code> — ${escapeHtml(finding.title)}</h3><p><strong>${escapeHtml(finding.severity)}</strong>; kind <code>${escapeHtml(finding.kind)}</code>; change <code>${escapeHtml(finding.change)}</code>; lifecycle <code>${escapeHtml(finding.lifecycleState ?? "not-provided")}</code></p><p>Owner: ${htmlOwner(finding)}</p><p>Waiver: <code>${escapeHtml(waiver.status)}</code> code <code>${escapeHtml(waiver.code)}</code>${waiver.expiresAt === undefined ? "" : `; expires <code>${escapeHtml(waiver.expiresAt)}</code> (${escapeHtml(waiver.expiryState)})`}</p><p>Policy: ${policy === undefined ? "not provided" : `<code>${escapeHtml(policy.policyId)}</code>@<code>${escapeHtml(policy.policyVersion)}</code> <code>${escapeHtml(policy.mode)}</code> <code>${escapeHtml(policy.status)}</code>${policy.ruleId === undefined ? "" : `; rule <code>${escapeHtml(policy.ruleId)}</code>`}`}</p><p>ADR references: ${finding.adrIds.length === 0 ? "none" : finding.adrIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}; drift: ${finding.driftCodes.length === 0 ? "none" : finding.driftCodes.map((code) => `<code>${escapeHtml(code)}</code>`).join(", ")}</p><p>Evidence: ${finding.evidenceRefs.length === 0 ? "none" : finding.evidenceRefs.map((ref) => `<code>${escapeHtml(ref)}</code>`).join(", ")}</p>${finding.nextStepIds.length === 0 ? "" : `<p>Next steps: ${finding.nextStepIds.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}</p>`}</article>`;
};

export function renderReviewSummaryHtml(value: unknown): string {
  const report = parseReviewSummaryReport(value);
  const comparison = report.comparison;
  const artifacts = report.artifacts.map(
    (artifact) =>
      `<li><code>${escapeHtml(artifact.id)}</code> — ${escapeHtml(artifact.label)} (<code>${escapeHtml(artifact.kind)}</code>): <code>${escapeHtml(artifact.path)}</code></li>`,
  );
  const nextSteps = report.nextSteps.map(
    (step) =>
      `<li><code>${escapeHtml(step.id)}</code> — ${escapeHtml(step.title)}: ${escapeHtml(step.action)} (<code>${escapeHtml(step.severity)}</code>; mutates: <code>${String(step.mutates)}</code>; evidence: ${step.evidenceRefs.length === 0 ? "none" : step.evidenceRefs.map((ref) => `<code>${escapeHtml(ref)}</code>`).join(", ")})</li>`,
  );
  const output = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>CARTOGRAPH review summary</title>
  <style>:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; } body { max-width: 72rem; margin: 0 auto; padding: 2rem; line-height: 1.5; } .summary { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit,minmax(14rem,1fr)); } .card, .finding { border: 1px solid #7777; border-radius: .5rem; padding: 1rem; margin: 1rem 0; } code { overflow-wrap: anywhere; } .empty { color: #777; }</style>
</head>
<body>
<main id="report" tabindex="-1">
<h1>CARTOGRAPH review summary</h1>
<p>Status: <code>${escapeHtml(report.status)}</code>; from <code>${escapeHtml(shortRevision(report.fromRevision.commitSha))}</code> to <code>${escapeHtml(shortRevision(report.toRevision.commitSha))}</code>.</p>
${comparison === undefined ? "" : `<p>Comparison: <code>${escapeHtml(comparison.mode)}</code>; base <code>${escapeHtml(comparison.baseRef)}</code> (<code>${escapeHtml(shortRevision(comparison.baseCommitSha))}</code>) → head <code>${escapeHtml(comparison.headRef)}</code> (<code>${escapeHtml(shortRevision(comparison.headCommitSha))}</code>)${comparison.mergeBaseSha === undefined ? "" : `; merge base <code>${escapeHtml(shortRevision(comparison.mergeBaseSha))}</code>`}.</p>`}
<section aria-labelledby="summary-heading"><h2 id="summary-heading">Summary</h2><div class="summary"><div class="card">${report.summary.findings} findings<br>${report.summary.new} new; ${report.summary.changed} changed; ${report.summary.accepted} accepted; ${report.summary.removed} removed</div><div class="card">Owners<br>${report.summary.ownerless} ownerless; ${report.summary.ambiguousOwners} ambiguous or unavailable</div><div class="card">Waivers<br>${report.summary.waiverActive} active; ${report.summary.waiverExpiring} expiring; ${report.summary.waiverExpired} expired; ${report.summary.waiverInvalid} invalid</div><div class="card">Policy<br>${report.summary.policyViolations} violations; ${report.summary.policyUnsupported} unsupported</div><div class="card">Actionable next steps<br>${report.summary.actionable}</div></div></section>
<section aria-labelledby="findings-heading"><h2 id="findings-heading">Findings</h2>${htmlList(report.findings.map(htmlFinding))}</section>
<section aria-labelledby="steps-heading"><h2 id="steps-heading">Next steps</h2>${htmlList(nextSteps)}</section>
<section aria-labelledby="context-heading"><h2 id="context-heading">Context</h2><ul><li>Policy: ${report.context.policy.available ? "available" : "not provided"}; ${report.context.policy.violations} violations; ${report.context.policy.unsupported} unsupported</li><li>Lifecycle: ${report.context.lifecycle.available ? "available" : "not provided"}; ${report.context.lifecycle.findings} findings; ${report.context.lifecycle.events} events</li><li>Ownership: ${report.context.ownership.available ? "available" : "not provided"}; ${report.context.ownership.targets} targets; ${report.context.ownership.resolved} resolved; ${report.context.ownership.unowned} unowned; ${report.context.ownership.ambiguous} ambiguous</li><li>Waivers: ${report.context.waivers.available ? "available" : "not provided"}; ${report.context.waivers.total} total; ${report.context.waivers.driftDiagnostics} drift diagnostics</li><li>ADR: ${report.context.adr.available ? `${report.context.adr.references.length} references` : "not provided"}</li></ul></section>
${artifacts.length === 0 ? "" : `<section aria-labelledby="artifacts-heading"><h2 id="artifacts-heading">Local artifacts</h2><ul>${artifacts.join("")}</ul></section>`}
<section aria-labelledby="contract-heading"><h2 id="contract-heading">Contract</h2><p><code>${escapeHtml(report.contract)}</code> media type <code>${escapeHtml(report.mediaType)}</code>; deterministic <code>${String(report.provenance.deterministic)}</code>; read-only <code>${String(report.provenance.readOnly)}</code>; network <code>${String(report.provenance.network)}</code>; authority granted <code>${String(report.provenance.authorityGranted)}</code>; automatic actions <code>${String(report.provenance.automaticActions)}</code>.</p></section>
</main>
</body>
</html>
`;
  assertOutputLimit(output);
  return output;
}

export function renderReviewSummary(
  value: unknown,
  format: ReviewSummaryReportFormat,
): string {
  const report = parseReviewSummaryReport(value);
  switch (format) {
    case "json": {
      const output = `${serializeReviewSummary(report)}\n`;
      assertOutputLimit(output);
      return output;
    }
    case "html":
      return renderReviewSummaryHtml(report);
    case "markdown":
      return renderReviewSummaryMarkdown(report);
  }
}
