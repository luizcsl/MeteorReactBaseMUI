# Reviewed local Meteor project scaffolding

The ordinary `project` planner operation composes features **inside an existing boilerplate**. This separate supervisor-reviewed workflow creates a **new project directory** from an explicitly selected local boilerplate. It does not expand the ordinary runner's protected-path permissions.

## API and request

`tools/automation/project.mjs` exports synchronous functions:

```js
import { planProject, applyProject } from './tools/automation/project.mjs';

const workspaceRoot = '/absolute/canonical/development/workspace';
const request = {
	source: 'approved-boilerplate',
	destination: 'new-app',
	name: 'new-app'
};
const plan = planProject(workspaceRoot, request);
// Persist and independently review the complete plan before the separate apply step.
const result = applyProject(workspaceRoot, plan, independentlyApprovedPlanHash);
```

- The workspace must be an explicitly provided absolute, canonical real directory, without symlink ancestors. Both source and destination are relative to this root. No request field accepts arbitrary commands, flags, install options or an external path.
- `source` may be `.` to use the workspace itself. Otherwise it uses safe relative path segments. The source must be a normal local Git checkout with its own `.git` directory; linked worktrees, symlinks, submodules and unmerged index entries fail closed.
- `destination` must be a **nonexistent directory**, even an existing empty directory is rejected. Its parent must already exist. Source and destination cannot be equal, and the destination cannot contain the source. A new child of the source is supported because untracked output is never copied.
- `name` is 2–63 lowercase ASCII letters, digits or hyphens, beginning with a letter. It changes only `package.json.name`, `package-lock.json.name` and `package-lock.json.packages[""].name`. It does not guess branding, package imports, URLs, roles, identity configuration or business semantics.
- Paths use portable ASCII letters/digits, underscore, dot, `@`, plus and hyphen; empty segments, dot segments, backslashes and traversal are rejected. Case-colliding tracked filenames are rejected. Unsupported filenames fail closed instead of being silently renamed.

`PROJECT_LIMITS` exposes fixed ceilings: 5,000 tracked entries, 8 MiB per copied file and 64 MiB of source content. These are implementation limits, not request-controlled budgets.

## What gets copied

The engine lists tracked files through a fixed read-only `git ls-files --cached --stage -z` invocation. It uses no shell, inherited Git environment variables, caller-supplied arguments, network, package manager or lifecycle script. Git filesystem monitoring and hooks are disabled for the invocation. Git must already be available in the supervised execution environment.

Only tracked paths are eligible. **Current working-tree bytes** are snapshotted, so reviewed local modifications are included; this is not a clean-commit export. Newly authored files must be tracked before they can appear in a scaffold. Each included file has its source byte length, mode and SHA-256 recorded. The full staged tracked listing is also fingerprinted, so staged additions, removals and executable-mode changes invalidate a prior plan.

Required tracked files are `package.json`, an npm v2/v3 `package-lock.json` with consistent root names, and `.meteor/packages`, `.meteor/versions`, `.meteor/release`, `.meteor/platforms`. Other allowed tracked application files, tools, templates, documentation, tests, public assets, private templates and configuration examples copy unchanged. Binary assets retain exact bytes and ordinary executable files retain their tracked executable bit. The new project's manifests get the explicitly requested package name without resolving or altering dependencies.

The plan provides every output file in full using `encoding: "utf8"` or `encoding: "base64"`, with its destination-relative path, size, mode and SHA-256. Review binary files by decoding their complete base64 payload. Source paths and excluded filenames are also visible for review; excluded file contents are never opened.

### Mandatory exclusions

The filter excludes these even if they were accidentally tracked:

