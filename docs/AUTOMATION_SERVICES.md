# Bounded service automation

The automation engine's `services` generator adds deterministic server factories, strict shared DTOs, registered methods, typed clients and connected report UI to a validated recipe. Integration reuses the existing core authorization/transport layer and the same recipe repository. Required private-storage, audit and notification adapters remain explicit: an unconfigured adapter never claims persistence or delivery. The separate supervisor dependency workflow generates a reviewed lockfile without installing packages or running lifecycle scripts.

Entry points: `validateServices(services, definition)` and `renderServices({ definition, services }, root?)` in `tools/automation/generators/services.mjs`. Rendering returns a repository-relative file/content map without writing files. The orchestration planner owns hashes, allowlists, drift detection and application. Shared strict DTO helpers live in `imports/automationServices/contracts.ts`; persistence/provider/runtime helpers live exclusively under `imports/automationServices/server/`. Discover the structural contract in `tools/automation/contracts/services.v1.schema.json`, and an all-capability feature example in `tools/automation/examples/services-feature.json`. Recipe-dependent constraints listed in schema metadata are enforced by `validateServices`; JSON Schema alone cannot establish referenced fields, scopes or business permission.

## Small-model input vocabulary

Select only the needed keys. Unknown properties, variants, fields and excessive bounds fail before rendering.

```json
{
	"attachments": { "maxBytes": 1048576, "mimeTypes": ["application/pdf"] },
	"csv": { "fields": ["title", "amount", "done"], "maxRows": 1000 },
	"notifications": { "events": ["created"], "subjectTemplate": "New {{title}}", "textTemplate": "Amount: {{amount}}" },
	"jobs": { "maxAttempts": 3, "leaseMs": 30000 },
	"search": { "fields": ["done"], "pageSize": 50 },
	"audit": { "events": ["updated"], "retentionDays": 365 },
	"reports": {
		"metrics": [
			{ "name": "count", "op": "count" },
			{ "name": "total", "op": "sum", "field": "amount" }
		]
	},
	"dependencies": { "updates": [{ "name": "some-package", "from": "1.0.0", "to": "1.1.0" }] }
}
```

The example assumes matching recipe fields. It is not a grant of business permissions or approval to send email. Required service ports are chosen and reviewed at the server composition root. The generated `integration.json` records the remaining composition and qualification requirements. `registration.json` is the deterministic integration contract: it identifies `registerServices`, `createServiceClient`, required adapters and method effects. `module:integrate` consumes it and calls service registration with the exact `RecipePorts` returned by recipe registration. Independent acceptance remains mandatory; generated code does not self-qualify.

Limits: private files 1–20,000,000 bytes; CSV 1–10,000 rows and 5 MB text; notification events 20 and recipients 100; job attempts 1–10 and leases 1 second–1 hour; pages 1–100; retention 1–3650 days; metrics 1–20; dependency changes 1–30. Field names must already exist. CSV includes every required recipe field; omitted optional fields become null. Search fields must also be declared recipe filters. Sum requires integer/money fields. Templates support field interpolation only, not executable expressions.

## Capability behavior and boundaries

### 14. Private attachments

The generated factory requires `RecipePorts` and an `AttachmentStore`. Upload checks authenticated identity, current permissions, document scope, size, MIME allowlist and safe filename before private storage. Linking uses a scoped document write; a failed link compensates by deleting the newly stored object. Download rechecks document access, file linkage and private-file access independently on every call. Output is bytes, not a bearer URL or global media token.

The storage adapter must enforce private ACLs, actual byte storage, atomic scoped linking, MIME/content inspection and any required malware scanning. Client-supplied MIME is only a declaration, not content validation. Secure delivery should use attachment disposition, no sniffing, bounded streaming and an authorized existing operation. The generated `uploadAttachment` and `downloadAttachment` methods use shared registration, invocation identity, strict DTOs, bounded output and rate limits; no separate public HTTP route or bearer URL is generated. Concurrent document deletion and linking require the adapter's reviewed consistency mechanism. Cleanup failures propagate; they are not reported as successful uploads.

### 15. CSV import/export

The parser handles comma-separated headers, escaped quotes, embedded newlines and CRLF. It rejects unclosed quotes, inconsistent columns, extra columns and row/byte overflow. All rows are parsed through the recipe contract before any write. Imports invoke `recipeService.create`, retaining reference checks and scoped writes. Stable per-row mutation IDs permit retries with the same prefix. On a write failure the response explicitly reports completed count and failed source row; there is no fictional all-or-nothing transaction. Reuse a prefix only for the same import content. Export applies recipe filters and scope and prefixes formula-like spreadsheet cells.

Export is explicitly bounded to `maxRows`, not a promise to export the whole collection. CSV only: XLSX, custom encodings, arbitrary separators and transactional bulk import are unsupported. Generated `importCsv`/`exportCsv` methods and typed client calls provide the transport flow; a browser file-selection wizard is not implied.

