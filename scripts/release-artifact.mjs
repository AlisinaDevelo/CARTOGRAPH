#!/usr/bin/env node
/* global console, process */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(repositoryRoot, "package.json");
const packageLockPath = join(repositoryRoot, "package-lock.json");
const changelogPath = join(repositoryRoot, "CHANGELOG.md");
const fixturePath = join(
  repositoryRoot,
  "test",
  "fixtures",
  "typescript-express",
);

const fail = (message) => {
  throw new Error(message);
};

const sha256Digest = (value) =>
  createHash("sha256").update(value).digest("hex");

const normalizeSbom = (value, { lockfileSha256, sourceCommit }) => {
  if (
    value?.bomFormat !== "CycloneDX" ||
    value?.specVersion !== "1.5" ||
    !Array.isArray(value.components) ||
    !Array.isArray(value.dependencies)
  )
    fail("npm sbom did not produce a CycloneDX 1.5 dependency inventory");

  const metadata = { ...value.metadata };
  delete metadata.timestamp;
  delete metadata.serialNumber;
  metadata.tools = [
    {
      vendor: "CARTOGRAPH",
      name: "release-artifact",
      version: "1",
    },
  ];
  metadata.properties = [
    { name: "cartograph:lockfile-sha256", value: lockfileSha256 },
    { name: "cartograph:source-commit", value: sourceCommit },
  ];

  const components = [...value.components].sort((left, right) =>
    String(left["bom-ref"]).localeCompare(String(right["bom-ref"])),
  );
  const dependencies = [...value.dependencies]
    .map((dependency) => ({
      ...dependency,
      ...(Array.isArray(dependency.dependsOn)
        ? { dependsOn: [...dependency.dependsOn].sort() }
        : {}),
    }))
    .sort((left, right) => String(left.ref).localeCompare(String(right.ref)));

  return {
    ...value,
    serialNumber: undefined,
    metadata,
    components,
    dependencies,
  };
};

const serializeJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const packageJson = await readJson(packagePath);
const version = packageJson.version;
if (process.argv.includes("--help")) {
  console.log(
    "usage: release-artifact.mjs [--tag v0.1.0] [--output directory]",
  );
  process.exit(0);
}
const tag =
  argument("--tag") ?? process.env.CARTOGRAPH_RELEASE_TAG ?? `v${version}`;
const requestedOutput = argument("--output");

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag))
  fail(`release tag must be a semantic version tag such as v${version}`);
if (tag !== `v${version}`)
  fail(`release tag ${tag} does not match package version ${version}`);

