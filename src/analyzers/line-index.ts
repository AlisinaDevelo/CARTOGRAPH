import type { SourceFile } from "ts-morph";

type LineIndex = {
  newlines: number[];
  lineBreaks: number[];
};

const indexes = new WeakMap<object, LineIndex>();

const buildIndex = (text: string): LineIndex => {
  const newlines: number[] = [];
  const lineBreaks: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10) {
      newlines.push(index);
      lineBreaks.push(index);
    } else if (code === 13) lineBreaks.push(index);
  }
  return { newlines, lineBreaks };
};

const indexFor = (sourceFile: SourceFile): LineIndex => {
  const key = sourceFile.compilerNode;
  const cached = indexes.get(key);
  if (cached) return cached;
  const created = buildIndex(sourceFile.getFullText());
  indexes.set(key, created);
  return created;
};

// Schema, lockfile, and API-definition text is scanned for many locations in
// a row; keep the index for the few most recent texts.
const MAX_TEXT_INDEXES = 8;
const textIndexes = new Map<string, LineIndex>();

const textIndexFor = (text: string): LineIndex => {
  const cached = textIndexes.get(text);
  if (cached) return cached;
  const created = buildIndex(text);
  if (textIndexes.size >= MAX_TEXT_INDEXES) {
    const oldest = textIndexes.keys().next().value;
    if (oldest !== undefined) textIndexes.delete(oldest);
  }
  textIndexes.set(text, created);
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
const locate = (
  { newlines, lineBreaks }: LineIndex,
  pos: number,
): { line: number; column: number } => {
  const breaksBefore = countBelow(lineBreaks, pos);
  const lineStart =
    breaksBefore === 0 ? 0 : (lineBreaks[breaksBefore - 1] as number) + 1;
  return {
    line: countBelow(newlines, pos) + 1,
    column: pos - lineStart + 1,
  };
};

export const lineAndColumnAtPos = (
  sourceFile: SourceFile,
  pos: number,
): { line: number; column: number } => locate(indexFor(sourceFile), pos);

/**
 * Line and column of an offset in plain text, with the same semantics as the
 * previous `prefix.split(/\r?\n/)` helpers: lines count only "\n", columns
 * restart after "\n" or "\r", and out-of-range offsets are clamped.
 */
export const lineAndColumnInText = (
  text: string,
  index: number,
): { line: number; column: number } =>
  locate(textIndexFor(text), Math.min(Math.max(0, index), text.length));
