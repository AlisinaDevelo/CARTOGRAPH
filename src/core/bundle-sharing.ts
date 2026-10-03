import { createHmac } from "node:crypto";

import {
  ASSURANCE_BUNDLE_ROLES,
  AssuranceBundleError,
  type AssuranceBundleRole,
} from "./assurance-bundle.js";

export const BUNDLE_SHARING_SCHEMA_VERSION = 1 as const;
export const BUNDLE_SHARING_CONTRACT = "cartograph.bundle-sharing" as const;
export const BUNDLE_SHARING_MAX_FINDINGS = 1_000 as const;
const MAX_DEPTH = 256;

export const SHARING_PROFILES = ["team", "public"] as const;
export type SharingProfile = (typeof SHARING_PROFILES)[number];

export const SHARING_CATEGORIES = [
  "private-key",
  "access-token",
  "jwt",
  "credential-assignment",
  "credential-url",
  "absolute-path",
  "email",
  "ip-address",
  "external-url",
  "unscannable",
] as const;
export type SharingCategory = (typeof SHARING_CATEGORIES)[number];

type Detector = { category: SharingCategory; pattern: RegExp };

const SECRET_DETECTORS: readonly Detector[] = [
  {
    category: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gu,
  },
  {
    category: "access-token",
    pattern:
      /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35})\b/gu,
  },
  {
    category: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  },
  {
    category: "credential-assignment",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret)\b["']?\s*[:=]\s*["']?[^\s"',;]{6,}/giu,
  },
  {
    category: "credential-url",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/giu,
  },
  {
    category: "absolute-path",
    pattern:
      /(?<=^|[\s"'(=:,])(?:\/(?:Users|home|root|private|var\/folders|tmp|opt|etc|srv|mnt|Volumes)\/|[A-Za-z]:\\|\\\\[A-Za-z0-9_.-]+\\|~\/)[^\s"')]*/gu,
  },
];

// Hosts that appear in contract documents themselves (schema and SARIF
// references) and are not information about the analyzed repository.
const PUBLIC_HOSTS = new Set([
  "json-schema.org",
  "json.schemastore.org",
  "docs.oasis-open.org",
  "raw.githubusercontent.com",
  "www.w3.org",
]);

// Hosts produced by createHostPseudonymizer (RFC 2606 reserves .invalid).
const PSEUDONYMOUS_HOST = /^h[0-9a-f]{10}\.invalid$/u;

const PUBLIC_DETECTORS: readonly Detector[] = [
  {
    category: "email",
    pattern:
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/gu,
  },
  {
    category: "ip-address",
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/gu,
  },
  {
    category: "external-url",
    pattern: /\bhttps?:\/\/([A-Za-z0-9.-]+)[^\s"'<>)]*/giu,
  },
];

const detectorsFor = (
  profile: SharingProfile,
  allowedHosts: ReadonlySet<string>,
): readonly Detector[] =>
  profile === "public"
    ? [
        ...SECRET_DETECTORS,
        ...PUBLIC_DETECTORS.map((detector) =>
          detector.category === "external-url"
            ? {
                ...detector,
                allow: (match: RegExpExecArray) => {
                  const host = (match[1] ?? "").toLowerCase();
                  return (
                    PUBLIC_HOSTS.has(host) ||
                    allowedHosts.has(host) ||
                    PSEUDONYMOUS_HOST.test(host)
                  );
                },
              }
            : detector,
        ),
      ]
    : SECRET_DETECTORS;

/** The bundle manifest is scanned too: labels and reasons are free text. */
export type SharingRole = AssuranceBundleRole | "manifest";

export type SharingFinding = {
  artifact: string;
  role: SharingRole;
  /** A JSON pointer for JSON artifacts, `line:<n>` for text reports. */
  location: string;
  category: SharingCategory;
};

export type SharingArtifact = {
  path: string;
  role: SharingRole;
  content: Uint8Array;
};

export type SharingOptions = {
  profile: SharingProfile;
  allowedHosts?: readonly string[];
};

const pointerSegment = (value: string | number): string =>
  String(value).replaceAll("~", "~0").replaceAll("/", "~1");

const isJsonRole = (role: SharingRole): boolean =>
  role === "manifest" ||
  (ASSURANCE_BUNDLE_ROLES[role].mediaType !== "text/html" &&
    ASSURANCE_BUNDLE_ROLES[role].mediaType !== "text/markdown");

const decode = (content: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
};

type Visitor = (text: string, location: string) => string;

/**
 * Visit every string (keys included) of a JSON value, replacing each with the
 * visitor's result. Throws when the document is deeper than the bound, so an
 * adversarial artifact is reported as unscannable instead of partly scanned.
 */
const mapJsonStrings = (
  value: unknown,
  visit: Visitor,
  pointer = "",
  depth = 0,
): unknown => {
  if (depth > MAX_DEPTH) throw new AssuranceBundleError("too deep");
  if (typeof value === "string") return visit(value, pointer || "/");
  if (Array.isArray(value))
    return value.map((item, index) =>
      mapJsonStrings(item, visit, `${pointer}/${index}`, depth + 1),
    );
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const location = `${pointer}/${pointerSegment(key)}`;
        return [
          visit(key, `${location}#key`),
          mapJsonStrings(item, visit, location, depth + 1),
        ];
      }),
    );
  return value;
};