const changelog = await readFile(changelogPath, "utf8");
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const heading = new RegExp(`^## \\[${escapedVersion}\\](?:\\s+-.*)?$`, "m");
const match = heading.exec(changelog);
if (match === null) fail(`CHANGELOG.md has no [${version}] release section`);
const sectionStart = match.index;
const nextHeading = changelog
  .slice(sectionStart + match[0].length)
  .search(/^## /m);
const releaseNotes = changelog
  .slice(
    sectionStart,
    nextHeading === -1
      ? changelog.length
      : sectionStart + match[0].length + nextHeading,
  )
  .trim();
if (!releaseNotes.includes("\n"))
  fail(`CHANGELOG.md [${version}] release section is empty`);

await access(fixturePath);
const sourceCommit =
  process.env.GITHUB_SHA ??
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
const lockfileSha256 = sha256Digest(await readFile(packageLockPath));
const npmVersion = execFileSync("npm", ["--version"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const outputRoot = requestedOutput
  ? resolve(requestedOutput)
  : await mkdtemp(join(tmpdir(), "cartograph-release-"));
const consumerRoot = await mkdtemp(
  join(tmpdir(), "cartograph-release-consumer-"),
);
const keepOutput = requestedOutput !== undefined;

try {
  await mkdir(outputRoot, { recursive: true });
  const existingOutput = await readdir(outputRoot);
  if (existingOutput.length > 0)
    fail(`release output directory is not empty: ${outputRoot}`);

  const packOutput = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", outputRoot, "--json"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const packResult = JSON.parse(packOutput)[0];
  if (packResult === undefined || typeof packResult.filename !== "string")
    fail("npm pack did not return a tarball filename");

  const tarballName = packResult.filename;
  const tarballPath = join(outputRoot, tarballName);
  const tarballRelative = relative(outputRoot, tarballPath);
  if (
    tarballRelative.startsWith("..") ||
    isAbsolute(tarballRelative) ||
    tarballRelative !== tarballName
  )
    fail("npm pack returned a tarball outside the release output directory");

  const tarballBytes = await readFile(tarballPath);
  const sha256 = sha256Digest(tarballBytes);
  const contentSha256 = sha256Digest(gunzipSync(tarballBytes));
  const integrity =
    typeof packResult.integrity === "string" ? packResult.integrity : undefined;
  const packedFiles = Array.isArray(packResult.files)
    ? packResult.files.map((file) => file.path)
    : [];
  if (packedFiles.length === 0)
    fail("npm pack did not report the package file set");
  const forbiddenPackagePath =
    /^(?:\.github|benchmarks|coverage|examples|scripts|test|tests|\.forge)\//u;
  const forbiddenFiles = packedFiles.filter((file) =>
    forbiddenPackagePath.test(file),
  );
  if (forbiddenFiles.length > 0)
    fail(
      `package includes source or fixture files: ${forbiddenFiles.join(", ")}`,
    );

  const sbomName = `${tarballName}.sbom.cdx.json`;
  const provenanceName = `${tarballName}.provenance.json`;
  const sbom = normalizeSbom(
    JSON.parse(
      execFileSync(
        "npm",
        [
          "sbom",
          "--package-lock-only",
          "--sbom-format",
          "cyclonedx",
          "--sbom-type",
          "library",
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
        },
      ),
    ),
    { lockfileSha256, sourceCommit },
  );
  const sbomText = serializeJson(sbom);
  const provenance = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: tarballName, digest: { sha256 } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType:
          "https://github.com/AlisinaDevelo/CARTOGRAPH/.github/workflows/release.yml",
        externalParameters: {
          repository:
            process.env.GITHUB_REPOSITORY ?? "AlisinaDevelo/CARTOGRAPH",
          ref: process.env.GITHUB_REF ?? `refs/tags/${tag}`,
          tag,
        },
        internalParameters: {
          nodeVersion: process.version,
          npmVersion,
          lockfileSha256,
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/AlisinaDevelo/CARTOGRAPH.git@${sourceCommit}`,
            digest: { sha1: sourceCommit },
          },
        ],
      },
      runDetails: {
        builder: {
          id:
            process.env.GITHUB_ACTIONS === "true"
              ? "https://github.com/actions/runner"
              : "https://github.com/AlisinaDevelo/CARTOGRAPH/local-release-builder",
        },
        metadata: {
          invocationId:
            process.env.GITHUB_RUN_ID ?? `local-${sourceCommit.slice(0, 12)}`,
          reproducible: true,
        },
      },
    },
  };
  if (
    provenance.subject[0].name !== tarballName ||
    provenance.subject[0].digest.sha256 !== sha256 ||
    provenance.predicate.buildDefinition.resolvedDependencies[0].digest.sha1 !==
      sourceCommit
  )
    fail("provenance statement does not bind the release subject");
  const provenanceText = serializeJson(provenance);
  const sbomSha256 = sha256Digest(sbomText);
  const provenanceSha256 = sha256Digest(provenanceText);
  const compatibilityName = "compatibility-matrix.json";
  const compatibilityPath = join(outputRoot, compatibilityName);
  execFileSync(
    process.execPath,
    [
      join(repositoryRoot, "scripts/release-compatibility.mjs"),
      "record",
      "--output",
      compatibilityPath,
      "--tag",
      tag,
      "--source-commit",
      sourceCommit,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const compatibilityText = await readFile(compatibilityPath, "utf8");
  const compatibility = JSON.parse(compatibilityText);
  const compatibilitySha256 = sha256Digest(compatibilityText);
  await writeFile(join(outputRoot, sbomName), sbomText);
  await writeFile(join(outputRoot, provenanceName), provenanceText);
  await writeFile(
    join(outputRoot, "SHA256SUMS"),
    [
      [sha256, tarballName],
      [sbomSha256, sbomName],
      [provenanceSha256, provenanceName],
      [compatibilitySha256, compatibilityName],
    ]
      .sort((left, right) => left[1].localeCompare(right[1]))
      .map(([digest, file]) => `${digest}  ${file}`)
      .join("\n") + "\n",
  );
  await writeFile(join(outputRoot, "release-notes.md"), `${releaseNotes}\n`);
  const metadata = {
    schemaVersion: 1,
    package: { name: packageJson.name, version },
    tag,
    sourceCommit,
    tarball: {
      file: tarballName,
      sha256,
      contentSha256,
      ...(integrity === undefined ? {} : { integrity }),
    },
    sbom: {
      file: sbomName,
      format: "CycloneDX 1.5",
      sha256: sbomSha256,
      lockfileSha256,
      components: sbom.components.length,
    },
    provenance: {
      file: provenanceName,
      sha256: provenanceSha256,
      predicateType: provenance.predicateType,
      subjectSha256: sha256,
    },
    compatibility: {
      file: compatibilityName,
      sha256: compatibilitySha256,
      matrixDigest: compatibility.matrixDigest,
      combinations: compatibility.combinations,
    },
    checksums: {
      file: "SHA256SUMS",
      files: [tarballName, sbomName, provenanceName, compatibilityName],
    },
    changelog: {
      source: "CHANGELOG.md",
      section: `[${version}]`,
      generatedFile: "release-notes.md",
    },
    smokeTest: {
      install: "npm install --offline --ignore-scripts <tarball>",
      commands: [
        "cartograph --version",
        "cartograph --help",
        "cartograph scan",
        "node --input-type=module -e import('cartograph-cli')",
      ],
      fixture: "test/fixtures/typescript-express",
    },
  };
  await writeFile(
    join(outputRoot, "release-metadata.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );

  execFileSync("npm", ["init", "-y"], {
    cwd: consumerRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarballPath,
    ],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const installedPackage = await readJson(
    join(consumerRoot, "node_modules", packageJson.name, "package.json"),
  );
  if (
    installedPackage.engines?.node !== packageJson.engines?.node ||
    installedPackage.bin?.cartograph !== "dist/cli.js" ||
    installedPackage.exports?.["."]?.import !== "./dist/index.js" ||
    installedPackage.exports?.["."]?.types !== "./dist/index.d.ts"
  )
    fail("packed artifact package, bin, export, or engine contract drifted");
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { scanRepository } from 'cartograph-cli';\nif (typeof scanRepository !== 'function') process.exit(1);",
    ],
    {
      cwd: consumerRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const installedCli = join(consumerRoot, "node_modules", ".bin", "cartograph");
  const installedVersion = execFileSync(installedCli, ["--version"], {
    cwd: consumerRoot,
    encoding: "utf8",
  }).trim();
  if (installedVersion !== version)
    fail(`installed CLI reported ${installedVersion}, expected ${version}`);
  execFileSync(installedCli, ["--help"], {
    cwd: consumerRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const snapshot = execFileSync(installedCli, ["scan", fixturePath], {
    cwd: consumerRoot,
    encoding: "utf8",
  });
  const parsedSnapshot = JSON.parse(snapshot);
  if (parsedSnapshot.schemaVersion !== 1 || parsedSnapshot.edges.length === 0)
    fail("installed CLI smoke scan did not produce a schema-valid graph");

  console.log(
    JSON.stringify(
      {
        tag,
        package: packageJson.name,
        version,
        tarball: tarballName,
        sha256,
        contentSha256,
        sbom: sbomName,
        provenance: provenanceName,
        compatibility: compatibilityName,
        sbomComponents: sbom.components.length,
        smokeTest: "passed",
        output: keepOutput ? outputRoot : "temporary output cleaned",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(consumerRoot, { recursive: true, force: true });
  if (!keepOutput) await rm(outputRoot, { recursive: true, force: true });
}
