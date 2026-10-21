# AI-ready development

## Scope and evidence

This is a modular Meteor business-application boilerplate, not an autonomous software engineer. Small models benefit from less implicit choice: strict contracts, explicit access policies, one reference implementation, deterministic scaffolds and independent tests. Productivity improvements must be measured; implementation does not demonstrate a model success rate.

Baseline: `luizcsl/MeteorReactBaseMUI`, master `ea89d092b18ce8be5fa3c25b5bd20519011c5636`. It matches the code referenced by the supplied analysis, although that document names another repository owner.

## Four layers

- `imports/core/contracts` and module contracts: input/output types and runtime parsing, without server imports.
- Module domain: pure business rules and state transitions.
- `server/`: trusted identity, operation registration, authorization, scoped repository writes.
- `ui/`: DTOs and remote calls only; loading, empty, failure and stale-operation handling.

The toolkit under `tools/` never runs inside the application. An external harness such as Synergia Code invokes its commands through a controlled executor. See [the harness contract](HARNESS_SYNERGIA.md).

## Canonical change sequence

1. Write a bounded task with objective, acceptance criteria, file allowlist, expected artifacts and budget.
2. Run doctor. Select an officially supported profile; unsupported capabilities require architectural review, not silent defaults.
3. Retrieve a bounded context package and inspect its dependency/truncation diagnostics.
4. Change contract and negative tests before implementation. Identity/roles/tenant/owner are never granted by input fields.
5. Use the deterministic scaffold for repetitive structure; review the manifest and wire server/UI explicitly.
6. Implement one vertical slice including interface states. Never ship a stub that claims persistence succeeded.
7. Run targeted checks while iterating. Run full verify outside the model before acceptance.
8. Report exact commit, tests, blocked gates and migrations. Publish only within granted authority; deploy/merge is separate.

## Capability profiles

The reference profile is online, authenticated, owner-scoped CRUD. Shared/tenant documents, transactional workflows, offline queues, arbitrary third-party integration and AI runtime need their own contracts and integration tests. The policy core can express verified server-side tenant context, but a client-supplied tenant ID is never a membership proof.

Legacy schemas remain for UI compatibility; they are not authorization schemas. New DTOs use strict parsers and preserve document generics. Public output must be projected even when the caller owns the document.

## Qualifications

Read [validation status](AI_READY_VALIDATION.md) for actual executed checks. Tooling tests are not DDP, HTTP, browser, Mongo rollback, distributed-rate-limit, restore or real-model evidence. Passing local checks is not proof that current dependency advisories or external CI pass.
