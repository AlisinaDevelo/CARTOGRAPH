import type { SourceFile } from "ts-morph";

type LineIndex = {
  newlines: number[];
  lineBreaks: number[];
};

const indexes = new WeakMap<object, LineIndex>();

const indexFor = (sourceFile: SourceFile): LineIndex => {
  const key = sourceFile.compilerNode;
  const cached = indexes.get(key);
  if (cached) return cached;
  const text = sourceFile.getFullText();
  const newlines: number[] = [];
  const lineBreaks: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10) {
      newlines.push(index);
      lineBreaks.push(index);
    } else if (code === 13) lineBreaks.push(index);
  }
  const created = { newlines, lineBreaks };
  indexes.set(key, created);
  return created;
};

// Number of offsets in the sorted array that are strictly below pos.
const countBelow = (offsets: readonly number[], pos: number): number => {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((offsets[middle] as number) < pos) low = middle + 1;
    else high = middle;
  }
  return low;
};

/**
 * Same result as ts-morph's SourceFile#getLineAndColumnAtPos (lines count
 * only "\n"; columns restart after "\n" or "\r"), without rescanning the file
 * text on every call.
 */
export const lineAndColumnAtPos = (
  sourceFile: SourceFile,
  pos: number,
): { line: number; column: number } => {
  const { newlines, lineBreaks } = indexFor(sourceFile);
  const breaksBefore = countBelow(lineBreaks, pos);
  const lineStart =
    breaksBefore === 0 ? 0 : (lineBreaks[breaksBefore - 1] as number) + 1;
  return {
    line: countBelow(newlines, pos) + 1,
    column: pos - lineStart + 1,
  };
};
