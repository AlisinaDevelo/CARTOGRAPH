# Sustainability and cost model

M-010 publishes a reproducible, local-first planning model for the effort and
direct cost of maintaining CARTOGRAPH. The machine-readable snapshot is
[`report.v0.1.json`](../test/fixtures/sustainability-cost/report.v0.1.json),
the contract is [`sustainability-cost-model.v0.1.schema.json`](../schema/sustainability-cost-model.v0.1.schema.json),
and the offline validator is:

```sh
npm run sustainability-cost-model:validate
```

The snapshot is as of 2026-08-25. It uses USD quarterly ranges and planning
hourly-rate assumptions. It is not an invoice, budget approval, funding claim,
or evidence that the project has received funding. Volunteer labor is priced so
that an unfunded option does not hide its opportunity cost.

## Scenarios

| Option                 | Maintainer hours / quarter | Direct cost / quarter | Priced labor assumption | Total planning range | Decision                                                                           |
| ---------------------- | -------------------------: | --------------------: | ----------------------: | -------------------: | ---------------------------------------------------------------------------------- |
| OSS local-first        |                      21–70 |               $0–$100 |          $100–$200/hour |       $2,100–$14,100 | Retain while capacity is available; no budget threshold is asserted.               |
| Funded OSS stewardship |                     52–148 |               $0–$230 |          $150–$250/hour |       $7,800–$37,230 | Fund only when committed sponsorship or grant capacity covers the upper bound.     |
| Hosted team expansion  |                   Deferred |              Deferred |                Deferred |   Deferred, not zero | Defer until a new, capacity-backed boundary and approved service operations exist. |

The estimate covers nine components in every scenario: core contracts,
roadmap governance, release and distribution, dependency upkeep, support
burden, security response, adapter ownership, CI/artifact cost, and approved
service operations. The first two scenarios are explicit ranges, not measured
invoices. Their break-even rules are capacity-only for local-first and a
$37,230-per-quarter budget threshold for funded stewardship. Hosted break-even
is intentionally deferred.

## Inputs and limitations

The model links to checked-in maintenance, release, security, adapter, CI,
strategy, health-scorecard, and resilience evidence. Five inputs are planning
ranges, one is deferred, and maintainer capacity and support burden are not
observed. There are no invoices, payroll records, private reports, source
bodies, hidden telemetry, or hosted service measurements in the fixture.

Deferred costs are unknown, not free. Before hosted work can be considered, a
new public gate must approve the architecture, privacy and security boundary,
service operations, staffing, and actual cost inputs. Stop conditions reject
source upload, hidden collection, or a funding decision that cannot reproduce
its assumptions locally.

This is a planning artifact, not a promise of an SLA, staffing level, release
cadence, or future hosted product. Re-run the validator after changing the
fixture and review the digest in the associated roadmap issue.
