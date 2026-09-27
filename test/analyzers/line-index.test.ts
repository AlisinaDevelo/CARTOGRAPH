import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import {
  lineAndColumnAtPos,
  lineAndColumnInText,
} from "../../src/analyzers/line-index.js";

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

  it("matches the previous text helper, including out-of-range offsets", () => {
    const previous = (text: string, index: number) => {
      const prefix = text.slice(0, Math.max(0, index));
      const line = prefix.split(/\r?\n/u).length;
      const lastBreak = Math.max(
        prefix.lastIndexOf("\n"),
        prefix.lastIndexOf("\r"),
      );
      return { line, column: prefix.length - lastBreak };
    };
    for (const text of ["", "a\nb", "a\r\nb\rc\n\n", "x\u2028y\nz"])
      for (let index = -2; index <= text.length + 2; index += 1)
        expect(lineAndColumnInText(text, index)).toEqual(previous(text, index));
  });
});
