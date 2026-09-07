import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Node, Project } from "ts-morph";
import { describe, expect, it, vi } from "vitest";

import { analyzeTypeScriptRepository } from "../../src/analyzers/typescript.js";

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/outside-import/project",
);
const analysisFailureFixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/typescript-express",
);

const analyzerOptions = {
  rootDir: fixtureRoot,
  extractors: ["typescript"] as const,
};

describe("TypeScript analyzer project lifecycle", () => {
  it("disposes the compiler service after every completed analysis", () => {
    let languageServiceCount = 0;
    let disposeCount = 0;
    const originalGetLanguageService = Project.prototype.getLanguageService;
    const getLanguageServiceSpy = vi
      .spyOn(Project.prototype, "getLanguageService")
      .mockImplementation(function (this: Project) {
        const service = originalGetLanguageService.call(this);
        const originalDispose = service.compilerObject.dispose.bind(
          service.compilerObject,
        );
        languageServiceCount += 1;
        vi.spyOn(service.compilerObject, "dispose").mockImplementation(() => {
          disposeCount += 1;
          originalDispose();
        });
        return service;
      });

    try {
      analyzeTypeScriptRepository(analyzerOptions);
      analyzeTypeScriptRepository(analyzerOptions);

      expect(languageServiceCount).toBe(2);
      expect(disposeCount).toBe(languageServiceCount);
    } finally {
      getLanguageServiceSpy.mockRestore();
    }
  });

  it("disposes a project created during setup without masking the failure", () => {
    let languageServiceCount = 0;
    let disposeCount = 0;
    const originalGetLanguageService = Project.prototype.getLanguageService;
    const getLanguageServiceSpy = vi
      .spyOn(Project.prototype, "getLanguageService")
      .mockImplementation(function (this: Project) {
        const service = originalGetLanguageService.call(this);
        const originalDispose = service.compilerObject.dispose.bind(
          service.compilerObject,
        );
        languageServiceCount += 1;
        vi.spyOn(service.compilerObject, "dispose").mockImplementation(() => {
          disposeCount += 1;
          originalDispose();
        });
        return service;
      });
    const addSourceFileSpy = vi
      .spyOn(Project.prototype, "addSourceFileAtPath")
      .mockImplementation(function (this: Project) {
        throw new Error("fixture setup failure");
      });

    try {
      expect(() => analyzeTypeScriptRepository(analyzerOptions)).toThrow(
        "fixture setup failure",
      );
      expect(languageServiceCount).toBe(1);
      expect(disposeCount).toBe(1);
    } finally {
      addSourceFileSpy.mockRestore();
      getLanguageServiceSpy.mockRestore();
    }
  });

  it("preserves an analysis failure when project cleanup also fails", () => {
    let disposeCount = 0;
    const originalGetLanguageService = Project.prototype.getLanguageService;
    const getLanguageServiceSpy = vi
      .spyOn(Project.prototype, "getLanguageService")
      .mockImplementation(function (this: Project) {
        const service = originalGetLanguageService.call(this);
        vi.spyOn(service.compilerObject, "dispose").mockImplementation(() => {
          disposeCount += 1;
          throw new Error("cleanup failure");
        });
        return service;
      });
    const getTypeSpy = vi
      .spyOn(Node.prototype, "getType")
      .mockImplementation(function (this: Node) {
        throw new Error("analysis failure");
      });

    try {
      expect(() =>
        analyzeTypeScriptRepository({
          rootDir: analysisFailureFixtureRoot,
        }),
      ).toThrow("analysis failure");
      expect(disposeCount).toBe(1);
    } finally {
      getTypeSpy.mockRestore();
      getLanguageServiceSpy.mockRestore();
    }
  });
});
