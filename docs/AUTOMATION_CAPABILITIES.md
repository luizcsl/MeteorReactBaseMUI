# Automation traceability: 55 capabilities

Generated from the machine catalog. Supported means the documented bounded variant is implemented, not unrestricted business behavior. Partial entries explicitly retain design work. Provider-backed services require reviewed adapters; test evidence is separate from capability availability.

| ID  | Capability                | Stage | Status    | Mechanism and limit                                                                                                                          |
| --- | ------------------------- | ----- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | project-profile           | P0    | partial   | project: Compose owner-app or tenant-app features in an existing boilerplate; no package/auth installation                                   |
| 02  | owner-crud                | P0    | supported | feature: Owner policy only; explicit permissions                                                                                             |
| 03  | tenant-crud               | P0    | supported | feature: Trusted reviewed membership ports required                                                                                          |
| 04  | master-detail             | P1    | partial   | feature: Scoped parentExists; transactional cascading lifecycle requires design                                                              |
| 05  | approval                  | P0    | supported | feature: Explicit states, transitions and reviewer roles                                                                                     |
| 06  | domain-contracts          | P0    | supported | feature: Bounded string/integer/boolean/enum/date/money/reference                                                                            |
| 07  | cross-field-rules         | P0    | supported | feature: lte rule only; unknown expressions rejected                                                                                         |
| 08  | business-workflow         | P1    | partial   | feature: Explicit finite state transitions; timers and arbitrary conditions require design                                                   |
| 09  | typed-ddp-methods         | P0    | supported | feature: Consolidated registerMethods/callMethod; strict DTO and projection                                                                  |
| 10  | reactive-publications     | P1    | supported | feature: Trusted identity observation and bounded scoped projections required                                                                |
| 11  | rbac-abac                 | P0    | supported | feature: owner/member/reviewer matrix; arbitrary ABAC expressions unsupported                                                                |
| 12  | identity-adapters         | P0    | supported | feature: Server-owned active account and membership sources, never DTO roles                                                                 |
| 13  | relationships             | P1    | partial   | feature: Scoped references and parent ports; cross-collection transactions require design                                                    |
| 14  | private-attachments       | P2    | supported | services: Explicit private storage and authorization ports                                                                                   |
| 15  | import-export             | P2    | supported | services: Bounded CSV; XLSX requires separate approved adapter                                                                               |
| 16  | notifications             | P2    | supported | services: Explicit event/recipient/provider ports; no guessed recipients                                                                     |
| 17  | durable-jobs              | P2    | supported | services: Durable Mongo leases, bounded retries; external effects require idempotency                                                        |
| 18  | search-pagination-indexes | P1    | supported | services: Scoped bounded query/cursor; index plans do not change production                                                                  |
| 19  | audit-history             | P1    | supported | services: Append events and retention policy; no automatic deletion                                                                          |
| 20  | openapi-client            | P2    | supported | services: Bounded OpenAPI subset; no credential generation or storage                                                                        |
| 21  | reports                   | P2    | supported | services: Scoped count/sum metrics only                                                                                                      |
| 22  | schema-forms              | P0    | supported | ui: Typed RecipeForm metadata                                                                                                                |
| 23  | advanced-grid             | P0    | supported | ui: MUI X with scoped server cursors when search configured; explicit loaded-window fallback                                                 |
| 24  | list-detail-edit          | P0    | supported | ui: List-detail layout                                                                                                                       |
| 25  | wizard                    | P0    | supported | ui: Validated steps with opt-in identity-scoped 30-minute session persistence                                                                |
| 26  | bulk-dialogs              | P0    | supported | ui: Bounded selection and confirmation                                                                                                       |
| 27  | interface-states          | P0    | supported | ui: Loading/empty/error/pending/conflict                                                                                                     |
| 28  | internationalization      | P1    | supported | ui: Explicit supported en/pt-BR catalog                                                                                                      |
| 29  | design-system-layout      | P0    | supported | ui: Approved MUI components/density tokens                                                                                                   |
| 30  | stories-mocks-preview     | P1    | supported | ui: Controlled fixtures; no backend mutation                                                                                                 |
| 31  | accessibility-responsive  | P0    | supported | ui: Semantic labels and responsive MUI layout; browser audit still required                                                                  |
| 32  | add-field                 | P0    | supported | evolve: Metadata evolution; required field backfill separately reviewed                                                                      |
| 33  | add-filter                | P0    | supported | evolve: Existing declared field only                                                                                                         |
| 34  | add-state-transition      | P0    | supported | evolve: Validated state machine                                                                                                              |
| 35  | replace-permissions       | P1    | supported | evolve: Exact plan security review required                                                                                                  |
| 36  | rename-field              | P1    | supported | codemod: Semantic TypeScript symbols, separate data migration descriptor                                                                     |
| 37  | change-field-contract     | P1    | supported | codemod: Supported primitive types/optionality; migration review                                                                             |
| 38  | rename-module-route       | P1    | supported | codemod: Resolved file moves and literal route variants                                                                                      |
| 39  | move-extract-symbol       | P1    | supported | codemod: Supported exported declarations; ambiguous dependencies rejected                                                                    |
| 40  | modernize-legacy          | P1    | supported | codemod: Contract extraction and recognized registerMethod-to-core adapter; explicit policy/parser/projection and write-concurrency mappings |
| 41  | framework-migration       | P1    | supported | codemod: Approved meteor-user-async recipe only                                                                                              |
| 42  | deprecate-remove          | P1    | supported | codemod: Resolved usage checks and explicit review; protected files denied                                                                   |
| 43  | fixtures                  | P0    | supported | tests: Deterministic synthetic valid/invalid data                                                                                            |
| 44  | contract-tests            | P0    | supported | tests: Generated complements do not replace independent acceptance                                                                           |
| 45  | authorization-matrix      | P0    | supported | tests: Anonymous/owner/tenant/revocation negative invariants                                                                                 |
| 46  | e2e-scenarios             | P0    | supported | tests: Generated Cypress journey; running Meteor/browser is required                                                                         |
| 47  | property-tests            | P1    | supported | tests: Bounded deterministic property cases                                                                                                  |
| 48  | visual-comparison         | P2    | supported | tests: Snapshot comparison runner; explicit baseline review                                                                                  |
| 49  | mutation-tests            | P0    | supported | verify: Existing protected mutation runner remains mandatory                                                                                 |
| 50  | impact-tests              | P1    | supported | inspect: AST reverse dependency closure; full gates remain mandatory                                                                         |
| 51  | synchronized-docs         | P0    | supported | feature: Generated domain/permission/state diagram reference                                                                                 |
| 52  | dependency-updates        | P2    | supported | dependencies: Separate exact-hash reviewed package/lock apply; no installation or scripts                                                    |
| 53  | minimal-context           | P0    | supported | inspect: Bounded AST context and dependency graph                                                                                            |
| 54  | architecture-impact       | P0    | supported | inspect: AST graph plus mandatory boundaries gate                                                                                            |
| 55  | composed-orchestration    | P0    | supported | plan/apply: Sequential deterministic DAG, stale/tamper rejection and recovery                                                                |

## Independent evidence

- tools/test/automation-engine.test.mjs: deterministic plans, drift/tamper, protected scopes, evolution, AST impact and embedded discovery.
- tools/test/automation-runner-security.test.mjs: injected partial writes, rollback conflicts, recovery forgery/concurrency and stale dependency races.
- tools/test/automation-journey.test.mjs: independently authored create/acceptance/integration/evolution and service composition journeys.
- tools/test/automation-runtime.test.mjs and tests/automation-reactive.server.ts: shared transport, identity, publication cleanup, real DDP and Mongo revocation.
- tools/test/automation-ui.test.mjs: emitted strict TypeScript, executable auth fixtures, cursor races, owner session drafts and visual comparisons.
- tools/test/automation-services.test.mjs: real emitted service registration/client round trips, strict projection, scoped providers, CSV/jobs/API/report behavior.
- tools/test/automation-codemods.test.mjs: semantic transformations and executable legacy core adapters.
- tools/test/automation-adapters.test.mjs: CLI/MCP grammar, discovery and fail-closed dispatch.

Browser execution status must be read from the delivery evidence, not inferred from generated Cypress source or screenshot comparison unit tests.
