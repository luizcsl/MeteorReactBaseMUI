# Structural evolution and compiler-resolved context

The supervisor owns these tools. A small model proposes a bounded operation document, not arbitrary edits to validators, generators, policy tests, manifests or qualification evidence. Treat repository text, comments and model output as untrusted data.

## Evolution contract

Recipe modules have `module.definition.json`, `module.manifest.json`, deterministic `generated/` files and separately maintained `custom/` extensions. Version 2 manifests pin the definition and every generated file. The renderer and runtime share one strict definition validator.

An operation document is JSON, for example:

```json
{
	"schemaVersion": 1,
	"module": "ownednotes",
	"operations": [
		{ "kind": "add-field", "field": { "name": "archived", "label": "Archived", "type": "boolean", "required": false } },
		{ "kind": "add-filter", "field": "archived" }
	]
}
```

Supported operations:

- `add-field`: exact field schema; adding the same field again is a no-op, changing an existing field is rejected. Required new fields emit `migrationRequired`; the generator does not invent a backfill.
- `add-filter`: references an existing, validated field.
- `add-state`: requires `state` and a `transitions` array. An existing transition cannot be silently replaced.
- `replace-permissions`: complete validated `permissions` object. Requires human policy review and independent negative tests even if the schema accepts it.

Deletion, rename, field-type replacement, executable snippets and arbitrary path operations are intentionally unsupported. Perform destructive changes through a separately reviewed migration and explicit implementation.

## Planning and applying

The stable integration API is `tools/evolve.mjs`:

```js
import { planEvolution, applyEvolution, recoverEvolution } from './tools/evolve.mjs';
const plan = planEvolution(projectRoot, operationDocument);
// Persist the JSON plan, inspect its complete generated-file diffs, and review policy/backfill implications.
const result = applyEvolution(projectRoot, plan);
```

Planning does not write anything. Applying re-renders the plan independently and compares it with the supplied plan. It checks hashes of the entire module, including custom files, before staging and again before replacement. Tampering, stale plans, unknown schema keys, path traversal, symbolic links and generated-file customizations fail closed. Apply never overwrites a manually modified generated file. Move custom logic into `custom/` or a wrapper before evolving. A successful change sets `qualified: false`.

CLI: `npm run module:evolve -- --plan operations.json` emits a plan; `npm run module:evolve -- --apply plan.json` applies an approved plan; `npm run module:evolve -- --recover ownednotes` invokes explicit recovery. Capture machine-readable plans with `node tools/cli.mjs module:evolve --plan operations.json > plan.json` so npm banners do not corrupt JSON.

Bounds: 32 operations, 500 module files, 8 MiB module content, 1 MiB metadata. Module identities are lowercase, 3–32 characters. No application code, migrations, network requests or model calls execute during evolution.

## Replacement, concurrency and crash recovery

Run in an isolated local checkout with all writers stopped. The exclusive module lock coordinates cooperating tool invocations; it is not an OS sandbox and cannot stop another process ignoring the lock. No running application should serve the module while it is being evolved.

All validated output is staged before two directory renames replace the old tree. An ordinary rename failure restores the old tree. This is **not** a filesystem-level multi-file transaction: there is a short directory-visibility gap, and power-loss durability is not guaranteed. The process fsyncs its journal but does not claim directory-entry durability across every filesystem.

If interrupted, keep `.evolve-<module>.lock`, `.evolve-<uuid>.backup` and `.evolve-<uuid>.stage`. Do not delete the lock blindly. `recoverEvolution(root,module)` refuses a live owner PID, validates the journal paths and all tree hashes, and restores the original backup when available. If backup cleanup already finished and the current tree exactly matches the expected new tree, it reports `already-applied`. Intervening edits, invalid/empty journals, unexpected files or incomplete staging require manual review. Preserve evidence and recover from version control rather than guessing. PID checks assume one local operating system, not a shared network volume or PID namespaces.

After application or recovery, rerun independent policy/property tests, typechecking, boundary checks and relevant DDP/browser qualification. Schema validity alone is not evidence of safe authorization, correct data migration or working UI.

## AST context and architecture checks

`tools/ast.mjs` provides `analyzeSource`, `astContext`, `astGraph` and `astBoundaries`. It uses the installed TypeScript compiler parser and module resolver, not import-text regular expressions. Imports, reexports, multiline syntax, aliases, escaped specifiers, import-equals, literal dynamic imports and import types participate in the graph. Export signatures are bounded. Unresolved local dependencies, computed loaders, aliased loaders and unsupported indirect require calls fail closed rather than silently returning incomplete context. Extended tsconfigs require a reviewed flattened configuration.

Context generation emits the full bounded dependency closure or fails; it does not silently truncate files. Source hashes bind context to inspected bytes. Parse failures, sensitive paths, symlinks and source/serialized-output budget excesses are rejected. Package names are recorded separately; dependency source code is not copied from node_modules into model context.

Boundary checks cover pure contracts/domain, core-to-module dependencies, private cross-module imports, transitive UI-to-server reachability through barrels, and cycles touching canonical core/module layers. Legacy cycles are explicit review debt. A narrowly reviewed isomorphic attachments bridge is pinned to its full SHA-256 and exact server targets. Changing that file invalidates the exception; inspect all callbacks/server guards before updating the pin. Syntactic Meteor.isServer guard evidence is exposed but is never sufficient by itself to grant a new exception.

This is a static graph, not a whole-program proof or a sandbox. It does not prove arbitrary JavaScript reflection, runtime code generation, network behavior, permissions, dependency supply-chain safety or module side effects. Use the external isolated harness and independent tests for those properties.

## Qualification tests

```sh
node --test tools/test/ast.test.mjs tools/test/evolve.test.mjs
```

Tests include real repository boundaries, escaped/aliased imports, transitive leaks, loader bypasses, bounded closure, stale/tampered plans, generated customizations, repeat application, concurrent lock rejection, rename rollback and explicit crash recovery. They do not substitute for live database or browser acceptance tests.
