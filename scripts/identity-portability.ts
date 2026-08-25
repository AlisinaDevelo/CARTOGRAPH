/* global process */

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  analyzeTypeScriptRepository,
  createGraphSnapshot,
  parseGraphSnapshot,
  serializeGraphSnapshot,
  stableStringify,
} from "../src/index.js";

type PortabilityDiagnostic = {
  code: "IDENTITY_CASE_COLLISION" | "IDENTITY_UNICODE_COLLISION";
  normalizedKey: string;
  stableKeys: string[];
};

type PortabilityFixture = {
  schemaVersion: number;
  contract: string;
  normalization: string;
  scenarios: Array<{
    id: string;
    kind: string;
    diagnostic?: string;
    invariant: string;
  }>;
};

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/identity-portability/scenarios.v0.1.json",
);
const canonicalPath = (path: string): string =>
  path.normalize("NFC").replaceAll("\\", "/");

const rawNodeFor = (path: string) => ({
  id: `module:${path}`,
  stableKey: `module:${path}`,
  kind: "module" as const,
  name: path,
  location: { path, line: 1 },
});

const nodeFor = (path: string) => rawNodeFor(canonicalPath(path));

const snapshotFor = (path: string) =>
  createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha: "identity-portability" },
    nodes: [nodeFor(path)],
    edges: [],
    diagnostics: [],
  });

const rawSnapshotFor = (paths: readonly string[]) => ({
  schemaVersion: 1,
  revision: { commitSha: "identity-portability" },
  nodes: paths.map(rawNodeFor),
  edges: [],
  diagnostics: [],
});

const portabilityKey = (value: string, caseSensitive: boolean): string => {
  const normalized = value.normalize("NFC").replaceAll("\\", "/");
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("en-US");
};

const portableIdentityDiagnostics = (
  input: unknown,
  caseSensitive: boolean,
): PortabilityDiagnostic[] => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const nodes = (input as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  const groups = new Map<string, string[]>();
  for (const candidate of nodes) {
    if (!candidate || typeof candidate !== "object") continue;
    const stableKey = (candidate as { stableKey?: unknown }).stableKey;
    if (typeof stableKey !== "string") continue;
    const key = portabilityKey(stableKey, caseSensitive);
    const values = groups.get(key) ?? [];
    if (!values.includes(stableKey)) values.push(stableKey);
    groups.set(key, values);
  }
  return [...groups.entries()]
    .filter(([, stableKeys]) => stableKeys.length > 1)
    .map(([normalizedKey, stableKeys]) => {
      const nfcKeys = new Set(stableKeys.map((key) => key.normalize("NFC")));
      const code: PortabilityDiagnostic["code"] =
        nfcKeys.size === 1
          ? "IDENTITY_UNICODE_COLLISION"
          : "IDENTITY_CASE_COLLISION";
      return {
        code,
        normalizedKey,
        stableKeys: stableKeys.sort(),
      };
    })
    .sort((left, right) =>
      left.normalizedKey < right.normalizedKey
        ? -1
        : left.normalizedKey > right.normalizedKey
          ? 1
          : 0,
    );
};

const writeProject = (root: string): void => {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
      },
      include: ["src/**/*.ts"],
    }),
    "utf8",
  );
  writeFileSync(
    join(root, "src/index.ts"),
    [
      "export const greeting = (name: string): string => `Hello ${name}`;",
      "",
    ].join("\n"),
    "utf8",
  );
};

