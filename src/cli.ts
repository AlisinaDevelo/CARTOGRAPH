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
  migrateSnapshotFile,
  reviewRemediationFile,
  scanRepository,
  serializeScan,
  writeOutputFile,
} from "./commands.js";
import {
  readCartographConfig,
  serializeGraphSnapshot,
  serializeMigrationReport,
  type CartographConfig,
} from "./core/index.js";
import type { ReportFormat } from "./report/render.js";

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
      "Evidence-backed architecture change control for TypeScript codebases",
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
    .option("-o, --output <path>", "output file; stdout when omitted")
    .option("--force", "replace an existing output file", false)
    .action(
      async (
        root: string,
        options: OutputOptions & {
          base: string;
          format: ReportFormat;
          head: string;
          tsconfig?: string;
          config?: string;
        },
      ): Promise<void> => {
        const config = readConfigOption(root, options.config);
        const report = await diffRepositoryRevisions({
          base: options.base,
          format: options.format,
          head: options.head,
          root,
          ...(config === undefined ? {} : { config }),
          ...(options.tsconfig === undefined
            ? {}
            : { tsconfigPath: options.tsconfig }),
        });
        await emit(report, options);
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
