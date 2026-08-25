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
import type { RevisionComparisonMode } from "./git/revision.js";

const VERSION = "0.1.0";

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
        },
      ): Promise<void> => {
        const config = readConfigOption(root, options.config);
        const report = await diffRepositoryRevisions({
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
    .option("-o, --output <path>", "output JSON report; stdout when omitted")
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
        await emit(`${serializePolicyEvaluation(report)}\n`, options);
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
