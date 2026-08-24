#!/usr/bin/env node
/* global console */

import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([
  ".git",
  ".forge",
  "coverage",
  "dist",
  "node_modules",
]);

const markdownFiles = async (root) => {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name))
        files.push(...(await markdownFiles(join(root, entry.name))));
      continue;
    }
    if (entry.isFile() && /\.md$/u.test(entry.name))
      files.push(join(root, entry.name));
  }
  return files;
};

const links = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+[^)]*)?\)/gu;
const files = await markdownFiles(repositoryRoot);
const failures = [];
let linkCount = 0;

for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(links)) {
    const rawTarget = match[1].replace(/^<|>$/gu, "");
    if (/^(?:https?:|mailto:|data:|javascript:|\/\/)/iu.test(rawTarget))
      continue;
    const [pathTarget] = rawTarget.split("#", 1);
    if (pathTarget.length === 0) continue;
    linkCount += 1;
    const target = resolve(dirname(file), decodeURIComponent(pathTarget));
    try {
      await access(target);
    } catch {
      failures.push(`${file}: ${rawTarget}`);
    }
  }
}

if (failures.length > 0)
  throw new Error(`broken documentation links:\n${failures.join("\n")}`);

console.log(
  JSON.stringify({ ok: true, files: files.length, links: linkCount }),
);
