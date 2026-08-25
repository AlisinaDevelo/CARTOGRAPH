import { describe, expect, it } from "vitest";

import {
  classifyCliError,
  formatCliError,
  redactCliText,
} from "../../src/cli-errors.js";

describe("CLI diagnostic safety", () => {
  it("classifies every supported failure boundary with a stable code", () => {
    const cases = [
      {
        name: "CommanderError",
        code: "commander.unknownCommand",
        expected: "cli-input",
      },
      { name: "ConfigValidationError", expected: "configuration-error" },
      { name: "TypeScriptConfigError", expected: "configuration-error" },
      { name: "PolicyCompositionError", expected: "configuration-error" },
      { name: "ResourceLimitError", expected: "resource-limit" },
      { name: "CancellationError", expected: "cancelled" },
      { name: "GitCommandError", expected: "git-error" },
      { name: "Error", code: "EEXIST", expected: "output-error" },
      { name: "GraphValidationError", expected: "analysis-error" },
    ];

    for (const item of cases) {
      expect(classifyCliError({ name: item.name, code: item.code })).toBe(
        item.expected,
      );
    }
  });

  it("redacts credentials, absolute paths, and source snippets from each error class", () => {
    const secrets = [
      "TOP-SECRET-TOKEN",
      "TOP-SECRET-CREDENTIAL",
      "/Users/private-user/project/src/secret.ts",
      "const sourceSnippet = 'TOP-SECRET-SOURCE';",
    ];
    const cases = [
      {
        name: "CommanderError",
        code: "commander.unknownCommand",
        message: "error: unknown command 'token=TOP-SECRET-TOKEN'",
      },
      {
        name: "ConfigValidationError",
        message:
          "could not parse config /Users/private-user/project/src/config.json: password='TOP-SECRET-CREDENTIAL'",
      },
      {
        name: "TypeScriptConfigError",
        message:
          "could not parse tsconfig: const sourceSnippet = 'TOP-SECRET-SOURCE';",
      },
      {
        name: "ResourceLimitError",
        message:
          "analysis exceeded limit at /Users/private-user/project/src/secret.ts",
      },
      {
        name: "CancellationError",
        message: "analysis cancelled after token=TOP-SECRET-TOKEN",
      },
      {
        name: "GitCommandError",
        message: "git failed: credential=TOP-SECRET-CREDENTIAL",
      },
      {
        name: "Error",
        code: "EEXIST",
        message:
          "output /Users/private-user/project/src/secret.ts already exists",
      },
      {
        name: "GraphValidationError",
        message: "analysis failed: const sourceSnippet = 'TOP-SECRET-SOURCE';",
      },
    ];

    for (const item of cases) {
      const diagnostic = formatCliError(item);
      expect(diagnostic).toContain(`[${classifyCliError(item)}]`);
      for (const secret of secrets) expect(diagnostic).not.toContain(secret);
    }
  });

  it("preserves safe diagnostics while dropping multiline source payloads", () => {
    const diagnostic = redactCliText(
      "invalid configuration field: resources.maxFiles\nconst leaked = 'TOP-SECRET-SOURCE';\n/Users/private-user/project/secret.ts",
    );

    expect(diagnostic).toContain(
      "invalid configuration field: resources.maxFiles",
    );
    expect(diagnostic).not.toContain("TOP-SECRET-SOURCE");
    expect(diagnostic).not.toContain("/Users/private-user/project/secret.ts");
  });
});
