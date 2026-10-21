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
