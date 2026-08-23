import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    coverage: {
      exclude: ["src/**/index.ts", "src/index.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      thresholds: {
        branches: 65,
        functions: 85,
        lines: 80,
        statements: 80,
      },
    },
    include: ["test/**/*.test.ts"],
  },
});
