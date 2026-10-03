import { createHash } from "node:crypto";

import type { AssuranceBundleManifest } from "./assurance-bundle.js";
import type { GraphNode, GraphSnapshot } from "./schemas.js";

export const CYCLONEDX_SPEC_VERSION = "1.6" as const;
export const IN_TOTO_STATEMENT_TYPE =
  "https://in-toto.io/Statement/v1" as const;
export const ASSURANCE_BUNDLE_PREDICATE_TYPE =
  "https://github.com/AlisinaDevelo/CARTOGRAPH/predicate/assurance-bundle/v1" as const;

const EXTERNAL_PREFIX = "module:external:";

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** `pkg:npm/<name>` with the scope `@` encoded, as the purl spec requires. */
export const npmPurl = (name: string): string =>
  `pkg:npm/${name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;

/** A stable RFC 4122-shaped URN derived from content, not from randomness. */
const contentUrn = (seed: string): string => {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export type CycloneDxBom = {
  bomFormat: "CycloneDX";
  specVersion: typeof CYCLONEDX_SPEC_VERSION;
  serialNumber: string;
  version: 1;
  metadata: {
    tools: {
      components: { type: "application"; name: string; version: string }[];
    };
    component?: CycloneDxComponent;
    properties: { name: string; value: string }[];
  };
  components: CycloneDxComponent[];
  dependencies: { ref: string; dependsOn: string[] }[];
};

type CycloneDxComponent = {
  type: "library" | "application";
  "bom-ref": string;
  name: string;
  purl: string;
  properties: { name: string; value: string }[];
};

/**
 * Project a snapshot's packages onto a CycloneDX 1.6 SBOM: external
 * packages and workspace packages become components, and `depends_on` edges
 * between them become dependencies. The graph records no package versions,
 * so components and purls carry none; modules, functions, endpoints,
 * confidence, and source locations are not represented. The output is
 * deterministic: no timestamp, and a serial number derived from the content.
 */
export const exportCycloneDx = (
  snapshot: GraphSnapshot,
  options: { toolName: string; toolVersion: string },
): CycloneDxBom => {
  const packageName = (node: GraphNode): string | undefined =>
    node.id.startsWith(EXTERNAL_PREFIX)
      ? node.id.slice(EXTERNAL_PREFIX.length)
      : node.kind === "package"
        ? node.name
        : undefined;
  const component = (node: GraphNode): CycloneDxComponent => ({
    type: node.id === "package:root" ? "application" : "library",
    "bom-ref": node.id,
    name: packageName(node) as string,
    purl: npmPurl(packageName(node) as string),
    properties: [
      { name: "cartograph:nodeId", value: node.id },
      {
        name: "cartograph:origin",
        value: node.kind === "package" ? "workspace" : "external",
      },
    ],
  });
  const packages = snapshot.nodes
    .filter((node) => packageName(node) !== undefined)
    .sort((left, right) => compare(left.id, right.id));
  const exported = new Set(packages.map((node) => node.id));
  const root = packages.find((node) => node.id === "package:root");
  const dependsOn = new Map<string, Set<string>>();
  for (const edge of snapshot.edges)
    if (
      edge.kind === "depends_on" &&
      exported.has(edge.from) &&
      exported.has(edge.to)
    )
      dependsOn.set(
        edge.from,
        (dependsOn.get(edge.from) ?? new Set()).add(edge.to),
      );
  const components = packages.filter((node) => node !== root).map(component);
  const body = {
    components,
    dependencies: [...dependsOn]
      .sort(([left], [right]) => compare(left, right))
      .map(([ref, targets]) => ({
        ref,
        dependsOn: [...targets].sort(compare),
      })),
  };
  return {
    bomFormat: "CycloneDX",
    specVersion: CYCLONEDX_SPEC_VERSION,
    serialNumber: contentUrn(
      `${snapshot.revision.commitSha}\0${JSON.stringify(body)}`,
    ),
    version: 1,
    metadata: {
      tools: {
        components: [
          {
            type: "application",
            name: options.toolName,
            version: options.toolVersion,
          },
        ],
      },
      ...(root === undefined ? {} : { component: component(root) }),
      properties: [
        { name: "cartograph:revision", value: snapshot.revision.commitSha },
        {
          name: "cartograph:limitation",
          value:
            "Components come from static analysis of imports and lockfiles; versions are not recorded and the list is not a complete inventory.",
        },
      ],
    },
    ...body,
  };
};

export type InTotoStatement = {
  _type: typeof IN_TOTO_STATEMENT_TYPE;
  subject: { name: string; digest: { sha256: string } }[];
  predicateType: typeof ASSURANCE_BUNDLE_PREDICATE_TYPE;
  predicate: {
    bundleId: string;
    tool: { name: string; version: string };
    analyzerFingerprint?: string;
    roles: string[];
    requiredRoles: string[];
    missing: { role: string; reason: string }[];
    sourceBodiesIncluded: false;
  };
};

/**
 * An unsigned in-toto Statement whose subjects are the bundle's artifacts
 * and manifest. Sign it with any in-toto tool (for example
 * `cosign attest --type custom`) to publish it as an attestation.
 */
export const exportBundleStatement = (
  manifest: AssuranceBundleManifest,
  manifestSha256: string,
): InTotoStatement => ({
  _type: IN_TOTO_STATEMENT_TYPE,
  subject: [
    { name: "manifest.json", digest: { sha256: manifestSha256 } },
    ...manifest.artifacts.map((artifact) => ({
      name: artifact.path,
      digest: { sha256: artifact.sha256 },
    })),
  ].sort((left, right) => compare(left.name, right.name)),
  predicateType: ASSURANCE_BUNDLE_PREDICATE_TYPE,
  predicate: {
    bundleId: manifest.bundleId,
    tool: { name: manifest.tool.name, version: manifest.tool.version },
    ...(manifest.provenance === undefined
      ? {}
      : { analyzerFingerprint: manifest.provenance.analyzerFingerprint }),
    roles: [...new Set(manifest.artifacts.map((item) => item.role))].sort(
      compare,
    ),
    requiredRoles: [...manifest.requiredRoles],
    missing: manifest.missing.map((item) => ({ ...item })),
    sourceBodiesIncluded: false,
  },
});
