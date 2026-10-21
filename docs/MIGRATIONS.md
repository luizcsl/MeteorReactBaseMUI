# Bounded migrations: offline exports and native Mongo

These are two different tools with different recovery guarantees. Neither is an
automatic production deployment step. Review a plan, its data contract, backup
evidence, access scope and application compatibility before applying it.

## Shared plan format

Both adapters use `validateMigration` from `tools/migrations/runner.mjs`:

```json
{
	"version": 1,
	"id": "rename-title",
	"fromVersion": 0,
	"toVersion": 1,
	"operations": [
		{ "kind": "rename-field", "from": "title", "to": "name" },
		{ "kind": "add-default", "field": "active", "value": true }
	]
}
```

Only top-level, non-overlapping `add-default` and `rename-field` operations are
accepted. Defaults are JSON scalars. A rename with both source and destination
present fails, even if the values appear equal. No arbitrary JavaScript, pipeline,
query, deletion, identity change or ownership change is accepted. Operation order
is part of the plan. A reused migration ID must retain the same plan definition.
The Mongo adapter uses a canonical SHA-256 plan hash, so JSON object key order
does not change that hash. The offline adapter retains its existing serialized
JSON hash format; preserve that plan's key order too when resuming an export.

## Offline JSON export runner

`migrateFile` operates only on a reviewed JSON export. It validates every remaining
record before writing, uses a local exclusive lock, creates an intact original
backup, and atomically replaces the export at each checkpoint. `rehearseRestore`
verifies those export bytes in a temporary file.

**An export-byte restore rehearsal is not a Mongo deployment restore rehearsal.**
It does not qualify Mongo indexes, users, oplog/PITR recovery, files/object storage,
application releases, cross-service consistency or recovery time. Its backup must
not be cited as a deployment recovery guarantee.

## Native Mongo adapter

`tools/migrations/mongo.mjs` exports:

- `migrateMongo({ collection, metadata, plan, ...options })`.
- `connectMongoMigration({ uri, database, collectionName, metadataName })`, which
  returns `{ collection, metadata, close }` using the official `mongodb` driver.
- `inspectMongoMigration({ collection, metadata, plan })`, a read-only inspection.
- `releaseMongoMigrationLock(...)`, an explicit, guarded operator recovery step.

The adapter executes native `find`, `insertOne`, `updateOne` and `deleteOne`
operations. It is not a JSON-file bridge or a mock-only implementation. It can use
native `Mongo.Collection.rawCollection()` ports from a trusted Meteor admin
process, or the standalone connection helper. Toolkit files remain excluded from
the ordinary application bundle. Do not expose the adapter as a client-callable
Meteor method or import it into application startup.

The standalone helper dynamically imports the official driver already available
in the operator environment. It never installs dependencies or discovers
credentials. A transitive driver may disappear when dependency trees change;
provision and review an explicit compatible driver for an operational admin
environment rather than depending on an incidental application dependency.

### Required data and operational contract

1. Target **one complete collection**, not an arbitrary selector. Use distinct
   target and metadata collections in the same database and deployment. Database
   and collection names use letters, digits, underscores or hyphens. All runners
   targeting a collection must use the **same metadata collection**, normally
   `_migration_control`; choosing another bypasses coordination.
2. Every target document must have a nonempty string `_id` (at most 512 UTF-8
   bytes, no NUL), explicit nonnegative safe-integer `schemaVersion`, and a
   nonnegative safe-integer `version`. A pending row's version must have room to
   increment. `schemaVersion` is the migration version; `version` is the
   application's optimistic-concurrency revision. Do not silently assume that
   missing versions mean zero. Legacy records need a separately reviewed
   initialization plan before using this adapter.
3. `_migrations` is adapter-owned metadata, with at most 128 immutable markers.
   Each marker contains the plan hash and source/target schema versions. Existing
   marker structure is validated. `schemaVersion`, `version`, `_id`, owner and
   tenant fields cannot be migration operation targets.
4. Freeze collection membership, including inserts, deletes and replacement
   writes, for the entire operation and all pauses. Prefer a maintenance window
   with writers stopped. Normal application updates must honor and increment
   `version`; they must never edit migration markers or revert schema versions.
   The adapter detects membership drift using a count and ordered ID hash, but
   cannot make an unfrozen collection into a point-in-time snapshot.
5. Review and retain an actual Mongo backup/snapshot and any corresponding file
   store/application release before applying. Rehearse restoring those assets to
   an isolated environment and verify application invariants. **This adapter
   creates no database backup and performs no automatic rollback.**
6. Use an authorized operator connection with finite driver/network timeouts.
   Never put URIs with credentials in source, plans, logs or command arguments.
   The helper reads only the explicitly supplied URI; it does not use an ambient
   production `MONGO_URL`. Its connection/server-selection timeouts are 10 seconds
   and socket timeout is 30 seconds. Injected native ports must provide equivalent
   connection policy themselves.

### Safety and bounds

- Dry-run is the default and performs **no writes**, including no lock,
  checkpoint, index or metadata creation. It is a non-snapshot observation, not
  authorization to apply later. Apply always re-runs preflight under its lock.
- Before the first data write, the entire bounded collection is checked for
  malformed rows, collisions, invalid markers and unsupported versions. Other
  `_id` types are explicitly rejected so Mongo's type-bracketed string cursor
  cannot silently omit them. Binary/simple collation is explicit.
- Each record update atomically combines field changes, schema-version change,
  revision increment and its plan marker. CAS checks the revision, schema version,
  marker absence, touched-field presence and exact whole values. Expression
  equality avoids Mongo's ordinary array-element equality semantics. Operator
  updates preserve unrelated fields and native BSON values.
