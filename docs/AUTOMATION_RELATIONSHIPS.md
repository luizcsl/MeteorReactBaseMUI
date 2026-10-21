# Transactional relationship lifecycle

Configured recipe modules can enforce named, bounded incoming deletion policies through the actual recipe service. This is opt-in. Existing recipes without `relationships` retain their original repository behavior and do not acquire a cross-collection referential-integrity guarantee.

The automation contract is `tools/automation/contracts/relationships.v1.schema.json`. Its runtime parser is shared with the generator, not a weaker duplicate. A parent example:

```json
{
	"incoming": [
		{ "name": "lineItems", "source": "lineitems", "field": "parentId", "policy": "cascade", "maxAffected": 50 }
	],
	"outgoing": [],
	"maxTotal": 100
}
```

The corresponding master/detail `lineitems` module declares:

```json
{
	"incoming": [],
	"outgoing": [{ "field": "parentId", "target": "orders" }],
	"maxTotal": 100
}
```

Use a reference field's exact name instead of `parentId` for an ordinary reference in `data`. The outgoing target must match the field's recipe definition. Every reference field and master/detail parent must have an outgoing declaration. Both sides must exist in the participating registry; missing or inconsistent policies stop integration at construction, before methods are registered.

## Executable policies and bounds

- `restrict`: any live reference within the authorized owner/tenant scope aborts deletion with `conflict`. Already deleted tombstones do not block.
- `cascade`: recursively plans deletion of the matching source records and then removes children before the requested root. Every deletion uses its observed version as a compare-and-set precondition and preserves a tombstone.
- `set-null`: nullifies only the declared optional reference field, validates the resulting source data, and increments its version using CAS. Required fields and master/detail parents cannot be nullified.
- `maxAffected`: 1–100 matching records per incoming policy and visited target. The query requests at most one extra record to detect overflow; overflow aborts, never silently truncates.
- `maxTotal`: 1–500 distinct deleted or nullified records, including the root, for the complete operation. Traversal depth is additionally capped at 32 and registry size at 30 modules. Cycles reuse the visited deletion plan. Restriction remains strict even when its referring record is otherwise planned for deletion.
- Records in the approval profile cannot be cascaded or nullified after their initial state. These helpers do not infer arbitrary custom workflow permissions for related records; such rules require a separately reviewed extension.

Policies are authorization-relevant server configuration, not method input. Remote callers still supply only the recipe operation's strict DTO. The service verifies identity, visibility, profile state, and expected version before invoking the atomic removal hook. The transaction reads and verifies the root again, so an earlier service read cannot authorize deleting a changed version.

## Ownership and tenant boundary

Personal scopes must contain both `ownerId` and an explicit `tenantId: null`. Tenant scopes require a verified tenant identifier and may also contain an owner. Unqualified owner-only operations are rejected.

All outgoing links are conservatively constrained to the **same owner and tenant** as their source, including team modules. Cross-owner references, even within one tenant, are not part of this standard implementation. Incoming traversal inherits the authorized root owner/tenant scope. A root's `parentId` list constraint does not accidentally constrain a different source module's parent relationship. Every returned source row is checked again for owner, tenant, liveness, reference value, record shape and version before it can be mutated.

The same-owner requirement means a configured graph must first be checked for legacy cross-owner links. Existing orphaned, invalid or cross-owner data is not automatically migrated. Fix or explicitly reject those records under a reviewed migration plan before enabling the graph. Existing callers with no graph config retain their original behavior.

## Integration and concrete Mongo adapter

The generator emits `generated/relationships/server/index.ts` with `relationshipConfiguration` and `createRelationshipPorts(basePorts, relationshipAdapter)`. The composition root provides `custom/server/relationshipPorts.ts`, exporting the approved `relationshipAdapter`. All graph modules must use these generated wrappers. The core recipe registration creates its usual single repository, applies `configureRepository` once, and returns the exact wrapped repository used by recipe and service registration.

`createMongoRelationshipAdapter` in `imports/core/recipes/server/mongoRelationships.ts` is a concrete native Mongo implementation, not an interface-only placeholder. Supply:

