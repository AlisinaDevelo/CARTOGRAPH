# Architecture waivers

G-003 adds the local `cartograph.architecture-waiver` v1 contract for a
bounded, reviewable exception to one policy finding on one architecture
revision. A waiver is evidence and review metadata, not an authorization
token. It cannot grant permission, change policy, or make an unsupported input
supported.

The record schema is
[`schema/architecture-waiver.v0.1.schema.json`](../schema/architecture-waiver.v0.1.schema.json).
Each record binds:

- one policy `ruleId` and its exact node, edge, or diff selector;
- one canonical snapshot or diff input digest and the exact `affectedIds`;
- a rationale, distinct owner and approver, policy version, evidence revision,
  evidence references, creation time, expiry time, and precedence;
- one or more explicit local `trustRootIds`; and
- `authority: "none"` plus an optional Ed25519 v1 assurance-signing record.

The digest covers the canonical waiver metadata, excluding the digest itself
and optional signature. The input digest covers the canonical graph snapshot or
diff. Evidence references are portable local identifiers; absolute paths,
URLs, private keys, and source bodies are outside the contract.

## Verification boundary

`evaluateArchitectureWaivers` first evaluates the policy without using this
waiver list as policy exceptions. It then checks each record in a fail-closed
order:

1. schema, canonical digest, policy version, input kind/digest, evidence
   revision, and rule existence;
2. exact selector and affected-ID scope (a missing selector field or a strict
   superset is `WAIVER_BROADENED`);
3. creation and expiry time; and
4. optional signature metadata, including manifest binding, timestamp and
   expiry coverage, algorithm/version, exact signer key, key validity,
   rotation/revocation, and explicit local trust roots.

Unsigned, malformed, tampered, broadened, replayed, expired, revoked,
untrusted, and otherwise invalid records remain in the report and never
suppress a violation. If several fully verified waivers match one violation,
the highest precedence wins and the rest are marked `shadowed`. A suppression
record contains the exact violation and evidence references and always records
`authorityGranted: false`.

Reports contain policy findings, visible waiver diagnostics, suppression
records, deterministic provenance, and no signing key or signature material.
The resolver never reads a checkout, executes repository code, contacts a
network, or infers authority from an approver or signature.

Replay the checked-in offline corpus with:

```sh
npm run architecture-waivers:validate
```

The fixture generates ephemeral signing keys in memory and covers active,
unsigned, invalid-signature, broadened, replayed, revoked, expired,
evidence-drift, and policy-drift cases. The fixture and generated reports are
not authority grants and are not substitutes for a human review process.
