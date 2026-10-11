#!/usr/bin/env node
/* global console, process, Buffer, setTimeout, clearTimeout */

import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPLAY_AS_OF = "2026-10-01T00:00:00.000Z";
const ROOT_ID = "offline-replay-fixture-root";
const KEY_ID = "offline-replay-fixture-key";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const writeJson = (path, value) =>
  writeFile(path, json(value), { flag: "wx", mode: 0o600 });

const run = (command, args, cwd, timeoutMs = 30_000) =>
  new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const collect = (stream) => (chunk) => {
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > 1024 * 1024) child.kill("SIGKILL");
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      accept({ status, signal, stdout, stderr });
    });
  });

const probeScript = `
const { connect } = require("node:net");
const socket = connect({ host: "127.0.0.1", port: Number(process.argv[1]) });
const finish = (connected, code) => {
  socket.destroy();
  console.log(JSON.stringify({ connected, ...(code ? { code } : {}) }));
};
socket.once("connect", () => finish(true));
socket.once("error", (error) => finish(false, error.code));
socket.setTimeout(1000, () => finish(false, "TIMEOUT"));
`;

export const probeIsolation = async (isolate, cwd) => {
  const server = createServer((socket) => socket.destroy());
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  try {
    const port = server.address().port;
    const args = ["-e", probeScript, "--", String(port)];
    const ordinary = await run(process.execPath, args, cwd, 5_000);
    const isolated = await run(
      isolate[0],
      [...isolate.slice(1), process.execPath, ...args],
      cwd,
      5_000,
    );
    const result = (child) => {
      if (child.status !== 0) return { connected: false, processFailed: true };
      try {
        return JSON.parse(child.stdout);
      } catch {
        return { connected: false, processFailed: true };
      }
    };
    const control = result(ordinary);
    const denied = result(isolated);
    return {
      ok:
        control.connected === true &&
        denied.connected === false &&
        [
          "ECONNREFUSED",
          "ENETUNREACH",
          "EHOSTUNREACH",
          "EPERM",
          "EACCES",
        ].includes(denied.code),
      transport: "tcp-loopback",
      control,
      isolated: denied,
    };
  } finally {
    await new Promise((accept) => server.close(accept));
  }
};

