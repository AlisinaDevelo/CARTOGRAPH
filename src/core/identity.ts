import { z } from "zod";

import { canonicalizeGraphSnapshot, stableStringify } from "./canonical.js";
import type { GraphNode, GraphSnapshot } from "./schemas.js";

export const IdentityMatchMethodSchema = z.enum([
  "stable-key",
  "same-name",
  "neighborhood",
]);
export const IdentityMatchConfidenceSchema = z.enum(["exact", "strong"]);
export const IdentitySignalSchema = z.enum([
  "stable-key",
  "same-kind",
  "same-language",
  "same-name",
  "same-neighborhood",
  "neighborhood-overlap",
]);

export type IdentityMatchMethod = z.infer<typeof IdentityMatchMethodSchema>;
export type IdentityMatchConfidence = z.infer<
  typeof IdentityMatchConfidenceSchema
>;
export type IdentitySignal = z.infer<typeof IdentitySignalSchema>;

export type IdentityCandidate = {
  beforeStableKey: string;
  afterStableKey: string;
  score: number;
  signals: IdentitySignal[];
};

export type IdentityMatch = IdentityCandidate & {
  before: GraphNode;
  after: GraphNode;
  method: IdentityMatchMethod;
  confidence: IdentityMatchConfidence;
};

export type IdentityAmbiguity = {
  before: GraphNode;
  candidates: IdentityCandidate[];
  reason: "equal-score" | "non-mutual-best";
};

export type IdentityReconciliation = {
  matches: IdentityMatch[];
  added: GraphNode[];
  removed: GraphNode[];
  ambiguous: IdentityAmbiguity[];
};

const compareStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const nodeIdentity = (node: Pick<GraphNode, "stableKey" | "id">): string =>
  `${node.stableKey}\u0000${node.id}`;

const profileFor = (snapshot: GraphSnapshot, node: GraphNode): string[] => {
  const byId = new Map(
    snapshot.nodes.map((candidate) => [candidate.id, candidate]),
  );
  const profile: string[] = [];
  for (const edge of snapshot.edges) {
    if (edge.from === node.id) {
      const neighbor = byId.get(edge.to);
      profile.push(
        `out|${edge.kind}|${neighbor?.kind ?? "unknown"}|${neighbor?.stableKey ?? edge.to}`,
      );
    }
    if (edge.to === node.id) {
      const neighbor = byId.get(edge.from);
      profile.push(
        `in|${edge.kind}|${neighbor?.kind ?? "unknown"}|${neighbor?.stableKey ?? edge.from}`,
      );
    }
  }
  return profile.sort(compareStrings);
};

const overlapCount = (
  left: readonly string[],
  right: readonly string[],
): number => {
  const counts = new Map<string, number>();
  for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
  let overlap = 0;
  for (const value of right) {
    const count = counts.get(value) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(value, count - 1);
    }
  }
  return overlap;
};

const candidateFor = (
  beforeSnapshot: GraphSnapshot,
  afterSnapshot: GraphSnapshot,
  before: GraphNode,
  after: GraphNode,
): IdentityCandidate | undefined => {
  if (before.stableKey === after.stableKey) return undefined;

  const signals: IdentitySignal[] = [];
  let score = 0;
  if (before.kind === after.kind) {
    score += 40;
    signals.push("same-kind");
  } else {
    return undefined;
  }
  if (before.language !== undefined && before.language === after.language) {
    score += 10;
    signals.push("same-language");
  }
  if (before.name === after.name) {
    score += 35;
    signals.push("same-name");
  }

  const beforeProfile = profileFor(beforeSnapshot, before);
  const afterProfile = profileFor(afterSnapshot, after);
  if (
    beforeProfile.length > 0 &&
    stableStringify(beforeProfile) === stableStringify(afterProfile)
  ) {
    score += 25;
    signals.push("same-neighborhood");
  } else {
    const overlap = overlapCount(beforeProfile, afterProfile);
    if (overlap > 0) {
      score += Math.min(20, overlap * 5);
      signals.push("neighborhood-overlap");
    }
  }

  // A same-kind/name move or a same-kind/neighborhood rename is supported;
  // weaker similarities remain unmatched rather than becoming guesses.
  if (score < 60) return undefined;
  return {
    beforeStableKey: before.stableKey,
    afterStableKey: after.stableKey,
    score,
    signals: signals.sort(compareStrings),
  };
};

const sortCandidates = (
  candidates: readonly IdentityCandidate[],
): IdentityCandidate[] =>
  [...candidates].sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    const beforeOrder = compareStrings(
      left.beforeStableKey,
      right.beforeStableKey,
    );
    return beforeOrder !== 0
      ? beforeOrder
      : compareStrings(left.afterStableKey, right.afterStableKey);
  });

const uniqueBest = (
  candidates: readonly IdentityCandidate[],
): IdentityCandidate | undefined => {
  const sorted = sortCandidates(candidates);
  if (sorted.length === 0) return undefined;
  const best = sorted[0];
  if (best === undefined) return undefined;
  return sorted[1]?.score === best.score ? undefined : best;
};

