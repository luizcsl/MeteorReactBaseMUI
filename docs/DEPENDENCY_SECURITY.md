# Dependency security evidence

Reviewed against the npm registry/advisory feed on 2026-10-21. `npm ci` uses the committed lock; never treat an audit count as a security proof.

- Updated Sharp to 0.35.5 (bundled native library fixes). Validate actual native decoding, not only TypeScript. [Upstream changelog](https://sharp.pixelplumbing.com/changelog/v0.35.5/).
- Migrated declarative routing from React Router 6 to 7.18.4. The supported `react-router` package exports BrowserRouter, Link and hooks directly; this avoids Meteor's inability to resolve the `react-router/dom` re-export from `react-router-dom`. Removed obsolete v7 future flags. [Upstream migration guide](https://reactrouter.com/upgrading/v6).
- Removed unused Quill and its types. No application source imported them. The [HTML-export advisory](https://github.com/advisories/GHSA-v3m3-f69x-jf25) lists no patched version; a suggested downgrade is not a reliable security fix.
- Locked qs 6.16.1, pbkdf2 3.1.7, serialize-javascript 7.1.2 and diff 8.0.3 overrides for ordinary dependency trees. Overrides do NOT rewrite vendored dependencies inside meteor-node-stubs.

## Residual upstream risks

The current `meteor-node-stubs` 1.2.27 package bundles vulnerable qs and pbkdf2 copies, despite overrides. These remain visible in the production audit. Do not claim zero vulnerabilities or modify installed node_modules to hide them. Browser polyfills are not a server parsing endpoint, but attacker-controlled values must still be bounded. Await upstream rebundle or undertake an independently tested replacement of the polyfill surface.

Removed the unused Cucumber preprocessing/discovery stack instead of accepting its unpatched [braces deep-pattern stack exhaustion](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). Historical Gherkin scenarios remain as documented migration reference, not falsely counted as executed tests. Both Cypress configurations now select the maintained canonical owner-CRUD suite. This removes the five high-severity entries belonging to that dev chain.

Re-run both `npm audit --omit=dev` and `npm audit` on each dependency update. Never use blanket audit suppression or `npm audit fix --force` as a qualification step.

## Validation recorded in this workspace

- Full TypeScript check passed after migration (2026-10-21).
- Sharp 0.35.5 native PNG encode/decode passed (2×2 pixel fixture).
- Production audit: 0 critical, 0 high, 2 moderate (the bundled polyfill copies above).
- Full audit after retiring the unused Cucumber stack: 0 critical, 0 high, 2 moderate (same vendored polyfill copies).
- Meteor app started successfully against disposable MongoDB and served HTTP. Browser CRUD is **not qualified** here: the official Cypress archive download was truncated; installed Chromium aborted at `process_singleton_posix.cc` with `socket() EPERM`, including a workspace profile and no-process-singleton/no-zygote variants. No gate was skipped or converted to success.

## Browser qualification elsewhere

The dedicated `npm run test:browser` uses `cypress.ai-ready.config.ts` and `.cypress/ai-ready/tasks.cy.js`. Start a local app against a disposable database and bootstrap a synthetic account through DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_EMAIL and DEFAULT_ADMIN_PASSWORD. Set CYPRESS_BASE_URL to that app and Cypress TEST_USER_EMAIL/TEST_USER_PASSWORD environment values to the same synthetic account (password >=14 characters). Never point this suite at production or use a real person's account. It exercises actual login, routed Tasks creation, editing, completion and deletion. CI must retain screenshots/logs on failures; this suite is distinct from the older Cucumber examples.

`.github/workflows/browser.yml` runs that qualification on a GitHub runner with a disposable Meteor-managed database, random masked bootstrap password, bounded readiness wait and failure artifacts. This workflow's existence is not evidence of a passing remote run; inspect the exact commit's job result before release.

The separate cloud-browser route was also attempted and returned an explicit browser security-policy denial for local page authority; it was stopped rather than bypassed. Only a passing browser CI job can close this qualification gap.
