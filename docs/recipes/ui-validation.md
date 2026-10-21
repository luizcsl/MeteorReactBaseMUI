# Schema-driven recipe UI qualification

## What this gate proves

`npm run test:recipe-ui` bundles the **actual** `RecipePage`, `RecipeForm` and shared recipe parser with React and MUI, starts a temporary HTTP listener bound only to `127.0.0.1` on an OS-selected port, and runs the dedicated Cypress suite in a real browser. The default browser is Cypress's bundled Electron. To select an installed browser, run `node tools/verify-recipe-ui.mjs --browser=chrome` (also accepts `chromium`, `firefox`, `edge`, and `electron`).

The injected `RecipeClient` is a controllable test adapter. It can hold or reject individual requests, return older snapshots, simulate a lost create acknowledgement and emulate a version conflict. These are **UI boundary tests, not full application E2E, real Meteor/DDP, Mongo persistence, authorization, reviewer eligibility or distributed idempotency evidence**. The adapter's simple receipt and version behavior creates the test conditions; it does not independently qualify those server properties. Run the separate server suites for those claims.

The master-detail selector is a fixture wrapper exercising the production component's `parentId` property. This does not claim that `RecipePage` supplies a parent-picker or that a downstream application's picker has been tested. Likewise, approval buttons are determined by the current state; server-side permission checks remain mandatory even when a button is visible.

## Covered browser behavior

The 16 independent cases cover:

- Accessible schema labels and string/integer/enum/boolean controls; HTML constraints and strict parser rejection before remote writes.
- Loading, empty, failed-list and retry states.
- Typed create payloads, pending controls, duplicate-submit suppression, update version arguments and cancel without writing.
- An unchanged uncertain create retry retaining its mutation ID; changed requests and post-success intentions using a new ID.
- Older list successes and failures arriving after a newer filter result.
- Exact typed filters and the bounded list limit.
- Version-conflict errors retaining the user's draft and explicit refresh loading fresh remote values.
- A save completing after a newer filter selection without overwriting its results.
- Current-state approval controls, pending/denied transitions without optimistic success, and a successful retry.
- Pending/denied deletion retaining the record until the adapter confirms removal.
- Parent-scoped lists and creation, clearing an edit on parent change, older parent results, late writes and old-parent errors.

Tests interact with the rendered interface and assert the remote boundary arguments and rendered results. No test route, fixture account, application registry edit or production data is needed. All fixture code lives under `tools/` and `.cypress/`, both excluded by `.meteorignore`.

## Run and retain evidence

1. Install the locked dependencies with `npm ci`. Cypress needs its matching browser binary and OS browser dependencies. A missing binary or a denied browser launch is a blocked gate, never a pass.
2. Run `npm run test:recipe-ui`. The runner fails for zero tests, failed, pending or skipped tests, as well as startup errors.
3. Retain `.ai-artifacts/recipe-ui.json` and `.cypress/screenshots/recipe-ui` together with the exact commit. The JSON records browser/Cypress versions, totals and SHA-256 hashes of the component, contract, fixture, configuration and test sources.
4. Rerun after any relevant source change. A previous result or a bundle-only check does not qualify a later revision.

For environments that cannot launch a browser, `node tools/verify-recipe-ui.mjs --build-only` checks bundling and writes `.ai-artifacts/recipe-ui-build.json`. It explicitly reports **browser not run**, uses a separate evidence file and cannot replace the browser gate. It does not bind a port or attempt to bypass environment access restrictions.

The harness starts no Meteor process or database, accepts no external base URL, and serves only its generated HTML and JavaScript. The listener and temporary bundle are cleaned up after normal completion or a reported runner failure. Do not expose this controllable fixture outside a disposable qualification environment.

## Evidence status for this implementation

On 2026-10-21 the standalone bundle and repository TypeScript check passed locally. Real browser execution in this editing environment is blocked: the matching Cypress binary is absent and the environment does not permit the required local browser/socket route. No local browser pass is claimed. The independent CI invocation must establish the exact-revision browser result; its evidence should be retained as described above. This statement is not a substitute for that result.
