import { constants, readdirSync } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  ASSURANCE_BUNDLE_LIMITS,
  ASSURANCE_BUNDLE_MANIFEST,
  ASSURANCE_BUNDLE_ROLES,
  AssuranceBundleError,
  AssuranceBundleManifestSchema,
  AssuranceSigningKeyringSchema,
  SHARING_PROFILES,
  checkBundleSharing,
  collectRepositoryPaths,
  createHostPseudonymizer,
  createPathPseudonymizer,
  redactArtifactForSharing,
  rewriteArtifactStrings,
  assuranceBundleSigningPayload,
  buildAssuranceBundle,
  verifyAssuranceBundle,
  verifyAssuranceBundleSignature,
  type AssuranceBundleSignatureResult,
  type AssuranceBundleSigningRequest,
  type AssuranceBundleRole,
  type AssuranceBundleVerification,
  type AssuranceBundleManifest,
  type SharingArtifact,
  type SharingProfile,
  type SharingReport,
} from "./core/index.js";
import { analyzerFingerprint } from "./scan-cache.js";

export type BundleCreateOptions = {
  output: string;
  artifacts: readonly { role: string; path: string }[];
  missing: readonly { role: string; reason: string }[];
  requiredRoles?: readonly string[];
  /** Refuse to write the bundle if it is unsafe to share under this profile. */
  profile?: string;
  toolVersion: string;
};

const roleOf = (value: string): AssuranceBundleRole => {
  if (!(value in ASSURANCE_BUNDLE_ROLES))
    throw new AssuranceBundleError(
      `unknown bundle role ${JSON.stringify(value)}; expected one of ${Object.keys(ASSURANCE_BUNDLE_ROLES).join(", ")}`,
    );
  return value as AssuranceBundleRole;
};

const readInput = async (path: string): Promise<Uint8Array> => {
  const metadata = await lstat(resolve(path));
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new AssuranceBundleError(
      `bundle input is not a regular file: ${path}`,
    );
  if (metadata.size > ASSURANCE_BUNDLE_LIMITS.maxArtifactBytes)
    throw new AssuranceBundleError(
      `bundle input exceeds the ${ASSURANCE_BUNDLE_LIMITS.maxArtifactBytes} byte ceiling: ${path}`,
    );
  return await readFile(resolve(path));
};

const writeNew = async (path: string, content: Uint8Array | string) => {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
};

/** Write a new bundle directory; refuses to reuse a non-empty directory. */
export async function createBundle(
  options: BundleCreateOptions,
): Promise<{ bundleId: string; artifacts: number; output: string }> {
  const inputs = await Promise.all(
    options.artifacts.map(async (artifact) => ({
      role: roleOf(artifact.role),
      content: await readInput(artifact.path),
    })),
  );
  const built = buildAssuranceBundle(inputs, {
    toolVersion: options.toolVersion,
    analyzerFingerprint: analyzerFingerprint(),
    ...(options.requiredRoles === undefined
      ? {}
      : { requiredRoles: options.requiredRoles.map(roleOf) }),
    missing: options.missing.map((item) => ({
      role: roleOf(item.role),
      reason: item.reason,
    })),
  });
  if (options.profile !== undefined) {
    const check = checkBundleSharing(builtArtifacts(built), {
      profile: profileOf(options.profile),
    });
    if (!check.ok)
      throw new AssuranceBundleError(
        `bundle is not safe to share under the ${check.profile} profile (${check.findings.length} finding(s)); run \`cartograph bundle check\` on an unprofiled build, or \`bundle share\``,
      );
  }
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });
  if (readdirSync(output).length > 0)
    throw new AssuranceBundleError(
      `bundle output directory is not empty: ${options.output}`,
    );
  await mkdir(join(output, "artifacts"));
  for (const [path, content] of built.files)
    await writeNew(join(output, path), content);
  await writeNew(join(output, ASSURANCE_BUNDLE_MANIFEST), built.manifest);
  const manifest = JSON.parse(built.manifest) as { bundleId: string };
  return { bundleId: manifest.bundleId, artifacts: built.files.size, output };
}

const listBundleFiles = (root: string): string[] => {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink())
        throw new AssuranceBundleError(
          `bundle contains a symbolic link: ${name}`,
        );
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(name);
      else
        throw new AssuranceBundleError(
          `bundle contains a special file: ${name}`,
        );
    }
  };
  visit(root);
  return files.sort();
};

const readJsonFile = async (path: string, label: string): Promise<unknown> => {
  const metadata = await lstat(resolve(path));
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 4 * 1024 * 1024
  )
    throw new AssuranceBundleError(
      `${label} is not a regular file under 4 MiB: ${path}`,
    );
  try {
    return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  } catch {
    throw new AssuranceBundleError(`${label} is not valid JSON: ${path}`);
  }
};

