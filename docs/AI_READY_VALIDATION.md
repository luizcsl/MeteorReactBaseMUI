# Qualification and evaluation traceability

Baseline: `luizcsl/MeteorReactBaseMUI` master `ea89d092b18ce8be5fa3c25b5bd20519011c5636`, identical to the commit inspected by the supplied review despite its different repository-owner label. Work reviewed on 2026-10-21. This is a security and developer-tooling improvement, not a claim of “100% secure” or demonstrated small-model performance.

## Review requirements

| Requirement | Implementation/evidence | Qualification boundary |
|---|---|---|
| E1 Context and authorization | Exact-arity legacy wrappers, context-first core and policy-before-mobile-read; DDP regression suite | Custom downstream methods need the same audit |
| E2 Media and limits | File-bound expiring signatures, active-account ownership, private cache headers, scoped quotas and bounded upload/fetch | Process-local quotas need external distributed enforcement; bearer URLs remain transferable until expiry |
| E3 Integrity | Immutable account binding, shared Example revisions, bounded receipts, compound cursors, canonical CAS and create deduplication | Example sync is default-off experimental, not a transactional global change log; no offline qualification |
| E4 Contracts and reference | Dependency-free strict DTOs/policies, scoped repository, canonical Tasks CRUD with UI states and negative tests | Legacy framework remains for compatibility, not a complete rewrite |
| E5 Templates | Strict versioned owner-CRUD spec, atomic directory staging, manifest, collision/symlink/drift/type/security tests | Registration is explicit; each generated module stays unqualified until its runtime gates pass |
| E6 Documentation and commands | Short AGENTS, recipes, deterministic bounded context closure, command/link checks | Lexical gates are diagnostics, not proof against arbitrary dynamic code |
| E7 CI and operation | Typecheck, core/toolkit/DDP/HTTP/E2E suites, pinned CI actions and vulnerability gate | Image/replica-set/restore and full deployment qualification require the target infrastructure |
| E8 Agent executor | External isolation design, supervisor-protected verifier, cumulative budgets, scope and evidence states | Toolkit is not an OS sandbox; no embedded autonomous executor or credential access |
| E9 Benchmark and pilots | Thirty-task, three-arm benchmark and held-out protocol; evidence aggregation tests | No real model campaign or representative application pilot executed, therefore no efficiency/quality gain claimed |
| E10 Distribution | Versioned templates/specs, migration guide, validation ledger and downstream upgrade workflow | Production data migration, branch protections and downstream release governance remain operator-reviewed actions |

## Critique incorporated

The application runtime, development toolkit, external harness and optional future application AI runtime are separate. Contracts and negative security properties precede generation. No runtime AI provider or agent executor was embedded. Media authorization is treated as a release blocker, not just a documentation issue. Benchmark configuration compares original, documentation-only and deterministic-toolkit conditions, includes held-out tasks and rejects fixture results as real performance evidence.

## Evidence ledger

The final local and CI evidence is recorded below after execution. A failed, unavailable or skipped check is not a pass. Model evaluation campaigns, production migrations, provider integrations, load testing, backup restoration and a full deployment penetration test have not been performed merely by adding these scripts.

- TypeScript: passed with zero errors.
- Deterministic core: 9/9 passed, including create replay and transaction error propagation.
- Toolkit/evaluation infrastructure: 28/28 passed, zero skipped. Includes ignored-source scope bypass regression.
- Templates: six generator safety/drift tests and isolated generated TypeScript/registration compilation passed.
- Generated module runtime: 5/5 passed through registered namespace, real Mongo and real DDP (owner isolation, CAS, concurrent create replay, malformed/anonymous denial).
- Real application server suite: 33/33 passed through Meteor 3.5 / MongoDB 7.0.16, including negative DDP and actual HTTP media tests. The mixed-writer test stubs only audit identity lookup outside MethodInvocation, not authorization, schema or persistence. Mongo was a standalone disposable local instance; replica-set transaction rollback is not qualified.
- Full production Meteor build: passed (exit 0), including final rebuild after removing accidental client/server import. Only upstream url.parse/Browserslist age warnings remain; no unresolved async_hooks import remains.
- Full and production npm audit: zero high/critical, two moderate vendored browser-polyfill advisories remain. See [dependency evidence](DEPENDENCY_SECURITY.md).
- Browser: local execution blocked by browser launch restrictions, and the existing cloud-browser route denied local page access. No browser pass claimed. Dedicated CI workflow is executable but has not run remotely; branch publication awaits explicit approval.
- Independent adversarial review found issues in mixed-writer revision, direct media active-profile checks, migration/version path consistency, crash lock recovery, create replay and ignored-source patch scope. Fixes and regressions were added. This is not an independent penetration-test certification.
- Real-model benchmark, representative application pilots, Docker image scan, replica-set rollback and backup restoration: not executed. Their protocols/gates do not constitute a pass.

## Release workflow

Run `npm ci`, `npm run verify`, the dedicated browser qualification, and a full `meteor build`. Review dependency advisories, migration quarantines and denied legacy paths. Protect the default branch and require CI in repository settings; CODEOWNERS and workflow files do not enforce those settings by themselves. Record the exact commit, test counts, runtime versions and residual risks. Downstream projects should retain an upstream remote, review/cherry-pick updates, rerun contracts and restoration rehearsals, and publish their own migration/version notes.
