# Public community feedback

M-004 defines a small, public feedback loop for adopters and contributors. It
is a decision record, not a telemetry system. CARTOGRAPH accepts only public,
synthetic, or explicitly authorized material; it never requires source upload,
private repository access, personal data, or hidden usage collection.

The versioned contract and current anonymized snapshot are
[`community-feedback.v0.1.schema.json`](../schema/community-feedback.v0.1.schema.json)
and
[`community-feedback/summary.v0.1.json`](../test/fixtures/community-feedback/summary.v0.1.json).
Validate the snapshot offline with:

```sh
npm run community-feedback:validate
```

## Public RFC process

Material changes to graph semantics, evidence, policies, adapters, privacy,
supported languages, or workflow authority require a public issue before
implementation. The RFC must include:

1. the problem and affected users;
2. alternatives and the smallest useful outcome;
3. an evidence and evaluation plan;
4. compatibility and migration impact;
5. privacy, security, and local-only boundary impact; and
6. a proposed decision and backlog links.

The public lifecycle is `proposed → evidence-requested → reviewed → decided`.
An RFC decision is one of `accept`, `defer`, `reject`, or `investigate` and must
name the resulting backlog issue or explicitly record `none`. A merged change
must link its acceptance criteria to the decision and retained local evidence.
Routine fixes may use the normal issue and pull-request templates; they do not
silently bypass this RFC rule when they change a material contract.
The public issue form is [`.github/ISSUE_TEMPLATE/rfc.yml`](../.github/ISSUE_TEMPLATE/rfc.yml).

## Triage taxonomy

Issues and feedback use one or more of these stable categories:

| Category           | Use it for                                         | Default response                |
| ------------------ | -------------------------------------------------- | ------------------------------- |
| `bug`              | A reproducible contract violation                  | Request a minimal reproduction  |
| `feature`          | A bounded capability request                       | Roadmap review                  |
| `docs`             | A documentation correction                         | Document and link the change    |
| `question`         | A clarification request                            | Answer publicly or improve docs |
| `performance`      | A measured resource or latency boundary            | Request fixture and environment |
| `compatibility`    | A runtime, schema, adapter, or platform mismatch   | Review support policy           |
| `security`         | A possible vulnerability or trust-boundary failure | Use the private report route    |
| `adopter-feedback` | A consented workflow evaluation                    | Roadmap review with evidence    |
| `contributor`      | Onboarding or maintainer-capacity signal           | Roadmap review                  |
| `roadmap`          | Sequencing or investment decision                  | Link an explicit decision       |
| `governance`       | Process, ownership, or decision-record concern     | Public governance review        |

Security reports are never handled in public issue content. Duplicate,
unsupported, or unactionable reports are closed with a factual explanation and
the relevant contract or documentation link.

## Adopter and contributor reports

The [adopter feedback template](ADOPTER_FEEDBACK_TEMPLATE.md) requests the
workflow, authorized input boundary, expected and observed result, smallest
reproduction, privacy review, consent, and backlog impact. Contributors may
use the same structure for onboarding or maintenance feedback. A report is
eligible for the ledger only after its signal is anonymized, its evidence is
public or digest-only, and its decision link is explicit.

The project does not infer adoption from downloads, issue volume, GitHub views,
or CI runs. A participant may withdraw consent before a summary is published;
the checked-in ledger retains only the anonymized signal and decision needed to
explain the backlog change.

## Current anonymized summary

The v0.1 snapshot contains one clearly marked synthetic maintainer baseline and
zero external adopter or contributor records. It therefore makes no traction
claim. Its explicit decisions are:

- retain the public, local-first, consent-based feedback boundary for M-004;
- defer traction and health claims in [M-005's scorecard](OSS_HEALTH_SCORECARD.md)
  until consented external evidence exists.

The synthetic baseline is a protocol regression fixture, not user research. It
exists to prove that every future record has a triage category, evidence
reference, anonymized representation, privacy boundary, and explicit backlog
decision. The validator rejects private telemetry, retained source payloads,
non-anonymized records, missing decisions, unknown triage IDs, and summary-count
drift.
