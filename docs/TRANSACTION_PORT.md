# Optional transaction port qualification

`imports/core/server/transaction.ts` is an optional adapter port. Its caller supplies a real Mongo session and binds every participating repository to that same session. The owner-CRUD repository is **not transaction-aware**; these tests do not qualify multi-document owner-CRUD operations, external integrations, or application-level transaction guarantees.

Run `npm run test:transactions` to request qualification. The script enables `TEST_TRANSACTIONS=1`, runs the server suite, and verifies `hello.setName` before any transaction test. A standalone Mongo server fails the requested suite instead of silently executing without transactions. With no external Mongo URL, Meteor manages its development Mongo replica set. An explicitly supplied `MONGO_URL` must point to an isolated test replica set, never production.

The actual-driver suite proves:

- Two explicitly bound repository ports share one native session and both writes commit.
- A callback error preserves its identity and rolls back both writes.
- A real duplicate-key driver error propagates and rolls back an earlier write, preserving the preexisting record.
- A repository-binding failure propagates, and every started native session ends.

Ordinary `npm run test:security` prints `Transaction port: NOT QUALIFIED in this run` unless the transaction suite is explicitly requested. It does not register skipped transaction tests or count absence as success. `npm run verify:release` and CI explicitly require `npm run test:transactions`, in addition to generated-module runtime qualification and browser qualification.

The suite uses synthetic records in `transaction_port_qualification`, deletes its test records, and must only target an isolated test database. The test-specific bound repositories are deliberately local to `tests/transactions.server.ts`; production modules must supply their own session-bound implementations and tests before claiming transaction support.
