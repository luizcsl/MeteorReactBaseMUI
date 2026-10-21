# Shared boilerplate transports

The deterministic automation layer remains outside the Meteor bundle. Generated application code preserves the boilerplate wrappers instead of creating a parallel transport.

- `imports/api/server/registration.ts`: shared `registerMethods` and `registerPublications`, reused by existing `ServerApiBase.registerMethod` / `addPublication` and strict core adapters.
- `imports/api/methodTransport.ts`: shared `callMethod`, used by existing `ApiBase.callMethod` and typed recipe/owner CRUD clients.
- `imports/api/subscriptionTransport.ts`: shared subscriptions used by existing API and recipe clients.

Legacy callback/offline behavior stays in its facade. Strict recipe methods register server-only, accept one DTO, resolve current invocation identity, project output, sanitize errors and enforce rates. They do not inherit the legacy constructor's automatic CRUD/REST exposure.

Reactive recipes re-run the same service list authorization and projection. Identity invalidation retracts published rows before asynchronous reauthorization; stop cleans observers and stale asynchronous results cannot republish. Tenant adapters require server-owned membership observation; master/detail additionally requires dependency observation. Collection-wide invalidation is bounded in returned rows but not qualified for large-volume observer performance.

`imports/server/recipeIdentity.ts` is the composition-root adapter for existing active account/profile semantics. No client role, tenant or profile ID is accepted as proof of identity.

Executed runtime evidence: typecheck; 43 core cases; 25 mutation kills; 10 new transport/publication/identity cases; existing recipe/scaffold/architecture checks. Live Meteor, Mongo and browser qualification remains separate.