```ts
const relationshipAdapter = createMongoRelationshipAdapter({
	database: approvedMongoDatabase,
	startSession: () => approvedMongoClient.startSession(),
	modules: [
		{ definition: ordersDefinition, relationships: ordersRelationships, collection: 'recipe_orders' },
		{ definition: itemsDefinition, relationships: itemsRelationships, collection: 'recipe_lineitems' }
	]
});
```

The database and session factory must refer to the same approved Mongo client. Reuse Meteor's native database/client in an explicit server-only composition root, rather than opening an unrelated database or manufacturing credentials. Registry collection names must match the registered recipe collections. Registry definitions/configuration are validated, copied, and frozen. An application's independently reviewed acceptance tests must establish the actual database/collection mapping and that **all** writers participate.

The generated wrapper replaces all insert, update, transition, and remove repository paths. Reference/parent existence checks run again **inside** the write transaction; earlier `referenceExists` and `parentExists` checks remain necessary for ordinary service authorization but are not the atomicity boundary. The wrapper does not silently compose an existing repository decorator or removal hook: conflicting hooks require explicit architectural review.

## Why the fence is necessary

Mongo snapshot transactions alone cannot prevent a new reference from appearing after a deletion transaction reads an empty reference set. The adapter therefore serializes every participating write using `recipe_relationship_fences`:

1. It creates a deterministic fence row for the verified tenant, or personal owner, if absent. This initialization contains no business data or user-provided query operators.
2. The transaction updates that shared fence **before any business read**. Concurrent writers in the same scope conflict and Mongo's transaction retry machinery obtains a fresh snapshot.
3. All graph reads, reference validations, nullifications, cascades, and root CAS deletion use the same native session.
4. Any bound violation, missing target, invalid source, failed CAS, or database error aborts the transaction. Nothing falls back to sequential non-transactional writes.
5. The session always ends. Driver retries rerun only database logic; external notifications, files, payments or other side effects do not belong in this callback.

The adapter requires a Mongo replica set or sharded deployment that supports transactions. It requests snapshot reads, majority writes and primary read preference. A standalone database fails closed. Tenant-wide fencing is intentionally conservative and can limit throughput; unbounded high-volume graphs need a separate design rather than disabling the fence.

Raw native/Meteor collection writes, legacy adapters, administrative scripts or another transaction coordinator that bypasses the shared fence invalidate the invariant. They are not covered by the standard. No tool can certify the absence of outside writers merely from a supplied port object. Independent integration tests and deployment controls are required.

## Qualification and migration effects

`node --test tools/test/automation-relationships.test.mjs` executes the actual runtime coordinator and concrete Mongo adapter against deterministic in-memory transaction/native-driver test doubles. It covers restrict, cascade, nullable-reference mutation, master/detail deletion, stale versions, late-failure rollback, complete-graph validation, bounded traversal, cross-owner/tenant denial, concurrent insertion ordering, same-session writes, shared-fence ordering and standalone-transaction failure. These tests are not evidence of live Mongo replica-set rollback, Meteor DDP or browser behavior.

Before release, run real replica-set concurrency tests with two sessions, a reference insert racing deletion, root/source version conflicts, process interruption and transaction retry. Exercise the independently reviewed identity and collection adapters through DDP, and verify publication invalidation and UI stale/error handling. Generated modules remain unqualified until those gates pass.

Enabling a graph introduces the internal fence collection and transactional writes. Existing relationship data must be audited first; the generator does not mutate user records or create database indexes. Provision reviewed scoped reference indexes for the actual workload, such as owner/tenant/deleted/reference, and retain tombstones under a separate approved retention policy. Do not clear fences or introduce a second fence namespace while participating writes can execute.

The engine additionally supports a server-only `beforeTransition` hook after role authorization and before CAS, plus a trusted `now` clock. Create/update/transition operations persist the server `updatedAt` timestamp without exposing it in DTOs. Legacy records may lack it; deadline policies must reject unsupported legacy state rather than guess a timestamp.
