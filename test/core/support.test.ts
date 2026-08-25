import { describe, expect, it } from "vitest";

import {
  assertSupportedEnvironment,
  UnsupportedEnvironmentError,
} from "../../src/core/index.js";

describe("runtime support matrix", () => {
  it("accepts the declared LTS window and newer compatible Node runtimes", () => {
    expect(
      assertSupportedEnvironment({
        nodeVersion: "22.13.0",
        platform: "linux",
        arch: "x64",
      }),
    ).toMatchObject({ ok: true, nodeWindow: "22.x" });
    expect(
      assertSupportedEnvironment({
        nodeVersion: "24.19.0",
        platform: "darwin",
        arch: "arm64",
      }),
    ).toMatchObject({ ok: true, nodeWindow: "24.x" });
    expect(
      assertSupportedEnvironment({
        nodeVersion: "26.7.0",
        platform: "linux",
        arch: "x64",
      }),
    ).toMatchObject({
      ok: true,
      nodeWindow: "compatible-outside-declared-window",
    });
  });

  it("fails closed with a stable diagnostic for unsupported environments", () => {
    for (const environment of [
      { nodeVersion: "22.12.0", platform: "linux", arch: "x64" },
      { nodeVersion: "24.19.0", platform: "win32", arch: "x64" },
      { nodeVersion: "not-a-version", platform: "darwin", arch: "arm64" },
    ]) {
      try {
        assertSupportedEnvironment(environment);
        throw new Error("expected unsupported environment");
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedEnvironmentError);
        expect(error).toMatchObject({
          code: "SUPPORT_MATRIX_UNSUPPORTED_ENVIRONMENT",
        });
      }
    }
  });
});
