export class ResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceLimitError";
  }
}

export class CancellationError extends Error {
  constructor(message = "analysis cancelled") {
    super(message);
    this.name = "CancellationError";
  }
}

export type ResourceBudgetOptions = {
  maxMemoryBytes?: number;
  maxWallClockMs?: number;
  signal?: AbortSignal;
  subject?: string;
};

export const createResourceBudget = (
  options: ResourceBudgetOptions,
): (() => void) => {
  const startedAt = Date.now();
  const subject = options.subject ?? "analysis";

  return (): void => {
    if (options.signal?.aborted)
      throw new CancellationError(`${subject} cancelled`);

    if (
      options.maxWallClockMs !== undefined &&
      Date.now() - startedAt > options.maxWallClockMs
    ) {
      throw new ResourceLimitError(
        `${subject} exceeded the ${options.maxWallClockMs} ms wall-clock ceiling`,
      );
    }

    if (
      options.maxMemoryBytes !== undefined &&
      process.memoryUsage().rss > options.maxMemoryBytes
    ) {
      throw new ResourceLimitError(
        `${subject} exceeded the ${options.maxMemoryBytes} byte memory ceiling`,
      );
    }
  };
};

export const assertReportItemLimit = (
  count: number,
  maximum: number | undefined,
): void => {
  if (maximum !== undefined && count > maximum)
    throw new ResourceLimitError(
      `report exceeds the ${maximum} item report-cardinality ceiling`,
    );
};