/** The unsigned record and exact payload to sign for a bundle. */
export async function bundleSigningPayload(
  directory: string,
  request: AssuranceBundleSigningRequest,
): Promise<ReturnType<typeof assuranceBundleSigningPayload>> {
  const manifest = await readFile(
    join(resolve(directory), ASSURANCE_BUNDLE_MANIFEST),
    "utf8",
  );
  return assuranceBundleSigningPayload(manifest, request);
}

export type BundleSignatureOptions = {
  signature: string;
  keyring: string;
  trustRoots: readonly string[];
  asOf?: string;
};

/** Verify a bundle directory offline, and its signature when one is given. */
export async function verifyBundle(
  directory: string,
  signatureOptions?: BundleSignatureOptions,
): Promise<
  AssuranceBundleVerification & { signature?: AssuranceBundleSignatureResult }
> {
  const root = resolve(directory);
  const files = listBundleFiles(root);
  const contents = new Map<string, Uint8Array>();
  let total = 0;
  for (const file of files) {
    const content = await readFile(join(root, file));
    total += content.byteLength;
    if (total > ASSURANCE_BUNDLE_LIMITS.maxTotalBytes + 16 * 1024 * 1024)
      throw new AssuranceBundleError("bundle exceeds its total byte ceiling");
    contents.set(file, content);
  }
  const report = verifyAssuranceBundle(files, (path) => {
    const content = contents.get(path);
    if (content === undefined)
      throw new AssuranceBundleError(`missing ${path}`);
    return content;
  });
  if (signatureOptions === undefined) return report;
  const manifest = contents.get(ASSURANCE_BUNDLE_MANIFEST);
  const signature: AssuranceBundleSignatureResult =
    manifest === undefined
      ? { status: "failed", code: "manifest-missing" }
      : verifyAssuranceBundleSignature(
          Buffer.from(manifest).toString("utf8"),
          await readJsonFile(signatureOptions.signature, "signature record"),
          {
            keyring: AssuranceSigningKeyringSchema.parse(
              await readJsonFile(signatureOptions.keyring, "keyring"),
            ),
            trustedRootIds: signatureOptions.trustRoots,
            ...(signatureOptions.asOf === undefined
              ? {}
              : { now: signatureOptions.asOf }),
          },
        );
  return {
    ...report,
    ok: report.ok && signature.status === "verified",
    signature,
  };
}

const builtArtifacts = (built: {
  manifest: string;
  files: Map<string, Uint8Array>;
}): SharingArtifact[] => [
  {
    path: ASSURANCE_BUNDLE_MANIFEST,
    role: "manifest",
    content: Buffer.from(built.manifest, "utf8"),
  },
  ...[...built.files].map(([path, content]) => ({
    path,
    role: roleOf(
      /^artifacts\/(.+)-[0-9a-f]{12}\.[a-z]+$/u.exec(path)?.[1] ?? "",
    ),
    content,
  })),
];

const readVerifiedBundle = async (
  directory: string,
): Promise<{
  manifest: AssuranceBundleManifest;
  artifacts: SharingArtifact[];
}> => {
  const verification = await verifyBundle(directory);
  if (!verification.ok)
    throw new AssuranceBundleError(
      "bundle does not verify; run `cartograph bundle verify` for details",
    );
  const root = resolve(directory);
  const manifestText = await readFile(
    join(root, ASSURANCE_BUNDLE_MANIFEST),
    "utf8",
  );
  const manifest = AssuranceBundleManifestSchema.parse(
    JSON.parse(manifestText) as unknown,
  );
  const artifacts: SharingArtifact[] = [
    {
      path: ASSURANCE_BUNDLE_MANIFEST,
      role: "manifest",
      content: Buffer.from(manifestText, "utf8"),
    },
  ];
  for (const artifact of manifest.artifacts)
    artifacts.push({
      path: artifact.path,
      role: artifact.role,
      content: await readFile(join(root, artifact.path)),
    });
  return { manifest, artifacts };
};

const profileOf = (value: string): SharingProfile => {
  const profile = SHARING_PROFILES.find((candidate) => candidate === value);
  if (profile === undefined)
    throw new AssuranceBundleError(
      `unknown sharing profile ${JSON.stringify(value)}; expected one of ${SHARING_PROFILES.join(", ")}`,
    );
  return profile;
};

/** Check a verified bundle for content unsafe to share with a recipient. */
export async function checkBundle(
  directory: string,
  options: { profile: string; allowedHosts?: readonly string[] },
): Promise<SharingReport> {
  const { artifacts } = await readVerifiedBundle(directory);
  return checkBundleSharing(artifacts, {
    profile: profileOf(options.profile),
    ...(options.allowedHosts === undefined
      ? {}
      : { allowedHosts: options.allowedHosts }),
  });
}

/** Roles a public profile leaves out unless they are asked for by name. */
export const PUBLIC_PROFILE_EXCLUDED_ROLES: readonly AssuranceBundleRole[] = [
  "configuration",
  "adapter-manifest",
];

export type BundleShareOptions = {
  input: string;
  output: string;
  profile: string;
  keyFile?: string;
  allowedHosts?: readonly string[];
  includeRoles?: readonly string[];
  toolVersion: string;
};

