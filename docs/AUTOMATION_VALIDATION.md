# Automation validation record

Recorded 2026-10-21 on Meteor 3.5.2 / Node 24.19.0. This is observable development evidence, not a release certificate or a measured small-model benchmark.

- At checkpoint 3, full `npm run verify` passed, including strict typecheck, 43 core tests, 25 killed security mutations, toolkit tests, architecture/template/documentation/legacy gates, contracts, and 49 real Meteor/Mongo security tests. The security run finished at 18:32:01 UTC.
- After adding the separate dependency CLI, all 108 automation tests passed with no skips. The complete toolkit suite and docs/boundary gates were rerun successfully.
- Independent journeys cover create → independently supplied acceptance → owner integration → field evolution → idempotent reintegration, protected consumers, custom composition, generated source tampering and service registration sharing the recipe repository.
- Real DDP tests cover revocation and raw driver ownership/tenant/profile changes without version increments. Standalone Mongo observation uses a bounded polling interval; large-volume performance has not been measured.
- Dependency tests use a controlled resolver. Actual repository manifest/lock compatibility was checked without running npm, changing dependencies or installing packages. Independent concurrency tests verify external edits survive rollback conflicts.
- Template runtime qualification passed (six cases). Browser-based release qualification remains blocked: Cypress download was not a valid archive, and available Chromium could not launch within the execution environment's sandbox. No browser/E2E or complete `verify:release` pass is claimed.

## Checkpoint 4 qualification boundary

All 160 automation tests passed with no skips after the final policy integration. The complete toolkit suite passed 295 tests with one existing skip and no failures. Strict typecheck, 43 core tests, the mutation gate, template/documentation/boundary/legacy checks and example contracts also passed.

New scaffold, workflow and relationship behavior is covered by deterministic unit tests, actual recipe-engine execution, strict generated TypeScript, and mock-driver transaction/fence tests. Six independently authored real replica-set cases were added for restrict/cascade/set-null, rollback, scope rejection and competing insert/delete serialization.

The new live gate could not execute: direct fresh Mongo startup failed with `open: Operation not permitted`; the standard Meteor test runner independently failed to start its own test Mongo (exit 100). The escalation launcher failed before execution. These are blocked tests, not passes. Earlier live security results do not qualify the new runtime changes. Run `npm run test:transactions`, `npm run verify` and the complete release gates in an environment supporting Mongo before production adoption.

Project copying excludes known credential/configuration paths but is not a general secret scanner; the complete tracked-source content requires supervisor review. Relationship links are deliberately limited to the same owner and tenant, and all participating writers must use the transaction adapter. Workflow deadlines are relative to the last server-owned update timestamp and are not automatic timers.

No deployment, production migration, credential creation or security configuration change was performed. The initial checkpoint left catalog entries 01, 04, 08 and 13 partial. A follow-on checkpoint adds actual local project scaffolding, typed transition conditions/deadlines, and bounded scoped relationship policies with a concrete fenced Mongo transaction adapter. All entries remain limited to their documented contracts, not arbitrary business semantics. External adapters and independently reviewed acceptance remain prerequisites where specified.
