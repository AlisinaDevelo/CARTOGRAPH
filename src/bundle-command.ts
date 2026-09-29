import { constants, readdirSync } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import {
  ASSURANCE_BUNDLE_LIMITS,
  ASSURANCE_BUNDLE_MANIFEST,
  ASSURANCE_BUNDLE_ROLES,
  AssuranceBundleError,
  AssuranceSigningKeyringSchema,
  assuranceBundleSigningPayload,
  buildAssuranceBundle,
  verifyAssuranceBundle,
  verifyAssuranceBundleSignature,
  type AssuranceBundleSignatureResult,
  type AssuranceBundleSigningRequest,
  type AssuranceBundleRole,
  type AssuranceBundleVerification,
} from "./core/index.js";
import { analyzerFingerprint } from "./scan-cache.js";

export type BundleCreateOptions = {
  output: string;
  artifacts: readonly { role: string; path: string }[];
  missing: readonly { role: string; reason: string }[];
  requiredRoles?: readonly string[];
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
