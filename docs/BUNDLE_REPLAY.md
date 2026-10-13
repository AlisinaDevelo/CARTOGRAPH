# Replaying an assurance bundle

`cartograph bundle replay` checks a bundle using only the bundle and public
tooling. The output is `cartograph.bundle-replay` v1
([schema](../schema/bundle-replay.v0.1.schema.json)).

```sh
cartograph bundle replay bundle/ \
  --signature signature.json --keyring keyring.json --trust-root cartograph-maintainers
```

It does four things in order:

1. **Verify** every digest, size, contract, and required role, and the
   signature if one is given ([signing](ASSURANCE_SIGNING.md)). If
   verification fails, nothing else runs.
2. **Regenerate** derived artifacts from the bundle's own inputs, then
   compare canonical bytes:
   - `diff` from `snapshot-base` and `snapshot-head`;
   - each `policy-evaluation` from its `policy`, its declared input (`diff`
     or `snapshot-head`), its recorded `asOf` and exception window, and the
     bundled `decisions`.

   Each check is `reproduced`, `differs` (both digests are listed), `failed`
   (regeneration threw), or `not-replayable` (its inputs are not in the
   bundle). `not-replayable` is listed, not passed silently.

3. **Check sharing** with the `team` profile ([sharing](SHARING.md)), and
   report the number of findings.
4. **Measure** wall-clock time and peak memory on this machine. These are
   reported but are not part of the deterministic result.

The command exits 2 when verification fails, a check `differs` or `failed`,
or the sharing check has findings.

## A clean, network-disabled replay

Install CARTOGRAPH on a connected machine, then replay with networking off.
With Docker:

```sh
npm install --prefix ./replay-tool cartograph-cli@<version>
docker run --rm --network none \
  -v "$PWD/replay-tool:/tool:ro" -v "$PWD/bundle:/bundle:ro" \
  node:22 node /tool/node_modules/cartograph-cli/dist/cli.js bundle replay /bundle
```

On Linux without Docker, `sudo unshare --net -- node …` gives the same
isolation. Both Ubuntu Node jobs run `scripts/replay-offline-smoke.sh` on
every pull request. The gate packs the current build, installs it into a fresh
consumer directory before isolation, then replays synthetic signed and unsigned
bundles with networking disabled. It requires an isolation command and probes
an owned loopback listener: an ordinary child must connect, and the isolated
child must be denied before replay can proceed.

```sh
npm run build
REPLAY_ISOLATE='sudo unshare --net --' \
  scripts/replay-offline-smoke.sh /tmp/cartograph-replay-new
```

The output directory must be new and outside development checkouts, so Node
cannot inherit dependencies from an ancestor's `node_modules`. The gate retains
the isolation probe, each
bundle, signature, public keyring, replay report and process exit status, plus
`summary.json` with tool versions, build and harness digests, OS/architecture,
and measured replay resources. It requires both diff and policy evaluation to
reproduce, and separately rejects an incorrect public key, an untrusted root,
changed artifact bytes, and a correctly signed bundle whose policy result does
not reproduce. Every expected failure must return exit 2 and its declared
verification or replay failure; an unreplayable artifact cannot pass this gate.

The fixture signer is synthetic. Its ephemeral Ed25519 private key stays in
producer memory and is never written, given to CARTOGRAPH, or logged. Retained
signature and public-key files have mode `0600`. Work, consumer, cases and
per-case directories have mode `0700`; bundle and artifact directories retain
the published creator's permissions (typically `0755`, subject to the process
umask) beneath those protected case directories.
These signatures exercise verification and do not establish a real producer
identity or independent review.

`REPLAY_ISOLATE` is an executable word list; it does not interpret quoted
arguments. Use a wrapper or a profile file when an isolation argument contains
spaces. The required CI isolation gate uses Linux network namespaces; other
platforms need a separately verified isolation mechanism. CARTOGRAPH's runtime
source under `src/` imports no network module and calls no `fetch`, and
`test/security/offline.test.ts` checks that boundary alongside enforced replay.

Use the analyzer version recorded in the manifest (`tool.version`, and
`provenance.analyzerFingerprint` for the exact build). A different version
can regenerate different bytes. That shows up as `differs` and is a finding
to report, not a replay failure to hide.

## Reporting an independent replay

Roadmap item A-006 asks for at least one reviewer outside the project to
follow this guide. Report:

- the bundle ID, the CARTOGRAPH version and fingerprint, OS, and Node version;
- the full replay report;
- any `differs`, `failed`, or `not-replayable` checks, and portability
  problems (paths, line endings, locale, time zone);
- sharing findings, by category only (never the values);
- time and memory used;
- whether you would accept the bundle, and why.

Open an issue with these details. Discrepancies are published as found.
