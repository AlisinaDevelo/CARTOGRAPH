# SARIF policy-result bridge

CARTOGRAPH exposes a versioned, offline SARIF 2.1.0 projection for policy
violations that have a repository-relative source location. The bridge is a
presentation and interoperability surface; the canonical graph, policy
evaluation, and evidence records remain the source of truth.

## Supported projection

`exportSarifPolicyEvaluation` accepts a validated policy evaluation and its
matching `GraphSnapshot` or `GraphDiff`. It emits a native SARIF log with one
run. Each mapped result is a failing (`kind: "fail"`) result with:

- a positive, repository-relative artifact URI and line region;
- the policy rule ID and bounded human-readable reason;
- a required `partialFingerprints.cartographFingerprint` SHA-256 digest;
- a `properties.cartograph` bag containing the policy violation ID, canonical
  graph IDs, and canonical evidence references.

The run's `tool.driver.properties.cartograph` bag records contract version,
policy identity, input kind, and the `sourceBodiesIncluded: false` guarantee.
The output is deterministic: the same evaluation and graph produce identical
serialized bytes and fingerprints.

## Deliberate boundary

Only violations whose matched graph objects all resolve to line-local source
locations are projected. Global, aggregate, unsupported, and source-less
violations are omitted and reported in the interchange `unsupported` list;
they are never represented as a SARIF result. This prevents a graph-level
architecture finding from being presented as a code-scanning vulnerability.

The bridge does not include source text, snippets, artifact contents, absolute
paths, local file URIs, network URLs, credentials, or hidden telemetry. It is
not a graph transport and does not import SARIF rules, code-flow traces,
taxonomies, or result kinds other than `fail`.

## Import and offline validation

`importSarifPolicyEvaluation` accepts either the native SARIF log or the
CARTOGRAPH interchange envelope. Import fails closed when a result has an
unsupported kind, missing fingerprint, mismatched fingerprint, unsafe path,
unknown property, or source-body field. Native and envelope imports verify the
same canonical graph/evidence references.

The checked-in fixture is replayed without network access or repository code
execution:

```bash
npm run sarif:validate
```

The fixture deliberately covers one line-local node violation and one
source-less aggregate violation, then exercises rejection of unsupported
result kinds, source bodies, missing fingerprints, and absolute paths.
