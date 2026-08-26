#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createGraphSnapshot, diffGraphSnapshots } from "../src/core/index.ts";
import { renderHtmlReport } from "../src/report/render.ts";

const repositoryRoot = resolve(process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/accessibility/scenario.v0.1.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(
    `cartograph.report-accessibility validation failed: ${message}`,
  );
};
const requireMatch = (value, pattern, label) => {
  if (!pattern.test(value)) fail(`${label} is missing`);
};
const hash = `sha256:${"a".repeat(64)}`;

const buildFixtureDiff = () => {
  const before = createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha: "1".repeat(40), branch: "fixture" },
    nodes: [
      {
        id: "module:src/app.ts",
        stableKey: "module:src/app.ts",
        kind: "module",
        name: "App",
        language: "typescript",
      },
      {
        id: "service:orders",
        stableKey: "service:orders",
        kind: "service",
        name: "Orders",
      },
    ],
    edges: [],
    diagnostics: [],
  });
  const after = createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha: "2".repeat(40), branch: "fixture" },
    nodes: [
      {
        id: "module:src/app.ts",
        stableKey: "module:src/app.ts",
        kind: "module",
        name: "Application",
        language: "typescript",
      },
      {
        id: "service:orders",
        stableKey: "service:orders",
        kind: "service",
        name: "Orders",
      },
      {
        id: "external:payments",
        stableKey: "external:payments",
        kind: "external_service",
        name: "Payments",
      },
    ],
    edges: [
      {
        from: "module:src/app.ts",
        to: "service:orders",
        kind: "calls",
        confidence: "observed",
        evidence: [
          {
            id: "evidence:request",
            kind: "source",
            path: "src/app.ts",
            line: 7,
            reference: "source://fixture/request",
            detector: "typescript@6.0.3",
            contentHash: hash,
          },
        ],
      },
      {
        from: "service:orders",
        to: "external:payments",
        kind: "requests",
        confidence: "inferred",
        evidence: [],
        unresolvedReason: "provider contract is unresolved in this snapshot",
      },
    ],
    diagnostics: [
      {
        id: "diagnostic:provider",
        code: "UNRESOLVED_PROVIDER",
        severity: "warning",
        message: "The payment provider contract is not declared locally.",
        remediation:
          "Review the provider boundary before relying on this edge.",
        nodeId: "external:payments",
        evidence: [
          {
            id: "evidence:provider",
            kind: "user",
            reference: "review://fixture/provider",
          },
        ],
      },
    ],
  });
  return diffGraphSnapshots(before, after);
};

