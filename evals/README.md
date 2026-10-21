# Agent benchmark: protocol and evidence reader

This directory defines a **functional pilot**, not evidence that any model achieves a success rate. No model campaign has been run or results invented. `report.test.mjs` tests the reader with temporary, explicitly labeled fixtures. Passing those tests says nothing about application behavior or agent effectiveness.

## Thirty tasks, three arms

`tasks.json` contains 8 CRUD, 6 security, 4 UI, 4 data/sync, 4 integration/file and 4 regression tasks. Every task specifies a concrete behavior, acceptance boundary and budget (3 attempts, 1,800 cumulative seconds, USD 5 cumulative model/tool cost). Budget excludes evaluator setup but includes all agent retries, tool use and billed model calls. Human work is reported separately, never hidden as agent success.

For each task and repetition run all three arms:

1. `original`: pinned upstream snapshot without added guidance.
2. `docs`: the same snapshot with only AI documentation/rules added.
3. `contracts`: pinned implementation with executable contracts and deterministic tools.

Copy `campaign.example.json` outside this directory or into a campaign evidence folder, replace placeholders with immutable source/model/harness versions, and record the randomization seed. The example deliberately has no execution results and invalid placeholder commits: it cannot be mistaken for a completed campaign. Use an identical model, temperature, time/cost/attempt budget, machine class, network policy and evaluator for each arm. Randomize arm order with the recorded seed; isolate every task in a fresh checkout and disposable database. Do not let one arm read another arm's changes, logs or answers. Record resolved tool/runtime versions and environment details in an additional campaign artifact.

The task prompts are public. Evaluators must add independent hidden assertions before running the campaign, including denial and regression tests. Do not expose those assertions to the coding agent or accept changes to them from the agent. Freeze task requirements, scope manifests, baseline fixtures and evaluator revision across arms before starting. Record allowed paths per task in the evaluator's scope manifest; compare actual Git changed paths against it, including untracked files. Hash that manifest into the scope-check artifact.

## External optional harness boundary

No LLM runtime, model SDK, orchestration library or provider credential belongs to the application or this report tool. An optional external harness owns model calls, isolation, task delivery, retries, budgets, source snapshots and independent verifiers. It writes evidence in `result.schema.json` format; it must not accept a model's own `success` message as an outcome. This repository does not yet provide the external harness or all hidden application acceptance tests.

For every attempt, the trusted evaluator runs and records all four checks:

- `acceptance`: observable task behavior through the actual boundary (real DDP for RPC/security, browser for UI, database readback for persistence).
- `security`: anonymous, cross-user/tenant and malformed-input denial assertions, plus field projection.
- `regression`: previously frozen baseline suite, including unchanged functionality.
- `scope`: independent Git diff against the allowed-path manifest, including untracked files and forbidden evaluator modifications.

Each check records the exact command, verifier identity, exit code, relative log artifact and its SHA-256. Exit zero means verified pass; nonzero means failure. Preserve stdout/stderr and assertion details in the artifact. Only trust manifests written by the external evaluator, not by the coding agent. Hashes verify integrity, not truth or evaluator independence. Do not include secrets, tokens or real user data in logs. Stop after accepted completion, budget exhaustion or explicit abort; aborts never qualify as successes. Record failed attempts rather than dropping them. Unknown cost must be `null`, not zero. Zero is valid only when measured cost truly was zero.

Run:

    node evals/report.mjs /path/to/campaign.json
    node --test evals/*.test.mjs

The report reads listed result files relative to the campaign directory, checks task/arm/repetition/baseline consistency, rejects duplicate results and missing/tampered evidence, and rejects fixture results by default. `--allow-fixtures` is only for reader development. Artifact paths must remain within the evidence directory, including symlink resolution.

## Measurements and limits

Per arm and per category the JSON report returns first-attempt and within-budget success rates, runs with any security/scope/regression failure, total elapsed attempt time, known USD cost, unknown-cost attempt count and human interventions. Violation rates count runs with at least one failed corresponding check, even if a later attempt fixes it. A success requires all four checks to pass in a completed run, within cumulative attempts/time/cost limits. Missing cost prevents a within-budget success claim.

Each rate includes its count, observed denominator and 95% Wilson interval. Missing planned runs are shown explicitly and are not silently treated as successes, failures or complete campaigns. Zero observations produce null estimates and intervals. Costs/times cover observed runs only. Retain incomplete campaign reports as incomplete; do not compare arms with selective reporting.

27/30 is a 90% point estimate with a roughly 74%–97% Wilson interval, not proof of a 90% future success rate. Tasks and repeated model runs may be correlated, violating the binomial independence assumption. This reader does not calculate causal significance or declare superiority. After the pilot, use independently authored unseen tasks across complexity levels, frozen hidden checks, repetitions and a predeclared paired/cluster-aware analysis. The current catalog is the pilot; a genuinely held-out validation catalog must be developed and reviewed separately before claiming independent validation.
