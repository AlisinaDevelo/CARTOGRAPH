import { describe, expect, it } from "vitest";

import {
  createResourceBudget,
  ResourceLimitError,
} from "../../src/resources.js";

describe("resource budget memory ceiling", () => {
  it("measures growth from the budget's starting resident memory", () => {
    // However large this worker already is, a fresh budget starts at zero.
    const check = createResourceBudget({ maxMemoryBytes: 32 * 1024 * 1024 });
    expect(() => check()).not.toThrow();

    const held = Array.from({ length: 4 }, () =>
      Buffer.alloc(64 * 1024 * 1024, 1),
    );
    expect(() => check()).toThrowError(ResourceLimitError);
    expect(held).toHaveLength(4);
  });
});
