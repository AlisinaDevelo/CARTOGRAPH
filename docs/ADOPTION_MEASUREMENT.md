# Telemetry-free adoption measurement

M-014 defines how CARTOGRAPH may collect adoption evidence without adding a
collector, source-upload path, account requirement, or hidden telemetry. The
versioned protocol and current snapshot are:

- [`adoption-measurement.v0.1.schema.json`](../schema/adoption-measurement.v0.1.schema.json)
- [`protocol.v0.1.json`](../test/fixtures/adoption-measurement/protocol.v0.1.json)

Validate the snapshot entirely offline:

```sh
npm run adoption-measurement:validate
```

## What may be measured

Only manually reviewed, public, or explicitly authorized evidence is eligible:

| Metric                                | Permitted evidence                                                              | Claim boundary                             |
| ------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| Opt-in public reports                 | A public report offered for aggregate review                                    | Descriptive only                           |
| Issue-template signals                | A public issue or pull request using the consent fields                         | Descriptive only                           |
| Release metadata events               | Public version and release verification metadata                                | Chronology, never a user count             |
| Manually reproducible repository runs | A pinned local replay with command, revision, aggregate output, and limitations | Technical sample only                      |
| Repeat consented runs                 | An anonymized summary of a participant's later run                              | Not observed until explicit consent exists |
| Consented feedback records            | An anonymized signal with public or digest-only evidence and a backlog decision | Not observed until explicit consent exists |

The current snapshot records five pinned compatibility runs (three successful
and two bounded failures) as technical evidence. It records no external
reports, release series, repeat users, or consented adopter records. It makes
no adoption, traction, accuracy, certification, or support claim. Downloads,
stars, views, issue volume, and CI executions are deliberately excluded.

## Sampling and missingness

The protocol uses purposive public opt-in sampling. It names public-selection,
survivorship, self-reporting, revision-drift, and small-cell bias and pairs
each with a mitigation. Bounded failures and explicit `not-observed` states
remain visible; missing data is never converted into zero or estimated from
hidden activity. A new snapshot must pin the source and tool revisions, the
replay command, the evidence digest, the observation window, and the
limitations review.

The protocol is not a population survey. A future claim would require multiple
independently consented, reproducible observations, a missingness review, and
an explicit decision record. A larger count alone cannot authorize a hosted
service or change the local-first boundary.

## Retention, anonymization, and deletion

Raw repositories, source bodies, conversations, credentials, direct
identifiers, and private URLs are not retained. The default is:

- discard raw inputs after review;
- retain only versioned aggregate observations and evidence digests for 365
  days unless a reviewed snapshot says otherwise;
- remove or generalize direct and quasi-identifiers, suppress cells below the
  minimum anonymization size of three, and keep consent as a boolean plus a
  public or digest-only reference; and
- accept a withdrawal before the next snapshot through the public feedback
  route or the private security route when sensitive material is involved.

The evidence publisher removes the original material, the CARTOGRAPH
maintainer removes the summary and regenerates dependent counts and digests,
and the release owner keeps withdrawn summaries out of future manifests.
Deletion is verified by the offline validator and a diff showing that the
withdrawn signal is absent from the next snapshot. Immutable public release
metadata may remain addressable, but it is not reused in current aggregates.

## Current decision

The protocol is implemented, but the adoption claim remains **deferred**.
Before that decision can change, the project needs new independently consented
evidence, a bias and missingness review, a deletion rehearsal, and a maintainer
review that preserves the no-network, no-source-upload, and no-hidden-
telemetry defaults.

The protocol complements the [public community feedback process](COMMUNITY_FEEDBACK.md),
[adopter template](ADOPTER_FEEDBACK_TEMPLATE.md),
[repository adoption evaluation](ADOPTION_EVALUATION.md), and
[OSS health scorecard](OSS_HEALTH_SCORECARD.md); none of those documents
authorizes collection beyond this boundary.
