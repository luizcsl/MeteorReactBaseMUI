# Deterministic development automation

This development-only engine extends the existing toolkit; it is not a replacement Meteor runtime. Runtime code uses the boilerplate's shared `registerMethods`, `registerPublications`, `callMethod` and subscription wrappers. See [transport consolidation](AUTOMATION_TRANSPORT.md).

## Small-model workflow

Use six tools, not 55 unrelated commands. CLI and MCP dispatch the same implementations. For a selected capability, call toolkit.catalog with {"capability":"23","schemas":true}; the result embeds schemas and an executable request example, so remote agents need no filesystem access.

1. `npm run --silent toolkit:catalog`: discover all 55 numbered capabilities, exact schemas, limits and gates.
2. `npm run --silent toolkit:inspect -- inspect.json`: bounded AST graph and reverse dependency impact. Example: `{"paths":["imports/modules/tasks"],"changed":["imports/modules/tasks/contracts.ts"]}`. Paths must exist; exceeded budgets fail closed.
3. `npm run --silent toolkit:plan -- tools/automation/examples/owner-feature.json > plan.json`: deterministic DAG, full old/new content/diff, SHA-256 preconditions, reviews and migration descriptors. No project files are changed; a temporary isolated staging tree is removed after planning.
4. Review the complete diff. `npm run --silent toolkit:apply -- plan.json` recomputes the plan from trusted generators, rejects edits/drift, and applies under an exclusive journal lock. Security, migration and semantic operations require an explicit review file: `{"planHash":"<exact hash>","reviews":["security"]}`; list every review category requested by the plan. This file records the caller's approval, not independent authentication.
5. `npm run --silent toolkit:verify > evidence.json`: run fixed allowlisted gates. Results distinguish passed, failed, blocked and not-run. Optional `{"gates":["typecheck","test:toolkit"]}` is only a partial fast loop.
6. `npm run --silent toolkit:report -- plan.json evidence.json`: summarize artifacts, reviews, migrations and evidence. `qualified` remains false: only a protected external supervisor can grant acceptance.

`npm run --silent toolkit:mcp` starts a newline-delimited JSON-RPC stdio MCP adapter with `toolkit.catalog`, `toolkit.inspect`, `toolkit.plan`, `toolkit.apply`, `toolkit.verify`, `toolkit.report`. Tool arguments are bounded data, never commands or arbitrary source code. Keep it inside the same externally controlled development workspace as the CLI.

## Feature contract and real output

`tools/automation/contracts/feature.v3.schema.json` describes a bounded feature. Supply explicit name, archetype, fields and read/write permissions. Owner defaults never grant tenant or reviewer access. Fields retain the existing recipe validators: bounded string, integer, boolean, enum, date, integer minor-unit money and trusted reference.

The owner example produces the existing recipe module plus authenticated MUI list/detail/edit UI, schema form, grid, complementary executable contract/authorization/property tests, Cypress journey, visual comparator, mutation delegation, mocks/stories and synchronized field/permission/workflow documentation. `module.automation.json` pins every generated extension and the source contract. It does not replace the existing recipe manifest.

UI variants include list-detail and wizard, optional bulk-delete confirmation, en/pt-BR interface messages, responsive MUI layouts and opt-in reactive subscriptions. With services.search configured, the grid uses registered server-scoped cursor queries, exact filters, bounded page size and stable ID ordering. Without search, its loaded-window fallback visibly discloses the 100-record limit. Owner wizards may opt into identity/context-scoped session progress with a 30-minute TTL, schema fingerprint and 64 KiB cap; tenant-profile persistence is rejected until a trusted tenant scope is supplied. Reactive UI requires trusted server identity/dependency observers.

Run emitted complementary tests with `node imports/modules/<name>/automation/tests/verify.mjs`. Browser specs require a provisioned synthetic account and integrated route. Visual comparisons require explicitly reviewed baseline files and fail on missing or changed baselines. No generated test replaces protected acceptance.

## Integration is explicit, not fake success

Feature generation alone does not expose routes or grant permissions. For owner integration, select `integration.identity = "owner-active-account"`; the composition root reuses the boilerplate's active account plus linked active-profile contract. Other profiles require `reviewed-ports` with an existing server-only `ports.ts`; a relative re-export preserves that adapter’s import context. The engine integrate operation accepts identity/ports selection, so the first feature need not include integration. Every integrated module also requires independently reviewed `custom/server/acceptance.test.ts` before `module:integrate` can wire server, authenticated route, menu and tests.

Recommended sequence: generate; review/supply trusted ports and independent acceptance; then plan an `integrate` operation. The integration tool validates the extension manifest and selects `automation/Page` without replacing or weakening the base generated files. Missing identity, parent, reference or acceptance contracts are blockers, not generated TODO success.

## Evolution and refactoring

Use `evolve` operations for generated modules: add field/filter/state or replace explicit permissions. The existing `module:evolve` implementation runs in staging; UI, fixtures, synchronized docs and extension manifest regenerate from the new definition. Any modified controlled extension blocks regeneration. A wizard that no longer partitions all fields also blocks until its business layout is explicitly updated.

