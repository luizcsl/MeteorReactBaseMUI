# Synergia Code harness integration contract

The boilerplate does not embed or require an agent executor. Any harness that can invoke CLI commands and Git can use the toolkit. Do not copy model credentials into application settings.

## Trusted executor boundary

Create a disposable checkout/container as an unprivileged account. Mount only the repository and a dedicated output directory. No host home, SSH agent, cloud credentials, Docker socket or production network. Restrict outbound traffic to an approved package mirror/model gateway as needed. Enforce process, memory, CPU, disk and wall-clock limits outside the model. A script checking paths is not a sandbox and cannot constrain a shell running with broad credentials.

Keep task allowlists, budgets, baseline hashes, acceptance tests and workflow policy in the supervisor's read-only store. Copy trusted gate code from a reviewed commit into a separate verifier checkout. Run gates against the candidate's application files, not a potentially edited evaluator. Reject symlinks, path escapes and changes to protected gates unless separately authorized. Repository checks provide diagnostics only; never let the model redefine its own success predicate.

## Task lifecycle

`pending -> context-ready -> editing -> verifying -> passed | needs-review | blocked | cancelled`.

This is the external harness lifecycle. The toolkit ledger intentionally has a smaller vocabulary: planned, running, needs-review, passed and failed. Its usage command emits running or needs-review, never passed; blocked/cancelled/context-ready/editing/verifying belong to the supervisor, not undocumented CLI states. Only the supervisor can mark passed after all required gates exited zero, nonzero test counts were checked and evidence is tied to the candidate Git tree. Persist each transition atomically with task ID, baseline/tree SHA, attempt number, elapsed time, model configuration, tool results and hashes. A provider response saying “done” has no status authority. Cancel terminates the child process group and prevents later stale output from changing state.

## Concrete task contract

Use the CLI’s exact versioned schema in `tools/schemas/task.v1.schema.json`, not free-form natural language alone. It accepts objective, acceptance, allowedPaths, contextFiles, commands, state and budgets for seconds/tokens/costUSD/files/attempts/contextBytes/contextFiles. Run `npm run task:validate` before execution. Keep model settings, expected artifact hashes, prohibited actions and diff-byte ceilings in a separate supervisor envelope; these are not accepted extra fields in the strict CLI schema. Cost/token usage is supervisor-supplied evidence; the model gateway must actually enforce spending and count retries and failed calls. The repository scripts cannot observe or enforce financial spending on their own.

Context selection starts from explicit files/module manifest and resolves local imports deterministically, sorted and bounded. Include contracts, policies, public symbols and one canonical example. If closure exceeds the budget or an import is unresolved, return a diagnostic. Expand only named dependencies after supervisor approval. Never silently drop a dependency and call the context complete.

## Repair and escalation

- Input/schema failure: return exact field/rule diagnostic; do not send the entire repository.
- Type/test failure: supply command, bounded sanitized output, failing files and relevant contracts.
- Transient provider outage: bounded retry with backoff inside the same total budget.
- Repeat identical failure twice, exhausted budget, changed contract/security policy, scope expansion or uncertain acceptance: needs-review.
- Infrastructure unavailable: blocked, never skipped-as-success.
- Security denial: stop that operation. No alternate route to evade the restriction.

Run one sequential task initially. Parallel work must have disjoint write sets and integrate through a fresh full validation. On a new user message the supervisor responds without abandoning child work; cancellation is explicit.

## Initial model routing

Small model: schema-backed CRUD, a single field, one UI state or bounded regression with an approved pattern. Escalate cross-module authorization, data migrations, concurrency, upload parsers and unclear acceptance to a stronger reviewer/human. This is a starting policy, not a demonstrated capability boundary. Every model receives the same protected gates.

## Evaluation

Use `evals/` tasks and evidence format. Compare original baseline, documentation-only, and deterministic-toolkit conditions with identical model/runtime/budget. Randomize order, use repeated trials and independent held-out tasks. Record functional success, first-pass success, cost, latency, repairs, out-of-scope changes, security violations and interventions. Publish n/N and uncertainty, not a single marketing percentage. No real-model campaign has been implied by installing this toolkit.

## Executable adapter in this repository

The optional `tools/harness/executor.mjs` exports `validateEnvelope`, `preflight`, `sandboxArguments`, `runVerifier` and `treeHash`. `tools/harness/benchmark.mjs` is an executable three-arm, repeated local-model runner. Run it with `npm run eval:run -- /absolute/campaign.json`; start from `tools/harness/campaign.example.json` and replace every placeholder with reviewed values. A failed preflight makes zero model calls.