### 16. Notifications/email

Notification events and templates are allowlisted. The server rechecks write permission and document scope, projects only recipe fields into plain-text templates and resolves recipients using a scoped provider. Recipients are internal IDs, never request-supplied addresses. Idempotency keys include scope, event, event ID and recipient. Provider sends must honor those keys and revalidate subscriptions/contact preferences. Subject CR/LF is stripped. The generated `notify` method applies the existing write policy, strict event/document/event-ID DTO and mutation rate limits. The provider contract is not an email account, subscription policy or guarantee of delivery. Automatic event wiring requires explicit business approval and an outbox if atomic event/write delivery is needed.

### 17. Durable jobs

`createJobs` accepts a persistent MongoDB collection implementing `DurableCollection`; an in-memory production fallback is deliberately absent. Call `initialize()` to install the claim index before enqueue/claim. Mongo's existing unique `_id` index gives idempotent enqueue; payload mismatch on a reused key fails. Acknowledged durable writes are mandatory; majority write concern is recommended. `findOneAndUpdate` must be atomic with `returnDocument: 'after'` and `includeResultMetadata: false`.

Claims atomically cover available pending work or expired running leases, increment attempts and assign a unique lease token. Completion and retry updates compare that token. Expired crashed jobs can be reclaimed; exhausted crashes become failed. Retry delay is exponential and capped. `renew` only extends the current unexpired lease. Worker scheduling and heartbeat cadence are the integrator's responsibility.

Guarantee: at-least-once execution, not exactly-once side effects. The handler receives a stable idempotency key and lease token and must fence external effects. The queue is server-worker-only; never expose enqueue or arbitrary payload handlers directly to a client. No distributed production qualification is claimed by the deterministic test double.

### 18. Search, pagination, indexes

Search uses recipe-approved equality filters, explicit ascending/descending `_id` ordering and `limit + 1` lookahead. Request limit is bounded by configured `pageSize`. Cursor contents are bounded and tied to server-derived scope, filter set, limit and order. Cursor data never grants authority; forged cursors can only alter position inside the already-authorized query. Returned records project id/version/state/recipe data, never arbitrary storage fields. The built-in repository query adapter uses the same Meteor Mongo collection instance as CRUD and honors database selectors, projection, sort and limit. A reviewed `query` override remains optional. Scoped filter index plans are returned, not silently installed. Query execution time/resource limits require deployment qualification; bounded results alone are not a database execution-time guarantee. This is bounded filter/cursor search, not full-text search or arbitrary aggregation.

### 19. Audit/history

Append and history both require current scoped access to the linked document. Events are allowlisted; payloads are validated recipe-data snapshots; identity and timestamps are assigned by the server. History is capped at 100 and projected. Retention uses explicit `expiresAt` with a Mongo TTL index plan. Install/review the index in the adapter. No automatic permanent deletion is performed by the generator. Legal holds and immutable archival stores require design review. Standalone append is not an atomic audit guarantee: business-write plus audit requires an approved transaction/outbox adapter.

### 20. External OpenAPI clients

`api: { "openapi": { ... } }` takes an inline OpenAPI 3.0.x document with exactly `openapi`, `info` (`title`, `version`), one HTTPS `servers` URL, and `paths`. Supported operations are literal-path GET/POST with unique `operationId`, optional required POST JSON body, and exactly one 2xx JSON response. Schemas support bounded object/string/number/integer/boolean/array. Objects require `additionalProperties: false`; arrays require `maxItems` and `items`. `$ref`, parameters, unions, nullable, callbacks, streaming, credentials and arbitrary authentication schemes are rejected rather than guessed.

Generation produces TypeScript input/output types, operation-specific calls, runtime request/response validation, normalized status/transport/contract errors and deterministic mock transport. Authentication stays inside a reviewed server `ApiTransport`. That transport must enforce destination egress/DNS policies, no redirects, timeout and response-size bounds. Static hostname validation does not replace SSRF protection at network time. No raw alternate DDP/HTTP server route is introduced. External API execution is a server port, not a browser secret-bearing client.

### 21. Reports/dashboard data

Reports build a server-side pipeline with authorized scope and deletion filter before grouping. Only declared count/sum metrics are returned. Recipe filters are parsed, numeric output is checked, and arbitrary pipeline input is rejected. The built-in same-repository query adapter supplies database aggregation; database time/resource limits remain deployment responsibilities. Generated `ReportDashboard.tsx` renders responsive MUI metric cards and an accessible table, with loading/error/empty states, refresh and stale-request cancellation. `ConnectedReportDashboard.tsx` wires its loader to the generated typed `report` client automatically. The caller supplies account/tenant scopeKey and filters; changing either hides previous results. Scope keys protect UI state, never replace server authorization. Only a zero count metric establishes an empty result; zero sums alone are not labeled no activity. No cross-tenant reporting, arbitrary grouping or analytics data warehouse is implied.

### 52. Assisted dependency upgrades

