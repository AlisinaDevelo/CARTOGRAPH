export const SUPPORT_MATRIX_SCHEMA_VERSION = 1 as const;
export const SUPPORT_MATRIX_CONTRACT = "cartograph.support-matrix" as const;
export const SUPPORT_MATRIX_DIAGNOSTIC_CODE =
  "SUPPORT_MATRIX_UNSUPPORTED_ENVIRONMENT" as const;

export const SUPPORTED_PLATFORMS = ["darwin", "linux"] as const;
export const SUPPORTED_NODE_LTS = ["22.x", "24.x"] as const;
export const SUPPORTED_NODE_MINIMUM = "22.13.0" as const;

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];
export type SupportedNodeLts = (typeof SUPPORTED_NODE_LTS)[number];

export type SupportEnvironment = {
  nodeVersion: string;
  platform: string;
  arch: string;
};

export type SupportEnvironmentReport = SupportEnvironment & {
  ok: true;
  nodeWindow: SupportedNodeLts | "compatible-outside-declared-window";
};

export class UnsupportedEnvironmentError extends Error {
  readonly code = SUPPORT_MATRIX_DIAGNOSTIC_CODE;
  readonly environment: SupportEnvironment;

  constructor(environment: SupportEnvironment, reason: string) {
    super(
      `${SUPPORT_MATRIX_CONTRACT} ${SUPPORT_MATRIX_DIAGNOSTIC_CODE}: ${reason}; platform=${environment.platform}; node=${environment.nodeVersion}; arch=${environment.arch}`,
    );
    this.name = "UnsupportedEnvironmentError";
    this.environment = environment;
  }
}

const nodeVersionParts = (version: string): [number, number, number] | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version.trim());
  return match === null
    ? null
    : [Number(match[1]), Number(match[2]), Number(match[3])];
};

const atLeastMinimumNode = (version: string): boolean => {
  const parts = nodeVersionParts(version);
  if (parts === null) return false;
  const [major, minor, patch] = parts;
  const [minimumMajor, minimumMinor, minimumPatch] = [22, 13, 0];
  if (major !== minimumMajor) return major > minimumMajor;
  if (minor !== minimumMinor) return minor > minimumMinor;
  return patch >= minimumPatch;
};

const nodeWindowFor = (
  version: string,
): SupportEnvironmentReport["nodeWindow"] => {
  const major = nodeVersionParts(version)?.[0];
  if (major === 22) return "22.x";
  if (major === 24) return "24.x";
  return "compatible-outside-declared-window";
};

export const currentSupportEnvironment = (): SupportEnvironment => ({
  nodeVersion: process.versions.node,
  platform: process.platform,
  arch: process.arch,
});

export const assertSupportedEnvironment = (
  environment: SupportEnvironment = currentSupportEnvironment(),
): SupportEnvironmentReport => {
  if (
    !SUPPORTED_PLATFORMS.includes(environment.platform as SupportedPlatform)
  ) {
    throw new UnsupportedEnvironmentError(
      environment,
      `unsupported operating system; supported platforms are ${SUPPORTED_PLATFORMS.join(", ")}`,
    );
  }
  if (!atLeastMinimumNode(environment.nodeVersion)) {
    throw new UnsupportedEnvironmentError(
      environment,
      `unsupported Node.js version; minimum supported version is ${SUPPORTED_NODE_MINIMUM}`,
    );
  }
  return {
    ...environment,
    ok: true,
    nodeWindow: nodeWindowFor(environment.nodeVersion),
  };
};
