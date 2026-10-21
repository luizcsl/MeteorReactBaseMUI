# Migrating derived projects

This branch changes security-sensitive behavior. Review the diff and stage against a restored copy of data, never directly against production.

1. Record upstream baseline, toolkit/schema/template versions and application-specific overrides. Keep an `upstream-boilerplate` Git remote and a reviewed merge/cherry-pick history; do not overwrite the application with a new template.
2. Test every custom remotely registered method for its exact declared argument count. Context comes only from the wrapper and can no longer be supplied in extra arguments. New operations use a single DTO and context-first handler.
3. Missing access policy is denied. Declare public operations explicitly and document their projection; no environment variable may bypass ownership.
4. Global media-token URLs cease being accepted. Regenerate links through authorized code. Treat old shared tokens as exposed and rotate operational secrets through your normal secure process; do not paste them into logs.
5. Reconcile profiles to immutable Meteor account IDs. Review duplicate email/profile records manually; email fallback is not a trustworthy account-link mechanism. Never copy provider service tokens into profiles.
6. Upgrade mobile clients together with cursor/version/mutation contracts. Legacy timestamp-only clients cannot safely page equal timestamps. Do not label a queued mutation synchronized before server confirmation.
7. The core is online-first. Disconnected methods fail explicitly. `jam:offline` is not installed by this repository; a future offline profile needs user-isolated persistence, logout cleanup and conflict qualification.
8. Run all gates, negative DDP/HTTP checks and restore rehearsal before rollout. Use a reversible deployment; database migrations need separately reviewed forward/backward compatibility.

The patch does not migrate deployed data automatically, close exposed historical credentials, enforce distributed quotas, validate all provider integrations or certify regulatory compliance. Release metadata and changelog make these limits visible to downstream maintainers.

## Experimental Example sync boundary

`example.mobilePull` and `example.mobileUpsert` are disabled by default (`experimental-sync-disabled`). Only a controlled qualification environment may opt in with `EXPERIMENTAL_EXAMPLE_SYNC=true`. This is not a production offline-support switch. `example.sync` remains retired (`sync-protocol-required`).

Example online inserts initialize `_syncRevision=1`. Online updates, mobile CAS, upload completion and asset removal share one atomic Mongo update pipeline: increment the revision and advance `lastupdate` to at least the prior timestamp plus one millisecond, using the database clock. Mobile updates require integer `baseRevision` (zero for an existing unmigrated record), not the former timestamp `baseVersion`. New mobile creates omit `baseRevision`. Stable `mutationId` is mandatory. The last 100 receipts per document support replay; older stale replays fail rather than silently overwrite data.

Pull cursors contain separate timestamp+ID checkpoints for documents and tombstones. This fixes equal-timestamp page truncation but is not a globally ordered, cross-instance change log or snapshot. Clock skew on creation and delayed commits still require transport qualification and a transactional change-log design. Deleting an Example while experimental sync is enabled fails explicitly with `experimental-sync-delete-unsupported`, because deletion and tombstone insertion are not atomic. Ordinary online deletion is available when sync is disabled.

Preserve existing queued edits for explicit reconciliation. Before production offline support, implement a transactional append-only change log including deletion, durable mutation receipts/retention policy, and real transport concurrency/reconnection tests. The Tasks reference is online CRUD, not a claim that this complete offline protocol exists. No deployed data or client queue is migrated automatically.
