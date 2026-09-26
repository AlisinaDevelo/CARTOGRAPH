import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { lineAndColumnAtPos } from "../../src/analyzers/line-index.js";

describe("cached line index", () => {
  it("matches ts-morph line and column semantics at every position", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const texts = [
      "",
      "const a = 1;\nconst b = 2;\n",
      "const a = 1;\r\nconst b = 2;\r\n\r\n",
      "a\rb\rc\n\r\nd",
      "x y z\nw",
      "\n\n\nlast",
    ];
    texts.forEach((text, index) => {
      const sourceFile = project.createSourceFile(`file${index}.ts`, text);
      for (let pos = 0; pos <= text.length; pos += 1)
        expect(lineAndColumnAtPos(sourceFile, pos)).toEqual(
          sourceFile.getLineAndColumnAtPos(pos),
        );
    });
  });
});
