# Adapter review playbook

This playbook is the maintainer gate for a new CARTOGRAPH adapter. It applies to
the copyable [`examples/adapter-starter`](../examples/adapter-starter) package
and to framework or language adapters that are proposed for the public support
matrix. A manifest is not approval: the adapter must produce bounded,
repeatable evidence under the same contract that protects the core.

## Review stages

1. **Scope and ownership** — Link the roadmap or RFC issue, name a maintainer
   owner and backup, state the supported construct slice, and list explicit
   non-goals. A broad language or framework claim is rejected until its bounded
   slice has fixtures and an owner.
2. **Contract declaration** — Validate the adapter manifest and package metadata.
   Check API, compatibility, graph, capability, diagnostic, stability, and
   media-type versions. The execution declaration must be read-only or none;
   network, child processes, dynamic module loading, and repository-code
   execution remain false.
3. **Evidence and quality** — Provide positive, negative, unsupported, and
   ambiguity fixtures where applicable. Run `runAdapterConformance` with at
   least two repetitions and a finite runtime budget. Record canonical output,
   complete evidence references, declared diagnostics, expected graph counts,
   and identity behavior when the adapter claims identity continuity.
4. **Security boundary** — Exercise executable configuration, path traversal,
   unsafe authority declarations, malformed output, output limits, timeout,
   and isolated execution. Use `runAdapterIsolated` for third-party modules;
   an unavailable permission model is a refusal, not permission to fall back
   silently. Do not upload source, add telemetry, or require a hosted service.
5. **Packaging and maintenance** — `npm pack --dry-run` must contain the
   adapter, fixtures, tests, README, and package metadata without generated
   output. The package must declare its Node range and CARTOGRAPH peer
   dependency. The review names release responsibility, deprecation and
   compatibility windows, fixture ownership, support route, and vulnerability
   response contact.
6. **Graduation decision** — The reviewer records pass, conditional pass, or
   reject. Graduation to the supported matrix requires all blocking findings
   closed, a compatibility decision, a maintainer owner and backup, the
   independent dry run below, and a public issue or RFC linking the evidence.
   Experimental adapters remain opt-in and do not count as stable support.

## Required evidence packet

| Area        | Required evidence                                                      |
| ----------- | ---------------------------------------------------------------------- |
| Contract    | manifest, package metadata, compatibility result                       |
| Fixtures    | checked-in fixture file and schema, expected graph/diagnostic outcomes |
| Conformance | deterministic repeated output, evidence completeness, budget report    |
| Security    | rejected authority/config/path cases and isolated-host result          |
| Maintenance | owner, backup, support route, deprecation and retirement dates         |
| Decision    | review checklist, findings, disposition, and issue/RFC link            |

The starter's independent harness is `npm run adapter-starter:validate`. It is
deliberately separate from the adapter module: it imports only the public
contract, reads the published fixture schema, performs a package dry-run, and
checks compatibility and security behavior before any adapter result is
accepted. The recorded run is in
[`ADAPTER_REVIEW_DRY_RUN.md`](ADAPTER_REVIEW_DRY_RUN.md).

## Finding policy

An authority escalation, source leak, nondeterministic result, fabricated edge,
missing evidence, malformed package, or unbounded execution is blocking. A
missing positive or unsupported fixture blocks graduation but may be recorded
as experimental. Documentation, benchmark, and non-semantic presentation gaps
must have an owner and target date before conditional approval. Retiring an
adapter requires a migration note, a fixture update, a notice in the
compatibility policy, and a support-window date; the change-control register
must not be silently deleted.
