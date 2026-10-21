# Structured AI development toolkit, second stage

This layer makes common changes smaller and mechanically checkable. It does not claim a secure system by construction, a production-ready tenant product, or measured small-model gains without an actual campaign.

## Choose the smallest valid change

| Need                                                  | Tool                                                                    | Required review                                                                |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Understand a bounded change                           | `npm run agent:context -- --task tools/task.example.json`               | Inspect closure, symbols and hashes; never silently truncate                   |
| Inspect architectural impact                          | `npm run agent:graph` and `npm run boundaries:check`                    | Resolve diagnostics; explicitly review legacy debt                             |
| Original owner-scoped task-shaped CRUD                | `npm run module:new -- --spec templates/owner-crud/example.spec.json`   | Register generated module and qualify                                          |
| Metadata-based business module                        | `npm run recipe:new -- --definition templates/recipes/owner.json`       | Select trusted identity/scope ports and independent tests                      |
| Add a field/filter/state or replace permission policy | `npm run module:evolve -- --plan operations.json`                       | Review full diff, migration requirement and policy changes before apply        |
| Controlled export migration                           | `npm run migration:export -- --store export.json --plan migration.json` | Dry-run by default; backup, explicit apply and restore rehearsal               |
| Check independent security predicates                 | `npm run test:mutations`                                                | Baseline must pass; every intentional mutant must fail actual tests            |
| Run an actual local-model experiment                  | `npm run eval:run -- campaign.json`                                     | Reviewed pinned image, independent verifier, loopback model and held-out tasks |

Machine consumers should invoke `node tools/cli.mjs ...` directly. npm may write human-readable banners before JSON. All paths in task/model operation documents are untrusted; tool validators reject unexpected fields, traversal and symlinks.

## Architecture and ownership

1. Application runtime: `imports/core/recipes` validates metadata, authorizes operations and projects results. `imports/core/ui` derives form/list state from that metadata. No model API or agent executor is imported into application code.
2. Deterministic development tools: `tools/ast.mjs`, `tools/recipes.mjs`, `tools/evolve.mjs` and `tools/migrations` are trusted supervisor tools, excluded from Meteor bundles.
3. External supervisor: `tools/harness` is optional. Synergia Code can call the APIs or CLI without depending on Meteor runtime. It owns model configuration, immutable task scope and verifier selection.
4. Independent qualification: protected tests, expected minimum test counts and immutable candidate/verifier hashes are not writable by the model. An operation plan or model response cannot mark itself passed.

Do not make the model generate the same schema independently for database, API and form. The versioned definition is validated once by a shared vocabulary; runtime and UI consume it. UI constraints improve usability but never replace server parsing, policy or output projection. Metadata is data, never executable JavaScript.

## Recommended Synergia Code specialization

Start each task with one reviewed preset and a bounded context package. Give a small model a structured operation vocabulary rather than unrestricted repository edits. For common changes, ask for the operation document, validate it, generate a plan, review the plan and apply deterministically. Keep custom behavior outside generated files.

Escalate permission expansion, tenant membership semantics, cross-collection lifecycle consistency, destructive data changes and unresolved dependencies to a stronger reviewer. Do not expand task scope automatically after a failure. Protect the supervisor, configuration, CI, tests, renderer and evaluator from candidate changes.

Use [structural evolution](STRUCTURAL_EVOLUTION.md), [recipe integration](recipes/structured-recipes.md) and [harness boundaries](HARNESS_SYNERGIA.md) as the integration references. The toolkit is not installed into a separate Synergia Code repository; no such repository was specified.

## Qualification boundaries

Static TypeScript/AST checks do not prove arbitrary dynamic behavior. Controlled mutation tests cover named authorization predicates, not all possible faults. An export-file restore rehearsal does not recover Mongo and private attachment storage together. Mocked browser clients do not prove live DDP integration. A container command builder and blocked preflight do not prove working isolation on a target host.

The [second-stage validation ledger](AI_TOOLKIT_V2_VALIDATION.md) distinguishes executed checks from unavailable infrastructure and application-specific obligations. Benchmark fixtures and controlled mock responses are never reported as real-model productivity results.