const matchesIn = (
  text: string,
  detectors: readonly Detector[],
): { category: SharingCategory; start: number; end: number }[] => {
  const found: { category: SharingCategory; start: number; end: number }[] = [];
  for (const detector of detectors) {
    const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      const allow = (
        detector as Detector & { allow?: (match: RegExpExecArray) => boolean }
      ).allow;
      if (allow?.(match)) continue;
      found.push({
        category: detector.category,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return found;
};

const transformArtifact = (
  artifact: SharingArtifact,
  visit: Visitor,
): string => {
  const text = decode(artifact.content);
  if (text === undefined) throw new AssuranceBundleError("not UTF-8");
  if (isJsonRole(artifact.role)) {
    const value = JSON.parse(text) as unknown;
    return `${JSON.stringify(mapJsonStrings(value, visit))}\n`;
  }
  return text
    .split("\n")
    .map((line, index) => visit(line, `line:${index + 1}`))
    .join("\n");
};

export type SharingReport = {
  schemaVersion: typeof BUNDLE_SHARING_SCHEMA_VERSION;
  contract: typeof BUNDLE_SHARING_CONTRACT;
  profile: SharingProfile;
  ok: boolean;
  artifacts: number;
  findings: SharingFinding[];
  truncated: boolean;
};

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const report = (
  profile: SharingProfile,
  artifacts: number,
  findings: SharingFinding[],
): SharingReport => {
  const unique = [
    ...new Map(
      findings.map((item) => [
        `${item.artifact}\0${item.location}\0${item.category}`,
        item,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      compare(left.artifact, right.artifact) ||
      compare(left.location, right.location) ||
      compare(left.category, right.category),
  );
  return {
    schemaVersion: BUNDLE_SHARING_SCHEMA_VERSION,
    contract: BUNDLE_SHARING_CONTRACT,
    profile,
    ok: unique.length === 0,
    artifacts,
    findings: unique.slice(0, BUNDLE_SHARING_MAX_FINDINGS),
    truncated: unique.length > BUNDLE_SHARING_MAX_FINDINGS,
  };
};

/**
 * Find content that should not leave the machine under a recipient profile.
 * Findings name the artifact, location, and category, never the value. An
 * artifact that cannot be decoded or walked is a finding, so the check fails
 * closed.
 */
export const checkBundleSharing = (
  artifacts: readonly SharingArtifact[],
  options: SharingOptions,
): SharingReport => {
  const detectors = detectorsFor(
    options.profile,
    new Set(options.allowedHosts?.map((host) => host.toLowerCase())),
  );
  const findings: SharingFinding[] = [];
  for (const artifact of artifacts) {
    try {
      transformArtifact(artifact, (text, location) => {
        for (const match of matchesIn(text, detectors))
          findings.push({
            artifact: artifact.path,
            role: artifact.role,
            location,
            category: match.category,
          });
        return text;
      });
    } catch {
      findings.push({
        artifact: artifact.path,
        role: artifact.role,
        location: "/",
        category: "unscannable",
      });
    }
  }
  return report(options.profile, artifacts.length, findings);
};

/**
 * Replace every detected value with a `[REDACTED:<category>]` marker,
 * field by field. The result still has to satisfy its contract, which the
 * caller checks by rebuilding the bundle.
 */
export const redactArtifactForSharing = (
  artifact: SharingArtifact,
  options: SharingOptions,
): { content: string; redactions: number } => {
  const detectors = detectorsFor(
    options.profile,
    new Set(options.allowedHosts?.map((host) => host.toLowerCase())),
  );
  let redactions = 0;
  const content = transformArtifact(artifact, (text) => {
    const matches = matchesIn(text, detectors).sort(
      (left, right) => left.start - right.start || right.end - left.end,
    );
    let output = "";
    let cursor = 0;
    for (const match of matches) {
      if (match.start < cursor) continue;
      output += `${text.slice(cursor, match.start)}[REDACTED:${match.category}]`;
      cursor = match.end;
      redactions += 1;
    }
    return output + text.slice(cursor);
  });
  return { content, redactions };
};

const PATH_FIELDS = new Set(["path", "file", "filePath", "uri"]);
const PORTABLE_PATH =
  /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s\\:*?"<>|]+$/u;

/** Repository-relative paths named by path fields anywhere in the artifacts. */
export const collectRepositoryPaths = (
  artifacts: readonly SharingArtifact[],
): string[] => {
  const paths = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(value)) for (const item of value) visit(item, depth + 1);
    else if (value !== null && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (
          PATH_FIELDS.has(key) &&
          typeof item === "string" &&
          PORTABLE_PATH.test(item) &&
          !item.includes("://")
        )
          paths.add(item);
        else visit(item, depth + 1);
      }
  };
  for (const artifact of artifacts) {
    if (!isJsonRole(artifact.role)) continue;
    const text = decode(artifact.content);
    if (text === undefined) continue;
    try {
      visit(JSON.parse(text) as unknown, 0);
    } catch {
      // Unparseable artifacts are reported by the sharing check.
    }
  }
  return [...paths].sort(compare);
};

/**
 * Keyed, consistent pseudonyms for repository path segments. Directory
 * structure and file extensions stay visible so boundary and policy results
 * keep their shape; names do not. Without the key, pseudonyms cannot be
 * reversed by hashing guessed names.
 */
export const createPathPseudonymizer = (
  key: Uint8Array,
  paths: readonly string[],
): ((text: string) => string) => {
  if (key.byteLength < 32)
    throw new AssuranceBundleError(
      "pseudonymization key must be at least 32 bytes",
    );
  const segments = new Set(paths.flatMap((path) => path.split("/")));
  const fullPaths = new Set(paths);
  const cache = new Map<string, string>();
  const pseudonym = (segment: string): string => {
    const cached = cache.get(segment);
    if (cached !== undefined) return cached;
    const dot = segment.lastIndexOf(".");
    const extension = dot > 0 ? segment.slice(dot) : "";
    const value = `p${createHmac("sha256", key).update(segment).digest("hex").slice(0, 10)}${extension}`;
    cache.set(segment, value);
    return value;
  };
  const token = /[A-Za-z0-9_.@*$+-]+(?:\/[A-Za-z0-9_.@*$+-]*)*/gu;
  return (text) =>
    text
      .split(/(\s+)/u)
      .map((chunk) =>
        chunk.includes("://")
          ? chunk
          : chunk.replace(token, (match) =>
              match.includes("/") ||
              fullPaths.has(match) ||
              (match.includes(".") && segments.has(match))
                ? match
                    .split("/")
                    .map((segment) =>
                      segments.has(segment) ? pseudonym(segment) : segment,
                    )
                    .join("/")
                : match,
            ),
      )
      .join("");
};

/** Apply a string transformation to every string of an artifact. */
export const rewriteArtifactStrings = (
  artifact: SharingArtifact,
  rewrite: (text: string) => string,
): string => transformArtifact(artifact, (text) => rewrite(text));

/**
 * Keyed pseudonyms for remote hosts in URLs, so external services stay
 * distinguishable without naming them. Contract and allowed hosts are kept.
 */
export const createHostPseudonymizer = (
  key: Uint8Array,
  allowedHosts: readonly string[] = [],
): ((text: string) => string) => {
  if (key.byteLength < 32)
    throw new AssuranceBundleError(
      "pseudonymization key must be at least 32 bytes",
    );
  const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
  return (text) =>
    text.replace(
      /\b(https?:\/\/)([A-Za-z0-9.-]+)/giu,
      (match, scheme: string, host: string) => {
        const lower = host.toLowerCase();
        if (
          PUBLIC_HOSTS.has(lower) ||
          allowed.has(lower) ||
          PSEUDONYMOUS_HOST.test(lower)
        )
          return match;
        return `${scheme}h${createHmac("sha256", key).update(`host\0${lower}`).digest("hex").slice(0, 10)}.invalid`;
      },
    );
};
