#!/usr/bin/env node

import { realpathSync } from "node:fs";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Command, InvalidArgumentError } from "commander";

import {
  formatCliError,
  formatCliWarning,
  redactCliText,
  isCommanderControlError,
} from "./cli-errors.js";
import {
  diffRepositoryRevisions,
  diffSnapshotFiles,
  evaluatePolicyFile,
  migrateSnapshotFile,
  reconcileRuntimeFiles,
  reviewRemediationFile,
  reviewSummaryFile,
  scanRepository,
  serializeScan,
  writeOutputFile,
} from "./commands.js";
import {
  readCartographConfig,
  assertSupportedEnvironment,
  parsePolicyCiMode,
  policyCiExitCode,
  serializeGraphSnapshot,
  serializeMigrationReport,
  serializePolicyEvaluation,
  type CartographConfig,
  type PolicyCiMode,
} from "./core/index.js";
import type { ReportFormat } from "./report/render.js";
import { runQueryCommand, type QueryRequest } from "./query-command.js";
import {
  EXPORT_FORMATS,
  exportSnapshotFile,
  policyEvaluationSarif,
  type ExportFormat,
} from "./export-command.js";
import { initRepository } from "./init-command.js";
import { linkSbomFiles } from "./sbom-command.js";
import { evaluateControls } from "./controls-command.js";
import {
  DEFAULT_HISTORY_STORE,
  exportHistoryRecords,
  historyGc,
  historyTrends,
  importHistoryRecords,
  listHistoryRecords,
  repairHistory,
  verifyHistory,
} from "./history-command.js";
import {
  bundleSigningPayload,
  checkBundle,
  createBundle,
  replayBundle,
  shareBundle,
  verifyBundle,
} from "./bundle-command.js";
import type { RevisionComparisonMode } from "./git/revision.js";

const VERSION = "0.1.1";

const writeRedactedError = (message: string): void => {
  process.stderr.write(
    message
      .replaceAll("\r", "")
      .split("\n")
      .map((line) => {
        const safe = redactCliText(line);
        return safe.startsWith("error:")
          ? `cartograph [cli-input]: ${safe}`
          : safe;
      })
      .join("\n"),
  );
};

type OutputOptions = {
  force?: boolean;
  output?: string;
};

type ConfigOptions = {
  config?: string;
};

const readConfigOption = (
  root: string,
  configPath: string | undefined,
): CartographConfig | undefined => {
  if (configPath === undefined) return undefined;
  const parsed = readCartographConfig(root, configPath);
  for (const warning of parsed.warnings)
    process.stderr.write(`${formatCliWarning(warning)}\n`);
  return parsed.config;
};

const reportFormat = (value: string): ReportFormat => {
  if (value === "html" || value === "json" || value === "markdown")
    return value;
  throw new InvalidArgumentError("format must be one of: html, json, markdown");
};

const exportFormat = (value: string): ExportFormat => {
  const format = EXPORT_FORMATS.find((candidate) => candidate === value);
  if (format === undefined)
    throw new InvalidArgumentError(
      `format must be one of: ${EXPORT_FORMATS.join(", ")}`,
    );
  return format;
};

const policyOutputFormat = (value: string): "json" | "sarif" => {
  if (value === "json" || value === "sarif") return value;
  throw new InvalidArgumentError("format must be one of: json, sarif");
};

const queryFormat = (value: string): "json" | "markdown" => {
  if (value === "json" || value === "markdown") return value;
  throw new InvalidArgumentError("format must be one of: json, markdown");
};

const edgeKindList = (value: string): string[] => {
  const kinds = value
    .split(",")
    .map((kind) => kind.trim())
    .filter((kind) => kind.length > 0);
  if (kinds.length === 0)
    throw new InvalidArgumentError("edges must list at least one edge kind");
  return [...new Set(kinds)];
};

const keyValue =
  (flag: string) =>
  (value: string, previous: { key: string; value: string }[] = []) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1)
      throw new InvalidArgumentError(`${flag} must be <role>=<value>`);
    return [
      ...previous,
      { key: value.slice(0, separator), value: value.slice(separator + 1) },
    ];
  };

const collect = (value: string, previous: string[] = []): string[] => [
  ...previous,
  value,
];

const revisionComparison = (value: string): RevisionComparisonMode => {
  if (value === "direct" || value === "merge-base") return value;
  throw new InvalidArgumentError(
    "comparison must be one of: direct, merge-base",
  );
};

const policyMode = (value: string): PolicyCiMode => {
  try {
    return parsePolicyCiMode(value);
  } catch {
    throw new InvalidArgumentError(
      "mode must be one of: informational, enforce",
    );
  }
};

