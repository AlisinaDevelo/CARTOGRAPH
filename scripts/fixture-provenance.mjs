#!/usr/bin/env node
/* global console, process */

import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

import Ajv from "ajv";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const fixturesRoot = resolve(repositoryRoot, "test/fixtures");
const manifestPath = resolve(fixturesRoot, "provenance.json");
const schemaPath = resolve(
  repositoryRoot,
  "schema/fixture-provenance.v0.1.schema.json",
);
const generatedDirectoryNames = new Set([
  ".cartograph",
  ".next",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "vendor",
]);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const fail = (message) => {
  throw new Error(message);
};

const containedFixturePath = (value) => {
  const candidate = resolve(fixturesRoot, value);
  const relativePath = relative(fixturesRoot, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith(sep)
  ) {
    fail(`fixture path escapes test/fixtures: ${value}`);
  }
  return candidate;
};

const discoverFixtureDirectories = () =>
  readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();

const generatedPaths = (fixtureRoot) => {
  const paths = [];
  const visit = (directory, relativeDirectory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink())
        fail(`fixture contains an unreviewed symbolic link: ${entry.name}`);
      const entryPath = resolve(directory, entry.name);
      const entryRelative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        if (generatedDirectoryNames.has(entry.name)) {
          paths.push(entryRelative);
          continue;
        }
        visit(entryPath, entryRelative);
      }
    }
  };
  visit(fixtureRoot, "");
  return paths.sort();
};

const validate = () => {
  const manifest = readJson(manifestPath);
  const schema = readJson(schemaPath);
  const validateSchema = new Ajv({ allErrors: true }).compile(schema);
  if (!validateSchema(manifest)) {
    fail(
      `fixture provenance schema validation failed: ${JSON.stringify(validateSchema.errors)}`,
    );
  }

  const entries = manifest.fixtures;
  const ids = new Set();
  const paths = new Set();
  const declaredGenerated = new Map();
  for (const entry of entries) {
    if (ids.has(entry.id)) fail(`duplicate fixture id: ${entry.id}`);
    ids.add(entry.id);
    if (paths.has(entry.path)) fail(`duplicate fixture path: ${entry.path}`);
    paths.add(entry.path);
    const fixturePath = containedFixturePath(entry.path);
    const metadata = lstatSync(fixturePath);
    if (!metadata.isDirectory())
      fail(`fixture path is not a directory: ${entry.path}`);
    for (const generated of entry.generated ?? []) {
      if (declaredGenerated.has(`${entry.path}/${generated.path}`)) {
        fail(`duplicate generated path: ${entry.path}/${generated.path}`);
      }
      declaredGenerated.set(
        `${entry.path}/${generated.path}`,
        generated.reason,
      );
      const generatedPath = resolve(fixturePath, generated.path);
      const generatedRelative = relative(fixturePath, generatedPath);
      if (
        generatedRelative === ".." ||
        generatedRelative.startsWith(`..${sep}`) ||
        generatedRelative.startsWith(sep)
      ) {
        fail(`generated path escapes fixture: ${entry.path}/${generated.path}`);
      }
      if (!lstatSync(generatedPath).isDirectory())
        fail(
          `declared generated path is not a directory: ${entry.path}/${generated.path}`,
        );
    }
  }

  const discovered = discoverFixtureDirectories();
  const missing = discovered.filter((path) => !paths.has(path));
  const extra = [...paths].filter((path) => !discovered.includes(path));
  if (missing.length > 0)
    fail(`fixtures missing provenance: ${missing.join(", ")}`);
  if (extra.length > 0)
    fail(`manifest entries are not fixture directories: ${extra.join(", ")}`);

  let generatedCount = 0;
  for (const fixtureName of discovered) {
    const fixturePath = containedFixturePath(fixtureName);
    for (const generatedPath of generatedPaths(fixturePath)) {
      const key = `${fixtureName}/${generatedPath}`;
      if (!declaredGenerated.has(key))
        fail(`generated output lacks a declared reason: ${key}`);
      generatedCount += 1;
    }
  }

  return {
    ok: true,
    manifest: manifestPath,
    fixtures: discovered.length,
    generatedDirectories: generatedCount,
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node scripts/fixture-provenance.mjs validate [--root path]",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(`fixture provenance validation failed: ${error.message}`);
  process.exit(1);
}
