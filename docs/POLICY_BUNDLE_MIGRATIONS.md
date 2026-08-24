# Policy-bundle migration and revocation

P-021 adds a local migration gate for digest-bound policy bundles. It is an
inspection and review boundary, not a policy evaluator and not a source loader.
The report contract is
[`schema/policy-bundle-migration.v0.1.schema.json`](../schema/policy-bundle-migration.v0.1.schema.json);
the explicit revocation input is
[`schema/policy-bundle-revocation.v0.1.schema.json`](../schema/policy-bundle-revocation.v0.1.schema.json).

## Findings

`evaluatePolicyBundleMigration` checks the bundle's digest and metadata for:

- a policy version upgrade;
- expiry and explicit digest revocation;
- graph/diff/capability compatibility drift;
- selectors outside the bounded local selector grammar;
- missing owners, unsupported versions, structural invalidity, or tampering.

The returned report is digest-only. It includes the bundle digest, policy
versions, review state, status, enforceability, and stable finding codes. It
does not include policy rules, selectors, source paths, or owner text.

`mode: "enforce"` fails closed when a bundle is blocked or when an incompatible
bundle has not received explicit review. Expired, revoked, ownerless, tampered,
unsupported, and structurally invalid bundles remain blocked even if a review
flag is present. A report never executes a rule or reads the source path.

The checked-in scenarios cover version upgrade, expiry, explicit revocation,
an incompatible selector, and a missing owner:

```sh
npm run policy-bundle:migrations:validate
```

Revocation is an explicit local input. It is not inferred from network state,
timestamps, or a hosted service; signed distribution and long-lived revocation
transport remain separate roadmap work.