const policyAsOf = (value: string): string => {
  if (!Number.isFinite(Date.parse(value))) {
    throw new InvalidArgumentError("as-of must be a parseable date-time");
  }
  return value;
};

const exceptionWindowDays = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3_650) {
    throw new InvalidArgumentError(
      "exception-window-days must be an integer from 0 to 3650",
    );
  }
  return parsed;
};

const runtimeLimit = (
  value: string,
  label: string,
  maximum: number,
): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new InvalidArgumentError(
      `${label} must be an integer from 1 to ${maximum}`,
    );
  }
  return parsed;
};

const emit = async (content: string, options: OutputOptions): Promise<void> => {
  if (options.output === undefined || options.output === "-") {
    process.stdout.write(content);
    return;
  }
  await writeOutputFile(options.output, content, options.force ?? false);
};

export function createCli(): Command {
  const program = new Command()
    .name("cartograph")
    .description(
      "Deterministic architecture graph scanning and evidence-backed revision diffs for TypeScript.",
    )
    .version(VERSION)
    .showHelpAfterError()
    .showSuggestionAfterError()
    .configureOutput({
      writeErr: writeRedactedError,
    });

  program
    .command("scan")
    .alias("snapshot")
    .description("scan a working tree and emit a canonical graph snapshot")
    .argument("[root]", "repository or project root", ".")
    .option("--tsconfig <path>", "TypeScript configuration path")
    .option("--config <path>", "repository-relative CARTOGRAPH JSON config")
    .option("-o, --output <path>", "output file; stdout when omitted")
    .option("--force", "replace an existing output file", false)
    .action(
      async (
        root: string,
        options: OutputOptions & ConfigOptions & { tsconfig?: string },
      ): Promise<void> => {
        const config = readConfigOption(root, options.config);
        const snapshot = scanRepository({
          root,
          ...(config === undefined ? {} : { config }),
          ...(options.tsconfig === undefined
            ? {}
            : { tsconfigPath: options.tsconfig }),
        });
        await emit(serializeScan(snapshot), options);
      },
    );

  program
    .command("diff")
    .description("compare architecture extracted from two local Git revisions")
    .argument("[root]", "Git repository root", ".")
    .requiredOption("--base <ref>", "base Git ref")
    .option("--head <ref>", "head Git ref", "HEAD")
    .option(
      "--comparison <mode>",
      "comparison mode: direct or merge-base",
      revisionComparison,
      "direct",
    )
    .option(
      "-f, --format <format>",
      "report format: json, markdown, or html",
      reportFormat,
      "markdown",
    )
    .option(
      "--tsconfig <path>",
      "repository-relative TypeScript configuration path",
    )
    .option("--config <path>", "repository-relative CARTOGRAPH JSON config")
    .option(
      "--adr <path>",
      "repository-relative local ADR reference JSON for report links",
    )
    .option(
      "--cache-dir <path>",
      "reuse revision snapshots stored here, keyed by analyzer, config, and commit tree",
    )
    .option("-o, --output <path>", "output file; stdout when omitted")
    .option("--force", "replace an existing output file", false)
    .action(
      async (
        root: string,
        options: OutputOptions & {
          base: string;
          comparison: RevisionComparisonMode;
          format: ReportFormat;
          head: string;
          tsconfig?: string;
          config?: string;
          adr?: string;
          cacheDir?: string;
        },
      ): Promise<void> => {
        const config = readConfigOption(root, options.config);
        const report = await diffRepositoryRevisions({
          ...(options.cacheDir === undefined
            ? {}
            : { cacheDir: options.cacheDir }),
          base: options.base,
          comparison: options.comparison,
          format: options.format,
          head: options.head,
          root,
          ...(config === undefined ? {} : { config }),
          ...(options.tsconfig === undefined
            ? {}
            : { tsconfigPath: options.tsconfig }),
          ...(options.adr === undefined ? {} : { adr: options.adr }),
        });
        await emit(report, options);
      },
    );

  program
    .command("reconcile-runtime")
    .description(
      "reconcile an explicit local GraphSnapshot, OTLP trace, and span bindings",
    )
    .requiredOption(
      "--snapshot <path>",
      "local GraphSnapshot JSON input; no remote resolution",
    )
    .requiredOption(
      "--trace <path>",
      "local OTLP JSON trace input; no collector or upload",
    )
    .requiredOption(
      "--bindings <path>",
      "local explicit RuntimeSpanBinding[] JSON input",
    )
    .option(
      "--max-input-bytes <bytes>",
      "runtime trace input-byte ceiling",
      (value: string) =>
        runtimeLimit(value, "max-input-bytes", 64 * 1024 * 1024),
    )
    .option(
      "--max-spans <count>",
      "normalized runtime span ceiling",
      (value: string) => runtimeLimit(value, "max-spans", 1_000_000),
    )
    .option(
      "--max-traces <count>",
      "runtime trace identity ceiling",
      (value: string) => runtimeLimit(value, "max-traces", 100_000),
    )
    .option(
      "--max-analysis-ms <milliseconds>",
      "end-to-end processing-time ceiling",
      (value: string) => runtimeLimit(value, "max-analysis-ms", 300_000),
    )
    .option(
      "--max-report-bytes <bytes>",
      "serialized report-byte ceiling",
      (value: string) =>
        runtimeLimit(value, "max-report-bytes", 64 * 1024 * 1024),
    )
    .option(
      "--max-report-items <count>",
      "reconciliation output-cardinality ceiling",
      (value: string) => runtimeLimit(value, "max-report-items", 200_000),
    )
    .option("-o, --output <path>", "output report file; stdout when omitted")
    .option("--force", "replace an existing output file", false)
    .action(
      async (
        options: OutputOptions & {
          snapshot: string;
          trace: string;
          bindings: string;
          maxInputBytes?: number;
          maxSpans?: number;
          maxTraces?: number;
          maxAnalysisMs?: number;
          maxReportBytes?: number;
          maxReportItems?: number;
        },
      ): Promise<void> => {
        await emit(
          await reconcileRuntimeFiles({
            snapshot: options.snapshot,
            trace: options.trace,
            bindings: options.bindings,
            ...(options.maxInputBytes === undefined
              ? {}
              : { maxInputBytes: options.maxInputBytes }),
            ...(options.maxSpans === undefined
              ? {}
              : { maxSpans: options.maxSpans }),
            ...(options.maxTraces === undefined
              ? {}
              : { maxTraces: options.maxTraces }),
            ...(options.maxAnalysisMs === undefined
              ? {}
              : { maxAnalysisMs: options.maxAnalysisMs }),
            ...(options.maxReportBytes === undefined
              ? {}
              : { maxReportBytes: options.maxReportBytes }),
            ...(options.maxReportItems === undefined
              ? {}
              : { maxReportItems: options.maxReportItems }),
          }),
          options,
        );
      },
    );

  program
    .command("diff-snapshots")
    .description("compare two existing graph snapshot files")
    .argument("<before>", "before snapshot JSON")
    .argument("<after>", "after snapshot JSON")
    .option(
      "-f, --format <format>",
      "report format: json, markdown, or html",
      reportFormat,
      "markdown",
    )
    .option("-o, --output <path>", "output file; stdout when omitted")
    .option("--force", "replace an existing output file", false)
    .action(
      async (
        before: string,
        after: string,
        options: OutputOptions & { format: ReportFormat },
      ): Promise<void> => {
        await emit(
          await diffSnapshotFiles(before, after, options.format),
          options,
        );
      },
    );

  program
    .command("query")
    .description(
      "query a graph snapshot or diff: cycles, dependency paths, or a graph query",
    )
    .option("--snapshot <path>", "graph snapshot JSON input")
    .option("--diff <path>", "GraphDiff JSON input (for change queries)")
    .option(
      "-e, --expr <query>",
      'graph query language text, e.g. "v1 nodes where kind = function"',
    )
    .option(
      "-q, --query <path>",
      "query file: an architecture-query JSON request or graph query text",
    )
    .option("--cycles", "report dependency cycles between modules", false)
    .option("--from <node>", "dependency-path start (node ID or module path)")
    .option("--to <node>", "dependency-path end (node ID or module path)")
    .option(
      "--edges <kinds>",
      "comma-separated edge kinds for --cycles and --from/--to",
      edgeKindList,
      ["imports"],
    )
    .option(
      "-f, --format <format>",
      "output format: json or markdown",
      queryFormat,
      "markdown",
    )
    .option(
      "--fail-on-match",
      "exit 2 when the query returns any result (for CI gates)",
      false,
    )
    .option("-o, --output <path>", "output file; stdout when omitted")
    .option("--force", "replace an existing output file", false)
    .action(
      async (
        options: OutputOptions & {
          snapshot?: string;
          diff?: string;
          expr?: string;
          query?: string;
          cycles: boolean;
          from?: string;
          to?: string;
          edges: string[];
          format: "json" | "markdown";
          failOnMatch: boolean;
        },
      ): Promise<void> => {
        if ((options.snapshot === undefined) === (options.diff === undefined))
          throw new InvalidArgumentError(
            "exactly one of --snapshot or --diff is required",
          );
        const pathRequested =
          options.from !== undefined || options.to !== undefined;
        const requested = [
          options.expr !== undefined,
          options.query !== undefined,
          options.cycles,
          pathRequested,
        ].filter(Boolean).length;
        if (requested !== 1)
          throw new InvalidArgumentError(
            "choose exactly one of --expr, --query, --cycles, or --from/--to",
          );
        let request: QueryRequest;
        if (options.expr !== undefined)
          request = { kind: "expression", expression: options.expr };
        else if (options.query !== undefined)
          request = { kind: "file", path: options.query };
        else if (options.cycles)
          request = { kind: "cycles", edgeKinds: options.edges };
        else {
          if (options.from === undefined || options.to === undefined)
            throw new InvalidArgumentError(
              "--from and --to must be used together",
            );
          request = {
            kind: "path",
            from: options.from,
            to: options.to,
            edgeKinds: options.edges,
          };
        }
        const input = options.snapshot ?? options.diff;
        if (input === undefined)
          throw new InvalidArgumentError(
            "exactly one of --snapshot or --diff is required",
          );
        const result = await runQueryCommand({
          input,
          inputKind: options.snapshot === undefined ? "diff" : "snapshot",
          request,
          format: options.format,
        });
        await emit(result.output, options);
        if (result.status !== "ok") process.exitCode = 1;
        else if (options.failOnMatch && result.matched > 0)
          process.exitCode = 2;
      },
    );

  program
    .command("export")
    .description(
      "export a graph snapshot as graph-interchange JSON, JSON-LD, an edge list, or a SCIP index",
    )
    .requiredOption("--snapshot <path>", "graph snapshot JSON input")
    .requiredOption(
      "-f, --format <format>",
      `export format: ${EXPORT_FORMATS.join(", ")}`,
      exportFormat,
    )
    .option("-o, --output <path>", "output file; stdout when omitted")
    .option("--force", "replace an existing output file", false)
    .action(
      async (
        options: OutputOptions & { snapshot: string; format: ExportFormat },
      ): Promise<void> => {
        await emit(
          await exportSnapshotFile(options.snapshot, options.format, VERSION),
          options,
        );
      },
    );

  program
    .command("sbom")
    .description("relate released software inventory to the architecture graph")
    .command("link")
    .description(
      "link CycloneDX or SPDX components, and SLSA build subjects, to graph objects with evidence and unresolved reasons",
    )
    .requiredOption("--snapshot <path>", "graph snapshot JSON input")
    .requiredOption(
      "--sbom <path>",
      "CycloneDX (1.4-1.6) or SPDX (2.2-2.3) JSON",
    )
    .option("--provenance <path>", "in-toto Statement with SLSA provenance")
    .option(
      "--alias <sbom-name=graph-name>",
      "an npm alias: the SBOM package name and the name the code imports (repeatable)",
      keyValue("--alias"),
      [],
    )
    .option("-o, --output <path>", "output file; stdout when omitted")
    .option("--force", "replace an existing output file", false)
    .action(
      async (
        options: OutputOptions & {
          snapshot: string;
          sbom: string;
          provenance?: string;
          alias: { key: string; value: string }[];
        },
      ): Promise<void> => {
        const report = await linkSbomFiles({
          snapshot: options.snapshot,
          sbom: options.sbom,
          ...(options.provenance === undefined
            ? {}
            : { provenance: options.provenance }),
          aliases: options.alias,
        });
        await emit(`${JSON.stringify(report)}\n`, options);
      },
    );

  program
    .command("controls")
    .description(
      "trace control objectives to bundled evidence (not a certification)",
    )
    .command("evaluate")
    .description(
      "relate a local control mapping to a verified bundle: observed evidence, owner assertions, gaps, and conflicts",
    )
    .requiredOption("--mapping <path>", "control mapping JSON")
    .requiredOption("--bundle <dir>", "verified assurance bundle directory")
    .requiredOption(
      "--as-of <date-time>",
      "evaluate periods and expiry at this time",
    )
    .option("-o, --output <path>", "output file; stdout when omitted")
    .option("--force", "replace an existing output file", false)
    .action(
      async (
        options: OutputOptions & {
          mapping: string;
          bundle: string;
          asOf: string;
        },
      ): Promise<void> => {
        const report = await evaluateControls({
          mapping: options.mapping,
          bundle: options.bundle,
          asOf: options.asOf,
        });
        await emit(`${JSON.stringify(report)}\n`, options);
      },
    );

  program
    .command("init")
    .description(
      "write a starter config, an informational policy, and the pull-request workflow",
    )
    .argument("[root]", "repository root", ".")
    .option("--no-workflow", "skip .github/workflows/cartograph.yml")
    .option("--force", "replace files that already exist", false)
    .action(
      async (
        root: string,
        options: { force: boolean; workflow: boolean },
      ): Promise<void> => {
        const result = await initRepository({
          root,
          force: options.force,
          workflow: options.workflow,
        });
        const lines = [
          ...result.created.map((path) => `created  ${path}`),
          ...result.replaced.map((path) => `replaced ${path}`),
          ...result.skipped.map(
            (path) => `skipped  ${path} (exists; use --force to replace)`,
          ),
        ];
        process.stdout.write(`${lines.join("\n")}\n`);
      },
    );

  const bundle = program
    .command("bundle")
    .description("create or verify an offline assurance bundle");
  bundle
    .command("create")
    .description(
      "package snapshots, diffs, policies, evaluations, and reports into a verifiable bundle",
    )
    .requiredOption("-o, --output <dir>", "new bundle directory")
    .option(
      "-a, --artifact <role=path>",
      "add an artifact (repeatable), e.g. diff=diff.json",
      keyValue("--artifact"),
      [],
    )
    .option(
      "--missing <role=reason>",
      "declare a required artifact as intentionally absent (repeatable)",
      keyValue("--missing"),
      [],
    )
    .option(
      "--require <role>",
      "require a role (repeatable); defaults to the roles supplied",
      collect,
    )
    .option(
      "--profile <team|public>",
      "refuse to write a bundle that is unsafe to share under this profile",
    )
    .action(
      async (options: {
        output: string;
        artifact: { key: string; value: string }[];
        missing: { key: string; value: string }[];
        require?: string[];
        profile?: string;
      }): Promise<void> => {
        const result = await createBundle({
          output: options.output,
          artifacts: options.artifact.map((item) => ({
            role: item.key,
            path: item.value,
          })),
          missing: options.missing.map((item) => ({
            role: item.key,
            reason: item.value,
          })),
          ...(options.require === undefined
            ? {}
            : { requiredRoles: options.require }),
          ...(options.profile === undefined
            ? {}
            : { profile: options.profile }),
          toolVersion: VERSION,
        });
        process.stdout.write(
          `${JSON.stringify({ ok: true, bundleId: result.bundleId, artifacts: result.artifacts })}\n`,
        );
      },
    );
  bundle
    .command("payload")
    .description(
      "print the unsigned signing record and exact payload to sign with your own Ed25519 key",
    )
    .argument("<dir>", "bundle directory")
    .requiredOption("--key-id <id>", "signer key ID in your keyring")
    .requiredOption("--signed-at <date-time>", "signing time (ISO 8601)")
    .requiredOption("--expires-at <date-time>", "signature expiry (ISO 8601)")
    .action(
      async (
        directory: string,
        options: { keyId: string; signedAt: string; expiresAt: string },
      ): Promise<void> => {
        const result = await bundleSigningPayload(directory, {
          signerKeyId: options.keyId,
          signedAt: options.signedAt,
          expiresAt: options.expiresAt,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      },
    );
  bundle
    .command("verify")
    .description(
      "verify a bundle offline: digests, sizes, contracts, required roles, and optionally its signature",
    )
    .argument("<dir>", "bundle directory")
    .option("--signature <path>", "assurance signing record for the manifest")
    .option("--keyring <path>", "public-key keyring JSON")
    .option("--trust-root <id>", "trusted root ID (repeatable)", collect)
    .option("--as-of <date-time>", "evaluate expiry and validity at this time")
    .action(
      async (
        directory: string,
        options: {
          signature?: string;
          keyring?: string;
          trustRoot?: string[];
          asOf?: string;
        },
      ): Promise<void> => {
        if (
          options.signature !== undefined &&
          (options.keyring === undefined || options.trustRoot === undefined)
        )
          throw new InvalidArgumentError(
            "--signature requires --keyring and at least one --trust-root",
          );
        const report = await verifyBundle(
          directory,
          options.signature === undefined || options.keyring === undefined
            ? undefined
            : {
                signature: options.signature,
                keyring: options.keyring,
                trustRoots: options.trustRoot ?? [],
                ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
              },
        );
        process.stdout.write(`${JSON.stringify(report)}\n`);
        if (!report.ok) process.exitCode = 2;
      },
    );

  bundle
    .command("replay")
    .description(
      "replay a bundle offline: verify it, regenerate derived artifacts from its own inputs, and compare",
    )
    .argument("<dir>", "bundle directory")
    .option("--signature <path>", "assurance signing record for the manifest")
    .option("--keyring <path>", "public-key keyring JSON")
    .option("--trust-root <id>", "trusted root ID (repeatable)", collect)
    .option("--as-of <date-time>", "evaluate signature expiry at this time")
    .action(
      async (
        directory: string,
        options: {
          signature?: string;
          keyring?: string;
          trustRoot?: string[];
          asOf?: string;
        },
      ): Promise<void> => {
        if (
          options.signature !== undefined &&
          (options.keyring === undefined || options.trustRoot === undefined)
        )
          throw new InvalidArgumentError(
            "--signature requires --keyring and at least one --trust-root",
          );
        const report = await replayBundle(
          directory,
          options.signature === undefined || options.keyring === undefined
            ? undefined
            : {
                signature: options.signature,
                keyring: options.keyring,
                trustRoots: options.trustRoot ?? [],
                ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
              },
        );
        process.stdout.write(`${JSON.stringify(report)}\n`);
        if (!report.ok) process.exitCode = 2;
      },
    );
  bundle
    .command("check")
    .description(
      "check a bundle for secrets, absolute paths, and identifiers before sharing it (values are never printed)",
    )
    .argument("<dir>", "bundle directory")
    .option("--profile <team|public>", "recipient profile", "team")
    .option(
      "--allow-host <host>",
      "a host the public profile may mention (repeatable)",
      collect,
    )
    .action(
      async (
        directory: string,
        options: { profile: string; allowHost?: string[] },
      ): Promise<void> => {
        const report = await checkBundle(directory, {
          profile: options.profile,
          ...(options.allowHost === undefined
            ? {}
            : { allowedHosts: options.allowHost }),
        });
        process.stdout.write(`${JSON.stringify(report)}\n`);
        if (!report.ok) process.exitCode = 2;
      },
    );
  bundle
    .command("share")
    .description(
      "derive a shareable bundle: exclude, pseudonymize, and redact for a recipient profile, then rebuild",
    )
    .argument("<dir>", "verified source bundle directory")
    .requiredOption("-o, --output <dir>", "new bundle directory")
    .option("--profile <team|public>", "recipient profile", "team")
    .option(
      "--key-file <path>",
      "local secret (at least 32 bytes) used to pseudonymize repository paths; required for public",
    )
    .option(
      "--allow-host <host>",
      "a host the public profile may mention (repeatable)",
      collect,
    )
    .option(
      "--include-role <role>",
      "keep a role the profile excludes by default (repeatable)",
      collect,
    )
    .action(
      async (
        directory: string,
        options: {
          output: string;
          profile: string;
          keyFile?: string;
          allowHost?: string[];
          includeRole?: string[];
        },
      ): Promise<void> => {
        const result = await shareBundle({
          input: directory,
          output: options.output,
          profile: options.profile,
          ...(options.keyFile === undefined
            ? {}
            : { keyFile: options.keyFile }),
          ...(options.allowHost === undefined
            ? {}
            : { allowedHosts: options.allowHost }),
          ...(options.includeRole === undefined
            ? {}
            : { includeRoles: options.includeRole }),
          toolVersion: VERSION,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      },
    );

  const history = program
    .command("history")
    .description(
      "keep a local, content-addressed history of snapshots, diffs, policies, and decisions",
    );
  const storeOption = [
    "--store <dir>",
    "history store directory",
    DEFAULT_HISTORY_STORE,
  ] as const;
  const printJson = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  history
    .command("import")
    .description("validate, canonicalize, and store records (deduplicated)")
    .option(...storeOption)
    .option(
      "-r, --record <kind=path>",
      "record to import (repeatable), e.g. snapshot=graph.json",
      keyValue("--record"),
      [],
    )
    .action(
      async (options: {
        store: string;
        record: { key: string; value: string }[];
      }): Promise<void> => {
        if (options.record.length === 0)
          throw new InvalidArgumentError(
            "give at least one --record kind=path",
          );
        printJson(
          await importHistoryRecords({
            store: options.store,
            inputs: options.record.map((item) => ({
              kind: item.key,
              path: item.value,
            })),
            toolVersion: VERSION,
          }),
        );
      },
    );
  history
    .command("list")
    .description("list indexed records")
    .option(...storeOption)
    .option("--kind <kind>", "only this record kind")
    .option("--revision <sha>", "only records for or referencing this revision")
    .action(
      async (options: {
        store: string;
        kind?: string;
        revision?: string;
      }): Promise<void> => {
        printJson(
          await listHistoryRecords({
            store: options.store,
            ...(options.kind === undefined ? {} : { kind: options.kind }),
            ...(options.revision === undefined
              ? {}
              : { revision: options.revision }),
          }),
        );
      },
    );
  history
    .command("verify")
    .description(
      "check every object's digest, contract, and canonical form against the index",
    )
    .option(...storeOption)
    .action(async (options: { store: string }): Promise<void> => {
      const report = await verifyHistory(options.store);
      printJson(report);
      if (!report.ok) process.exitCode = 2;
    });
  history
    .command("repair")
    .description(
      "quarantine corrupt objects, clear leftovers and stale locks, and rebuild the index",
    )
    .option(...storeOption)
    .action(async (options: { store: string }): Promise<void> => {
      printJson(await repairHistory(options.store));
    });
  history
    .command("export")
    .description("write selected records as standalone contract documents")
    .option(...storeOption)
    .requiredOption("-o, --output <dir>", "new export directory")
    .option("--revision <sha>", "records for or referencing this revision")
    .option("--id <id>", "a record ID (repeatable)", collect)
    .option("--kind <kind>", "only this record kind (repeatable)", collect)
    .option(
      "--profile <team|public>",
      "redact values unsafe for this recipient; fails if a record's contract breaks",
    )
    .action(
      async (options: {
        store: string;
        output: string;
        revision?: string;
        id?: string[];
        kind?: string[];
        profile?: string;
      }): Promise<void> => {
        printJson(
          await exportHistoryRecords({
            store: options.store,
            output: options.output,
            ...(options.revision === undefined
              ? {}
              : { revision: options.revision }),
            ...(options.id === undefined ? {} : { ids: options.id }),
            ...(options.kind === undefined ? {} : { kinds: options.kind }),
            ...(options.profile === undefined
              ? {}
              : { profile: options.profile }),
          }),
        );
      },
    );
  history
    .command("gc")
    .description(
      "plan or apply a retention policy: tombstone, unindex, and delete expired records (irreversible with --apply)",
    )
    .option(...storeOption)
    .requiredOption("--policy <path>", "retention policy JSON")
    .requiredOption(
      "--as-of <date-time>",
      "evaluate ages and holds at this time",
    )
    .option("--apply", "delete the planned records", false)
    .action(
      async (options: {
        store: string;
        policy: string;
        asOf: string;
        apply: boolean;
      }): Promise<void> => {
        printJson(
          await historyGc({
            store: options.store,
            policy: options.policy,
            asOf: options.asOf,
            apply: options.apply,
          }),
        );
      },
    );

  history
    .command("trends")
    .description(
      "recompute architecture trend metrics across stored revisions, in order",
    )
    .option(...storeOption)
    .option(
      "--revision <sha>",
      "a revision, oldest first (repeatable)",
      collect,
    )
    .option("--policy-record <id>", "policy record applied to every revision")
    .option(
      "--decisions-record <id>",
      "decisions record applied to every revision",
    )
    .option(
      "--policy-at <revision=id>",
      "use this policy record from that revision on (repeatable); the change is reported as a break",
      keyValue("--policy-at"),
      [],
    )
    .option(
      "--decisions-at <revision=id>",
      "use this decisions record from that revision on (repeatable)",
      keyValue("--decisions-at"),
      [],
    )
    .option(
      "--previous <path>",
      "an earlier trends report; changed values are listed as restatements",
    )
    .option(
      "--explanations <path>",
      "reviewer notes for known breaks (cartograph.trend-explanations)",
    )
    .action(
      async (options: {
        store: string;
        revision?: string[];
        policyRecord?: string;
        decisionsRecord?: string;
        policyAt: { key: string; value: string }[];
        decisionsAt: { key: string; value: string }[];
        previous?: string;
        explanations?: string;
      }): Promise<void> => {
        if (options.revision === undefined || options.revision.length === 0)
          throw new InvalidArgumentError("give at least one --revision");
        printJson(
          await historyTrends({
            store: options.store,
            revisions: options.revision,
            ...(options.policyRecord === undefined
              ? {}
              : { policyRecord: options.policyRecord }),
            ...(options.decisionsRecord === undefined
              ? {}
              : { decisionsRecord: options.decisionsRecord }),
            policyAt: options.policyAt.map((item) => ({
              revision: item.key,
              id: item.value,
            })),
            decisionsAt: options.decisionsAt.map((item) => ({
              revision: item.key,
              id: item.value,
            })),
            ...(options.previous === undefined
              ? {}
              : { previous: options.previous }),
            ...(options.explanations === undefined
              ? {}
              : { explanations: options.explanations }),
          }),
        );
      },
    );

  program
    .command("review")
    .description(
      "join a local GraphDiff with bounded lifecycle, ownership, waiver, policy, and ADR context",
    )
    .argument("<input>", "local review-summary input JSON")
    .option(
      "-f, --format <format>",
      "report format: json, markdown, or html",
      reportFormat,
      "markdown",
    )
    .option("-o, --output <path>", "output report file; stdout when omitted")
    .option("--force", "replace an existing output file", false)
    .action(
      async (
        input: string,
        options: OutputOptions & { format: ReportFormat },
      ): Promise<void> => {
        await emit(await reviewSummaryFile(input, options.format), options);
      },
    );

  program
    .command("policy")
    .description("evaluate a local policy against a graph snapshot or diff")
    .argument("[root]", "repository or project root", ".")
    .requiredOption(
      "--policy <path>",
      "repository-relative local policy JSON file",
    )
    .option("--snapshot <path>", "graph snapshot JSON input")
    .option("--diff <path>", "GraphDiff JSON input")
    .option(
      "--mode <mode>",
      "CI mode: informational or enforce; policy mode when omitted",
      policyMode,
    )
    .option(
      "--as-of <date-time>",
      "evaluation time for expiry-bound policy exceptions",
      policyAsOf,
    )
    .option(
      "--adr <path>",
      "repository-relative local ADR reference JSON for policy bindings",
    )
    .option(
      "--exception-window-days <days>",
      "days before expiry to classify an exception as expiring",
      exceptionWindowDays,
    )
    .option(
      "-f, --format <format>",
      "report format: json, or sarif for code scanning",
      policyOutputFormat,
      "json",
    )
    .option("-o, --output <path>", "output report; stdout when omitted")
    .option("--force", "replace an existing output file", false)
    .action(
      async (
        root: string,
        options: OutputOptions & {
          diff?: string;
          adr?: string;
          mode?: PolicyCiMode;
          asOf?: string;
          exceptionWindowDays?: number;
          format: "json" | "sarif";
          policy: string;
          snapshot?: string;
        },
      ): Promise<void> => {
        const hasSnapshot = options.snapshot !== undefined;
        const hasDiff = options.diff !== undefined;
        if (hasSnapshot === hasDiff) {
          throw new InvalidArgumentError(
            "exactly one of --snapshot or --diff is required",
          );
        }
        const input = options.snapshot ?? options.diff;
        if (input === undefined) {
          throw new InvalidArgumentError(
            "exactly one of --snapshot or --diff is required",
          );
        }
        const report = await evaluatePolicyFile({
          input,
          inputKind: hasSnapshot ? "snapshot" : "diff",
          ...(options.mode === undefined ? {} : { mode: options.mode }),
          ...(options.adr === undefined ? {} : { adr: options.adr }),
          ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
          ...(options.exceptionWindowDays === undefined
            ? {}
            : { expiringWithinDays: options.exceptionWindowDays }),
          policy: options.policy,
          root,
        });
        await emit(
          options.format === "sarif"
            ? await policyEvaluationSarif(
                report,
                input,
                hasSnapshot ? "snapshot" : "diff",
                VERSION,
              )
            : `${serializePolicyEvaluation(report)}\n`,
          options,
        );
        process.exitCode = policyCiExitCode(
          options.mode ?? report.mode,
          report,
        );
      },
    );

  program
    .command("migrate-snapshot")
    .description("migrate a legacy GraphSnapshot and report identity changes")
    .argument("<input>", "legacy GraphSnapshot v0 JSON")
    .requiredOption("--report <path>", "migration report output path")
    .option(
      "-o, --output <path>",
      "migrated snapshot output; stdout when omitted",
    )
    .option("--force", "replace existing output files", false)
    .action(
      async (
        input: string,
        options: OutputOptions & { report: string },
      ): Promise<void> => {
        const result = await migrateSnapshotFile(input);
        await emit(serializeGraphSnapshot(result.snapshot) + "\n", options);
        await writeOutputFile(
          options.report,
          serializeMigrationReport(result.report),
          options.force ?? false,
        );
      },
    );

  program
    .command("review-remediation")
    .description(
      "evaluate a human remediation review record without applying it",
    )
    .argument("<input>", "remediation review request JSON")
    .option(
      "--as-of <timestamp>",
      "evaluation timestamp; current time when omitted",
    )
    .option("-o, --output <path>", "output JSON report; stdout when omitted")
    .option("--force", "replace an existing output file", false)
    .action(
      async (
        input: string,
        options: OutputOptions & { asOf?: string },
      ): Promise<void> => {
        await emit(await reviewRemediationFile(input, options.asOf), options);
      },
    );

  return program;
}

export async function runCli(
  argv: readonly string[] = process.argv,
): Promise<void> {
  assertSupportedEnvironment();
  await createCli().parseAsync([...argv]);
}

const invokedDirectly = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return (
      pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
    );
  } catch {
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  }
})();

if (invokedDirectly) {
  runCli().catch((error: unknown) => {
    if (isCommanderControlError(error)) return;
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
