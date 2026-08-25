# CARTOGRAPH adapter starter

Copy this directory when beginning a third-party adapter. Replace the example
implementation and fixtures with a bounded construct slice; keep the public
shape of the manifest, package, tests, and review evidence.

## Included gates

- `adapter.mjs` declares API, compatibility, graph, capability, diagnostic,
  stability, and execution versions.
- `fixtures/cases.v0.1.json` covers empty, supported, and explicit unsupported
  behavior with expected graph and diagnostic outcomes.
- `test/adapter.test.mjs` runs repeated conformance, compatibility rejection,
  and unsafe authority/configuration checks through the public `cartograph-cli`
  contract.
- `package.json` declares ESM packaging, Node support, the CARTOGRAPH peer
  dependency, and a dry-run package check.

Install a released `cartograph-cli` in the consuming project, then run:

```text
npm test
npm run pack:check
```

The adapter must remain local-first: no network, child processes, dynamic
module loading, repository-code execution, hidden telemetry, or executable
configuration. Third-party modules are hosted through `runAdapterIsolated`;
the host's permission model and resource ceilings are part of the review, not
optional deployment advice.

Before requesting graduation, follow the repository
[adapter review playbook](../../docs/ADAPTER_REVIEW_PLAYBOOK.md), link the
fixtures and conformance report, name an owner and backup, and record the
compatibility and retirement decision. This starter is a template, not a
stable support claim by itself.