Feature service configuration emits `dependency-review.json` describing exact proposed changes and review gates. The executable follow-through is a **separate supervisor-reviewed API**, `tools/automation/dependencies.mjs`:

- `planDependencies(root, { updates: [{ name, from, to }] })` accepts only existing dependency names and an exact target `to` version. `from` must equal the current manifest declaration byte-for-byte, including any ^/~ range; it is never inferred from the installed version.
- Planning copies package.json and package-lock.json to an isolated temporary directory, changes only requested existing declarations, and executes fixed `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org`. It does not run npm in the repository. HOME, cache, user/global npm configuration and process environment are isolated; auth tokens and NODE_OPTIONS are not inherited.
- Local/git/URL dependency sources, workspaces, resolutions, linked packages, new dependency names and arbitrary command arguments are rejected. Existing bounded nested registry-only override trees are preserved and hashed; changing overrides is never part of this updater. npm v2/v3 lockfiles must resolve to the official HTTPS registry. Requested versions must have matching locked entries and integrity values. This deliberately bounded updater does not silently handle unsupported monorepo or custom-registry variants.
- The plan includes full before/after bytes, complete replacement diffs, hashes and the fixed command. `applyDependencies(root, plan, approvalHash)` requires the exact reviewed plan hash, validates manifest/lock semantics and fresh original bytes, acquires a dedicated lock, stages both files and replaces each by atomic rename. Before each rename the current bytes must still match the reviewed original. A failure restores an already-written file only if its current bytes still equal this transaction’s output; concurrent external edits are never overwritten. A conflict during rollback retains backups, a recovery marker and the workflow lock. Apply never invokes npm or runs scripts.
- An OS does not offer one atomic rename across two independent files. Caught failures roll back; an interrupted process may leave the lock/staging backups and requires supervised recovery. Leftover staging directories fail closed. A failed rollback preserves recovery evidence instead of claiming success. The caller/harness owns the actual approval decision; knowing a hash is not proof of human review.
- Ordinary automation protected-path rules remain unchanged. This workflow is not available through the normal feature apply allowlist. It does not install updated modules, accept package terms, deploy, merge, qualify compatibility or assert that a target version exists before the registry planning operation succeeds. Advisory/license review and full verification remain separate requirements.

Tests use an internal injected executor to produce deterministic temporary lockfiles. That hook is not a JSON command parameter or public tool schema. No real dependency update or registry/npm planning run was performed on the user's repository during these tests.

## Composition and evidence

The generated bridge consists of:

- `generated/services/contracts.ts`: strict input/output schemas, named DTOs and exact report metric types; no server imports.
- `generated/services/client.ts`: `createServiceClient()`, using the existing online-only `callMethod` and validating both directions.
- `generated/services/server/register.ts`: `registerServices(ports, adapters)` with invocation-owned identity, shared `registerMethods`, error normalization and per-user/per-connection limits (writes 20/40 per minute; reads 60/120).
- `generated/services/registration.json`: required/optional adapter metadata consumed by `module:integrate`.

Depending on selected configuration, methods are `<module>.services.search`, `.report`, `.history`, `.importCsv`, `.exportCsv`, `.uploadAttachment`, `.downloadAttachment` and `.notify`. Unknown fields, owner/tenant/role input injection and malformed outputs fail closed. Jobs, audit append and external API calls stay server-worker-only.

The integration bridge first calls the existing recipe registration, then passes its returned RecipePorts to `registerServices`, reusing exactly one repository/collection. Search/report use `ports.repository.query` by default; `serviceAdapters.query` can override it explicitly. Storage, audit and notification selections require reviewed `custom/server/servicePorts.ts` exporting `serviceAdapters`. CSV/search/reports need no fabricated custom provider. Missing required adapters stop registration before methods are added. Required business identity and independent `custom/server/acceptance.test.ts` are still supplied by reviewed custom code.

Never pass client roles, ownership or tenant proof into ports. Master/detail services currently fail with `needs-design` because they require additional explicit parent-scope composition.

Run `node --test tools/test/automation-services.test.mjs tools/test/automation-service-integration.test.mjs tools/test/automation-dependencies.test.mjs`. Independent fixtures exercise emitted factories and actual bundled runtime helpers: scope denial, malformed input, attachment compensation, CSV atomic prevalidation and idempotent retries, cursor isolation, audit retention, report scoping, provider keys, durable lease recovery/fencing, OpenAPI failures and no-install dependency plans. The integration fixture generates a feature, supplies reviewed identity/acceptance/adapters, invokes the real integration planner, strictly typechecks server/client/dashboard, and exercises shared transport registration with only the Meteor/Mongo boundary mocked. It proves that CSV creation is visible through the same CRUD repository and that report/export scope isolation remains enforced. These tests are not real MongoDB/DDP, email delivery, blob-storage, production queues, registry availability or browser evidence. Run doctor, typecheck, test:toolkit and verify plus the appropriate real adapter/integration gates before acceptance.