Use `codemod` operations only for supported hand-written TypeScript patterns. Compiler symbol resolution updates references; ambiguity fails closed. See [codemod scope](AUTOMATION_CODEMODS.md). Every semantic change requires review. Field/type changes produce pending migration plans, never run database operations. Legacy modernization extracts public contracts and adapts recognized inherited registerMethod callbacks through real core input/output/policy/identity/projection contracts. Writes require an explicit reviewed concurrency executor and single-invocation guard. It does not infer policies or automatically prove arbitrary ProductBase behavior.

Use `project` to compose up to ten owner-app/tenant-app feature contracts inside this boilerplate. This does not create credentials, install packages, deploy an app or create a different framework.

## Services and conditional capabilities

The all-services example and [service guide](AUTOMATION_SERVICES.md) cover private attachments, CSV import/export, notifications, durable leased jobs, scoped cursor search/index plans, audit/history, bounded OpenAPI clients/mocks, aggregate reports and dependency update review plans. Generators emit strict typed service DTOs, shared registerMethods registration, callMethod clients and a connected report dashboard. Integration reuses the exact recipe repository and wires service registration; non-builtin storage/provider adapters remain explicit reviewed ports. Generating them does not claim an email provider, external service or production queue has been configured.

Unsupported XLSX, arbitrary OpenAPI schemas, cross-store transactions, unrestricted ABAC, arbitrary workflow expressions and complete legacy rewrites fail closed or remain explicit design work. The catalog reports bounded support explicitly, together with adapter requirements and remaining limits. The 55 entries are traceable mechanisms, not a claim that every possible variant of all 55 topics is automated.

## Transaction safety and recovery

Planning snapshots bounded UTF-8 source trees, rejects symlinks, and computes complete diffs. Apply never executes commands supplied in plans. It recomputes generators, checks every dependency snapshot after asynchronous planning, and rechecks each file before writing. Protected tests/configuration cannot be changed by codemods. Trusted generator-owned complementary tests can regenerate only after manifest verification.

The journal is atomically renamed and fsynced. Individual source writes use temporary rename; caught errors roll back prior writes. This is a development-worktree transaction, not simultaneous multi-file visibility to a running application. Stop live consumers and other writers before applying. The lock coordinates engine writers; it is not an OS sandbox.

An unresolved journal blocks future work. After independently confirming the writer terminated, inspect and remove a stale lock, then run `toolkit:recover`. Recovery reconstructs and revalidates the original trusted plan, preflights all targets, preserves conflicting edits and restores only matching states. Never remove a live lock or edit a journal to bypass validation. No production data migration or automatic security/configuration expansion occurs.

## Evidence and limits

Run `npm run test:automation` for independent generator/runtime/codemod/transaction cases. `npm run verify` retains the existing complete gate chain, including real security acceptance. Actual Meteor, Mongo and browser evidence must be recorded separately from Node/typecheck results. No measured small-model productivity claim is made; use the existing protected benchmark harness to compare conventional, context-guided and automation-assisted tasks under the same acceptance conditions.

## Separate dependency review workflow (52)

This deliberately does not grant the six ordinary tools permission to edit package manifests. Discover its request schema and entrypoint with `toolkit.catalog` input `{"capability":"52","schemas":true}`. The example versions illustrate syntax, not a recommendation or an assertion that a release exists.

1. `node tools/automation/adapters/dependencies-cli.mjs plan updates.json > dependency-plan.json` resolves only existing registry dependencies in an isolated temporary directory, using fixed npm arguments and scripts disabled. `from` must exactly match the current declaration (including `^`/`~`); `to` is an exact version. No project files or installed packages change during planning.
2. Independently review every package/lock diff, source, compatibility and security implication. Supply `review.json` containing only `{"approvedPlanHash":"<exact plan hash>"}`.
3. `node tools/automation/adapters/dependencies-cli.mjs apply dependency-plan.json review.json` checks hashes, semantics, current bytes and concurrent edits, then updates only the two reviewed files. It does not install packages or execute scripts. Requalify separately after an authorized installation.

Existing safe registry-only overrides remain unchanged. New packages, nonregistry dependencies, arbitrary npm flags and scripts are rejected. A process crash or rollback conflict retains the lock/backups for supervised recovery; do not remove a live writer's lock. This workflow is not an atomic two-file database transaction. The approval file records a supervisor decision; it is not an authentication mechanism.

## Additional standard policy variants

A new project can be created from an approved tracked local copy using the separate project CLI. Its plan includes complete bytes/hashes, excludes known private-configuration paths and local caches (exact content still requires review), and only applies into a nonexistent destination under the explicitly selected workspace. It does not install packages, create credentials or deploy. See [project creation](AUTOMATION_PROJECT.md).

Feature contracts may include `workflow` typed conditions and trusted server-clock deadlines, enforced before registered transitions. They do not execute arbitrary expressions or schedule automatic transitions. See [workflow contracts](AUTOMATION_WORKFLOWS.md).

Feature `relationships` declares scoped incoming/outgoing links and bounded restrict, cascade or nullable-reference policies. Integration requires an explicit registry using the supplied Mongo transaction adapter; every participating write uses the shared scope fence. Standalone Mongo without transaction support is rejected, not downgraded to a racy precheck. See [relationship lifecycle](AUTOMATION_RELATIONSHIPS.md). Raw writes outside the adapter are outside the invariant and must not be used for participating collections.
