# Sharing bundles safely

Assurance bundles and the history store are plain local directories. Nothing
in CARTOGRAPH uploads them, and nothing here provides access control,
encryption, or a compliance certification. This guide covers what a bundle
can reveal, what CARTOGRAPH checks before it leaves the machine, and what
stays your responsibility.

```sh
cartograph bundle check bundle/ --profile public        # exit 2 on findings
cartograph bundle share bundle/ -o shared/ --profile public --key-file share.key
cartograph bundle create -o bundle/ -a ... --profile team  # refuse unsafe inputs
```

## Threat model

The asset is what a bundle says about a private repository: file and
directory names, module and symbol names, external service hosts, policy and
decision text, finding and waiver reasons, and anything a report or
configuration file happens to contain. The threats are an accidental leak to
the wrong recipient (a bundle attached to a public issue, or a vendor ticket)
and a recipient learning more than intended from a bundle meant for them.

Out of scope: an attacker with access to the machine that holds the bundle or
the pseudonymization key, and the recipient's handling after delivery.

## Default exclusions

These never enter a bundle, whatever the profile:

- Source bodies. No role carries source, and the manifest records
  `sourceBodiesIncluded: false`.
- Timestamps, hostnames, usernames, and absolute paths of the machine that
  built the bundle. The manifest is derived from contents only.
- Files that are not one of the declared roles, symbolic links, and special
  files (`bundle verify` rejects them).

## Recipient profiles

| Profile  | For                                        | Flags                                                                                                                                                                   |
| -------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `team`   | people who can already read the repository | private keys, access tokens, JWTs, credential assignments, URLs with credentials, absolute local paths                                                                  |
| `public` | anyone else                                | everything `team` flags, plus email addresses, IP addresses, and URLs to hosts other than contract references (`json-schema.org`, SARIF schema hosts) or `--allow-host` |

`share --profile public` also leaves out the `configuration` and
`adapter-manifest` roles, which describe the local setup. They are declared
missing with a reason in the new manifest, so the bundle still verifies.
Use `--include-role` to keep one.

## Safe-sharing checks

`bundle check` verifies the bundle, then scans every string in every
artifact and in the manifest (keys and values for JSON, every line for HTML
and Markdown reports). Each finding names the artifact, a JSON pointer or
line, and a category. It never contains the value. An artifact that is not
UTF-8, not parseable, or nested more than 256 levels is reported as
`unscannable`, so the check fails closed. The report is
`cartograph.bundle-sharing` v1
([schema](../schema/bundle-sharing.v0.1.schema.json)).

`bundle create --profile` runs the same check on the new bundle and writes
nothing if there are findings.

## Field-level redaction

`bundle share` builds a new bundle from a verified one:

1. Drop the roles the profile excludes.
2. With `--key-file`, pseudonymize repository paths, and for `public`,
   remote hosts too.
3. Replace each detected value, inside its field, with
   `[REDACTED:<category>]`.
4. Rebuild and re-verify every artifact against its contract, and re-run the
   sharing check.

If a redacted artifact no longer satisfies its contract (for example, two IDs
that redact to the same value), or anything is still flagged, `share` fails
and writes nothing. Its error names the role, not the value. Fix the value at
its source and rebuild the bundle. The shared bundle has a new `bundleId`,
and the result reports the source bundle ID, so you can keep a local record
of what was derived from what.

## Pseudonymization and its limits

With `--key-file` (at least 32 bytes, for example
`head -c 32 /dev/urandom > share.key`), each path segment becomes
`p<10 hex>` keyed with HMAC-SHA-256. The file extension stays, so
`src/api/users.ts` becomes `pXXXX/pXXXX/pXXXX.ts` everywhere it appears: in
IDs, locations, evidence, policy selectors, and reports. Remote hosts become
`h<10 hex>.invalid`. The same key gives the same pseudonyms, so two bundles
shared with one key can be compared, and different keys cannot.

Pseudonymization is not anonymization:

- Structure stays visible: directory depth, file counts, extensions, graph
  shape, edge kinds, counts, and diagnostics.
- Symbol names (functions, classes, routes), policy IDs, decision titles, and
  free text are not pseudonymized. Read the report and the decisions before
  sharing them, or leave those roles out.
- Evidence content hashes stay. They identify file contents, so anyone who
  holds a file can confirm it was analyzed.
- Anyone who has the key can reverse a pseudonym by hashing candidate names.
  Keep the key local and never put it in a bundle.

## Retention and deletion

Nothing expires automatically.

- A bundle is a directory; deleting it deletes it. Shared copies are outside
  CARTOGRAPH's control.
- The history store (`.cartograph/history` by default) keeps every imported
  record until you remove it. Records are content-addressed, so the same
  content imported twice is one object. To drop records, export the ones to
  keep with `history export`, remove the store, and import them again.
  `history repair` moves corrupt objects to `quarantine/`. Delete that
  directory when you no longer need it.
- Add `.cartograph/` to `.gitignore` so the history store and caches are
  never committed.
- Rotate or delete a pseudonymization key when it should no longer link old
  and new shared bundles.
