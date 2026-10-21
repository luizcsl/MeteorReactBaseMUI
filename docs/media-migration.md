# Private media migration and crash recovery

## Compatibility and rollout

Back up Mongo and private storage together before upgrading. Configure a random `MEDIA_SIGNING_KEY` of at least 48 characters, identical across replicas. Never reuse or distribute the old global access token. Global `?token=` links and `DISABLE_MEDIA_TOKEN=true` are deliberately unsupported. A capability authorizes only one file's original version for download, for at most five minutes. Possession permits sharing that one resource during its validity; it is not a user session. Deactivating the file owner's profile revokes even unexpired links. Downloads, uploads, removal, and attachment publications require an active account/profile; a logged-in inactive requester cannot use a capability.

Existing files lack the server-owned content validation marker and remain quarantined by default. Minting another URL does not make them downloadable. Do not bulk-set `meta.contentValidated` or copy it from client input. Document URLs should be refreshed from an authorized server operation rather than persisted permanently.

## Revalidate an explicit batch

Use the trusted Meteor server shell in a maintenance window. The helper is not exposed over DDP or HTTP. First reconcile immutable `accountId` identity links. A legacy profile is automatically linked only when its primary ID matches an existing Meteor account; ambiguous/orphan profiles stop readiness and require operator reconciliation, never email-based linking.

1. Inspect attachment metadata and select at most 100 explicit IDs. Verify each `meta.userId` is the intended owning account; the migration does not infer owners.
2. In `meteor shell`, load `require('./imports/server/mediaMigration').revalidateLegacyMedia` as `revalidate` (use the equivalent absolute application module ID if your shell resolves from a different working directory).
3. Run `await revalidate({ ids: ['reviewed-file-id'], apply: false })`. This checks storage confinement through real paths, active ownership, declared type/size, file signatures, and bounded image decoding metadata. The served original version must resolve to the validated path and exactly match its size/type; unsupported extra versions are quarantined. It does not change records or files.
4. After reviewing the result and authorization, run the same explicit batch with `apply: true`. Only passing files receive the validation marker. Snapshot changes produce a `conflict` report instead of claiming successful validation. Failed files remain physically stored but receive `meta.quarantined: true` and cannot be downloaded. Resolve ownership/type/content issues separately; do not bypass the check.
5. Request fresh links through the authorized application path. Verify an allowed download, an unauthorized/cross-file denial, private/no-store headers, and revocation after owner deactivation.

The checks are an admission gate, not malware scanning. Office/archive signatures identify containers, not safe contents; production deployments that accept untrusted office documents should add malware scanning before releasing quarantine. BMP is not accepted by the image decoder; convert it in a separately approved migration rather than relabeling its MIME.

## Upload staging and interrupted processes

Chunked uploads use a private local staging directory, serialized filesystem locking, immutable metadata, a maximum of three unfinished uploads per owner and 100 per store, and one-hour inactivity expiry. The same user must reach the same staging store: use sticky routing for local disks. Distributed object storage needs a separate coordinated adapter. Expiry cleanup runs on subsequent upload activity, not as a continuously scheduled job.

A process crash may leave a fail-closed lock. Never remove it while a writer might still be running. The lock contains its owner's PID and hostname. A partial lock without owner metadata also requires a maintenance window.

1. Stop every app process sharing the staging store, including other containers/replicas.
2. Run `node tools/recover-upload-lock.mjs` on the originating host to inspect the lock without changing anything.
3. After confirming all writers are stopped, run `node tools/recover-upload-lock.mjs --apply --confirm-all-app-processes-stopped`. It refuses a live owner PID, a foreign host, or a changed lock. It removes only the stale lock, not uploads.
4. Restart the app. Existing uploads resume by offset and checksum; expired ones are cleaned on the next upload.

PID reuse intentionally fails closed and requires operator investigation. Never run this recovery command automatically on a timer.
