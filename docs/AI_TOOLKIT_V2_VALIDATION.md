# Second-stage qualification ledger

Implementation reviewed on 2026-10-21, building on the separately qualified [first-stage source](AI_READY_VALIDATION.md). This ledger distinguishes local executed evidence from the mandatory hosted checks. The GitHub Actions result attached to the delivery commit is authoritative for final integration; earlier green commits do not qualify later changes.

## Executed locally

- Strict repository TypeScript: passed.
- Original core/login plus independent generated identity/policy properties: 34 tests passed.
- Independent security mutation campaign: baseline passed and all 25 deliberate core/recipe authorization/projection mutants were killed by executed tests, not compilation failures.
- Deterministic toolkit: 108 passed, no failures, one explicit native-Mongo qualification skip in the general toolkit command. That separate integration gate was then executed against real Mongo below; the skip is not counted as a pass.
- Independent harness tests: mocked process/runtime campaigns cover all three arms, repeated repair attempts, missing/zero/failed receipts, mutable evidence, token/time bounds, cancellation and local HTTP redirect/credential rejection. These are fixtures, not a real-model campaign or operational container proof.
- Generated source: original owner-CRUD fixture plus all four structured recipes were generated in an isolated tree and passed full TypeScript compilation, resolving their actual runtime/UI imports.
- Real Meteor 3.5.2, MongoDB 7.0.16, DDP and HTTP suite: 41 tests passed, including seven new recipe cases. Covers actual tenant/personal separation, current membership revocation, concurrent create replay, CAS, tombstones, approval separation, scoped parents and corrupt persisted envelopes. The first built-in Mongo startup attempt failed before tests; the successful run used an isolated explicit Mongo process with a normal loopback connection and no Unix socket.
- Real Mongo migration adapter: 24 tests passed with zero skips, including native-driver CAS, uncertain-write resume, retained locks, ID membership consistency and BSON values. This was a disposable local database, not production data or a restore of a deployed system.
- Recipe UI: browser bundle compilation and TypeScript passed. Nineteen actual Cypress scenarios are supplied; local browser execution was not available, so no local browser pass is claimed. The dedicated hosted browser workflow must execute them.
- Standalone trusted-verifier preparation and syntax checks: passed. Docker and Podman were absent locally; no unsandboxed fallback was attempted.

## Mandatory hosted qualification

### Toolkit review follow-up — 2026-10-21

Reviewed working tree based on `58a7a49fc7513232dca73ba0af5facc80fb6c5c0`. Changes enforce strict CLI arguments before dispatch and inspect both sides of Git renames for scope/budget enforcement. Added five regression cases; no application schema, generated module, dependency lock or persisted-data migration changed. Existing CLI callers that send ignored, repeated or conflicting options must correct their invocations; renames now consume two changed paths.

Observed with Node 24.21.0 and subprocess execution enabled:

- Targeted argument/toolkit tests: 16 passed, zero failures or skips.
- `npm run doctor`: passed; database connectivity remains explicitly unverified.
- `npm run typecheck`: failed on missing `BrowserRouter` and `Link` exports in the installed React Router types.
- `npm run test:toolkit`: 113 passed, one failed, one existing Mongo integration skip. The failure is the router compatibility test: the expected upstream CommonJS file is absent.
- Installed React Router is 6.30.4; `package-lock.json` requires 7.18.4. This dependency drift blocks qualification; it is not grounds to weaken the adapter or its tests.
- `npm run verify`: failed at its initial typecheck; subsequent gates in that command did not execute.
- `npm run docs:verify` and `npm run boundaries:check`: passed. The latter still reports existing legacy cycles and the pinned attachments bridge as review debt.

The initial restricted-shell attempt used Node 20 and could not capture subprocess output reliably (`EPERM`); the targeted tests and required commands above were rerun with the supported Node and execution permissions. This follow-up is not full integration approval. Restore dependencies from the lockfile and rerun full qualification before integration; no browser, live database or real-model productivity result is claimed for these changes.

The workflows require application/server/transaction/generated-module gates, mutation checks, native Mongo migration execution, application and recipe UI browsers, production build, dependency audits and SBOM. The container-harness workflow separately exercises real Docker isolation and receipt integrity without calling a model. Missing infrastructure and nonzero/zero-test/skip outcomes are failures in their required qualification commands.

## Not demonstrated by this delivery alone

- Measured productivity, cost or quality improvements with any real small model. No suitable local inference service was running, and no paid API or remote source-code transmission was authorized or used.
- Full deployment restore across Mongo and private object/file storage. The export runner rehearses only its own integrity-checked export file; Mongo migration is resumable but not an automatic rollback or backup system.
- Generic cross-collection transactional master/detail lifecycle, durable distributed queue delivery, antivirus/content pipeline, arbitrary import mapping, external-provider integration or production tenant identity provisioning. Presets expose bounded contracts/guards and require explicit product integration.
- Security certification or resistance to a compromised host/container engine. Protected code and hashes cannot make a dishonest verifier trustworthy, and same-process JavaScript unit tests are not a malicious-code proof.

See [the toolkit guide](AI_TOOLKIT_V2.md), [structural evolution](STRUCTURAL_EVOLUTION.md), [migration operation](MIGRATIONS.md), [recipe integration](recipes/structured-recipes.md) and [harness integration](HARNESS_SYNERGIA.md) for the executable interfaces and remaining operator obligations.

## Boilerplate product/integration stage — 2026-10-21

See the [delivery report](BOILERPLATE_IMPROVEMENTS_REPORT.md) for source baseline, actual final gates, migration effects and limits of the additive integration/domain/journey changes. Earlier counts above remain historical evidence.
