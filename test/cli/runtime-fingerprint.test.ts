import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);

describe("installed runtime fingerprint", () => {
  it("works without the development-only TypeScript package", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "cartograph-runtime-fingerprint-")),
    );
    try {
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
      cpSync(join(repositoryRoot, "src"), root, {
        recursive: true,
      });
      mkdirSync(join(root, "node_modules"));
      for (const dependency of ["zod", "ts-morph"])
        symlinkSync(
          dirname(require.resolve(`${dependency}/package.json`)),
          join(root, "node_modules", dependency),
          "dir",
        );
      const source = pathToFileURL(join(root, "scan-cache.ts")).href;
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(require.resolve("tsx")).href,
          "--input-type=module",
          "-e",
          `
            import { createRequire } from "node:module";
            const require = createRequire(${JSON.stringify(source)});
            let developmentCompilerAvailable = true;
            try { require.resolve("typescript/package.json"); }
            catch (error) {
              if (error.code !== "MODULE_NOT_FOUND") throw error;
              developmentCompilerAvailable = false;
            }
            if (developmentCompilerAvailable)
              throw new Error("fixture inherited a development compiler");
            const { analyzerFingerprint } = await import(${JSON.stringify(source)});
            const first = analyzerFingerprint();
            console.log(JSON.stringify({
              developmentCompilerAvailable,
              first,
              repeated: analyzerFingerprint(),
            }));
          `,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, NODE_PATH: "" },
          stdio: "pipe",
          timeout: 30_000,
        },
      );
      const result = JSON.parse(output) as {
        developmentCompilerAvailable: boolean;
        first: string;
        repeated: string;
      };
      expect(result.developmentCompilerAvailable).toBe(false);
      expect(result.first).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.repeated).toBe(result.first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