export type BundleShareResult = {
  ok: true;
  profile: SharingProfile;
  sourceBundleId: string;
  bundleId: string;
  artifacts: number;
  excludedRoles: AssuranceBundleRole[];
  pathsPseudonymized: number;
  redactions: number;
};

/**
 * Derive a shareable bundle from a verified one: drop roles the profile
 * excludes, pseudonymize repository paths with a local key, redact detected
 * values field by field, and rebuild. The result must still satisfy every
 * contract and pass the sharing check, or nothing is written.
 */
export async function shareBundle(
  options: BundleShareOptions,
): Promise<BundleShareResult> {
  const profile = profileOf(options.profile);
  if (profile === "public" && options.keyFile === undefined)
    throw new AssuranceBundleError(
      "the public profile pseudonymizes repository paths; give --key-file with at least 32 random bytes",
    );
  const { manifest, artifacts } = await readVerifiedBundle(options.input);
  const included = new Set((options.includeRoles ?? []).map(roleOf));
  const excludedRoles =
    profile === "public"
      ? PUBLIC_PROFILE_EXCLUDED_ROLES.filter(
          (role) =>
            !included.has(role) &&
            manifest.artifacts.some((item) => item.role === role),
        )
      : [];
  const kept = artifacts.filter(
    (artifact) =>
      artifact.role !== "manifest" && !excludedRoles.includes(artifact.role),
  );
  const sharingOptions = {
    profile,
    ...(options.allowedHosts === undefined
      ? {}
      : { allowedHosts: options.allowedHosts }),
  };
  let rewrite = (text: string): string => text;
  let pathsPseudonymized = 0;
  if (options.keyFile !== undefined) {
    const key = await readInput(options.keyFile);
    const paths = collectRepositoryPaths(kept);
    pathsPseudonymized = paths.length;
    const pseudonymizePaths = createPathPseudonymizer(key, paths);
    const hosts =
      profile === "public"
        ? createHostPseudonymizer(key, options.allowedHosts)
        : (text: string): string => text;
    rewrite = (text) => pseudonymizePaths(hosts(text));
  }
  let redactions = 0;
  const clean = (text: string): string => {
    const result = redactArtifactForSharing(
      {
        path: "text",
        role: "manifest",
        content: Buffer.from(JSON.stringify(rewrite(text)), "utf8"),
      },
      sharingOptions,
    );
    redactions += result.redactions;
    return JSON.parse(result.content) as string;
  };
  const inputs = kept.map((artifact) => {
    if (artifact.role === "manifest")
      throw new AssuranceBundleError("unreachable");
    const pseudonymized = rewriteArtifactStrings(artifact, rewrite);
    const redacted = redactArtifactForSharing(
      { ...artifact, content: Buffer.from(pseudonymized, "utf8") },
      sharingOptions,
    );
    redactions += redacted.redactions;
    const label = manifest.artifacts.find(
      (item) => item.path === artifact.path,
    )?.label;
    return {
      role: artifact.role,
      content: Buffer.from(redacted.content, "utf8"),
      ...(label === undefined ? {} : { label: clean(label) }),
    };
  });
  let built: ReturnType<typeof buildAssuranceBundle>;
  try {
    built = buildAssuranceBundle(inputs, {
      toolVersion: options.toolVersion,
      analyzerFingerprint: analyzerFingerprint(),
      requiredRoles: manifest.requiredRoles,
      missing: [
        ...manifest.missing.map((item) => ({
          role: item.role,
          reason: clean(item.reason),
        })),
        ...excludedRoles.map((role) => ({
          role,
          reason: `excluded by the ${profile} sharing profile`,
        })),
      ],
    });
  } catch (error) {
    const role =
      error instanceof AssuranceBundleError
        ? /^([a-z-]+) artifact/u.exec(error.message)?.[1]
        : undefined;
    throw new AssuranceBundleError(
      `${role ?? "an"} artifact no longer satisfies its contract after redaction; remove the flagged values at their source and rebuild the bundle`,
    );
  }
  const check = checkBundleSharing(builtArtifacts(built), sharingOptions);
  if (!check.ok)
    throw new AssuranceBundleError(
      `shared bundle still has ${check.findings.length} sharing finding(s); run \`cartograph bundle check\` on the source bundle`,
    );
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });
  if (readdirSync(output).length > 0)
    throw new AssuranceBundleError(
      `bundle output directory is not empty: ${options.output}`,
    );
  await mkdir(join(output, "artifacts"));
  for (const [path, content] of built.files)
    await writeNew(join(output, path), content);
  await writeNew(join(output, ASSURANCE_BUNDLE_MANIFEST), built.manifest);
  return {
    ok: true,
    profile,
    sourceBundleId: manifest.bundleId,
    bundleId: (JSON.parse(built.manifest) as { bundleId: string }).bundleId,
    artifacts: built.files.size,
    excludedRoles,
    pathsPseudonymized,
    redactions,
  };
}
