# Assurance signing metadata

The local assurance-signing contract records public signer identity references,
algorithm/version, key validity, rotation, revocation, and an expiry-bound
signature over a manifest digest. The record and key schemas are:

- [`schema/assurance-signing.v0.1.schema.json`](../schema/assurance-signing.v0.1.schema.json)
- [`schema/assurance-signing-key.v0.1.schema.json`](../schema/assurance-signing-key.v0.1.schema.json)
- [`schema/assurance-signing-keyring.v0.1.schema.json`](../schema/assurance-signing-keyring.v0.1.schema.json)
- [`schema/assurance-signing-verification.v0.1.schema.json`](../schema/assurance-signing-verification.v0.1.schema.json)

The v0.1 verifier supports only Ed25519 algorithm version 1. It accepts a
public-key keyring and an explicit trusted-root ID list; no private key is
accepted by the configuration or emitted in a report. A signer key is selected
by exact ID and never replaced with another key when it is missing, untrusted,
revoked, expired, retired past its rotation boundary, or invalid.

Verification is offline and checks the canonical digest payload, key validity,
record expiry, trust-root membership, rotation predecessor, algorithm/version,
and signature. Reports contain only the manifest digest, signer key ID, status,
and stable failure code.

The local fixture gate generates ephemeral Ed25519 keys in memory and covers old
keys, missing trust roots, tampered manifests, explicit revoked keys, and a
missing signer that must not fall back to another key:

```sh
npm run assurance-signing:validate
```

This is signing metadata and verification only. Assurance-bundle packaging,
redaction, retention, and independent replay remain separate roadmap work.
