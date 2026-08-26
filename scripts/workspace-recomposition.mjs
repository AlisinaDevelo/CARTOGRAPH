#!/usr/bin/env node
/* global console, process */

import { performance } from "node:perf_hooks";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import Ajv from "ajv";

import {
  WorkspaceRecompositionCacheError,
  parseWorkspaceRecompositionCache,
  parseWorkspaceRecompositionRequest,
  recomposeWorkspace,
  serializeWorkspaceRecompositionCache,
  writeWorkspaceRecompositionCacheAtomic,
  readWorkspaceRecompositionCache,
} from "../src/core/index.ts";

const repositoryRoot = resolve(process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/workspace-recomposition/request.v0.1.json",
);
const schemaPath = resolve(
  repositoryRoot,
  "schema/workspace-recomposition.v0.1.schema.json",
);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(`workspace recomposition validation failed: ${message}`);
};

const withoutResults = (request) => ({
  ...request,
  units: request.units.map(({ result: _result, ...unit }) => unit),
});

const validate = () => {
  const input = readJson(fixturePath);
  const request = parseWorkspaceRecompositionRequest(input);
  const schemaValidator = new Ajv({ allErrors: true }).compile(
    readJson(schemaPath),
  );
  if (!schemaValidator(request)) {
    fail(
      `published schema rejected request: ${JSON.stringify(schemaValidator.errors)}`,
    );
  }

  const coldStarted = performance.now();
  const cold = recomposeWorkspace(request);
  const coldMs = performance.now() - coldStarted;
  if (cold.stats.recomputed !== request.units.length)
    fail("cold run did not recompute every unit");
  if (!schemaValidator(cold))
    fail(
      `published schema rejected cold plan: ${JSON.stringify(schemaValidator.errors)}`,
    );

  const warmStarted = performance.now();
  const warm = recomposeWorkspace(withoutResults(request), cold.cache);
  const warmMs = performance.now() - warmStarted;
  if (warm.stats.hits !== request.units.length)
    fail("warm run did not hit every cached unit");
  if (
    serializeWorkspaceRecompositionCache(warm.cache) !==
    serializeWorkspaceRecompositionCache(cold.cache)
  ) {
    fail("warm cache changed the byte-stable cached results");
  }

  const partialInput = JSON.parse(JSON.stringify(input));
  partialInput.inputs = partialInput.inputs.map((item) =>
    item.id === "alpha-content"
      ? {
          ...item,
          digest:
            "sha256:9999999999999999999999999999999999999999999999999999999999999999",
        }
      : item,
  );
  const partial = recomposeWorkspace(partialInput, cold.cache);
  const partialStatuses = new Map(
    partial.units.map((unit) => [unit.id, unit.status]),
  );
  if (partialStatuses.get("alpha-snapshot") !== "recomputed")
    fail("changed alpha input was not recomputed");
  if (partialStatuses.get("boundary-composition") !== "recomputed")
    fail("dependent boundary unit was not recomputed");
  if (partialStatuses.get("beta-snapshot") !== "hit")
    fail("unrelated beta unit was invalidated");
  if (!partial.changedInputIds.includes("alpha-content"))
    fail("partial run omitted the changed input identity");

  const forged = JSON.parse(JSON.stringify(cold.cache));
  forged.entries[0].resultDigest =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  try {
    parseWorkspaceRecompositionCache(forged);
    fail("forged cache result digest was accepted");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }

  const root = mkdtempSync(join(tmpdir(), "cartograph-recomposition-"));
  const cachePath = join(root, "cache.json");
  try {
    writeWorkspaceRecompositionCacheAtomic(cachePath, cold.cache);
    const beforeInterrupted = serializeWorkspaceRecompositionCache(
      readWorkspaceRecompositionCache(cachePath),
    );
    try {
      writeWorkspaceRecompositionCacheAtomic(cachePath, partial.cache, {
        beforeCommit: () => {
          throw new Error("synthetic interruption");
        },
      });
      fail("interrupted atomic write unexpectedly committed");
    } catch (error) {
      if (
        !(error instanceof WorkspaceRecompositionCacheError) ||
        error.code !== "cache-corrupt"
      )
        throw error;
    }
    const afterInterrupted = serializeWorkspaceRecompositionCache(
      readWorkspaceRecompositionCache(cachePath),
    );
    if (afterInterrupted !== beforeInterrupted)
      fail("interrupted atomic write changed the prior cache");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  return {
    ok: true,
    inputs: request.inputs.length,
    units: request.units.length,
    cold: {
      milliseconds: Number(coldMs.toFixed(3)),
      recomputed: cold.stats.recomputed,
    },
    warm: { milliseconds: Number(warmMs.toFixed(3)), hits: warm.stats.hits },
    measuredSpeedup: Number((coldMs / Math.max(warmMs, 0.001)).toFixed(3)),
    partial: {
      changedInputIds: partial.changedInputIds,
      hits: partial.stats.hits,
      recomputed: partial.stats.recomputed,
    },
    atomic: "preserved-prior-cache-on-interruption",
  };
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/workspace-recomposition.mjs validate",
  );
  process.exit(2);
}

try {
  console.log(JSON.stringify(validate()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
