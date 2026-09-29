import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assuranceBundleSigningPayload,
  buildAssuranceBundle,
  createGraphSnapshot,
  serializeGraphSnapshot,
  verifyAssuranceBundleSignature,
} from "../../src/core/index.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const key = (overrides: Record<string, unknown> = {}) => ({
  keyId: "release-2026",
  trustRootId: "maintainers",
  algorithm: "ed25519",
  algorithmVersion: 1,
  publicKey: publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64url"),
  status: "active",
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: "2027-12-31T00:00:00.000Z",
  retiredAt: null,
  revokedAt: null,
  rotatedFrom: null,
  ...overrides,
});

const snapshot = createGraphSnapshot({
  schemaVersion: 1,
  revision: { commitSha: "head" },
  nodes: [],
  edges: [],
});
const { manifest } = buildAssuranceBundle(
  [
    {
      role: "snapshot-head",
      content: new TextEncoder().encode(serializeGraphSnapshot(snapshot)),
    },
  ],
  { toolVersion: "0.1.1", analyzerFingerprint: "f".repeat(64) },
);

const signed = (manifestText: string) => {
  const { payload, record } = assuranceBundleSigningPayload(manifestText, {
    signerKeyId: "release-2026",
    signedAt: "2026-09-29T00:00:00.000Z",
    expiresAt: "2027-09-29T00:00:00.000Z",
  });
  return {
    ...record,
    signature: sign(null, Buffer.from(payload, "utf8"), privateKey).toString(
      "base64url",
    ),
  };
};

const verify = (
  record: unknown,
  keyring = [key()],
  now = "2026-10-01T00:00:00.000Z",
  roots = ["maintainers"],
) =>
  verifyAssuranceBundleSignature(manifest, record, {
    keyring: { schemaVersion: 1, keys: keyring } as never,
    trustedRootIds: roots,
    now,
  }).code;

describe("assurance bundle signatures", () => {
  it("records build provenance in the manifest", () => {
    expect(JSON.parse(manifest)).toMatchObject({
      provenance: { analyzerFingerprint: "f".repeat(64) },
    });
  });

  it("verifies a signature over the exact manifest", () => {
    expect(verify(signed(manifest))).toBe("verified");
  });

  it("detects altered manifests, expiry, revocation, untrusted roots, and forged signatures", () => {
    const record = signed(manifest);
    expect(verify(signed(manifest.replace('"0.1.1"', '"0.1.2"')))).toBe(
      "manifest-mismatch",
    );
    expect(verify(record, [key()], "2027-10-01T00:00:00.000Z")).toBe("expired");
    expect(
      verify(record, [
        key({ status: "revoked", revokedAt: "2026-09-30T00:00:00.000Z" }),
      ]),
    ).toBe("revoked");
    expect(verify(record, [key()], undefined, ["someone-else"])).toBe(
      "missing-trust-root",
    );
    expect(verify({ ...record, signature: "AAAA" })).toBe("invalid-signature");
    expect(verify({ ...record, algorithm: "rsa" })).toBe(
      "unsupported-algorithm",
    );
  });

  it("never needs or reports a private key", () => {
    const { payload, record } = assuranceBundleSigningPayload(manifest, {
      signerKeyId: "release-2026",
      signedAt: "2026-09-29T00:00:00.000Z",
      expiresAt: "2027-09-29T00:00:00.000Z",
    });
    expect(`${payload}${JSON.stringify(record)}`).not.toMatch(/PRIVATE/u);
    expect(record).not.toHaveProperty("signature");
  });
});
