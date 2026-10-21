# Reviewable semantic codemods

`planCodemod(root, operation)` from `tools/automation/codemods/index.mjs` plans only. It returns `{changes, diagnostics, migrations, requiresReview}`. Every change has an exact source `before` and proposed `after` (null denotes creation/deletion). The automation runner owns allowed paths, stale-hash checks, transactional writes and gates. A failed precondition clears all proposed changes and migrations and returns an error diagnostic. The planner never edits the checkout, changes persisted data, installs a dependency, executes an arbitrary expression or claims validation passed.

All operations require review. Review is not a substitute for compilation, independent tests, persistence/browser tests or examining runtime/external consumers. The compiler cannot discover arbitrary strings, remote API clients, stored data or computed reflection. The source project is bounded to 4,000 files, 1 MiB each, 32 MiB total, excluding dependency/build directories; symlink paths are rejected. Unknown input keys and operation kinds are rejected.

## Small, explicit operations

Each request uses a `kind` plus these fields. `file` and `to` are safe project-relative paths. `symbol` identifies a declaration, not a search/replace string. An optional zero-based `position` selects one declaration when its identifier is ambiguous.

- `rename-field`: `file`, `symbol`, `newName`, optional `position`. Requires an interface/type/class property with one declaration and no target collision. TypeScript language-service rename follows bound references, including typed object literals; unrelated same-spelled properties and prose are preserved. Emits a separate pending data/API rename migration plan.
- `change-field`: `file`, `symbol`, at least one of `type` (`string`, `number`, `boolean`) and `required` (boolean), optional `position`. Edits only explicit interface/type property signatures. Emits a pending conversion/backfill/compatibility plan, with no inferred conversion expression or data execution. Runtime validators and persisted data must be migrated and qualified separately.
- `rename-module`: `file`, `to`. Renames **one TypeScript/JavaScript source module**, using compiler file-rename edits to update imports and re-exports. Destination must not exist. This is not a generated feature-folder identity rename: manifests, registration strings and external consumers require separate review.
- `rename-route`: `file`, `from`, `to`. Both route strings start with `/`. Edits matching static AST `path`, `to`, `href` object properties and JSX attributes in the explicitly selected file, not arbitrary text. Emits a route-compatibility review plan. Dynamic routes, redirect policy and external bookmarks are outside this recipe.
- `move-symbol`: `file`, `symbol`, `to`, optional `position`. Uses TypeScript's semantic Move to file refactor for a top-level function, class, interface or type alias. The compiler updates imports and declaration dependencies. Existing destinations, nested declarations and eager static class initialization are rejected. Runtime module evaluation order and architectural boundaries still require review.
- `modernize-legacy`: same selectors as move-symbol plus `recipe: "extract-public-contract"`. Progressively extracts an existing legacy interface/type into the requested new contracts source file. This changes real source and its consumers, but **does not migrate ProductBase behavior**. The diagnostic explicitly retains the remaining authorization, parsing, projection and concurrency design work. No automatic replacement of a legacy authorization mechanism is approved.
- `migrate-framework`: `file`, `recipe: "meteor-user-async"`. Follows the named `Meteor` import from `meteor/meteor` (including aliases) and transforms zero-argument `Meteor.user()` calls only inside functions already declared `async`, adding `await` with grouping when needed. Shadowed local variables are not touched. A synchronous context blocks the entire plan instead of changing callers to return promises. Requires Meteor with `userAsync` and server/API compatibility verification.
- `deprecate-symbol`: `file`, `symbol`, optional `position`. Reports compiler-resolved uses and inserts a JSDoc deprecation on a top-level function/class/interface/type. Already deprecated and unsupported declaration shapes fail closed.
- `remove-symbol`: `file`, `symbol`, optional `position`. Reports uses first. Only unused, unexported, single top-level function/interface/type declarations can be removed. Runtime functions must be in an external module without direct `eval`; exported, merged, referenced and effectful declaration shapes are rejected. Public API retirement requires a reviewed migration outside this recipe.

Capabilities 32–35 continue using metadata-driven `module:evolve`, not these manual-code transformations. Capabilities 36–42 are bounded as described above, not universal refactorings.

## Data migrations and evidence

Field changes emit `status: "planned-not-executed"` and `executesDataChanges: false`. Plans require explicit persisted-consumer review, backup/rollback, conversion or backfill, staged compatibility and record-count/sample verification. No database connection is opened. A code plan must not be represented as completed functional migration.

Run `node --test tools/test/automation-codemods.test.mjs`. These independent fixtures cover bound references versus homonyms, read-only deterministic planning, collision/ambiguity rejection, pending backfill plans, import updating, contract extraction, async precedence and shadowing, usage/deprecation/removal, traversal and parse failures. They are tooling tests, not evidence of real Mongo or DDP behavior.

## Progressive legacy method migration

Capability 40 also supports `modernize-legacy` with `recipe: "register-method-to-operation"`, `file`, `symbol` (the business method), and `mappings`. This is a real core-operation adapter, not just contract extraction. It recognizes exactly one `this.registerMethod("customName", this.business.bind(this))` call resolving to `imports/api/serverBase.ts`, in a `server/` source. The business method has exactly two required parameters `(input, legacyContext)`. Explicit arity `1, 1` is also allowed.

Mappings must resolve semantically to existing typed symbols in scope, including qualified namespace symbols:

- `input` and `output`: existing runtime schemas with `parse`.
- `policy`: core policy `(context, parsedInput) => Promise<void>`.
- `contextBuilder`: core trusted identity builder.
- `identityFromLegacy`: explicit function mapping the legacy trusted context to a user ID; the generator never guesses context field names.
- `project`: function projecting the original business result to the public output contract.
- `effect`: explicit `read` or `write`.
- `concurrency`: required only for writes; an existing reviewed executor `(context, parsedInput, perform) => Promise<Result>`. It must enforce the appropriate transaction/CAS/idempotency invariant and invoke `perform` exactly once. The generated guard prevents a second business invocation and rejects zero invocations. Symbol resolution is not proof of concurrency correctness.

The transformation captures the original bound function once, inserts a compiler-selected relative import of core `operationHandler`, and wraps that callback with strict input parsing, trusted identity validation, explicit policy, projection and output validation. The original method body is unchanged. Legacy registration, context construction, argument-count checks and the post-business legacy validator remain in place. No second registration or duplicate business call is introduced. The public shape intentionally follows the explicitly supplied projection.

This progressive adapter does not replace the transport with `registerOperation`; therefore it does not claim new core transport error normalization or rate limits. Existing legacy transport behavior stays unchanged. Optional/multiple DTO arguments, implicit CRUD names, transaction/REST registration, registration overrides, unresolved or untyped mappings, and writes without concurrency executors fail closed. Moving a legacy source into `server/` and ensuring it has no client imports is a separate reviewed boundary change.

Independent fixtures execute generated adapters against the actual repository core `operationHandler`, runtime schemas and errors. They compare original business results after the declared projection, check exact single execution and legacy validator preservation, and deny anonymous, other-owner, forged-input, malformed-input and extra-context arguments. Write fixtures demonstrate that policy denial never reaches the reviewed concurrency executor or business method.