- The durable cursor advances only after every row in a batch is acknowledged.
  A crash after a row write but before its checkpoint re-reads that row and checks
  its exact marker; it does not increment or rename it a second time. Both cursor
  and completion updates are themselves compare-and-swap guarded.
- Resume verifies the original count and ordered ID hash, and refuses a cursor
  that would skip an unmigrated row. Completion verifies the entire collection
  again. Even a completed rerun verifies actual data, rather than blindly trusting
  a ledger. Rerunning an old plan after another schema migration or after new
  records were added is intentionally rejected, not reported as unchanged.
- Writes request majority acknowledgment and journaling. A single-node test is
  not evidence of replica failover or disaster recovery. There is no multi-row
  transaction: a rejected CAS or later database error may leave a safely marked,
  partially migrated collection that requires inspection and resume.
- Defaults: `batchSize=100`, `maxBatches=100`, `maxRecords=100000`,
  `maxScanBytes=64 MiB`, `maxTimeMS=30000`. A run applies at most
  `batchSize × maxBatches` records, then returns `paused` if work remains.
  Full preflight/verification still scan the bounded collection on every run.
  `maxScanBytes` counts V8-serialized document bytes as a bounded memory/work
  budget, not BSON wire size. Pages are consumed incrementally and capped before
  accumulating further records. `maxTimeMS` is a per-read server limit, not a
  whole-run deadline. Limits are finite validated integers with hard ceilings.

### Running a reviewed dry-run

Provide a reviewed plan file and an explicitly chosen authorized database through
your operator environment. The example below is read-only. It does not read a
production application's connection settings automatically.

```sh
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { connectMongoMigration, migrateMongo } from './tools/migrations/mongo.mjs';

const plan = JSON.parse(await readFile(process.env.MIGRATION_PLAN_FILE, 'utf8'));
const { close, ...ports } = await connectMongoMigration({
  uri: process.env.MIGRATION_MONGO_URI,
  database: process.env.MIGRATION_DATABASE,
  collectionName: process.env.MIGRATION_COLLECTION
});
try {
  console.log(await migrateMongo({ ...ports, plan, batchSize: 100, maxBatches: 10 }));
} finally {
  await close();
}
JS
```

After independent review, backup rehearsal and the required operational approval,
set `apply: true` in the `migrateMongo` call. Run the identical plan and target
again to resume a `paused` result. Keep the original plan, result hashes and
checkpoint evidence. A bounded pause releases its lock, but does **not** authorize
writers to restart. An unfinished checkpoint also blocks a different schema
migration, even when all of the first plan's row writes already committed.

### Crash and uncertain-write recovery

Locks are collection-wide, not migration-ID-wide, and use the metadata
collection's unique `_id`. They **never expire automatically**. There is no lease
takeover that could let an old paused runner keep writing. Successful pauses and
completion release only the matching owner token. Failures after a write is
attempted retain the lock; network/write-concern timeouts are not treated as proof
that no write happened.

1. Stop and verify termination of every old runner for that collection. Resolve
   uncertain/in-flight writes at the database before proceeding. Do not infer
   safety from lock age, an idle terminal or a guessed process ID.
2. Call `inspectMongoMigration` and review its exact namespace, plan hash, lock
   owner token and checkpoint. Do not modify or delete markers/checkpoints to make
   a failing plan appear compatible.
3. Only after step 1 is established, call
   `releaseMongoMigrationLock({ ...ports, plan, ownerToken, assertNoActiveRunner: true })`.
   This assertion is an operator attestation, not an automated process detector.
   The delete also compares namespace, migration ID and plan hash. A changed or
   missing lock fails instead of being blindly retried.
4. Repeat dry-run and apply with the same immutable plan. For data/schema drift,
   investigate first; a new plan or restoration needs a separate review. If a
   release response is lost, inspect again before taking further action.

Application writers and other migration systems do not automatically honor this
lock. This is an adapter coordination mechanism, not an access-control boundary.

## Qualification

Run deterministic safety/fault-injection tests:

```sh
node --test tools/test/migrations.test.mjs tools/test/mongo-migrations.test.mjs
```

Run actual native-driver tests against an explicitly local disposable Mongo:

```sh
MONGO_MIGRATION_TEST_URI='mongodb://127.0.0.1:32118/' \
  node --test tools/test/mongo-migrations.test.mjs
```

For a required CI/release gate that starts and stops its own disposable Mongo and
refuses skipped tests, run:

```sh
node tools/verify-mongo-migrations.mjs
```

This finds the pinned release's bundled `mongod` under `~/.meteor`, or uses an
explicit `MONGOD_BINARY` pointing to an approved official binary. Optional
`MONGO_MIGRATION_TEST_PORT` changes the default loopback port `32118`. A missing
binary, startup denial, occupied port, test failure, zero-test report or skipped
test fails the gate. It does not fall back to another server or production URI.
Its environment omits application credentials and Mongo connection settings;
temporary database files are removed after both child processes terminate.

The real suite rejects non-loopback URIs and embedded credentials, creates unique
test collections, and cleans them up. The test database name is unique to the
run. Start/stop the disposable `mongod` outside the suite with a cleanup trap.
When the environment variable is absent, the report explicitly says the real
Mongo suite is **NOT QUALIFIED**; deterministic tests are not substituted for it.
Real tests cover dry-run, durable pause/resume/replay, duplicate-key locking,
concurrent version rejection, exact array-value CAS, recovery after a committed
write's lost response, whole-collection preflight and BSON preservation. Simulated
response loss is injected around a real committed write; it is not a live network
partition test.
