#!/usr/bin/env node
/* global console, process */

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";

const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repositoryRoot = resolve(argumentValue("--root") ?? process.cwd());
const fixturePath = resolve(
  repositoryRoot,
  argumentValue("--fixture") ??
    "test/fixtures/patch-previews/scenarios.v0.1.json",
);

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));
const fail = (message) => {
  throw new Error(message);
};

const validate = async () => {
  const fixture = readJson(fixturePath);
  const fixtureSchema = readJson(
    resolve(repositoryRoot, "schema/patch-preview-fixtures.v0.1.schema.json"),
  );
  const requestSchema = readJson(
    resolve(repositoryRoot, "schema/patch-preview.v0.1.schema.json"),
  );
  const reportSchema = readJson(
    resolve(repositoryRoot, "schema/patch-preview-report.v0.1.schema.json"),
  );
  const ajv = new Ajv({ allErrors: true });
  const validateFixture = ajv.compile(fixtureSchema);
  const validateRequest = ajv.compile(requestSchema);
  const validateReport = ajv.compile(reportSchema);
  if (!validateFixture(fixture))
    fail(
      `fixture schema validation failed: ${JSON.stringify(validateFixture.errors)}`,
    );

  const {
    PATCH_PREVIEW_CONTRACT,
    PATCH_PREVIEW_SCHEMA_VERSION,
    PatchPreviewError,
    patchContentDigest,
    previewPatch,
    serializePatchPreviewReport,
  } = await import("../src/core/index.ts");
  const sourceRef = "HEAD";
  const source = execFileSync(
    "git",
    ["-C", repositoryRoot, "show", `${sourceRef}:README.md`],
    { encoding: "utf8", maxBuffer: 512 * 1024 },
  );
  const request = {
    schemaVersion: PATCH_PREVIEW_SCHEMA_VERSION,
    contract: PATCH_PREVIEW_CONTRACT,
    previewId: "validator-preview",
    sourceRef,
    operations: [
      {
        path: "README.md",
        expectedDigest: patchContentDigest(source),
        replacement: `${source}\n`,
      },
    ],
    validationCommands: ["verify-patch", "node-version"],
  };
  if (!validateRequest(request))
    fail(
      `request schema validation failed: ${JSON.stringify(validateRequest.errors)}`,
    );
  const beforeStatus = readFileSync(
    resolve(repositoryRoot, "README.md"),
    "utf8",
  );
  const report = await previewPatch({
    root: repositoryRoot,
    request,
  });
  if (!validateReport(report))
    fail(
      `report schema validation failed: ${JSON.stringify(validateReport.errors)}`,
    );
  if (report.status !== "passed" || !report.worktreePreserved)
    fail(`isolated preview did not pass safely: ${JSON.stringify(report)}`);
  if (
    readFileSync(resolve(repositoryRoot, "README.md"), "utf8") !== beforeStatus
  )
    fail("isolated preview changed the original README");
  try {
    await previewPatch({
      root: repositoryRoot,
      request: {
        ...request,
        previewId: "malicious-path-preview",
        operations: [
          {
            ...request.operations[0],
            path: "../outside.txt",
          },
        ],
      },
    });
    fail("malicious path should have been rejected");
  } catch (error) {
    if (!(error instanceof PatchPreviewError) || error.code !== "invalid-input")
      throw error;
  }

  console.log(
    JSON.stringify({
      ok: true,
      schemaVersion: PATCH_PREVIEW_SCHEMA_VERSION,
      contract: PATCH_PREVIEW_CONTRACT,
      status: report.status,
      sourceCommit: report.sourceCommit,
      requestDigest: report.requestDigest,
      validation: report.validation.map((result) => ({
        command: result.command,
        status: result.status,
      })),
      serializedBytes: Buffer.byteLength(serializePatchPreviewReport(report)),
    }),
  );
};

if (process.argv[2] !== "validate") {
  console.error(
    "usage: node --import tsx scripts/patch-previews.mjs validate [--fixture path]",
  );
  process.exit(2);
}

try {
  await validate();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`patch preview validation failed: ${message}`);
  process.exit(1);
}
