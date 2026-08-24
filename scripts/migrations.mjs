#!/usr/bin/env node
/* global console, process */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(process.cwd());
const readJson = (relativePath) =>
  JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
const requireFile = (relativePath) => {
  if (!existsSync(resolve(repositoryRoot, relativePath)))
    throw new Error(
      `migration matrix references missing file: ${relativePath}`,
    );
};

const check = () => {
  const matrix = readJson("schema/migrations/migration-matrix.v0.1.json");
  if (matrix.schemaVersion !== 1 || matrix.contract !== "GraphSnapshot")
    throw new Error("migration matrix has an unsupported contract header");
  if (
    matrix.currentVersion !== 1 ||
    JSON.stringify(matrix.supportedReaders) !== "[1]"
  )
    throw new Error("migration matrix current reader policy drift");
  if (!Array.isArray(matrix.transitions) || matrix.transitions.length === 0)
    throw new Error("migration matrix must declare at least one transition");

  for (const transition of matrix.transitions) {
    for (const field of [
      "command",
      "library",
      "implementation",
      "fixture",
      "report",
    ]) {
      if (
        typeof transition[field] !== "string" ||
        transition[field].length === 0
      )
        throw new Error(`migration transition is missing ${field}`);
    }
    if (
      transition.mode !== "automatic-with-review" ||
      transition.manualReviewGate !== "required"
    )
      throw new Error("migration transition must require manual review");
    requireFile(transition.implementation);
    requireFile(transition.fixture);
    requireFile("schema/migrations/snapshot-v0-to-v1.md");
    const fixture = readJson(transition.fixture);
    if (fixture.schemaVersion !== transition.sourceVersion)
      throw new Error(`migration fixture version drift: ${transition.fixture}`);
  }

  return {
    ok: true,
    contract: matrix.contract,
    currentVersion: matrix.currentVersion,
    transitions: matrix.transitions.length,
  };
};

if (process.argv[2] !== "validate") {
  console.error("usage: node scripts/migrations.mjs validate");
  process.exit(2);
}

try {
  console.log(JSON.stringify(check()));
} catch (error) {
  console.error(`migration matrix validation failed: ${error.message}`);
  process.exit(1);
}
