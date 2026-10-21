# Versioned, bounded recipes

These are reusable building blocks, not a claim that an arbitrary generated application is production-qualified. The existing `tasks` module remains the qualified reference. The five JSON presets in `templates/recipes` exercise executable domain services and React/MUI form/list components.

## Deterministic creation and evolution

`tools/recipes.mjs` exports `validateDefinition(input)`, `renderDefinition(input)` and `createRecipe(projectRoot,input)`. The same TypeScript validator is bundled for the Node tool and used by the application; there is no weaker tool-only parser. Fields are bounded strings, integers, booleans, enums, civil dates, exact money or authorized references. See [domain contracts](../DOMAIN_CONTRACTS.md) for serialization, cross-field rules and reference ports. Unknown keys, unbounded values, operator-bearing filters, reserved ownership fields and arbitrary code are rejected.

The generator writes `imports/modules/<name>/module.definition.json`, a SHA-256 `module.manifest.json`, and a generated definition, server adapter, page and contract assertion. It stages a new module before renaming, refuses collisions and symlink escapes, and is idempotent for unchanged inputs. Put custom code in `custom/` or wrappers. Evolution must review its plan and baseline hashes instead of overwriting hand-edited generated files. Adding required fields requires a data migration before accepting old records; changing permissions requires security review. `qualified:false` is deliberate.

## Explicit integration

1. Choose a preset and review its fields, exact-match filters, states and permissions. Module names are lowercase alphanumeric, 3–32 characters. Render and inspect the output.
2. Import `generated/server/register` only from server startup. Call its exported registration function with a server-owned `resolveIdentity(userId)` port. This function MUST reject inactive accounts and obtain current tenant membership and roles from trusted storage on every request. Neither URL parameters nor user-editable profile fields are membership evidence. Missing tenant membership fails closed for team and approval.
3. For master/detail, implement `parentExists(scope,id)` with a parent repository that enforces the supplied owner/tenant scope. Lists require a parent ID and validate the parent before querying its children. The sample adapter checks parent existence and child insertion separately, so applications requiring referential integrity across concurrent deletion MUST replace this path with a transaction or immutable parent lifecycle. No cross-collection transaction is claimed.
4. Import `generated/Page` into an authenticated route, passing the selected parent ID for master/detail. UI visibility is not authorization. The server parses and scopes every operation independently. The form renders loading, pending, error and empty states; exact-match lists are capped at 100, not full pagination.
5. Execute the generated contract assertion function, the independent recipe suite, the repository acceptance gates, and real DDP/Mongo/browser tests for the chosen identity adapter and routes. Generation alone never registers or qualifies a module. The explicit [integration operation](../MODULE_INTEGRATION.md) prepares and applies server/route/menu/test wiring after trusted ports and acceptance tests have been supplied.

The default Mongo adapter has no public publication, uses scoped selectors and atomic version compare-and-set for updates, transitions and deletion. The DDP adapter sanitizes unknown errors and limits requests by connection and authenticated user. Those rate limits are per process, not a distributed limit. Provision reviewed compound indexes for the actual owner/tenant/filter workload before deploying at scale. Creation requires a client mutation ID. Server-generated SHA-256 IDs bind it to the module and verified owner/tenant; Mongo’s built-in unique `_id` index provides the concurrency boundary. A canonical payload fingerprint rejects changed-payload replay. Deletion clears business data and retains an inaccessible tombstone so replay cannot recreate a deleted record. The page retains its operation ID across retries of an unchanged submission, but not across a browser reload; a durable offline client must persist that operation envelope itself. Tombstone retention and cleanup need an explicit retention policy; deleting a tombstone permits that old ID to be used again. Definition evolution is not a database migration.

## Presets and security boundaries

- Owner: only the authenticated owner can list or mutate records. Output excludes owner and tenant identifiers.
- Team: shared records are bounded to a tenant obtained from the trusted identity resolver. This is a bounded tenant/team example, not a complete tenant provisioning or membership-management product.
- Master/detail: scoped parent authorization, linked child creation, parent-filtered child listing and immutable parent references. Concurrent parent lifecycle integrity requires the application integration described above.
- Approval: draft edits only; an owner submits and a separate reviewer in the same tenant approves/rejects through explicit transitions. Submitted data cannot be edited or deleted through this service. Metadata changes can materially alter the workflow and must be reviewed. There is no tamper-proof audit ledger in this recipe.

`authorizeLinkedAttachment` requires document access, an explicit document/file link, and file access independently. It does not grant bearer tokens or implement object storage. Use it at the download boundary before streaming bytes, never in place of the storage adapter's authorization.

`prepareImport` parses the whole batch before writes, with 1–100 rows and a size cap. It does not promise rollback if subsequent persistence fails. `jobTransition` is an executable finite-state guard, not a durable scheduler: worker leases, retries, idempotency, fencing and crash recovery must be provided by a queue adapter before using background work in production. There are no fake upload/import/queue integrations.

## Executed local tests

`node --test tools/test/recipes.test.mjs` covers deterministic generation, unchanged reruns, malformed definitions, symlink escape, customization preservation, generated syntax and fifteen independently executed domain/security tests. Those include repeated owner-isolation cases, tenant isolation, projection, identity rejection, optimistic concurrency, separation of duties, scoped parents, attachment permissions and bounded import/job transitions. `npm run typecheck` also checks the reusable runtime and UI; generate all five presets before that command to check their actual local imports. These checks are not substitutes for the real integration qualification above.

`tests/recipes.server.ts` adds real authenticated DDP/Mongo cases for malformed input, concurrent create replay, CAS, tombstone safety, tenant revocation, separate approval and scoped parent links. Import it from the server test entrypoint; evidence is pending until the Meteor test run actually passes.

Personal owner scopes use an explicit null tenant constraint, translated to a tenant-absent selector in Mongo. They are never unqualified owner-only queries. The service repeats the scope check after repository reads, and validates persisted ID, version, state and parent envelope before projecting or mutating it. Tests include the same owner moving between tenants and personal context.

The approval preset uses `approvalrequests` so it does not collide with the complete `requests` journey shipped in the application. Existing generated definitions are not renamed or migrated automatically.