const matchMethod = (
  signals: readonly IdentitySignal[],
): IdentityMatchMethod =>
  signals.includes("same-name") ? "same-name" : "neighborhood";

/**
 * Reconcile nodes between two canonical snapshots without changing either
 * snapshot's stable keys. Exact stable keys cover line moves. Unique
 * same-kind/name candidates cover supported file moves, while a unique
 * same-kind/neighborhood candidate covers a supported rename. Ties and
 * non-mutual candidates are returned as ambiguity records and never guessed.
 */
export const reconcileGraphNodeIdentities = (
  beforeInput: unknown,
  afterInput: unknown,
): IdentityReconciliation => {
  const beforeSnapshot = canonicalizeGraphSnapshot(beforeInput);
  const afterSnapshot = canonicalizeGraphSnapshot(afterInput);
  const beforeByKey = new Map(
    beforeSnapshot.nodes.map((node) => [node.stableKey, node]),
  );
  const afterByKey = new Map(
    afterSnapshot.nodes.map((node) => [node.stableKey, node]),
  );

  const matches: IdentityMatch[] = [];
  const matchedBefore = new Set<string>();
  const matchedAfter = new Set<string>();
  for (const [stableKey, before] of beforeByKey) {
    const after = afterByKey.get(stableKey);
    if (after === undefined) continue;
    matches.push({
      beforeStableKey: stableKey,
      afterStableKey: stableKey,
      score: Number.POSITIVE_INFINITY,
      signals: (["stable-key", "same-kind"] as IdentitySignal[]).sort(
        compareStrings,
      ),
      before,
      after,
      method: "stable-key",
      confidence: "exact",
    });
    matchedBefore.add(stableKey);
    matchedAfter.add(stableKey);
  }

  const beforeCandidates = new Map<string, IdentityCandidate[]>();
  const afterCandidates = new Map<string, IdentityCandidate[]>();
  for (const before of beforeSnapshot.nodes) {
    if (matchedBefore.has(before.stableKey)) continue;
    for (const after of afterSnapshot.nodes) {
      if (matchedAfter.has(after.stableKey)) continue;
      const candidate = candidateFor(
        beforeSnapshot,
        afterSnapshot,
        before,
        after,
      );
      if (candidate === undefined) continue;
      const beforeList = beforeCandidates.get(before.stableKey) ?? [];
      beforeList.push(candidate);
      beforeCandidates.set(before.stableKey, beforeList);
      const afterList = afterCandidates.get(after.stableKey) ?? [];
      afterList.push(candidate);
      afterCandidates.set(after.stableKey, afterList);
    }
  }

  const ambiguous = new Map<string, IdentityAmbiguity>();
  for (const before of beforeSnapshot.nodes) {
    const candidates = beforeCandidates.get(before.stableKey) ?? [];
    if (candidates.length === 0) continue;
    const best = uniqueBest(candidates);
    if (best === undefined) {
      ambiguous.set(before.stableKey, {
        before,
        candidates: sortCandidates(candidates),
        reason: "equal-score",
      });
      continue;
    }
    const reciprocal = uniqueBest(
      afterCandidates.get(best.afterStableKey) ?? [],
    );
    if (
      reciprocal === undefined ||
      reciprocal.beforeStableKey !== before.stableKey
    ) {
      ambiguous.set(before.stableKey, {
        before,
        candidates: sortCandidates(candidates),
        reason: "non-mutual-best",
      });
      continue;
    }
    const after = afterByKey.get(best.afterStableKey);
    if (after === undefined) continue;
    matches.push({
      ...best,
      before,
      after,
      method: matchMethod(best.signals),
      confidence: "strong",
    });
    matchedBefore.add(before.stableKey);
    matchedAfter.add(after.stableKey);
  }

  const added = afterSnapshot.nodes
    .filter(
      (node) =>
        !matchedAfter.has(node.stableKey) &&
        ![...ambiguous.values()].some((item) =>
          item.candidates.some(
            (candidate) => candidate.afterStableKey === node.stableKey,
          ),
        ),
    )
    .sort((left, right) =>
      compareStrings(nodeIdentity(left), nodeIdentity(right)),
    );
  const removed = beforeSnapshot.nodes
    .filter(
      (node) =>
        !matchedBefore.has(node.stableKey) && !ambiguous.has(node.stableKey),
    )
    .sort((left, right) =>
      compareStrings(nodeIdentity(left), nodeIdentity(right)),
    );

  return {
    matches: matches.sort((left, right) =>
      compareStrings(left.beforeStableKey, right.beforeStableKey),
    ),
    added,
    removed,
    ambiguous: [...ambiguous.values()].sort((left, right) =>
      compareStrings(left.before.stableKey, right.before.stableKey),
    ),
  };
};

export const matchGraphNodeIdentities = reconcileGraphNodeIdentities;

export const serializeIdentityReconciliation = (
  result: IdentityReconciliation,
): string => stableStringify(result);