- `.git`, `node_modules`, `.meteor/local`, and `.meteor/.id`. The source project's identity is not reused; Meteor can create a new identity on first use.
- Real `.env` variants, actual `settings*.json`, `.npmrc`, Yarn registry configuration, `.netrc`, `.git-credentials`, SSH key names and private-key/container formats. `.env.example` and `settings.example.json` remain available for explicit configuration later.
- `.aws`, `.ssh`, `.gnupg`, `.codex`, `.agents`, credentials/secrets paths and conventional credential/secret filenames.
- Automation state, review locks/staging, generated artifacts, dependency/build/cache output, logs, coverage, IDE state, and Cypress result/screenshot/video directories.
- `.gitmodules`; tracked submodule entries themselves are unsupported rather than recursively fetched.

This is a conservative **path-based exclusion filter**, not a general secret scanner. A secret embedded in an otherwise allowed source file or misleadingly named example cannot be recognized reliably. Review the approved source and every planned payload before approval. No guarantee is made that an arbitrary repository is free of secrets or malicious source code. The workflow never executes copied code.

## Review and apply

`planProject` is read-only. It snapshots the source twice and fails if the included files or tracked listing change during planning. Its deterministic SHA-256 covers the complete plan, including the canonical workspace, request, source preconditions and all output bytes. JSON key order does not change the approval hash.

The only accepted approval is the **exact independently reviewed plan hash**. `applyProject` rebuilds the plan from the current approved local source and compares the complete result before writing. Editing a payload and recomputing its hash does not make it an authentic generated plan. A changed request requires a new reviewed plan. The hash is an approval record, not authentication or proof that a human reviewed the contents; an external supervisor owns the approval boundary.

Apply takes an exclusive `.project-scaffold.lock` in the workspace, revalidates, and creates the destination with exclusive ownership. Files use exclusive create, no-follow opens and explicit ordinary modes; there is no overwrite operation. Every destination component is checked for symlinks and owned directory replacement. The engine verifies written files and detects unexpected destination entries, then rechecks source preconditions before reporting success.

Both plan and result explicitly retain `installed: false`, `scriptsExecuted: false`, and `qualified: false`. Success means **files were created**, not that dependencies were installed, Meteor ran, a browser passed, production configuration exists, or deployment is ready. After separate authorization, configure examples, install through the normal trusted workflow, and run the normal qualification gates. No Git repository, commit, credentials, account, production settings or deployment is created automatically.

## Failure and recovery

A caught failure removes only files still matching the writer's identity and expected bytes, then removes only owned empty directories. Concurrent edits, replaced directories and foreign files are preserved. A successful rollback removes the lock and leaves no generated destination.

A rollback conflict retains the lock and conflicting destination for **supervised recovery**. A process crash can likewise leave a partial destination and lock. Before any manual recovery, independently confirm that the writer is no longer running, inspect the lock's plan hash/destination against the reviewed plan, and preserve unrelated or concurrently edited data. Do not remove a live writer's lock or recursively delete a destination merely because the workflow once created it. This workflow intentionally does not provide automatic crash recovery or reuse an existing destination.

This is a controlled development-workspace transaction, not an atomic directory publication or an OS sandbox. Output may be partially visible during creation. Stop live consumers and other filesystem writers. Component checks and no-follow final opens reject ordinary path/symlink substitution, but cannot isolate against a hostile process racing ancestor replacement between individual filesystem syscalls. The external supervisor must own the workspace and trusted Git executable/configuration. No runtime, production data or existing security configuration is modified.

## Tests and evidence

Run:

```sh
node --test tools/test/automation-project-scaffold.test.mjs
```

The isolated synthetic repositories cover deterministic complete payloads, real Meteor metadata, lock-name consistency, binary files, executable modes, secret/cache exclusion, untracked omission, exact approval, tampering even with a recomputed hash, source drift, path traversal, symlinks, missing metadata, exclusive locking, no overwrite, caught-failure rollback, preserved concurrent edits, unexpected files, source changes during apply, and an in-source destination.

These Node/filesystem tests do not claim Meteor runtime, installation, browser, deployment, or production qualification. The parent automation guide and protected external harness remain authoritative for end-to-end acceptance.
