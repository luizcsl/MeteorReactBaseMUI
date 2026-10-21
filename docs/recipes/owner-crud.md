# Recipe: one owner-scoped CRUD module

1. Read `imports/modules/tasks/architecture.manifest.json` (or the reference's current manifest) and its contracts, server policy and UI.
2. Supply a versioned `owner-crud` spec to `npm run module:new -- --spec path/to/spec.json`. Use `--help` for the exact accepted contract. Unsupported types/profiles fail rather than generating insecure approximations.
3. Review generated files and negative tests. Repeating the same spec is idempotent; conflicts require an explicit migration, not overwrite.
4. Supply trusted ports and independent acceptance tests, then prepare/review/apply the [integration plan](../MODULE_INTEGRATION.md) for server registration, authenticated route, navigation and test imports. Server imports remain server-only.
5. Add domain-specific validation and independent cases for anonymous access, another owner, forbidden fields, stale revisions, malformed inputs and output leakage.
6. Run template checks, typecheck and the complete integration suite. A generated directory alone is not a working registered module.

Do not grant administrator or tenant bypass by passing `ownerId`, `roles` or `tenantId` in a DTO. For a shared-resource application, stop and define a separate membership policy/contract with revocation tests first.