const validate = () => {
  const fixture = readJson(fixturePath);
  if (
    fixture.schemaVersion !== 1 ||
    fixture.contract !== "cartograph.report-accessibility-fixture" ||
    fixture.fixtureId !== "d020-v0.1"
  )
    fail("fixture identity is invalid");
  if (
    fixture.method?.network !== false ||
    fixture.method?.sourceBodiesIncluded !== false ||
    fixture.method?.credentialsUsed !== false ||
    fixture.method?.hiddenTelemetry !== false ||
    fixture.method?.rerunnable !== true
  )
    fail(
      "fixture must remain offline, source-free, credential-free, and rerunnable",
    );

  const diff = buildFixtureDiff();
  const html = renderHtmlReport(diff);
  const requiredFeatures = new Set();
  requireMatch(html, /<table id="summary-table">/u, "semantic summary table");
  requireMatch(
    html,
    /<caption id="summary-table-caption">/u,
    "summary caption",
  );
  requiredFeatures.add("semantic-summary-table");
  requireMatch(
    html,
    /<details[^>]*\bopen\b[^>]*><summary>Show or hide /u,
    "native details",
  );
  requiredFeatures.add("native-details");
  requireMatch(
    html,
    /<nav class="report-navigation"[^>]*>/u,
    "section navigation",
  );
  const navigationMarkup = html.match(
    /<nav class="report-navigation"[\s\S]*?<\/nav>/u,
  )?.[0];
  if (navigationMarkup === undefined) fail("section navigation is missing");
  const navigationTargets = [
    ...navigationMarkup.matchAll(/<a href="(#[^"]+)">/gu),
  ].map((match) => match[1]);
  const expectedNavigationTargets = [
    "#summary-heading",
    "#added-nodes-heading",
    "#removed-nodes-heading",
    "#changed-nodes-heading",
    "#matched-identities-heading",
    "#ambiguous-identities-heading",
    "#unsupported-identities-heading",
    "#added-edges-heading",
    "#removed-edges-heading",
    "#changed-edges-heading",
    "#rewired-edges-heading",
    "#added-diagnostics-heading",
    "#removed-diagnostics-heading",
    "#changed-diagnostics-heading",
    "#evidence-heading",
  ];
  if (
    JSON.stringify(navigationTargets) !==
    JSON.stringify(expectedNavigationTargets)
  )
    fail("section navigation order or coverage drifted");
  if (new Set(navigationTargets).size !== navigationTargets.length)
    fail("section navigation contains duplicate targets");
  for (const target of navigationTargets) {
    if (!html.includes(`id="${target.slice(1)}"`))
      fail(`section navigation target is missing: ${target}`);
  }
  requiredFeatures.add("ordered-internal-navigation");
  requireMatch(
    html,
    /id="report-status"[^>]*role="status"[^>]*aria-live="polite"/u,
    "visible live status",
  );
  requireMatch(
    html,
    /Report status: 1 node added, 0 nodes removed, 1 node changed/u,
    "status summary",
  );
  requiredFeatures.add("visible-live-status");
  requireMatch(html, /:focus-visible/u, "focus-visible styles");
  if (/<[^>]+tabindex="[1-9]\d*"/u.test(html))
    fail("report contains a positive tabindex");
  requiredFeatures.add("focus-visible-styles");
  requireMatch(
    html,
    /@media \(prefers-reduced-motion: reduce\)/u,
    "reduced-motion styles",
  );
  requiredFeatures.add("reduced-motion-styles");

  if (diff.nodes.changed.length !== 1 || !html.includes("Application"))
    fail("manual changed-node review is missing the changed node");
  if (
    diff.diagnostics.added.length !== 1 ||
    !html.includes("UNRESOLVED_PROVIDER") ||
    !html.includes("Review the provider boundary")
  )
    fail("manual diagnostic review is missing the diagnostic or remediation");
  const evidenceLinks = [
    ...html.matchAll(/<a href="#(evidence-[^"]+)">/gu),
  ].map((match) => match[1]);
  if (evidenceLinks.length < 2)
    fail("manual evidence review is missing internal evidence links");
  for (const target of evidenceLinks) {
    if (!html.includes(`id="${target}"`))
      fail(`evidence link target is missing: ${target}`);
  }
  for (const evidenceId of fixture.review.evidenceIds) {
    if (!html.includes(`<code>${evidenceId}</code>`))
      fail(`manual evidence review is missing ${evidenceId}`);
  }
  requiredFeatures.add("internal-evidence-links");

  if (!html.includes("Content-Security-Policy")) fail("CSP is missing");
  if (/<(?:script|img|link)\b/iu.test(html))
    fail("fixture report contains an executable or external element");
  if (/\bhref="(?!#)/u.test(html))
    fail("fixture report contains an external href");
  if (
    fixture.review.requiredFeatures.some(
      (feature) => !requiredFeatures.has(feature),
    )
  )
    fail("fixture required feature is not covered");

  return {
    ok: true,
    contract: fixture.contract,
    schemaVersion: fixture.schemaVersion,
    fixtureId: fixture.fixtureId,
    changedNodes: diff.nodes.changed.length,
    addedDiagnostics: diff.diagnostics.added.length,
    evidenceLinks: evidenceLinks.length,
    navigationLinks: navigationTargets.length,
    requiredFeatures: [...requiredFeatures].sort(),
    network: false,
    sourceBodiesIncluded: false,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/accessibility-fixture.mjs validate",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
