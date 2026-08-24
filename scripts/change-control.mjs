#!/usr/bin/env node
/* global console, process */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import Ajv from "ajv";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const registerRelativePath = "schema/change-control.v0.1.json";
const registerPath = resolve(
  repositoryRoot,
  argumentValue("--register") ?? registerRelativePath,
);
const schemaPath = resolve(
  repositoryRoot,
  argumentValue("--schema") ?? "schema/change-control.v0.1.schema.json",
);

const fail = (message) => {
  throw new Error(message);
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    fail(`could not read JSON ${path}: ${detail}`);
  }
};

const strictDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

const portablePath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.startsWith("/") &&
  !value.startsWith("\\") &&
  !value.startsWith("~") &&
  !/^[A-Za-z]:[\\/]/u.test(value) &&
  !value.includes("\0") &&
  !value.split(/[\\/]/u).includes("..");

const containedPath = (candidate, label) => {
  if (!portablePath(candidate))
    fail(`${label} must be a portable repository path`);
  const resolved = resolve(repositoryRoot, candidate);
  const relativePath = relative(repositoryRoot, resolved);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  )
    fail(`${label} escapes the repository: ${candidate}`);
  return resolved;
};

const requireFile = (candidate, label) => {
  const path = containedPath(candidate, label);
  if (!existsSync(path) || !lstatSync(path).isFile())
    fail(`${label} does not name an existing regular file: ${candidate}`);
};

const changedFilesFor = (baseRef) => {
  if (!baseRef) return [];
  try {
    return execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
      cwd: repositoryRoot,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`could not inspect base ref ${baseRef}: ${detail}`);
  }
};

const previousRegister = (baseRef) => {
  if (!baseRef) return undefined;
  try {
    return JSON.parse(
      execFileSync("git", ["show", `${baseRef}:${registerRelativePath}`], {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return undefined;
  }
};

const validate = () => {
  const register = readJson(registerPath);
  const schema = readJson(schemaPath);
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(register))
    fail(
      `change-control schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  if (register.registerVersion !== 1)
    fail("unsupported change-control register version");
  if (!strictDate(register.asOf))
    fail(`invalid register asOf date: ${register.asOf}`);

  const ids = new Set();
  const asOf =
    argumentValue("--as-of") ??
    process.env.CARTOGRAPH_CHANGE_CONTROL_AS_OF ??
    new Date().toISOString().slice(0, 10);
  if (!strictDate(asOf))
    fail(`--as-of must be a real YYYY-MM-DD date: ${asOf}`);
  const overdue = [];
  let deprecated = 0;
  let removed = 0;
  for (const entry of register.entries) {
    if (ids.has(entry.id)) fail(`duplicate change-control entry: ${entry.id}`);
    ids.add(entry.id);
    if (!strictDate(entry.reviewDate))
      fail(`invalid review date for ${entry.id}: ${entry.reviewDate}`);
    if (
      entry.status !== "active" &&
      entry.status !== "deprecated" &&
      entry.status !== "removed"
    )
      fail(`unsupported status for ${entry.id}: ${entry.status}`);
    if (entry.status === "deprecated" || entry.status === "removed") {
      if (entry.status === "deprecated") deprecated += 1;
      else removed += 1;
      if (
        typeof entry.replacement !== "string" ||
        entry.replacement.length === 0 ||
        typeof entry.deprecationReason !== "string" ||
        !strictDate(entry.deprecatedSince) ||
        !entry.removalGate
      )
        fail(
          `${entry.status} entry ${entry.id} is missing replacement, reason, date, or removal gate`,
        );
      requireFile(
        entry.removalGate.migrationNote,
        `${entry.id} migration note`,
      );
      for (const fixture of entry.removalGate.fixtureUpdate)
        requireFile(fixture, `${entry.id} fixture update`);
    } else if (
      entry.replacement !== null ||
      entry.deprecationReason !== null ||
      entry.deprecatedSince !== null ||
      entry.removalGate !== null
    ) {
      fail(
        `active entry ${entry.id} must not carry deprecation or removal metadata`,
      );
    }
    if (entry.status !== "removed" && entry.reviewDate < asOf)
      overdue.push({
        id: entry.id,
        reviewDate: entry.reviewDate,
        status: entry.status,
      });
  }

  const explicitBaseRef = argumentValue("--base-ref");
  const baseRef =
    explicitBaseRef ??
    (process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : undefined);
  const previous = previousRegister(baseRef);
  const changedFiles = changedFilesFor(baseRef);
  const removedIds =
    previous?.entries?.map((entry) => entry.id).filter((id) => !ids.has(id)) ??
    [];
  if (removedIds.length > 0) {
    const hasMigrationNote = changedFiles.some(
      (file) =>
        file.startsWith("schema/migrations/") ||
        file === "docs/IDENTITY_MIGRATION.md",
    );
    const hasFixtureUpdate = changedFiles.some((file) =>
      file.startsWith("test/fixtures/"),
    );
    if (!hasMigrationNote || !hasFixtureUpdate)
      fail(
        `register entries cannot be deleted without a migration note and fixture update: ${removedIds.join(", ")}`,
      );
  }

  const result = {
    ok: overdue.length === 0,
    registerVersion: register.registerVersion,
    asOf,
    entries: register.entries.length,
    deprecated,
    removed,
    overdue,
    ...(baseRef ? { baseRef, deletedEntries: removedIds } : {}),
  };
  console.log(JSON.stringify(result));
  if (overdue.length > 0)
    fail(
      `overdue change-control entries: ${overdue.map((entry) => `${entry.id} (review ${entry.reviewDate})`).join(", ")}`,
    );
  return result;
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node scripts/change-control.mjs validate [--as-of YYYY-MM-DD] [--base-ref ref]",
  );
  process.exit(2);
}

try {
  validate();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`change-control validation failed: ${message}`);
  process.exit(1);
}
