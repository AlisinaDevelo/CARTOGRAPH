export type RealRepositoryBudgets = {
  maxMs: number;
  maxRssBytes: number;
  maxDiagnosticsPerNode: number;
  minNodes: number;
  minEdges: number;
};

export type RealRepository = {
  id: string;
  url: string;
  commit: string;
  license: string;
  size: "small" | "medium" | "large";
  resources?: Record<string, number>;
  budgets: RealRepositoryBudgets;
};

export type RealRepositoryMeasurement = {
  ms: number;
  maxRssBytes: number;
  nodes: number;
  edges: number;
  diagnostics: number;
};

export declare const validateManifest: (manifest: unknown) => {
  repositories: RealRepository[];
};

export declare const budgetFailures: (
  repository: RealRepository,
  measurement: RealRepositoryMeasurement,
) => string[];
