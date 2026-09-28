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
  // Name the `resources.*` config keys in ceiling errors (analysis and
  // revision materialization, which the config file controls).
  configKeys?: boolean;
};

export const createResourceBudget = (
  options: ResourceBudgetOptions,
): (() => void) => {
  const startedAt = Date.now();
  const subject = options.subject ?? "analysis";
  // The ceiling bounds what this budget's work adds on top of the process's
  // resident memory when it started. A long-lived host (a test runner, an
  // editor, a server) that has already grown past the ceiling must not make
  // every later analysis fail; a fresh CLI process starts near zero, so its
  // limit is effectively the same as an absolute one.
  const baselineRss =
    options.maxMemoryBytes === undefined ? 0 : process.memoryUsage.rss();

  return (): void => {
    if (options.signal?.aborted)
      throw new CancellationError(`${subject} cancelled`);

    if (
      options.maxWallClockMs !== undefined &&
      Date.now() - startedAt > options.maxWallClockMs
    ) {
      throw new ResourceLimitError(
        `${subject} exceeded the ${options.maxWallClockMs} ms wall-clock ceiling${options.configKeys === true ? "; raise resources.maxWallClockMs in the --config file to allow more time" : ""}`,
      );
    }

    if (
      options.maxMemoryBytes !== undefined &&
      process.memoryUsage.rss() - baselineRss > options.maxMemoryBytes
    ) {
      throw new ResourceLimitError(
        `${subject} exceeded the ${options.maxMemoryBytes} byte memory ceiling${options.configKeys === true ? "; raise resources.maxMemoryBytes in the --config file" : ""}`,
      );
    }
  };
};

export const assertReportItemLimit = (
  count: number,
  maximum: number | undefined,
  configKey?: string,
): void => {
  if (maximum !== undefined && count > maximum)
    throw new ResourceLimitError(
      `report exceeds the ${maximum} item report-cardinality ceiling (${count} items)${configKey === undefined ? "" : `; raise ${configKey} in the --config file to at least ${count}`}`,
    );
};
