# Deterministic workflow conditions and deadlines

The optional feature `workflow` adds **server-enforced guards** to existing recipe transitions. It does not add transitions, grant roles, register a second transport, start timers, or schedule background transitions. Existing identity, tenant/owner scope, approval separation of duties, reference checks, strict DTOs and optimistic concurrency remain authoritative.

## Bounded contract

`tools/automation/contracts/workflow.v1.schema.json` describes the JSON shape. Generation and execution use the same typed `validateWorkflowConfig` implementation; semantic checks also require fields and transitions to exist in the validated recipe.

```json
{
	"transitions": [
		{
			"from": "draft",
			"to": "approved",
			"conditions": [
				{ "field": "ready", "op": "eq", "value": true },
				{ "field": "amount", "op": "lte", "value": 10000 }
			],
			"deadline": {
				"anchor": "updatedAt",
				"afterMs": 86400000,
				"mode": "before"
			}
		}
	]
}
```

- Select 1–40 unique existing `from`/`to` pairs. Each rule requires nonempty `conditions`, a `deadline`, or both. Unconfigured transitions retain normal recipe behavior.
- A rule permits 1–20 conditions combined with AND. `eq` and `ne` use strict typed equality. `lt`, `lte`, `gt`, and `gte` support only integer, integer minor-unit money, and valid ISO civil-date fields. Strings and enum labels do not have ordering semantics.
- Literals must match the selected field's type and bounds. References must be syntactically valid IDs, but comparison never proves reference access; the recipe's scoped reference port still does that.
- Null is permitted only for optional fields with `eq`/`ne`. An optional null value fails every ordered comparison. There is no truthiness or string/number coercion.
- Unknown keys, unknown fields, duplicate rules/conditions, invalid dates, expressions, callback names, arbitrary JavaScript, cron, and implicit jobs are rejected. Arrays are dense and bounded; accessors and non-plain objects are not accepted.

## Time semantics and migration

`afterMs` is an integer from 1 to 31,536,000,000 (365 days). The only anchor is the persisted server-owned `updatedAt` timestamp. The recipe engine supplies trusted time, optionally through its server-only `now` port, and writes `updatedAt` on creation, data updates and state transitions. Callers cannot submit either timestamp through a mutation DTO, and timestamps are not added to public recipe DTOs.

`dueAt = updatedAt + afterMs`. A deadline is due when `now >= dueAt`:

- `before` permits the transition strictly before `dueAt`; exact due time and later fail with `conflict`.
- `after` permits the transition at or after `dueAt`; earlier calls fail with `conflict`.

The anchor is the **last successful mutation**, not the first time the record entered its state. Data updates restart this interval. This is an explicit inactivity/last-update deadline, not a fixed calendar deadline or state-entry SLA. A different anchor requires a reviewed extension; the generator does not invent it.

Legacy records without `updatedAt` continue to work with ordinary recipes and conditions-only rules, but a matching deadline rule fails closed with `conflict`. A valid ordinary data update establishes a new anchor by design. If historical deadline continuity matters, review and execute an explicit timestamp backfill before enabling guards. Generation never modifies production records or silently substitutes the current time. Invalid dates, a clock earlier than the anchor, and timestamp overflow also fail closed.

## Composition and status

`renderWorkflow({ definition, workflow })` emits `generated/workflow/server/index.ts`, imported through `generated/workflow/server`. Its `createWorkflowPorts(basePorts)` accepts ports before repository creation, retains the existing trusted ports, and composes `beforeTransition` instead of overwriting its checks. Integration must pass the wrapped ports into the existing generated registration function. The actual engine invokes the hook after identity, scope, transition role and stale-version checks and before the same versioned compare-and-set.

`createWorkflowGuard` snapshots validated configuration when constructed. `evaluateWorkflow(definition, config, row, to, now)` performs the deterministic evaluation and throws `forbidden` when conditions fail or `conflict` when time constraints fail. It never writes a record or sends a notification.

`workflowStatus` and the generated `getWorkflowStatus` provide read-only outgoing-transition status, including `conditionsMet`, `allowed`, `blockedBy`, and `deadline: { dueAt, due, mode }`. These server helpers require a row already authorized by the caller and trusted server time. They are not independently exposed remote methods, authorization decisions, or automatic scheduling. Do not pass arbitrary client rows to them. A public status endpoint must reuse existing authorized read/projection wrappers.

A durable deadline-triggered job requires an explicit reviewed queue/worker adapter and authorized identity/revalidation semantics. No scheduler, timer, notification provider, credentials, deployment or security configuration is provisioned by this DSL.

## Evidence

Run `node --test tools/test/automation-workflow.test.mjs`. The tests compile the actual TypeScript evaluator and engine, execute generated wrappers, and typecheck generated code. Coverage includes all operators, typed/null comparisons, strict configuration, exact time boundaries, invalid timestamps, denied/stale/unauthenticated writes, trusted timestamp persistence, status projection and preservation of existing guards. These focused tests are not a substitute for full toolkit, Meteor/DDP, Mongo or browser qualification.
