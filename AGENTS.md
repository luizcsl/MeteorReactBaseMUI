# Working on this boilerplate

Read `docs/AI_DEVELOPMENT.md` before changing architecture and the nearest module manifest before editing.

- Runtime: Meteor 3.5 / Node 24, React 19, MUI 7, strict TypeScript. Exact versions are locked.
- New modules use `imports/core` contracts and `imports/modules/tasks` as the canonical reference, not the legacy Example capabilities demo.
- Server code belongs in a `server/` directory. Never import it from shared/contracts/UI code.
- Remote input is untrusted. Identity comes from invocation; require explicit policy, strict DTO, output projection and document-scoped queries.
- Never remove a denial test to pass a gate. Never convert failures to skips or claim a tool was run when it was not.
- Run `npm run doctor`, `npm run typecheck`, `npm run test:toolkit`, then `npm run verify` before integration. A missing Meteor/browser/service is a blocked gate, not a pass.
- Use `npm run module:new -- --help` and `npm run agent:context -- --help`; inspect generated diffs. `check:changed` is a fast loop, not full qualification.
- Do not read secrets, deploy, update production data, install hooks, force push or overwrite unrelated changes. Request expansion when the task allowlist is insufficient.
- The external harness must isolate filesystem/network/credentials and protect tests/gates. Repository scripts are diagnostics, not a sandbox.
- Record observable evidence, residual risks and migration effects in the delivery report.

Recipes: `docs/recipes/owner-crud.md`, `docs/HARNESS_SYNERGIA.md`. Migration: `docs/MIGRATION_AI_READY.md`.
