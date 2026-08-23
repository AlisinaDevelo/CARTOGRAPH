#!/usr/bin/env node

import { realpathSync } from "node:fs";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Command, InvalidArgumentError } from "commander";

import {
  diffRepositoryRevisions,
  diffSnapshotFiles,
  scanRepository,
  serializeScan,
  writeOutputFile,
} from "./commands.js";
import type { ReportFormat } from "./report/render.js";

const VERSION = "0.1.0";

type OutputOptions = {
  force?: boolean;
  output?: string;
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
    .showSuggestionAfterError();

  program
    .command("scan")
    .alias("snapshot")
    .description("scan a working tree and emit a canonical graph snapshot")
    .argument("[root]", "repository or project root", ".")
    .option("--tsconfig <path>", "TypeScript configuration path")
    .option("-o, --output <path>", "output file; stdout when omitted")
    .option("--force", "replace an existing output file", false)
    .action(
      async (
        root: string,
        options: OutputOptions & { tsconfig?: string },
      ): Promise<void> => {
        const snapshot = scanRepository({
          root,
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
        },
      ): Promise<void> => {
        const report = await diffRepositoryRevisions({
          base: options.base,
          format: options.format,
          head: options.head,
          root,
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
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cartograph: ${message}\n`);
    process.exitCode = 1;
  });
}
