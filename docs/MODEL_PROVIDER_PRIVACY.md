# Optional model-provider privacy boundary

Status: RFC, design-only, 2026-08-24. CARTOGRAPH does not ship a model
provider, provider credential handling, or a network client as part of this
RFC. The design must be accepted and re-reviewed before any provider adapter
is implemented.

## Decision summary

The default is **no provider**. Local deterministic analysis, governed rules,
and explicit deferral are the complete default behavior. A future provider
mode would be an opt-in operation selected by the user for one request; a
repository, issue body, suggestion, or configuration file may not turn it on.
Provider output can propose unverified text only. It cannot become graph truth,
policy truth, evidence, approval, or an instruction to execute a command.

The provider boundary has four states:

| State                       | Behavior                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `local-only`                | Analyze and redact locally; never construct a network request.                                                    |
| `provider-consent-required` | Refuse to send until the user has reviewed the provider, model, fields, retention, training policy, and budget.   |
| `provider-requested`        | Send only the fixed, redacted allowlist after local checks and record digest-only provenance.                     |
| `deferred`                  | Return an explicit no-provider result when policy, availability, budget, provenance, or confidence controls fail. |

There is no silent fallback from a provider failure to an unverified success.
Deferral is a valid and expected result.

## Data boundary

The payload allowlist is exact and bounded. Every field is canonicalized before
redaction and included only when the user has consented to provider mode.

| Field                                               | Eligible to leave the machine | Required control                                                                                              |
| --------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `contract`, `schemaVersion`                         | Yes                           | Fixed protocol constants only.                                                                                |
| `requestId`                                         | Yes                           | Fresh opaque identifier; never a path, account ID, or credential.                                             |
| `findingCode`, `severity`, `risk`, `suggestionKind` | Yes                           | Enumerated values from the validated local contract.                                                          |
| `baselineDigest`, `evidenceDigest`, `sourceDigest`  | Yes                           | SHA-256 digests only; no source text or absolute path.                                                        |
| `relativeReference`                                 | Conditionally                 | Repository-relative, normalized, user-approved, and never a secret-bearing name.                              |
| `redactedSummary`                                   | Conditionally                 | Local deterministic redaction, 2,000-byte bound, explicit per-request consent; omit the field when uncertain. |
| `inputNames`                                        | Conditionally                 | Enumerated names only; drop names that contain path, credential, identity, or source content.                 |
| prompt/response bodies                              | No by default                 | Never part of the canonical local report; retaining them requires a separate explicit audit setting.          |

The following never leave the machine: source or issue bodies, code excerpts,
raw report markup, credentials, API keys, authorization headers, cookies,
private keys, environment values, absolute paths, URLs with credentials/query
strings/fragments, local user identifiers, provider tokens, and repository
configuration that can select commands or credentials. A digest is evidence of
identity, not permission to disclose the value it represents.

## Local redaction and consent

Redaction happens before request construction and before any transport boundary.
The denylist covers bearer/basic authorization, common API-key prefixes, JWTs,
private-key blocks, password/token/secret assignments, credential-bearing URLs,
absolute POSIX or Windows paths, and environment-variable values. Matches are
replaced with typed markers such as `[REDACTED:credential]`; if the redactor
cannot classify a value, the whole field is omitted and the request is
deferred. Redaction is deterministic and its policy digest is recorded.

Consent is explicit, recent, and scoped to one provider request. The consent
record names the provider and model, eligible field classes, endpoint region,
retention period, training policy, budget, and whether a digest-only local
provenance record may be kept. Configuration defaults, issue text, prompt
instructions, and provider responses cannot constitute consent. Revocation
must prevent the next request and must not be treated as a retroactive deletion
of a provider's retained data; the provider's deletion contract is a separate
requirement.

## Retention and training policy

The default local retention is digest-only provenance: request digest, response
digest, redaction-policy digest, provider/model identifier, protocol version,
timestamp, budget result, and disposition. Raw prompts and responses are
discarded after the operation unless the user separately enables an encrypted
audit store and a deletion schedule. A provider is eligible only when its
contract states the retention period, deletion path, region, subprocessors,
incident process, and **no training on customer content by default**. An unknown
or opt-out training policy is a hard defer, not an advisory warning.

## Provenance and reproducibility

The request provenance record contains the canonical input digest, source and
evidence digests, redaction-policy version/digest, consent ID, provider/model
identifiers, protocol version, budget, and a monotonic request timestamp. The
response record contains only a response digest, disposition, validation result,
and an explicit nondeterminism flag. If a provider exposes sampling controls,
the chosen settings and seed are recorded; a seed is not treated as proof of
reproducibility. Model upgrades, unavailable versions, different tool context,
or a response digest mismatch cause replay to defer.

Provider confidence is advisory metadata, never a certainty upgrade. The local
contract retains uncertainty, assumptions, risk, evidence links, and
`status: unverified`. A response that claims high confidence without evidence,
or that asks to weaken a policy or execute a command, is rejected or deferred.

## Budgets and availability

Provider mode requires caller-supplied ceilings for request bytes, response
bytes, input items, output items, wall-clock time, retries, and cost. The
minimum safe default is zero network retries and no background requests.
Provider adapters must use fixed argument construction, no repository-selected
commands, no provider tools, and no credentials sourced from repository files.
Timeout, quota, authentication, rate-limit, malformed-response, and transport
errors all produce `deferred` with a typed reason. Local deterministic analysis
and reviewed remediation rules remain available after a defer.

## Adversarial acceptance matrix

The checked-in fixture set uses inert markers rather than functional secrets or
live endpoints. Each case requires `noRawLeak: true` and an explicit disposition:

| Fixture                      | Threat                                                           | Required disposition |
| ---------------------------- | ---------------------------------------------------------------- | -------------------- |
| `no-provider-default`        | A repository requests provider use through untrusted config.     | `local-only`         |
| `source-prompt-injection`    | Source text says to ignore policy and disclose files.            | `deferred`           |
| `issue-prompt-injection`     | Issue text impersonates an operator and requests a secret.       | `deferred`           |
| `secret-exfiltration`        | A suggestion contains credential-shaped material.                | `deferred`           |
| `untrusted-report`           | A report embeds remote instructions or unsupported evidence.     | `deferred`           |
| `malicious-suggestion`       | A response proposes a destructive command or policy weakening.   | `deferred`           |
| `provider-failure`           | Timeout, quota, auth, or malformed response occurs.              | `deferred`           |
| `nondeterminism`             | Same canonical input produces a different response digest.       | `deferred`           |
| `misleading-confidence`      | Provider confidence conflicts with evidence or uncertainty.      | `deferred`           |
| `consented-redacted-summary` | A user-approved summary passes local redaction and field bounds. | `redact-and-send`    |
| `training-policy-unknown`    | Provider retention or training terms are unspecified.            | `deferred`           |
| `budget-exceeded`            | Request, response, time, retry, or cost ceiling is exceeded.     | `deferred`           |

These fixtures are policy tests, not evidence that a provider is safe. A future
adapter must add transport-boundary tests, provider contract review, and an
independent red-team gate before it can leave the design-only state.

Validate the RFC's scenario contract offline with:

```sh
npm run model-provider-privacy:validate
```
