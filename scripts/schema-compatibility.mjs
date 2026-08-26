#!/usr/bin/env node
/* global console, process */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());

const readText = (relativePath) =>
  readFileSync(resolve(repositoryRoot, relativePath), "utf8");

const readJson = (relativePath) => JSON.parse(readText(relativePath));

const sourceVersion = (source, constant) => {
  const match = source.match(new RegExp(`${constant}\\s*=\\s*(\\d+)`, "u"));
  return match ? Number(match[1]) : undefined;
};

const requireEqual = (label, actual, expected) => {
  if (actual !== expected) {
    throw new Error(`${label} drift: expected ${expected}, found ${actual}`);
  }
};

const requireReviewed = (label, contract) => {
  if (typeof contract.current === "number") {
    if (!contract.supportedReaders.includes(contract.current)) {
      throw new Error(
        `${label} current version ${contract.current} is not in supportedReaders`,
      );
    }
    if (!contract.reviewedVersions.includes(contract.current)) {
      throw new Error(
        `${label} current version ${contract.current} is not reviewed`,
      );
    }
    return;
  }

  if (contract.reviewed !== true) {
    throw new Error(`${label} unversioned boundary is not reviewed`);
  }
};

const checkHostedVersionChange = () => {
  const baseRef = process.env.GITHUB_BASE_REF;
  if (!process.env.GITHUB_ACTIONS || !baseRef) return;

  const changed = execFileSync(
    "git",
    ["diff", "--name-only", `origin/${baseRef}...HEAD`],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const versionChanged = changed.some(
    (file) =>
      file === "src/core/schemas.ts" ||
      file === "src/core/support.ts" ||
      file === "src/core/capabilities.ts" ||
      file === "src/core/diagnostics.ts" ||
      file === "src/core/policy-bundles.ts" ||
      file === "src/core/policy.ts" ||
      file === "src/core/policy-composition.ts" ||
      file === "src/core/adr.ts" ||
      file === "src/core/adapters.ts" ||
      file === "src/core/adapter-compatibility.ts" ||
      file === "src/core/runtime-traces.ts" ||
      file === "src/core/runtime-reconciliation.ts" ||
      file === "src/core/runtime-trace-safety.ts" ||
      file === "src/core/runtime-trace-budgets.ts" ||
      file === "src/core/policy-evaluation.ts" ||
      file === "src/core/policy-bundle-migrations.ts" ||
      file === "src/core/assurance-signing.ts" ||
      file === "src/core/remediation-suggestions.ts" ||
      file === "src/core/remediation-rules.ts" ||
      file === "src/core/patch-previews.ts" ||
      file === "src/core/remediation-review.ts" ||
      file === "src/core/remediation-evaluation.ts" ||
      file === "src/core/query.ts" ||
      file === "src/core/query-explanation.ts" ||
      file === "src/core/impact-model.ts" ||
      file === "src/core/workspace-composition.ts" ||
      file === "src/report/adr.ts" ||
      file === "schema/graph-snapshot.v0.1.schema.json" ||
      file === "schema/support-matrix.v0.1.schema.json" ||
      file === "schema/graph-diff.v0.1.schema.json" ||
      file === "schema/capability-registry.v0.1.schema.json" ||
      file === "schema/diagnostic-registry.v0.1.schema.json" ||
      file === "schema/policy-bundle.v0.1.schema.json" ||
      file === "schema/policy.v0.1.schema.json" ||
      file === "schema/policy-exception.v0.1.schema.json" ||
      file === "schema/policy-adr-binding.v0.1.schema.json" ||
      file === "schema/policy-composition.v0.1.schema.json" ||
      file === "schema/adr-reference.v0.1.schema.json" ||
      file === "schema/adapter.v0.1.schema.json" ||
      file === "schema/adapter-compatibility.v0.1.schema.json" ||
      file === "schema/runtime-traces.v0.1.schema.json" ||
      file === "schema/runtime-reconciliation.v0.1.schema.json" ||
      file === "schema/runtime-trace-safety.v0.1.schema.json" ||
      file === "schema/runtime-trace-budgets.v0.1.schema.json" ||
      file === "schema/policy-evaluation.v0.1.schema.json" ||
      file === "schema/policy-bundle-migration.v0.1.schema.json" ||
      file === "schema/policy-bundle-revocation.v0.1.schema.json" ||
      file === "schema/assurance-signing.v0.1.schema.json" ||
      file === "schema/assurance-signing-key.v0.1.schema.json" ||
      file === "schema/assurance-signing-keyring.v0.1.schema.json" ||
      file === "schema/assurance-signing-verification.v0.1.schema.json" ||
      file === "schema/remediation-suggestion.v0.1.schema.json" ||
      file === "schema/remediation-suggestion-report.v0.1.schema.json" ||
      file === "schema/remediation-rules.v0.1.schema.json" ||
      file === "schema/patch-preview.v0.1.schema.json" ||
      file === "schema/patch-preview-report.v0.1.schema.json" ||
      file === "schema/remediation-review.v0.1.schema.json" ||
      file === "schema/remediation-evaluation.v0.1.schema.json" ||
      file === "schema/architecture-query.v0.1.schema.json" ||
      file === "schema/architecture-query-result.v0.1.schema.json" ||
      file === "schema/architecture-query-explanation.v0.1.schema.json" ||
      file ===
        "schema/architecture-query-explanation-fixtures.v0.1.schema.json" ||
      file ===
        "schema/architecture-query-explanation-evaluation.v0.1.schema.json" ||
      file === "schema/architecture-impact.v0.1.schema.json" ||
      file === "schema/architecture-impact-fixtures.v0.1.schema.json" ||
      file === "schema/architecture-impact-evaluation.v0.1.schema.json" ||
      file === "schema/adr-coverage.v0.1.schema.json" ||
      file === "schema/workspace-composition.v0.1.schema.json",
  );
  const reviewRecorded = changed.some(
    (file) =>
      file === "schema/compatibility.json" ||
      file === "docs/COMPATIBILITY.md" ||
      file.startsWith("schema/migrations/"),
  );
  if (versionChanged && !reviewRecorded) {
    throw new Error(
      "schema version source changed without a compatibility manifest, policy, or migration review record",
    );
  }
};

const checkCompatibility = () => {
  const policy = readJson("schema/compatibility.json");
  const source = readText("src/core/schemas.ts");
  const supportSource = readText("src/core/support.ts");
  const capabilitySource = readText("src/core/capabilities.ts");
  const diagnosticSource = readText("src/core/diagnostics.ts");
  const policyBundleSource = readText("src/core/policy-bundles.ts");
  const localPolicySource = readText("src/core/policy.ts");
  const policyCompositionSource = readText("src/core/policy-composition.ts");
  const adrReferenceSource = readText("src/core/adr.ts");
  const adrCoverageSource = readText("src/report/adr.ts");
  const adapterSource = readText("src/core/adapters.ts");
  const adapterCompatibilitySource = readText(
    "src/core/adapter-compatibility.ts",
  );
  const runtimeTraceSource = readText("src/core/runtime-traces.ts");
  const runtimeReconciliationSource = readText(
    "src/core/runtime-reconciliation.ts",
  );
  const runtimeTraceSafetySource = readText("src/core/runtime-trace-safety.ts");
  const runtimeTraceBudgetsSource = readText(
    "src/core/runtime-trace-budgets.ts",
  );
  const policyEvaluationSource = readText("src/core/policy-evaluation.ts");
  const policyBundleMigrationSource = readText(
    "src/core/policy-bundle-migrations.ts",
  );
  const assuranceSigningSource = readText("src/core/assurance-signing.ts");
  const remediationSuggestionSource = readText(
    "src/core/remediation-suggestions.ts",
  );
  const remediationRulesSource = readText("src/core/remediation-rules.ts");
  const patchPreviewSource = readText("src/core/patch-previews.ts");
  const remediationReviewSource = readText("src/core/remediation-review.ts");
  const remediationEvaluationSource = readText(
    "src/core/remediation-evaluation.ts",
  );
  const querySource = readText("src/core/query.ts");
  const queryExplanationSource = readText("src/core/query-explanation.ts");
  const impactSource = readText("src/core/impact-model.ts");
  const workspaceCompositionSource = readText(
    "src/core/workspace-composition.ts",
  );
  const snapshotSchema = readJson("schema/graph-snapshot.v0.1.schema.json");
  const supportSchema = readJson("schema/support-matrix.v0.1.schema.json");
  const diffSchema = readJson("schema/graph-diff.v0.1.schema.json");
  const capabilitySchema = readJson(
    "schema/capability-registry.v0.1.schema.json",
  );
  const diagnosticSchema = readJson(
    "schema/diagnostic-registry.v0.1.schema.json",
  );
  const policyBundleSchema = readJson("schema/policy-bundle.v0.1.schema.json");
  const localPolicySchema = readJson("schema/policy.v0.1.schema.json");
  const policyExceptionSchema = readJson(
    "schema/policy-exception.v0.1.schema.json",
  );
  const policyAdrBindingSchema = readJson(
    "schema/policy-adr-binding.v0.1.schema.json",
  );
  const policyCompositionSchema = readJson(
    "schema/policy-composition.v0.1.schema.json",
  );
  const adrReferenceSchema = readJson("schema/adr-reference.v0.1.schema.json");
  const adrCoverageSchema = readJson("schema/adr-coverage.v0.1.schema.json");
  const adapterSchema = readJson("schema/adapter.v0.1.schema.json");
  const adapterCompatibilitySchema = readJson(
    "schema/adapter-compatibility.v0.1.schema.json",
  );
  const runtimeTraceSchema = readJson("schema/runtime-traces.v0.1.schema.json");
  const runtimeReconciliationSchema = readJson(
    "schema/runtime-reconciliation.v0.1.schema.json",
  );
  const runtimeTraceSafetySchema = readJson(
    "schema/runtime-trace-safety.v0.1.schema.json",
  );
  const runtimeTraceBudgetsSchema = readJson(
    "schema/runtime-trace-budgets.v0.1.schema.json",
  );
  const policyEvaluationSchema = readJson(
    "schema/policy-evaluation.v0.1.schema.json",
  );
  const policyBundleMigrationSchema = readJson(
    "schema/policy-bundle-migration.v0.1.schema.json",
  );
  const assuranceSigningSchema = readJson(
    "schema/assurance-signing.v0.1.schema.json",
  );
  const assuranceSigningVerificationSchema = readJson(
    "schema/assurance-signing-verification.v0.1.schema.json",
  );
  const remediationSuggestionSchema = readJson(
    "schema/remediation-suggestion.v0.1.schema.json",
  );
  const remediationSuggestionReportSchema = readJson(
    "schema/remediation-suggestion-report.v0.1.schema.json",
  );
  const remediationRulesSchema = readJson(
    "schema/remediation-rules.v0.1.schema.json",
  );
  const patchPreviewSchema = readJson("schema/patch-preview.v0.1.schema.json");
  const patchPreviewReportSchema = readJson(
    "schema/patch-preview-report.v0.1.schema.json",
  );
  const remediationReviewSchema = readJson(
    "schema/remediation-review.v0.1.schema.json",
  );
  const remediationEvaluationSchema = readJson(
    "schema/remediation-evaluation.v0.1.schema.json",
  );
  const architectureQuerySchema = readJson(
    "schema/architecture-query.v0.1.schema.json",
  );
  const architectureQueryResultSchema = readJson(
    "schema/architecture-query-result.v0.1.schema.json",
  );
  const architectureQueryExplanationSchema = readJson(
    "schema/architecture-query-explanation.v0.1.schema.json",
  );
  const architectureImpactSchema = readJson(
    "schema/architecture-impact.v0.1.schema.json",
  );
  const workspaceCompositionSchema = readJson(
    "schema/workspace-composition.v0.1.schema.json",
  );
  const contracts = policy.contracts;
  const snapshotVersion = sourceVersion(
    source,
    "GRAPH_SNAPSHOT_SCHEMA_VERSION",
  );
  const supportMatrixVersion = sourceVersion(
    supportSource,
    "SUPPORT_MATRIX_SCHEMA_VERSION",
  );
  const diffVersion = sourceVersion(source, "GRAPH_DIFF_SCHEMA_VERSION");
  const capabilityVersion = sourceVersion(
    capabilitySource,
    "CAPABILITY_REGISTRY_VERSION",
  );
  const diagnosticVersion = sourceVersion(
    diagnosticSource,
    "DIAGNOSTIC_REGISTRY_VERSION",
  );
  const policyBundleVersion = sourceVersion(
    policyBundleSource,
    "POLICY_BUNDLE_SCHEMA_VERSION",
  );
  const localPolicyVersion = sourceVersion(
    localPolicySource,
    "LOCAL_POLICY_SCHEMA_VERSION",
  );
  const policyExceptionVersion = sourceVersion(
    localPolicySource,
    "LOCAL_POLICY_EXCEPTION_SCHEMA_VERSION",
  );
  const policyAdrBindingVersion = sourceVersion(
    localPolicySource,
    "LOCAL_POLICY_ADR_BINDING_SCHEMA_VERSION",
  );
  const policyCompositionVersion = sourceVersion(
    policyCompositionSource,
    "POLICY_COMPOSITION_SCHEMA_VERSION",
  );
  const adrReferenceVersion = sourceVersion(
    adrReferenceSource,
    "ADR_REFERENCE_SCHEMA_VERSION",
  );
  const adrCoverageVersion = sourceVersion(
    adrCoverageSource,
    "ADR_COVERAGE_SCHEMA_VERSION",
  );
  const adapterVersion = sourceVersion(adapterSource, "ADAPTER_API_VERSION");
  const adapterCompatibilityVersion = sourceVersion(
    adapterCompatibilitySource,
    "ADAPTER_COMPATIBILITY_SCHEMA_VERSION",
  );
  const runtimeTraceVersion = sourceVersion(
    runtimeTraceSource,
    "RUNTIME_TRACE_SCHEMA_VERSION",
  );
  const runtimeReconciliationVersion = sourceVersion(
    runtimeReconciliationSource,
    "RUNTIME_RECONCILIATION_SCHEMA_VERSION",
  );
  const runtimeTraceSafetyVersion = sourceVersion(
    runtimeTraceSafetySource,
    "RUNTIME_TRACE_SAFETY_SCHEMA_VERSION",
  );
  const runtimeTraceBudgetsVersion = sourceVersion(
    runtimeTraceBudgetsSource,
    "RUNTIME_TRACE_BUDGETS_SCHEMA_VERSION",
  );
  const policyEvaluationVersion = sourceVersion(
    policyEvaluationSource,
    "POLICY_EVALUATION_SCHEMA_VERSION",
  );
  const policyBundleMigrationVersion = sourceVersion(
    policyBundleMigrationSource,
    "POLICY_BUNDLE_MIGRATION_SCHEMA_VERSION",
  );
  const assuranceSigningVersion = sourceVersion(
    assuranceSigningSource,
    "ASSURANCE_SIGNING_SCHEMA_VERSION",
  );
  const remediationSuggestionVersion = sourceVersion(
    remediationSuggestionSource,
    "REMEDIATION_SUGGESTION_SCHEMA_VERSION",
  );
  const remediationRulesVersion = sourceVersion(
    remediationRulesSource,
    "REMEDIATION_RULESET_SCHEMA_VERSION",
  );
  const patchPreviewVersion = sourceVersion(
    patchPreviewSource,
    "PATCH_PREVIEW_SCHEMA_VERSION",
  );
  const remediationReviewVersion = sourceVersion(
    remediationReviewSource,
    "REMEDIATION_REVIEW_SCHEMA_VERSION",
  );
  const remediationEvaluationVersion = sourceVersion(
    remediationEvaluationSource,
    "REMEDIATION_EVALUATION_SCHEMA_VERSION",
  );
  const architectureQueryVersion = sourceVersion(
    querySource,
    "ARCHITECTURE_QUERY_SCHEMA_VERSION",
  );
  const architectureQueryExplanationVersion = sourceVersion(
    queryExplanationSource,
    "ARCHITECTURE_QUERY_EXPLANATION_SCHEMA_VERSION",
  );
  const architectureImpactVersion = sourceVersion(
    impactSource,
    "ARCHITECTURE_IMPACT_SCHEMA_VERSION",
  );
  const workspaceCompositionVersion = sourceVersion(
    workspaceCompositionSource,
    "WORKSPACE_COMPOSITION_SCHEMA_VERSION",
  );

  if (
    snapshotVersion === undefined ||
    supportMatrixVersion === undefined ||
    diffVersion === undefined ||
    capabilityVersion === undefined ||
    diagnosticVersion === undefined ||
    policyBundleVersion === undefined ||
    localPolicyVersion === undefined ||
    policyExceptionVersion === undefined ||
    policyAdrBindingVersion === undefined ||
    policyCompositionVersion === undefined ||
    adrReferenceVersion === undefined ||
    adrCoverageVersion === undefined ||
    adapterVersion === undefined ||
    adapterCompatibilityVersion === undefined ||
    runtimeTraceVersion === undefined ||
    runtimeReconciliationVersion === undefined ||
    runtimeTraceSafetyVersion === undefined ||
    runtimeTraceBudgetsVersion === undefined ||
    policyEvaluationVersion === undefined ||
    policyBundleMigrationVersion === undefined ||
    assuranceSigningVersion === undefined ||
    remediationSuggestionVersion === undefined ||
    remediationRulesVersion === undefined ||
    patchPreviewVersion === undefined ||
    remediationReviewVersion === undefined ||
    remediationEvaluationVersion === undefined ||
    architectureQueryVersion === undefined ||
    architectureQueryExplanationVersion === undefined ||
    architectureImpactVersion === undefined ||
    workspaceCompositionVersion === undefined
  ) {
    throw new Error("runtime schema version constants are missing");
  }
  requireEqual(
    "snapshot runtime/policy",
    snapshotVersion,
    contracts.snapshot.current,
  );
  requireEqual("diff runtime/policy", diffVersion, contracts.diff.current);
  requireEqual(
    "GraphSnapshot JSON Schema/runtime",
    snapshotSchema.properties.schemaVersion.const,
    snapshotVersion,
  );
  requireEqual(
    "support matrix runtime/policy",
    supportMatrixVersion,
    contracts.supportMatrix.current,
  );
  requireEqual(
    "support matrix JSON Schema/runtime",
    supportSchema.properties.schemaVersion.const,
    supportMatrixVersion,
  );
  requireEqual(
    "GraphDiff JSON Schema/runtime",
    diffSchema.properties.schemaVersion.const,
    diffVersion,
  );
  requireEqual(
    "capability registry runtime/policy",
    capabilityVersion,
    contracts.capabilities.current,
  );
  requireEqual(
    "capability registry JSON Schema/runtime",
    capabilitySchema.properties.registryVersion.const,
    capabilityVersion,
  );
  requireEqual(
    "diagnostic registry runtime/policy",
    diagnosticVersion,
    contracts.diagnostics.current,
  );
  requireEqual(
    "diagnostic registry JSON Schema/runtime",
    diagnosticSchema.properties.registryVersion.const,
    diagnosticVersion,
  );
  requireEqual(
    "policy bundle runtime/policy",
    policyBundleVersion,
    contracts.policyBundles.current,
  );
  requireEqual(
    "policy bundle JSON Schema/runtime",
    policyBundleSchema.properties.schemaVersion.const,
    policyBundleVersion,
  );
  requireEqual(
    "local policy runtime/policy",
    localPolicyVersion,
    contracts.policies.current,
  );
  requireEqual(
    "local policy JSON Schema/runtime",
    localPolicySchema.properties.schemaVersion.const,
    localPolicyVersion,
  );
  requireEqual(
    "local policy exception runtime/policy",
    policyExceptionVersion,
    contracts.policyExceptions.current,
  );
  requireEqual(
    "local policy exception JSON Schema/runtime",
    policyExceptionSchema.properties.schemaVersion.const,
    policyExceptionVersion,
  );
  requireEqual(
    "local policy ADR binding runtime/policy",
    policyAdrBindingVersion,
    contracts.policyAdrBindings.current,
  );
  requireEqual(
    "local policy ADR binding JSON Schema/runtime",
    policyAdrBindingSchema.properties.schemaVersion.const,
    policyAdrBindingVersion,
  );
  requireEqual(
    "policy composition runtime/policy",
    policyCompositionVersion,
    contracts.policyCompositions.current,
  );
  requireEqual(
    "policy composition JSON Schema/runtime",
    policyCompositionSchema.properties.schemaVersion.const,
    policyCompositionVersion,
  );
  requireEqual(
    "ADR reference runtime/policy",
    adrReferenceVersion,
    contracts.adrReferences.current,
  );
  requireEqual(
    "ADR reference JSON Schema/runtime",
    adrReferenceSchema.properties.schemaVersion.const,
    adrReferenceVersion,
  );
  requireEqual(
    "ADR coverage runtime/policy",
    adrCoverageVersion,
    contracts.adrCoverage.current,
  );
  requireEqual(
    "ADR coverage JSON Schema/runtime",
    adrCoverageSchema.properties.schemaVersion.const,
    adrCoverageVersion,
  );
  requireEqual(
    "adapter runtime/policy",
    adapterVersion,
    contracts.adapters.current,
  );
  requireEqual(
    "adapter JSON Schema/runtime",
    adapterSchema.properties.apiVersion.const,
    adapterVersion,
  );
  requireEqual(
    "adapter compatibility runtime/policy",
    adapterCompatibilityVersion,
    contracts.adapterCompatibilityNegotiation.current,
  );
  requireEqual(
    "adapter compatibility JSON Schema/runtime",
    adapterCompatibilitySchema.properties.schemaVersion.const,
    adapterCompatibilityVersion,
  );
  requireEqual(
    "runtime trace runtime/policy",
    runtimeTraceVersion,
    contracts.runtimeTraces.current,
  );
  requireEqual(
    "runtime trace JSON Schema/runtime",
    runtimeTraceSchema.properties.schemaVersion.const,
    runtimeTraceVersion,
  );
  requireEqual(
    "runtime reconciliation runtime/policy",
    runtimeReconciliationVersion,
    contracts.runtimeReconciliation.current,
  );
  requireEqual(
    "runtime reconciliation JSON Schema/runtime",
    runtimeReconciliationSchema.properties.schemaVersion.const,
    runtimeReconciliationVersion,
  );
  requireEqual(
    "runtime trace safety runtime/policy",
    runtimeTraceSafetyVersion,
    contracts.runtimeTraceSafety.current,
  );
  requireEqual(
    "runtime trace safety JSON Schema/runtime",
    runtimeTraceSafetySchema.properties.schemaVersion.const,
    runtimeTraceSafetyVersion,
  );
  requireEqual(
    "runtime trace budgets runtime/policy",
    runtimeTraceBudgetsVersion,
    contracts.runtimeTraceBudgets.current,
  );
  requireEqual(
    "runtime trace budgets JSON Schema/runtime",
    runtimeTraceBudgetsSchema.properties.schemaVersion.const,
    runtimeTraceBudgetsVersion,
  );
  requireEqual(
    "policy evaluation runtime/policy",
    policyEvaluationVersion,
    contracts.policyEvaluations.current,
  );
  requireEqual(
    "policy evaluation JSON Schema/runtime",
    policyEvaluationSchema.properties.schemaVersion.const,
    policyEvaluationVersion,
  );
  requireEqual(
    "policy bundle migration runtime/policy",
    policyBundleMigrationVersion,
    contracts.policyBundleMigrations.current,
  );
  requireEqual(
    "policy bundle migration JSON Schema/runtime",
    policyBundleMigrationSchema.properties.schemaVersion.const,
    policyBundleMigrationVersion,
  );
  requireEqual(
    "assurance signing runtime/policy",
    assuranceSigningVersion,
    contracts.assuranceSigning.current,
  );
  requireEqual(
    "assurance signing JSON Schema/runtime",
    assuranceSigningSchema.properties.schemaVersion.const,
    assuranceSigningVersion,
  );
  requireEqual(
    "assurance signing verification JSON Schema/runtime",
    assuranceSigningVerificationSchema.properties.schemaVersion.const,
    assuranceSigningVersion,
  );
  requireEqual(
    "remediation suggestion runtime/policy",
    remediationSuggestionVersion,
    contracts.remediationSuggestions.current,
  );
  requireEqual(
    "remediation suggestion JSON Schema/runtime",
    remediationSuggestionSchema.properties.schemaVersion.const,
    remediationSuggestionVersion,
  );
  requireEqual(
    "remediation suggestion report JSON Schema/runtime",
    remediationSuggestionReportSchema.properties.schemaVersion.const,
    remediationSuggestionVersion,
  );
  requireEqual(
    "remediation rules runtime/policy",
    remediationRulesVersion,
    contracts.remediationRules.current,
  );
  requireEqual(
    "remediation rules JSON Schema/runtime",
    remediationRulesSchema.properties.schemaVersion.const,
    remediationRulesVersion,
  );
  requireEqual(
    "patch preview runtime/policy",
    patchPreviewVersion,
    contracts.patchPreviews.current,
  );
  requireEqual(
    "patch preview JSON Schema/runtime",
    patchPreviewSchema.properties.schemaVersion.const,
    patchPreviewVersion,
  );
  requireEqual(
    "patch preview report JSON Schema/runtime",
    patchPreviewReportSchema.properties.schemaVersion.const,
    patchPreviewVersion,
  );
  requireEqual(
    "remediation review runtime/policy",
    remediationReviewVersion,
    contracts.remediationReviews.current,
  );
  requireEqual(
    "remediation review JSON Schema/runtime",
    remediationReviewSchema.properties.schemaVersion.const,
    remediationReviewVersion,
  );
  requireEqual(
    "remediation evaluation runtime/policy",
    remediationEvaluationVersion,
    contracts.remediationEvaluations.current,
  );
  requireEqual(
    "remediation evaluation JSON Schema/runtime",
    remediationEvaluationSchema.properties.schemaVersion.const,
    remediationEvaluationVersion,
  );
  requireEqual(
    "architecture query runtime/policy",
    architectureQueryVersion,
    contracts.architectureQueries.current,
  );
  requireEqual(
    "architecture query JSON Schema/runtime",
    architectureQuerySchema.properties.schemaVersion.const,
    architectureQueryVersion,
  );
  requireEqual(
    "architecture query result JSON Schema/runtime",
    architectureQueryResultSchema.properties.schemaVersion.const,
    architectureQueryVersion,
  );
  requireEqual(
    "architecture query explanation runtime/policy",
    architectureQueryExplanationVersion,
    contracts.architectureQueryExplanations.current,
  );
  requireEqual(
    "architecture query explanation JSON Schema/runtime",
    architectureQueryExplanationSchema.properties.schemaVersion.const,
    architectureQueryExplanationVersion,
  );
  requireEqual(
    "architecture impact runtime/policy",
    architectureImpactVersion,
    contracts.architectureImpacts.current,
  );
  requireEqual(
    "architecture impact JSON Schema/runtime",
    architectureImpactSchema.properties.schemaVersion.const,
    architectureImpactVersion,
  );
  requireEqual(
    "workspace composition runtime/policy",
    workspaceCompositionVersion,
    contracts.workspaceCompositions.current,
  );
  requireEqual(
    "workspace composition JSON Schema/runtime",
    workspaceCompositionSchema.properties.schemaVersion.const,
    workspaceCompositionVersion,
  );

  for (const [label, contract] of Object.entries(contracts)) {
    requireReviewed(label, contract);
  }
  checkHostedVersionChange();

  return {
    ok: true,
    policyVersion: policy.policyVersion,
    snapshotVersion,
    supportMatrixVersion,
    diffVersion,
    capabilityVersion,
    diagnosticVersion,
    policyBundleVersion,
    localPolicyVersion,
    policyExceptionVersion,
    policyAdrBindingVersion,
    policyCompositionVersion,
    adrReferenceVersion,
    adrCoverageVersion,
    adapterVersion,
    adapterCompatibilityVersion,
    runtimeTraceVersion,
    runtimeReconciliationVersion,
    runtimeTraceSafetyVersion,
    runtimeTraceBudgetsVersion,
    policyEvaluationVersion,
    policyBundleMigrationVersion,
    assuranceSigningVersion,
    remediationSuggestionVersion,
    remediationRulesVersion,
    patchPreviewVersion,
    remediationReviewVersion,
    remediationEvaluationVersion,
    architectureQueryVersion,
    architectureQueryExplanationVersion,
    architectureImpactVersion,
    workspaceCompositionVersion,
  };
};

if (process.argv[2] !== "check") {
  console.error(
    "usage: node scripts/schema-compatibility.mjs check [--root path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(checkCompatibility()));
} catch (error) {
  console.error(`schema compatibility check failed: ${error.message}`);
  process.exit(1);
}
