import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import {
  architectureWaiverDigest,
  ArchitectureWaiverSchema,
  architectureWaiverInputDigest,
  assuranceSigningPayload,
  ASSURANCE_SIGNING_ALGORITHM,
  ASSURANCE_SIGNING_ALGORITHM_VERSION,
  ASSURANCE_SIGNING_CONTRACT,
  ASSURANCE_SIGNING_SCHEMA_VERSION,
  evaluateArchitectureWaivers,
  parseArchitectureWaiver,
  serializeArchitectureWaiverEvaluation,
  type ArchitectureWaiver,
  type AssuranceSigningKey,
} from "../../src/core/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixturePath = resolve(
  repositoryRoot,
  "test/fixtures/architecture-waivers/scenarios.v0.1.json",
);
const fixtureSchemaPath = resolve(
  repositoryRoot,
  "schema/architecture-waiver-fixtures.v0.1.schema.json",
);
const waiverSchemaPath = resolve(
  repositoryRoot,
  "schema/architecture-waiver.v0.1.schema.json",
);
const scriptPath = resolve(repositoryRoot, "scripts/architecture-waivers.mjs");

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  policy: Record<string, unknown>;
  input: Record<string, unknown>;
  inputDigest: `sha256:${string}`;
  asOf: string;
  expiringWithinDays: number;
  evidenceRevision: string;
  cases: Array<{
    id: string;
    waivers: Array<Record<string, unknown>>;
  }>;
};

const input = { kind: "snapshot" as const, snapshot: fixture.input };

const createSigningContext = () => {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const key: AssuranceSigningKey = {
    keyId: "signer-local",
    trustRootId: "root-local",
    algorithm: ASSURANCE_SIGNING_ALGORITHM,
    algorithmVersion: ASSURANCE_SIGNING_ALGORITHM_VERSION,
    publicKey,
    status: "active",
    validFrom: "2029-01-01T00:00:00.000Z",
    validUntil: "2031-12-31T23:59:59.000Z",
    retiredAt: null,
    revokedAt: null,
    rotatedFrom: null,
  };
  return { keyPair, key };
};

const signWaiver = (
  template: Record<string, unknown>,
  keyPair: ReturnType<typeof generateKeyPairSync>,
): ArchitectureWaiver => {
  const waiver = parseArchitectureWaiver(template);
  const unsigned = {
    schemaVersion: ASSURANCE_SIGNING_SCHEMA_VERSION,
    contract: ASSURANCE_SIGNING_CONTRACT,
    manifestDigest: waiver.digest,
    signerKeyId: "signer-local",
    algorithm: ASSURANCE_SIGNING_ALGORITHM,
    algorithmVersion: ASSURANCE_SIGNING_ALGORITHM_VERSION,
    signedAt: waiver.createdAt,
    expiresAt: waiver.expiresAt,
  };
  return parseArchitectureWaiver({
    ...waiver,
    signature: {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(assuranceSigningPayload(unsigned), "utf8"),
        keyPair.privateKey,
      ).toString("base64url"),
    },
  });
};

