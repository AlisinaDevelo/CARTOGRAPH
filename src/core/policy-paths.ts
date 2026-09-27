import type {
  LocalPolicyEdgeSelector,
  LocalPolicyNodeSelector,
} from "./policy.js";
import type { GraphEdge, GraphNode } from "./schemas.js";

/**
 * Repository-relative glob matching for policy selectors. Supported syntax is
 * deliberately small: `*` matches within one path segment, `**` matches any
 * number of segments, and `?` matches one non-separator character. There are
 * no character classes, braces, or negation, so a pattern cannot express more
 * than a path prefix/suffix shape and compiles to a linear-time expression.
 */
const compiled = new Map<string, RegExp>();

const globExpression = (pattern: string): RegExp => {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        const followedBySlash = pattern[index + 2] === "/";
        source += followedBySlash ? "(?:[^/]*/)*" : ".*";
        index += followedBySlash ? 2 : 1;
      } else source += "[^/]*";
    } else if (character === "?") source += "[^/]";
    else source += character.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  const expression = new RegExp(`^${source}$`, "u");
  compiled.set(pattern, expression);
  return expression;
};

export const matchesPathPattern = (path: string, pattern: string): boolean =>
  globExpression(pattern).test(path);

const EXTERNAL_MODULE_PREFIX = "module:external:";

/** The package name of an external module node, or undefined for local nodes. */
export const externalModuleName = (nodeId: string): string | undefined =>
  nodeId.startsWith(EXTERNAL_MODULE_PREFIX)
    ? nodeId.slice(EXTERNAL_MODULE_PREFIX.length)
    : undefined;

/**
 * A package pattern matches the package itself and its subpaths, so
 * `lodash` covers `lodash/fp` and `@scope/*` covers `@scope/pkg/sub`.
 */
export const matchesPackagePattern = (name: string, pattern: string): boolean =>
  matchesPathPattern(name, pattern) ||
  matchesPathPattern(name, `${pattern}/**`);

/**
 * Repository path of a graph node: its source location when the graph carries
 * the node, otherwise the path embedded in canonical module and function IDs
 * (`module:<path>`, `function:<path>:<name>`). Diffs only carry changed nodes,
 * so the ID form covers unchanged edge endpoints there.
 */
export const nodePathResolver = (
  nodes: readonly GraphNode[],
): ((nodeId: string) => string | undefined) => {
  const locations = new Map<string, string>();
  for (const node of nodes)
    if (node.location) locations.set(node.id, node.location.path);
  return (nodeId) => {
    const located = locations.get(nodeId);
    if (located !== undefined) return located;
    if (externalModuleName(nodeId) !== undefined) return undefined;
    if (nodeId.startsWith("module:")) return nodeId.slice("module:".length);
    if (nodeId.startsWith("function:")) {
      const rest = nodeId.slice("function:".length);
      const separator = rest.lastIndexOf(":");
      return separator > 0 ? rest.slice(0, separator) : undefined;
    }
    return undefined;
  };
};

/**
 * Groups of edges that form cycles: one group per strongly connected component
 * with more than one node, or a single node with a self-edge. Groups and the
 * edges inside them are returned in canonical order.
 */
export const edgeCycles = (edges: readonly GraphEdge[]): GraphEdge[][] => {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
  }
  for (const targets of adjacency.values()) targets.sort();

  // Iterative Tarjan so deep dependency chains cannot overflow the stack.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const component = new Map<string, number>();
  let nextIndex = 0;
  let nextComponent = 0;
  for (const start of [...adjacency.keys()].sort()) {
    if (index.has(start)) continue;
    const work: { node: string; child: number }[] = [{ node: start, child: 0 }];
    index.set(start, nextIndex);
    low.set(start, nextIndex);
    nextIndex += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { node: string; child: number };
      const targets = adjacency.get(frame.node) ?? [];
      if (frame.child < targets.length) {
        const target = targets[frame.child] as string;
        frame.child += 1;
        if (!index.has(target)) {
          index.set(target, nextIndex);
          low.set(target, nextIndex);
          nextIndex += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, child: 0 });
        } else if (onStack.has(target))
          low.set(
            frame.node,
            Math.min(
              low.get(frame.node) as number,
              index.get(target) as number,
            ),
          );
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent)
        low.set(
          parent.node,
          Math.min(
            low.get(parent.node) as number,
            low.get(frame.node) as number,
          ),
        );
      if (low.get(frame.node) === index.get(frame.node)) {
        let member: string | undefined;
        do {
          member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.set(member, nextComponent);
        } while (member !== frame.node);
        nextComponent += 1;
      }
    }
  }

  const groups = new Map<number, GraphEdge[]>();
  for (const edge of edges) {
    const from = component.get(edge.from);
    if (from === undefined || from !== component.get(edge.to)) continue;
    const group = groups.get(from) ?? [];
    group.push(edge);
    groups.set(from, group);
  }
  const edgeKey = (edge: GraphEdge): string =>
    `${edge.from}\0${edge.kind}\0${edge.to}`;
  return [...groups.values()]
    .map((group) =>
      [...group].sort((left, right) =>
        edgeKey(left) < edgeKey(right)
          ? -1
          : edgeKey(left) > edgeKey(right)
            ? 1
            : 0,
      ),
    )
    .sort((left, right) => {
      const a = edgeKey(left[0] as GraphEdge);
      const b = edgeKey(right[0] as GraphEdge);
      return a < b ? -1 : a > b ? 1 : 0;
    });
};

type PathOf = (nodeId: string) => string | undefined;

const pathMatches = (
  path: string | undefined,
  include: string | undefined,
  exclude: string | undefined,
): boolean => {
  if (include === undefined && exclude === undefined) return true;
  // A node without a repository path (external module, service, table) never
  // satisfies a path constraint, including an exclude-only one.
  if (path === undefined) return false;
  if (include !== undefined && !matchesPathPattern(path, include)) return false;
  return exclude === undefined || !matchesPathPattern(path, exclude);
};

export const matchesPolicyNodeSelector = (
  node: GraphNode,
  selector: LocalPolicyNodeSelector,
  pathOf: PathOf,
): boolean =>
  (selector.kind === undefined || selector.kind === node.kind) &&
  (selector.id === undefined ||
    selector.id === node.id ||
    selector.id === node.stableKey) &&
  (selector.name === undefined || selector.name === node.name) &&
  pathMatches(pathOf(node.id), selector.path, selector.pathExclude);

export const matchesPolicyEdgeSelector = (
  edge: Pick<GraphEdge, "from" | "to" | "kind">,
  selector: LocalPolicyEdgeSelector,
  pathOf: PathOf,
): boolean => {
  if (selector.kind !== undefined && selector.kind !== edge.kind) return false;
  if (selector.from !== undefined && selector.from !== edge.from) return false;
  if (selector.to !== undefined && selector.to !== edge.to) return false;
  if (
    !pathMatches(pathOf(edge.from), selector.fromPath, selector.fromPathExclude)
  )
    return false;
  if (!pathMatches(pathOf(edge.to), selector.toPath, selector.toPathExclude))
    return false;
  if (selector.toPackage !== undefined) {
    const name = externalModuleName(edge.to);
    if (name === undefined || !matchesPackagePattern(name, selector.toPackage))
      return false;
  }
  return true;
};
