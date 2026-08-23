# ADR 0002: Keep the complete local loop open

- Status: accepted
- Date: 2026-08-23

## Context

Architecture analysis touches proprietary source and must earn trust. Distribution also benefits when maintainers can run the tool locally and inspect the evidence format.

## Decision

License the analyzer, schemas, CLI, local reports, evaluator, adapters, policy engine, and CI integration under Apache-2.0. Require no account, source upload, or hidden telemetry for the complete local workflow.

## Alternatives

- Closed source: weakens trust and distribution.
- A crippled community edition: makes the public artifact a demo rather than a useful tool.
- AGPL for the first release: adds adoption friction without protecting a hosted asset that exists today.

## Consequences

Future commercial value must come from collaboration, organizational history, managed operation, and enterprise controls. The public formats remain portable even if a hosted product is never built.