// Synthetic fixture signer only: private keys stay in memory, never in files,
// CARTOGRAPH configuration, stdout, stderr, or retained replay reports.
export const createReplayCases = async (api, createBundle, directory) => {
  await mkdir(directory, { mode: 0o700 });
  const producer = join(directory, "producer");
  await mkdir(producer, { mode: 0o700 });
  const module = (path) => ({
    id: `module:${path}`,
    stableKey: `module:${path}`,
    kind: "module",
    name: path,
    location: { path, line: 1 },
  });
  const base = api.createGraphSnapshot({
    schemaVersion: 1,
    revision: { commitSha: "offline-fixture-base" },
    nodes: [module("src/api/a.ts"), module("src/db/b.ts")],
    edges: [],
  });
  const head = api.createGraphSnapshot({
    ...base,
    revision: { commitSha: "offline-fixture-head" },
    edges: [
      {
        from: "module:src/api/a.ts",
        to: "module:src/db/b.ts",
        kind: "imports",
        confidence: "certain",
        evidence: [
          {
            id: "fixture-api-db",
            kind: "source",
            path: "src/api/a.ts",
            line: 1,
            detector: "offline-replay-fixture@1",
            contentHash: "e".repeat(64),
          },
        ],
      },
    ],
  });
  const policy = api.parsePolicyConfig({
    policyId: "offline-fixture-layers",
    version: "1.0.0",
    mode: "enforce",
    rules: [
      {
        id: "no-db-from-api",
        target: "edge",
        assertion: "absent",
        selector: {
          kind: "imports",
          fromPath: "src/api/**",
          toPath: "src/db/**",
        },
      },
    ],
  });
  const decisions = api.parseAdrReferenceDocument({
    references: [
      {
        id: "ADR-fixture",
        file: "docs/adr/fixture.md",
        title: "Synthetic layering decision",
        status: "accepted",
        graphIds: ["module:src/api/a.ts"],
      },
    ],
  });
  const diff = api.diffGraphSnapshots(base, head);
  const options = { asOf: REPLAY_AS_OF, adr: { document: decisions } };
  const artifacts = {
    "snapshot-base": api.serializeGraphSnapshot(base),
    "snapshot-head": api.serializeGraphSnapshot(head),
    diff: api.serializeGraphDiff(diff),
    policy: api.stableStringify(policy),
    decisions: api.stableStringify(decisions),
    "policy-evaluation": api.serializePolicyEvaluation(
      api.evaluatePolicyOnDiff(policy, diff, options),
    ),
  };
  const pair = generateKeyPairSync("ed25519");
  const publicKey = (key) =>
    key.export({ format: "der", type: "spki" }).toString("base64url");
  const keyring = {
    schemaVersion: 1,
    keys: [
      {
        keyId: KEY_ID,
        trustRootId: ROOT_ID,
        algorithm: "ed25519",
        algorithmVersion: 1,
        publicKey: publicKey(pair.publicKey),
        status: "active",
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2028-12-31T23:59:59.000Z",
        retiredAt: null,
        revokedAt: null,
        rotatedFrom: null,
      },
    ],
  };
  const signed = async (id, texts) => {
    const root = join(directory, id);
    await mkdir(root, { mode: 0o700 });
    const inputs = [];
    for (const [role, text] of Object.entries(texts)) {
      const path = join(producer, `${id}-${role}.json`);
      await writeFile(path, text, { flag: "wx", mode: 0o600 });
      inputs.push({ role, path });
    }
    const bundle = join(root, "bundle");
    await createBundle(bundle, inputs);
    const manifest = await readFile(join(bundle, "manifest.json"), "utf8");
    const { payload, record } = api.assuranceBundleSigningPayload(manifest, {
      signerKeyId: KEY_ID,
      signedAt: "2026-09-29T00:00:00.000Z",
      expiresAt: "2027-09-29T00:00:00.000Z",
    });
    await writeJson(join(root, "signature.json"), {
      ...record,
      signature: sign(
        null,
        Buffer.from(payload, "utf8"),
        pair.privateKey,
      ).toString("base64url"),
    });
    await writeJson(join(root, "keyring.json"), keyring);
    return root;
  };
  try {
    const original = await signed("signed", artifacts);
    for (const id of [
      "unsigned",
      "wrong-key",
      "untrusted-root",
      "changed-artifact",
    ])
      await cp(original, join(directory, id), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    const wrong = { ...keyring, keys: keyring.keys.map((key) => ({ ...key })) };
    wrong.keys[0].publicKey = publicKey(
      generateKeyPairSync("ed25519").publicKey,
    );
    await writeFile(join(directory, "wrong-key", "keyring.json"), json(wrong), {
      mode: 0o600,
    });
    const manifest = JSON.parse(
      await readFile(join(original, "bundle/manifest.json"), "utf8"),
    );
    const artifact = manifest.artifacts.find(
      (item) => item.role === "snapshot-head",
    );
    const changedPath = join(
      directory,
      "changed-artifact",
      "bundle",
      artifact.path,
    );
    await writeFile(changedPath, `${await readFile(changedPath, "utf8")}\n`);
    await signed("derivation-mismatch", {
      ...artifacts,
      "policy-evaluation": api.serializePolicyEvaluation(
        api.evaluatePolicyOnDiff(
          policy,
          api.diffGraphSnapshots(base, base),
          options,
        ),
      ),
    });
    return [
      {
        id: "signed",
        status: 0,
        signature: "verified",
        checks: ["diff:reproduced", "policy-evaluation:reproduced"],
      },
      {
        id: "unsigned",
        status: 0,
        checks: ["diff:reproduced", "policy-evaluation:reproduced"],
      },
      {
        id: "wrong-key",
        status: 2,
        signature: "invalid-signature",
        checks: [],
      },
      {
        id: "untrusted-root",
        status: 2,
        signature: "missing-trust-root",
        checks: [],
      },
      {
        id: "changed-artifact",
        status: 2,
        signature: "verified",
        verification: false,
        checks: [],
      },
      {
        id: "derivation-mismatch",
        status: 2,
        signature: "verified",
        checks: ["diff:reproduced", "policy-evaluation:differs"],
      },
    ].map((item) => ({ ...item, directory: join(directory, item.id) }));
  } finally {
    await rm(producer, { recursive: true });
  }
};

export const replayArguments = (scenario) => [
  "bundle",
  "replay",
  join(scenario.directory, "bundle"),
  ...(scenario.id === "unsigned"
    ? []
    : [
        "--signature",
        join(scenario.directory, "signature.json"),
        "--keyring",
        join(scenario.directory, "keyring.json"),
        "--trust-root",
        scenario.id === "untrusted-root" ? "untrusted-fixture-root" : ROOT_ID,
        "--as-of",
        REPLAY_AS_OF,
      ]),
];

export const checkReplayResult = (scenario, child, report) => {
  const checks = report.checks?.map((check) => `${check.role}:${check.status}`);
  const signature = report.verification?.signature?.code;
  if (
    child.status !== scenario.status ||
    report.contract !== "cartograph.bundle-replay" ||
    report.schemaVersion !== 1 ||
    report.ok !== (scenario.status === 0) ||
    signature !== scenario.signature ||
    JSON.stringify(checks) !== JSON.stringify(scenario.checks) ||
    report.verification?.ok !==
      (scenario.verification ??
        !["wrong-key", "untrusted-root"].includes(scenario.id)) ||
    report.sharing?.findings !== 0
  )
    throw new Error(`${scenario.id} replay did not match its declared outcome`);
  for (const check of report.checks) {
    if (
      !/^[0-9a-f]{64}$/u.test(check.bundledSha256 ?? "") ||
      !/^[0-9a-f]{64}$/u.test(check.regeneratedSha256 ?? "") ||
      (check.bundledSha256 === check.regeneratedSha256) !==
        (check.status === "reproduced")
    )
      throw new Error(
        `${scenario.id} replay digest comparison is inconsistent`,
      );
  }
};

const main = async () => {
  const [requested, ...isolate] = process.argv.slice(2);
  if (!requested || isolate.length === 0)
    throw new Error("work directory and isolation command are required");
  const work = resolve(requested);
  await mkdir(work, { mode: 0o700 });
  const isolation = await probeIsolation(isolate, work);
  await writeJson(join(work, "isolation.json"), isolation);
  if (!isolation.ok) throw new Error("network isolation probe failed");
  const packed = await run(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", work, "--json"],
    repositoryRoot,
  );
  if (packed.status !== 0) throw new Error("packing the replay tool failed");
  const filename = JSON.parse(packed.stdout)[0]?.filename;
  if (
    typeof filename !== "string" ||
    basename(filename) !== filename ||
    !filename.endsWith(".tgz")
  )
    throw new Error("invalid replay package filename");
  const consumer = join(work, "consumer");
  await mkdir(consumer, { mode: 0o700 });
  await writeJson(join(consumer, "package.json"), {
    name: "cartograph-offline-replay-consumer",
    version: "1.0.0",
    private: true,
  });
  const installed = await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(work, filename),
    ],
    consumer,
    120_000,
  );
  if (installed.status !== 0)
    throw new Error("installing the replay consumer failed");
  const toolRoot = join(consumer, "node_modules/cartograph-cli");
  const cli = join(toolRoot, "dist/cli.js");
  const api = await import(pathToFileURL(join(toolRoot, "dist/index.js")).href);
  const cases = await createReplayCases(
    api,
    async (output, artifacts) => {
      const created = await run(
        process.execPath,
        [
          cli,
          "bundle",
          "create",
          "-o",
          output,
          ...artifacts.flatMap((item) => ["-a", `${item.role}=${item.path}`]),
        ],
        consumer,
      );
      if (created.status !== 0)
        throw new Error(
          `creating the replay fixture bundle failed (status ${created.status}, signal ${created.signal}): ${created.stderr.trim().replaceAll(work, "<work>").replaceAll(repositoryRoot, "<repository>").slice(0, 4096)}`,
        );
    },
    join(work, "cases"),
  );
  const results = [];
  for (const scenario of cases) {
    const child = await run(
      isolate[0],
      [
        ...isolate.slice(1),
        process.execPath,
        cli,
        ...replayArguments(scenario),
      ],
      consumer,
    );
    let report;
    try {
      report = JSON.parse(child.stdout);
    } catch {
      throw new Error(`${scenario.id} replay did not return a report`);
    }
    await writeJson(join(scenario.directory, "replay.json"), report);
    await writeJson(join(scenario.directory, "process.json"), {
      status: child.status,
      signal: child.signal,
    });
    checkReplayResult(scenario, child, report);
    results.push({
      id: scenario.id,
      status: child.status,
      ok: report.ok,
      signature: report.verification.signature?.code,
      bundleId: report.bundleId,
      checks: scenario.checks,
      resources: report.resources,
    });
  }
  const tool = JSON.parse(
    await readFile(join(toolRoot, "package.json"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(join(cases[0].directory, "bundle/manifest.json"), "utf8"),
  );
  const npm = await run("npm", ["--version"], consumer);
  if (npm.status !== 0)
    throw new Error("reading the consumer toolchain failed");
  const harnessSha256 = createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .update(
      await readFile(join(repositoryRoot, "scripts/replay-offline-smoke.sh")),
    )
    .digest("hex");
  const summary = {
    ok: true,
    fixtureSigner: "ephemeral-synthetic-key",
    toolVersion: tool.version,
    analyzerFingerprint: manifest.provenance.analyzerFingerprint,
    harnessSha256,
    nodeVersion: process.version,
    npmVersion: npm.stdout.trim(),
    platform: process.platform,
    osRelease: release(),
    architecture: process.arch,
    isolation,
    cases: results,
    independentReview: "not-performed",
  };
  await writeJson(join(work, "summary.json"), summary);
  console.log(JSON.stringify(summary));
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(`offline replay smoke failed: ${error.message}`);
    process.exitCode = 2;
  }
}
