# Design-partner and outreach plan

CARTOGRAPH should earn its first users by delivering a useful architecture-diff artifact, not by promoting an unfinished platform.

## Initial target

Recruit staff engineers, platform leads, maintainers, and engineering managers working with TypeScript repositories where architecture drift is expensive. Useful trigger signals include monolith decomposition, a new platform team, rapid hiring, senior-engineer turnover, repeated onboarding friction, and manually maintained diagrams.

The first public cohort should be substantial repositories with direct Express usage and understandable test histories. Avoid repositories whose primary architecture is generated, build-time metaprogrammed, or framework-dynamic until the support matrix covers them.

## The useful gift

For a public repository, produce one reproducible report that contains:

- one request or module flow;
- one architecture change between two named revisions;
- one new or removed boundary crossing when present;
- direct source evidence;
- analyzer diagnostics and limitations;
- the exact tool/configuration versions needed to reproduce it.

Ask whether the result is correct and useful before asking anyone to install software.

Do not open promotional issues or pull requests in other projects. Send a private, researched note or publish an external teardown that links to the original repository and respects its license.

## First ten design partners

Offer founder-led setup, free pilot use, deletion guarantees, and direct support. Ask each partner for:

- one recent architecture-review failure or surprise;
- one repository or recorded snapshot they are authorized to provide;
- a short weekly review during the pilot;
- permission to measure correctness and repeat use;
- an anonymized case study only if the result works.

A polite conversation is not a design partnership. Useful commitment increases when someone provides a real case, runs a second analysis without prompting, invites a reviewer, or adopts the check in CI.

## Outreach message

> I am building a local architecture-diff tool for TypeScript repositories. I ran the current analyzer against `<public repository>` and mapped `<specific change>` between `<base>` and `<head>`. The report includes direct source evidence and the unsupported cases, and it can be reproduced locally. May I send it for a correctness check? I am looking for three teams willing to pilot the same read-only workflow on one private repository; no source leaves their environment.

Replace every placeholder with a real observation. Do not send bulk or automated variants.

## First 100 users

1. Users 1–10: direct design partners and correctness interviews.
2. Users 10–30: two detailed public case studies, a runnable demo, a privacy/security page, and referrals from successful users.
3. Users 30–100: open-source distribution, public repository teardowns, technical talks, and a Show HN only when strangers can run the tool.

GitHub Marketplace and a hosted GitHub App come after the local Action is stable. Product Hunt may amplify proof but is not the core B2B channel.

## Feedback loop

Track:

- reported edges confirmed or rejected by maintainers;
- unresolved constructs that block usefulness;
- time to first inspectable result;
- second-run and CI adoption;
- ignored or noisy findings;
- which report objects reviewers share.

Feed repeated failures into fixtures and public issues. Do not collect source or usage telemetry by default.
