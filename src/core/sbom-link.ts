import type { GraphNode, GraphSnapshot } from "./schemas.js";

export const SBOM_LINK_SCHEMA_VERSION = 1 as const;
export const SBOM_LINK_CONTRACT = "cartograph.sbom-link" as const;
export const SBOM_LINK_MAX_COMPONENTS = 50_000 as const;
const MAX_NESTING = 32;
const GENERATED_DETECTOR = "cartograph.generated@1/source";

export class SbomLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SbomLinkError";
  }
}

export type SbomComponent = {
  ref: string;
  name: string;
  version?: string;
  purl?: string;
  /** Lower-case component type: library, application, file, ... */
  type: string;
  sha256: string[];
  /** The component this one is bundled into (CycloneDX nesting or SPDX CONTAINS). */
  parent?: string;
};

export type ParsedSbom = {
  format: "cyclonedx" | "spdx";
  specVersion: string;
  root?: SbomComponent;
  components: SbomComponent[];
  malformed: { ref: string; reason: string }[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const sha256Of = (alg: unknown, content: unknown): string[] => {
  const algorithm = text(alg)?.toUpperCase().replaceAll("-", "");
  const digest = text(content)?.toLowerCase();
  return algorithm === "SHA256" &&
    digest !== undefined &&
    /^[0-9a-f]{64}$/u.test(digest)
    ? [digest]
    : [];
};
const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const tooMany = (count: number): void => {
  if (count > SBOM_LINK_MAX_COMPONENTS)
    throw new SbomLinkError(
      `SBOM has more than ${SBOM_LINK_MAX_COMPONENTS} components`,
    );
};

const parseCycloneDx = (document: Record<string, unknown>): ParsedSbom => {
  const specVersion = text(document.specVersion) ?? "";
  if (!/^1\.[4-6]$/u.test(specVersion))
    throw new SbomLinkError(
      `CycloneDX specVersion ${JSON.stringify(specVersion)} is not supported; use 1.4, 1.5, or 1.6`,
    );
  const components: SbomComponent[] = [];
  const malformed: ParsedSbom["malformed"] = [];
  const toComponent = (
    value: unknown,
    fallbackRef: string,
    parent?: string,
  ): SbomComponent | undefined => {
    if (!isRecord(value)) {
      malformed.push({ ref: fallbackRef, reason: "not an object" });
      return undefined;
    }
    const ref = text(value["bom-ref"]) ?? fallbackRef;
    const name = text(value.name);
    if (name === undefined) {
      malformed.push({ ref, reason: "missing name" });
      return undefined;
    }
    const version = text(value.version);
    const purl = text(value.purl);
    return {
      ref,
      name,
      ...(version === undefined ? {} : { version }),
      ...(purl === undefined ? {} : { purl }),
      type: (text(value.type) ?? "library").toLowerCase(),
      sha256: array(value.hashes).flatMap((hash) =>
        isRecord(hash) ? sha256Of(hash.alg, hash.content) : [],
      ),
      ...(parent === undefined ? {} : { parent }),
    };
  };
  const visit = (
    values: unknown,
    path: string,
    depth: number,
    parent?: string,
  ): void => {
    if (depth > MAX_NESTING)
      throw new SbomLinkError("SBOM component nesting is too deep");
    array(values).forEach((value, index) => {
      const component = toComponent(value, `${path}/${index}`, parent);
      if (component !== undefined) {
        components.push(component);
        tooMany(components.length);
      }
      if (isRecord(value))
        visit(
          value.components,
          `${path}/${index}/components`,
          depth + 1,
          component?.ref ?? parent,
        );
    });
  };
  visit(document.components, "/components", 0);
  const metadata = isRecord(document.metadata) ? document.metadata : {};
  const root =
    metadata.component === undefined
      ? undefined
      : toComponent(metadata.component, "/metadata/component");
  return {
    format: "cyclonedx",
    specVersion,
    ...(root === undefined ? {} : { root }),
    components,
    malformed,
  };
};

const parseSpdx = (document: Record<string, unknown>): ParsedSbom => {
  const specVersion = text(document.spdxVersion) ?? "";
  if (!/^SPDX-2\.[23]$/u.test(specVersion))
    throw new SbomLinkError(
      `SPDX version ${JSON.stringify(specVersion)} is not supported; use SPDX-2.2 or SPDX-2.3 JSON`,
    );
  const malformed: ParsedSbom["malformed"] = [];
  const components: SbomComponent[] = [];
  array(document.packages).forEach((value, index) => {
    const fallback = `/packages/${index}`;
    if (!isRecord(value)) {
      malformed.push({ ref: fallback, reason: "not an object" });
      return;
    }
    const ref = text(value.SPDXID) ?? fallback;
    const name = text(value.name);
    if (name === undefined) {
      malformed.push({ ref, reason: "missing name" });
      return;
    }
    const version = text(value.versionInfo);
    const purl = array(value.externalRefs)
      .filter(isRecord)
      .find((item) => text(item.referenceType)?.toLowerCase() === "purl");
    const locator =
      purl === undefined ? undefined : text(purl.referenceLocator);
    components.push({
      ref,
      name,
      ...(version === undefined ? {} : { version }),
      ...(locator === undefined ? {} : { purl: locator }),
      type: (text(value.primaryPackagePurpose) ?? "library").toLowerCase(),
      sha256: array(value.checksums).flatMap((checksum) =>
        isRecord(checksum)
          ? sha256Of(checksum.algorithm, checksum.checksumValue)
          : [],
      ),
    });
    tooMany(components.length);
  });
  array(document.files).forEach((value, index) => {
    const fallback = `/files/${index}`;
    if (!isRecord(value)) {
      malformed.push({ ref: fallback, reason: "not an object" });
      return;
    }
    const ref = text(value.SPDXID) ?? fallback;
    const name = text(value.fileName);
    if (name === undefined) {
      malformed.push({ ref, reason: "missing fileName" });
      return;
    }
    components.push({
      ref,
      name,
      type: "file",
      sha256: array(value.checksums).flatMap((checksum) =>
        isRecord(checksum)
          ? sha256Of(checksum.algorithm, checksum.checksumValue)
          : [],
      ),
    });
    tooMany(components.length);
  });
  const byRef = new Map(components.map((item) => [item.ref, item]));
  for (const relationship of array(document.relationships)) {
    if (!isRecord(relationship)) continue;
    if (text(relationship.relationshipType) !== "CONTAINS") continue;
    const parent = text(relationship.spdxElementId);
    const child = byRef.get(text(relationship.relatedSpdxElement) ?? "");
    if (parent !== undefined && byRef.has(parent) && child !== undefined)
      child.parent = parent;
  }
  const described = array(document.documentDescribes)
    .map(text)
    .filter((item) => item !== undefined);
  const root =
    described.length === 1 ? byRef.get(described[0] as string) : undefined;
  return {
    format: "spdx",
    specVersion,
    ...(root === undefined ? {} : { root }),
    components: components.filter((item) => item !== root),
    malformed,
  };
};

/** Accept a CycloneDX (1.4–1.6) or SPDX (2.2–2.3) JSON document. */
export const parseSbom = (value: unknown): ParsedSbom => {
  if (!isRecord(value)) throw new SbomLinkError("SBOM is not a JSON object");
  if (value.bomFormat === "CycloneDX") return parseCycloneDx(value);
  if (typeof value.spdxVersion === "string") return parseSpdx(value);
  throw new SbomLinkError(
    "SBOM is neither CycloneDX JSON (bomFormat) nor SPDX JSON (spdxVersion)",
  );
};

export type BuildProvenance = {
  subjects: { name: string; sha256: string }[];
  sourceCommits: string[];
};

/** Accept an in-toto Statement carrying SLSA provenance (v0.2 or v1). */
export const parseBuildProvenance = (value: unknown): BuildProvenance => {
  if (
    !isRecord(value) ||
    !/^https:\/\/in-toto\.io\/Statement\/v(?:0\.1|1)$/u.test(
      text(value._type) ?? "",
    )
  )
    throw new SbomLinkError("provenance is not an in-toto Statement");
  if (
    !/^https:\/\/slsa\.dev\/provenance\//u.test(text(value.predicateType) ?? "")
  )
    throw new SbomLinkError("provenance predicate is not SLSA provenance");
  const subjects = array(value.subject).flatMap((subject) => {
    if (!isRecord(subject)) return [];
    const name = text(subject.name);
    const digest = isRecord(subject.digest)
      ? sha256Of("SHA256", subject.digest.sha256)
      : [];
    return name !== undefined && digest[0] !== undefined
      ? [{ name, sha256: digest[0] }]
      : [];
  });
  if (subjects.length === 0)
    throw new SbomLinkError("provenance has no subject with a SHA-256 digest");
  const predicate = isRecord(value.predicate) ? value.predicate : {};
  const definition = isRecord(predicate.buildDefinition)
    ? predicate.buildDefinition
    : {};
  const dependencies = [
    ...array(definition.resolvedDependencies),
    ...array(predicate.materials),
  ];
  const sourceCommits = [
    ...new Set(
      dependencies.flatMap((dependency) => {
        if (!isRecord(dependency) || !isRecord(dependency.digest)) return [];
        return [dependency.digest.gitCommit, dependency.digest.sha1]
          .map(text)
          .filter((item): item is string => item !== undefined)
          .map((item) => item.toLowerCase());
      }),
    ),
  ].sort(compare);
  return {
    subjects: subjects.sort((left, right) => compare(left.name, right.name)),
    sourceCommits,
  };
};

export type SbomLinkTarget = {
  nodeId: string;
  method: "purl" | "name" | "alias" | "file-path" | "generated-source";
  confidence: "certain" | "inferred";
};

export type SbomComponentLink = {
  ref: string;
  name: string;
  version?: string;
  status: "linked" | "ambiguous" | "unresolved";
  targets: SbomLinkTarget[];
  reason?:
    | "not-in-graph"
    | "multiple-graph-objects"
    | "unsupported-ecosystem"
    | "bundled-in-artifact"
    | "version-skew";
  bundledIn?: string;
  generated?: boolean;
};

export type SbomLinkReport = {
  schemaVersion: typeof SBOM_LINK_SCHEMA_VERSION;
  contract: typeof SBOM_LINK_CONTRACT;
  sbom: { format: ParsedSbom["format"]; specVersion: string };
  revision: string;
  root?: SbomComponentLink;
  components: SbomComponentLink[];
  malformed: { ref: string; reason: string }[];
  graphOnly: { nodeId: string; reason: "not-in-sbom" }[];
  versionSkew: { nodeId: string; versions: string[] }[];
  artifacts: {
    name: string;
    sha256: string;
    components: string[];
    packageNode?: string;
    status: "linked" | "unresolved";
    reason?: "no-matching-component-or-package";
  }[];
  sourceRevision: "matches" | "differs" | "not-recorded";
  coverage: {
    components: number;
    linked: number;
    ambiguous: number;
    unresolved: number;
    malformed: number;
    graphExternalPackages: number;
    graphExternalPackagesInSbom: number;
  };
};

export type SbomLinkOptions = {
  provenance?: BuildProvenance;
  /** SBOM package name to the name the graph uses for it (npm aliases). */
  aliases?: Readonly<Record<string, string>>;
};

const EXTERNAL_PREFIX = "module:external:";

/** npm package name from a purl, or undefined when it is not an npm purl. */
const npmNameFromPurl = (purl: string): string | undefined => {
  const match =
    /^pkg:npm\/([^@?#]+(?:\/[^@?#]+)?)(?:@[^?#]*)?(?:[?#].*)?$/u.exec(purl);
  if (match?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return undefined;
  }
};

const purlEcosystem = (purl: string): string | undefined =>
  /^pkg:([a-z0-9.+-]+)\//u.exec(purl)?.[1];

const normalizePath = (path: string): string =>
  path.replace(/^\.\//u, "").replaceAll("\\", "/");

/**
 * Relate SBOM components and build artifacts to graph objects. Every link
 * names its method and confidence, every component that cannot be related
 * says why, and coverage counts only what was measured.
 */
export const linkSbomToGraph = (
  snapshot: GraphSnapshot,
  sbom: ParsedSbom,
  options: SbomLinkOptions = {},
): SbomLinkReport => {
  const external = new Map<string, GraphNode>();
  const packages = new Map<string, GraphNode[]>();
  const modulesByPath = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) {
    if (node.id.startsWith(EXTERNAL_PREFIX))
      external.set(node.id.slice(EXTERNAL_PREFIX.length).toLowerCase(), node);
    else if (node.kind === "package")
      packages.set(node.name.toLowerCase(), [
        ...(packages.get(node.name.toLowerCase()) ?? []),
        node,
      ]);
    else if (node.kind === "module" && node.location !== undefined)
      modulesByPath.set(node.location.path, node);
  }
  const generatedSources = new Map<string, string[]>();
  for (const edge of snapshot.edges)
    if (
      edge.kind === "depends_on" &&
      edge.evidence.some((item) => item.detector === GENERATED_DETECTOR)
    )
      generatedSources.set(edge.from, [
        ...(generatedSources.get(edge.from) ?? []),
        edge.to,
      ]);
  const aliases = new Map(
    Object.entries(options.aliases ?? {}).map(([from, to]) => [
      from.toLowerCase(),
      to.toLowerCase(),
    ]),
  );

  const link = (component: SbomComponent): SbomComponentLink => {
    const base = {
      ref: component.ref,
      name: component.name,
      ...(component.version === undefined
        ? {}
        : { version: component.version }),
      ...(component.parent === undefined
        ? {}
        : { bundledIn: component.parent }),
    };
    if (component.type === "file") {
      const module = modulesByPath.get(normalizePath(component.name));
      if (module === undefined)
        return {
          ...base,
          status: "unresolved",
          targets: [],
          reason: "not-in-graph",
        };
      const sources = generatedSources.get(module.id) ?? [];
      return {
        ...base,
        status: "linked",
        targets: [
          { nodeId: module.id, method: "file-path", confidence: "certain" },
          ...sources.sort(compare).map((nodeId) => ({
            nodeId,
            method: "generated-source" as const,
            confidence: "inferred" as const,
          })),
        ],
        ...(sources.length > 0 ? { generated: true } : {}),
      };
    }
    const ecosystem =
      component.purl === undefined ? undefined : purlEcosystem(component.purl);
    if (ecosystem !== undefined && ecosystem !== "npm")
      return {
        ...base,
        status: "unresolved",
        targets: [],
        reason: "unsupported-ecosystem",
      };
    const fromPurl =
      component.purl === undefined
        ? undefined
        : npmNameFromPurl(component.purl);
    const declared = (fromPurl ?? component.name).toLowerCase();
    const alias = aliases.get(declared);
    const name = alias ?? declared;
    const method: SbomLinkTarget["method"] =
      alias !== undefined ? "alias" : fromPurl !== undefined ? "purl" : "name";
    const confidence = method === "name" ? "inferred" : "certain";
    const candidates = [
      ...(external.has(name) ? [external.get(name) as GraphNode] : []),
      ...(packages.get(name) ?? []),
    ];
    if (candidates.length === 0)
      return {
        ...base,
        status: "unresolved",
        targets: [],
        // Code bundled into another component is not a dependency edge.
        reason:
          component.parent === undefined
            ? "not-in-graph"
            : "bundled-in-artifact",
      };
    const targets = candidates
      .map((node) => ({ nodeId: node.id, method, confidence }) as const)
      .sort((left, right) => compare(left.nodeId, right.nodeId));
    return candidates.length === 1
      ? { ...base, status: "linked", targets: [...targets] }
      : {
          ...base,
          status: "ambiguous",
          targets: [...targets],
          reason: "multiple-graph-objects",
        };
  };

  const components = sbom.components
    .map(link)
    .sort(
      (left, right) =>
        compare(left.ref, right.ref) || compare(left.name, right.name),
    );

  const versionsByNode = new Map<string, Set<string>>();
  for (const component of components)
    if (component.status === "linked" && component.version !== undefined)
      for (const target of component.targets)
        if (
          target.method !== "file-path" &&
          target.method !== "generated-source"
        )
          versionsByNode.set(
            target.nodeId,
            (versionsByNode.get(target.nodeId) ?? new Set()).add(
              component.version,
            ),
          );
  const versionSkew = [...versionsByNode]
    .filter(([, versions]) => versions.size > 1)
    .map(([nodeId, versions]) => ({
      nodeId,
      versions: [...versions].sort(compare),
    }))
    .sort((left, right) => compare(left.nodeId, right.nodeId));
  const skewed = new Set(versionSkew.map((item) => item.nodeId));
  for (const component of components)
    if (
      component.status === "linked" &&
      component.targets.some((target) => skewed.has(target.nodeId))
    )
      component.reason = "version-skew";

  const linkedNodes = new Set(
    components.flatMap((component) =>
      component.status === "unresolved"
        ? []
        : component.targets.map((target) => target.nodeId),
    ),
  );
  const graphOnly = [...external.values()]
    .filter((node) => !linkedNodes.has(node.id))
    .map((node) => ({ nodeId: node.id, reason: "not-in-sbom" as const }))
    .sort((left, right) => compare(left.nodeId, right.nodeId));

  const root = sbom.root === undefined ? undefined : link(sbom.root);
  const allComponents = [
    ...(sbom.root === undefined ? [] : [sbom.root]),
    ...sbom.components,
  ];
  const tarballName = (name: string): string =>
    name.replace(/^@/u, "").replaceAll("/", "-");
  const artifacts = (options.provenance?.subjects ?? []).map((subject) => {
    const matched = allComponents
      .filter((component) => component.sha256.includes(subject.sha256))
      .map((component) => component.ref)
      .sort(compare);
    const packageNode = [...packages.entries()]
      .filter(([name]) =>
        new RegExp(
          `^${tarballName(name).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-\\d[^/]*\\.tgz$`,
          "u",
        ).test(subject.name.toLowerCase()),
      )
      .flatMap(([, nodes]) => nodes.map((node) => node.id))
      .sort(compare)[0];
    const linked = matched.length > 0 || packageNode !== undefined;
    return {
      name: subject.name,
      sha256: subject.sha256,
      components: matched,
      ...(packageNode === undefined ? {} : { packageNode }),
      status: linked ? ("linked" as const) : ("unresolved" as const),
      ...(linked
        ? {}
        : { reason: "no-matching-component-or-package" as const }),
    };
  });

  const commit = snapshot.revision.commitSha.toLowerCase();
  const sourceRevision =
    options.provenance === undefined ||
    options.provenance.sourceCommits.length === 0
      ? ("not-recorded" as const)
      : options.provenance.sourceCommits.includes(commit)
        ? ("matches" as const)
        : ("differs" as const);

  return {
    schemaVersion: SBOM_LINK_SCHEMA_VERSION,
    contract: SBOM_LINK_CONTRACT,
    sbom: { format: sbom.format, specVersion: sbom.specVersion },
    revision: snapshot.revision.commitSha,
    ...(root === undefined ? {} : { root }),
    components,
    malformed: [...sbom.malformed].sort((left, right) =>
      compare(left.ref, right.ref),
    ),
    graphOnly,
    versionSkew,
    artifacts,
    sourceRevision,
    coverage: {
      components: components.length,
      linked: components.filter((item) => item.status === "linked").length,
      ambiguous: components.filter((item) => item.status === "ambiguous")
        .length,
      unresolved: components.filter((item) => item.status === "unresolved")
        .length,
      malformed: sbom.malformed.length,
      graphExternalPackages: external.size,
      graphExternalPackagesInSbom: [...external.values()].filter((node) =>
        linkedNodes.has(node.id),
      ).length,
    },
  };
};
