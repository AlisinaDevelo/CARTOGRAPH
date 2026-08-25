# Adopter feedback template

Use this template for a public, consented report from someone evaluating the
documented CARTOGRAPH workflow. A maintainer may summarize a private
conversation only after the participant explicitly consents to the anonymized
summary; the original message is not checked in.

Do not include source bodies, private repository URLs, credentials, personal
data, customer names, screenshots containing sensitive material, or
unpublished vulnerability details. Security reports must use the private route
in [`SECURITY.md`](../SECURITY.md).

## Workflow

- Evaluated workflow or command:
- CARTOGRAPH commit or version:
- Operating system, Node.js, npm, and TypeScript versions:
- Public or synthetic fixture used:

## Authorized input

- What input were you authorized to analyze?
- Was the input public, synthetic, or explicitly authorized for this review?
- What was removed before publication?

## Expected result

What architecture question or review decision were you trying to answer?

## Observed result

What did CARTOGRAPH report? Separate confirmed, unresolved, unsupported, and
incorrect observations. Link only to public evidence or a redacted local
artifact digest.

## Reproduction

Provide the smallest public fixture and exact commands that reproduce the
observation. Do not attach private source or a full repository archive.

## Privacy review and consent

- [ ] I removed secrets, private URLs, source bodies, and personal data.
- [ ] I am authorized to share the remaining material publicly.
- [ ] I consent to an anonymized summary of this signal being retained in the
      versioned feedback ledger.

## Backlog impact

- Suggested triage labels:
- Which existing issue or RFC should this inform?
- Suggested decision: accept, defer, reject, or investigate.
- Why is that decision proportionate to this one observation?
