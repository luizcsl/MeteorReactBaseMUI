# Changelog

## 0.1.0-ai-ready.1 (prerelease): contract/toolkit profile v1

Based on ea89d092b18ce8be5fa3c25b5bd20519011c5636. This is a reviewable security/migration release, not a backwards-compatible template refresh.

- Fixed client argument/context injection and explicit deny-by-default policy boundaries.
- Replaced global media access with scoped expiring capabilities and content quarantine.
- Bound profiles to account IDs, constrained upload/fetch resources and separated user/connection quotas.
- Added strict contracts, owner-scoped CAS CRUD reference, deterministic module/context/task tooling and external Synergia harness guidance.
- Added negative runtime/infrastructure tests and benchmark scaffolding without claiming unmeasured model gains.

Breaking/security changes and operational caveats: [migration guide](docs/MIGRATION_AI_READY.md). Qualification evidence and intentionally unqualified scope: [validation](docs/AI_READY_VALIDATION.md). Template/spec versions are recorded in templates and generated manifests; qualify each generated module before deployment.

- Native auth/profile/password browser scenarios replace the retired vulnerable Gherkin runner; fixed profile routes rendering Example.
- Optional real replica-set transaction-port qualification and CycloneDX dependency inventory are release gates.