The executor accepts only an already provisioned digest-pinned Docker/Podman image (or a full `sha256:` local image ID checked against image inspection). It never pulls images, mounts credentials, exposes the Docker socket, or falls back to an ordinary host shell. It requests a read-only root, no network, UID/GID 65534, no capabilities, no privilege escalation, bounded memory/CPU/PIDs/time/output, read-only candidate/verifier mounts, and bounded writable ephemeral scratch. The evidence directory is never mounted. `/tmp` is noexec; `/scratch` supports trusted compiler work on a copied candidate. Scratch is tmpfs and consumes memory: its disk ceiling does not add memory beyond the container memory budget. These constraints follow the [Docker runtime interface](https://docs.docker.com/engine/containers/run/); operational isolation still requires qualification on the actual host.

The model endpoint is deliberately restricted to explicit loopback HTTP (`127.0.0.1` or `::1`) and the OpenAI-compatible `/v1/chat/completions` route. Redirects, remote endpoints, credentials and arbitrary provider URLs are rejected. There is no paid-provider adapter or unapproved source-code transmission. An operator who needs a remote model must separately approve destination, data and budget and implement the corresponding controlled adapter; changing the URL alone is intentionally insufficient.

Each response must contain only structured file replacements within the reviewed allowlist. Protected tool/configuration/test files cannot be authorized by a model task. Campaign evidence records model identity, reported token usage, conservative token reservations, elapsed time, attempts, source/candidate/verifier hashes, changed files and each independent gate. Aggregate time/token bounds include retries and all cells. Unknown or over-budget usage blocks further calls. Local compute cost remains unknown, not zero. Controlled runtime/model test doubles mark results as fixtures.

Repair feedback is bounded and treated as untrusted data. Keep held-out acceptance details outside model context. Preserve separate development and held-out tasks; once results influence tuning, those tasks are no longer held out. A randomized deterministic order is reproducible but does not replace adequate sample size or statistical analysis.

## Prepare a concrete trusted verifier

1. Review a clean checkout, choose exact baseline commits for all three arms and author task-specific acceptance tests independently. Copy `tools/harness/verifier.policy.example.json` outside the candidate and replace `baselineCommits`, writable scope, protected overlay and minimum counts. The example's canonical core tests are a starter regression/security suite, NOT sufficient acceptance for an arbitrary newly generated module.
2. Run `node tools/harness/prepare-verifier.mjs /reviewed/checkout /new/separate/verifier /reviewed/policy.json`. It bundles the outer protocol wrapper and records baseline file hashes. Protect that directory from candidate writes. Keep expected verifier hashes in the supervisor store.
3. Build the provided Node-contract verifier image from the reviewed checkout using `tools/harness/Dockerfile.verifier` and an approved digest-pinned Node 24 base in `NODE_IMAGE`. Review dependency install output and image contents. Publish/provision it only through the organization's approved image process, then use the resulting registry digest. For a reviewed local build, a full immutable image ID is also supported without publishing the image; tags and short IDs remain forbidden. The executor will not use a mutable tag or an unprovisioned image.
4. Execute a trusted gate with `verification.kind`, `verification.minimumTests` and `verification.baselineCommit` set. The campaign runner supplies these automatically. The outer verifier independently hashes both mounts and emits exactly the `ai-verifier/v1` JSON receipt. All reviewed tests must execute and pass, with no skips; zero exit status without that receipt is rejected.
5. Qualify isolation, cancellation, resource exhaustion, malicious candidate behavior and the full workflow on the deployment host before enabling autonomous execution.

The supplied image runs Node contract tests with a protected compiler/launcher and immutable test overlay. It intentionally does not claim to be a prebuilt Meteor/DDP/browser image. For those heavier gates, provision a separate reviewed image containing the pinned Meteor release, cached packages, Mongo/browser binaries and adequate writable scratch/memory; use protected black-box tests against the candidate app. Never let candidate package scripts install dependencies at execution time. The additional `tools/harness/Dockerfile.meteor-verifier` and hosted real-container workflow provision the pinned Meteor warehouse and run protected Mongo/DDP tests with networking disabled. Read [its reproduction and qualification contract](../tools/harness/container-fixtures/README.md). Both real-container jobs must pass on the delivered head; a Dockerfile alone is not qualification. Browser workflows remain separate.

The TAP wrapper rejects missing, duplicated, failed, skipped and undersized summaries and never forwards candidate stdout as the outer receipt. Nevertheless, unit tests that load arbitrary candidate JavaScript into their own process are not a tamper-proof security boundary: hostile code can interfere with a test runtime. For adversarial candidates, independent black-box test processes/services and stronger process isolation are required. Tree hashes protect evidence binding, not a compromised host, container runtime or dishonest verifier. Do not market the adapter's mock tests as an operational sandbox qualification.