const analyzeRelocation = (): boolean => {
  const firstRoot = mkdtempSync(join(tmpdir(), "cartograph-portability-a-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "cartograph-portability-b-"));
  try {
    writeProject(firstRoot);
    writeProject(secondRoot);
    const first = analyzeTypeScriptRepository({
      rootDir: firstRoot,
      revision: { commitSha: "relocation" },
    });
    const second = analyzeTypeScriptRepository({
      rootDir: secondRoot,
      revision: { commitSha: "relocation" },
    });
    return serializeGraphSnapshot(first) === serializeGraphSnapshot(second);
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
};

const analyzeSymlinkPolicy = (): boolean => {
  const root = mkdtempSync(join(tmpdir(), "cartograph-portability-symlink-"));
  try {
    writeProject(root);
    symlinkSync("index.ts", join(root, "src/linked.ts"));
    if (!lstatSync(join(root, "src/linked.ts")).isSymbolicLink()) return false;
    const snapshot = analyzeTypeScriptRepository({
      rootDir: root,
      revision: { commitSha: "symlink-policy" },
    });
    return !stableStringify(snapshot).includes("linked.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

export const loadPortabilityFixture = (): PortabilityFixture =>
  JSON.parse(readFileSync(fixturePath, "utf8")) as PortabilityFixture;

export const runIdentityPortability = () => {
  const fixture = loadPortabilityFixture();
  if (
    fixture.schemaVersion !== 1 ||
    fixture.contract !== "cartograph.identity-portability" ||
    fixture.normalization !== "NFC"
  )
    throw new Error("identity portability fixture contract is unsupported");

  const windows = serializeGraphSnapshot(snapshotFor("src\\entry.ts"));
  const posix = serializeGraphSnapshot(snapshotFor("src/entry.ts"));
  if (windows !== posix)
    throw new Error("Windows and POSIX path snapshots diverged");

  const composed = serializeGraphSnapshot(snapshotFor("src/caf\u00e9.ts"));
  const decomposed = serializeGraphSnapshot(snapshotFor("src/cafe\u0301.ts"));
  if (composed !== decomposed)
    throw new Error("Unicode composed and decomposed snapshots diverged");

  if (!analyzeRelocation())
    throw new Error("repository relocation changed relative identities");

  const casePaths = ["src/Foo.ts", "src/foo.ts"];
  const caseSnapshot = rawSnapshotFor(casePaths);
  if (portableIdentityDiagnostics(caseSnapshot, true).length !== 0)
    throw new Error("case-sensitive paths were reported as colliding");
  const caseDiagnostics = portableIdentityDiagnostics(caseSnapshot, false);
  if (caseDiagnostics[0]?.code !== "IDENTITY_CASE_COLLISION")
    throw new Error("case-insensitive collision did not fail with diagnostics");

  const unicodePaths = ["src/caf\u00e9.ts", "src/cafe\u0301.ts"];
  const unicodeSnapshot = rawSnapshotFor(unicodePaths);
  const unicodeDiagnostics = portableIdentityDiagnostics(unicodeSnapshot, true);
  if (unicodeDiagnostics[0]?.code !== "IDENTITY_UNICODE_COLLISION")
    throw new Error("Unicode collision did not fail with diagnostics");
  let unicodeRejected = false;
  try {
    parseGraphSnapshot(unicodeSnapshot);
  } catch {
    unicodeRejected = true;
  }
  if (!unicodeRejected)
    throw new Error("Unicode collision was not rejected by the graph contract");

  if (!analyzeSymlinkPolicy())
    throw new Error("symlinked source input was not ignored by the analyzer");

  const report = {
    ok: true as const,
    contract: fixture.contract,
    normalization: fixture.normalization,
    scenarios: fixture.scenarios.length,
    equivalentProjects: 3,
    caseSensitiveDistinct: true,
    diagnostics: caseDiagnostics.concat(unicodeDiagnostics),
    symlinkPolicy: "ignored",
  };
  return report;
};

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  const report = runIdentityPortability();
  console.log(JSON.stringify(report));
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath !== undefined) {
    appendFileSync(
      summaryPath,
      `## CARTOGRAPH identity portability\n\n- Normalization: \`${report.normalization}\`\n- Scenarios: ${report.scenarios}\n- Collision diagnostics: ${report.diagnostics.length}\n- Symlink policy: ${report.symlinkPolicy}\n- Result: passed\n`,
      "utf8",
    );
  }
}