describe("locally verifiable architecture waivers", () => {
  it("replays the complete offline fixture and keeps every failure visible", () => {
    const fixtureSchema = JSON.parse(
      readFileSync(fixtureSchemaPath, "utf8"),
    ) as object;
    const validateFixture = new Ajv({ allErrors: true }).compile(fixtureSchema);
    expect(validateFixture(JSON.parse(readFileSync(fixturePath, "utf8")))).toBe(
      true,
    );

    const output = JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "validate"],
        { cwd: repositoryRoot, encoding: "utf8" },
      ),
    ) as {
      ok: boolean;
      offline: boolean;
      privateKeysIncluded: boolean;
      authorityGranted: boolean;
      cases: Array<{
        id: string;
        status: string;
        violations: string[];
        suppressed: string[];
        waiverStatuses: string[];
      }>;
    };

    expect(output).toMatchObject({
      ok: true,
      offline: true,
      privateKeysIncluded: false,
      authorityGranted: false,
    });
    expect(output.cases).toHaveLength(9);
    expect(output.cases.find((entry) => entry.id === "signed-active")).toEqual(
      expect.objectContaining({
        status: "passed",
        violations: [],
        suppressed: ["violation:no-endpoints"],
        waiverStatuses: ["active"],
      }),
    );
    for (const id of [
      "unsigned",
      "invalid-signature",
      "broadened",
      "replayed",
      "revoked",
      "expired",
      "evidence-changed",
      "policy-changed",
    ]) {
      expect(output.cases.find((entry) => entry.id === id)).toEqual(
        expect.objectContaining({
          status: "violations",
          violations: ["violation:no-endpoints"],
          suppressed: [],
        }),
      );
    }

    const source = readFileSync(scriptPath, "utf8");
    expect(source).not.toMatch(/node:(?:http|https|net|tls)/u);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
  });

  it("suppresses only an exact verified violation and never grants authority", () => {
    const template = fixture.cases.find((entry) => entry.id === "signed-active")
      ?.waivers[0];
    if (!template) throw new Error("signed waiver fixture setup");
    const { keyPair, key } = createSigningContext();
    const waiver = signWaiver(template, keyPair);
    const report = evaluateArchitectureWaivers(
      fixture.policy,
      input,
      [waiver],
      {
        asOf: fixture.asOf,
        expiringWithinDays: fixture.expiringWithinDays,
        evidenceRevision: fixture.evidenceRevision,
        keyring: [key],
        trustedRootIds: [key.trustRootId],
      },
    );

    expect(report).toMatchObject({
      policyStatus: "violations",
      status: "passed",
      authorityGranted: false,
      violations: [],
      suppressed: [
        expect.objectContaining({
          violationId: "violation:no-endpoints",
          waiverId: waiver.id,
          authorityGranted: false,
        }),
      ],
    });
    expect(report.waivers).toEqual([
      expect.objectContaining({
        id: waiver.id,
        status: "active",
        code: "WAIVER_ACTIVE",
        suppresses: true,
        authorityGranted: false,
        signatureCode: "verified",
      }),
    ]);
    expect(report.provenance).toMatchObject({
      network: false,
      sourceBodiesIncluded: false,
      privateKeysIncluded: false,
      authorityGranted: false,
      deterministic: true,
    });
    const serialized = serializeArchitectureWaiverEvaluation(report);
    expect(serialized).not.toContain(waiver.signature!.signature);
    expect(serialized).not.toContain('"privateKey"');
    expect(serialized).toBe(
      serializeArchitectureWaiverEvaluation(JSON.parse(serialized)),
    );
  });

  it("canonicalizes waiver arrays, binds the input digest, and rejects private-key or trust-root bypasses", () => {
    expect(architectureWaiverInputDigest(input)).toBe(fixture.inputDigest);
    const template = fixture.cases.find((entry) => entry.id === "unsigned")
      ?.waivers[0];
    if (!template) throw new Error("unsigned waiver fixture setup");
    const ordered = {
      ...template,
      evidenceRefs: ["graph://g003/z", "graph://g003/a"],
      trustRootIds: ["root-z", "root-a"],
      changeScope: {
        ...(template.changeScope as Record<string, unknown>),
        affectedIds: ["node:z", "node:a"],
      },
    };
    const permuted = {
      ...ordered,
      evidenceRefs: ["graph://g003/a", "graph://g003/z"],
      trustRootIds: ["root-a", "root-z"],
      changeScope: {
        ...(ordered.changeScope as Record<string, unknown>),
        affectedIds: ["node:a", "node:z"],
      },
    };
    expect(architectureWaiverDigest(ordered)).toBe(
      architectureWaiverDigest(permuted),
    );

    const schema = JSON.parse(readFileSync(waiverSchemaPath, "utf8")) as object;
    const validateWaiver = new Ajv({ allErrors: true }).compile(schema);
    const privateKeyRecord = { ...template, privateKey: "never-store-this" };
    expect(validateWaiver(privateKeyRecord)).toBe(false);
    expect(() => ArchitectureWaiverSchema.parse(privateKeyRecord)).toThrow();

    const emptyTrustRoots = { ...template, trustRootIds: [] };
    expect(validateWaiver(emptyTrustRoots)).toBe(false);
    expect(() => parseArchitectureWaiver(emptyTrustRoots)).toThrow();

    const malformed = {
      ...template,
      owner: "team:security",
      digest: template.digest,
    };
    const malformedReport = evaluateArchitectureWaivers(
      fixture.policy,
      input,
      [malformed],
      { asOf: fixture.asOf, evidenceRevision: fixture.evidenceRevision },
    );
    expect(malformedReport.violations.map((violation) => violation.id)).toEqual(
      ["violation:no-endpoints"],
    );
    expect(malformedReport.waivers).toEqual([
      expect.objectContaining({
        id: "waiver-unsigned",
        status: "invalid",
        code: "WAIVER_INVALID",
        suppresses: false,
        authorityGranted: false,
      }),
    ]);
  });
});
