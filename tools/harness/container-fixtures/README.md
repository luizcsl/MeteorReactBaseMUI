# Hosted real-container qualification

The `Real container harness qualification` workflow executes two mandatory jobs on
Ubuntu 24.04's Docker daemon. Missing Docker, failed provisioning, missing evidence
or zero tests fail the job; none are converted to skips. There are no model API calls.
The images are local to the runner: the workflow neither logs in to nor publishes to
an image registry. Public official Node/Meteor/npm downloads occur only during the
explicit provisioning phase, never inside candidate execution.

## Reproduce on an approved Docker host

```sh
npm ci --ignore-scripts
node node_modules/esbuild/install.js
node --test tools/harness/container-fixtures/meteor/report.test.mjs
docker pull node:24.19.0-bookworm
base="$(docker image inspect node:24.19.0-bookworm --format '{{index .RepoDigests 0}}')"
node tools/verify-container-harness.mjs --image="$base" --mode=fixtures

docker build --pull=false --build-arg NODE_IMAGE="$base" \
  --file tools/harness/Dockerfile.meteor-verifier --iidfile /tmp/meteor-verifier.iid .
node tools/verify-container-harness.mjs \
  --image="$(cat /tmp/meteor-verifier.iid)" --mode=meteor
```

Provision only from an independently reviewed checkout. A model's candidate must
never supply the Dockerfile, dependencies, verifier, policy or protected test overlay.
The official Node tag is used solely for provisioning, then its resolved RepoDigest
is recorded. A built image has no registry RepoDigest until publication, so the
executor also accepts its exact full `sha256:<image-id>`, verifies `.Id` equality,
and runs with `--pull=never`. Mutable tags and abbreviated IDs remain forbidden.

The fixture run executes 19 cases. The positive case requires 19 real assertions,
including UID, capabilities, no-new-privileges, external network denial, absence of
host credentials/socket/evidence, writes denied on candidate/verifier/root files,
writable ephemeral scratch and CPU/memory/swap/PID cgroup settings. Candidate and
verifier fixture modes are deliberately world-writable on the host so ordinary
Unix file permissions cannot falsely prove read-only mounts. Other cases reject
zero, missing, malformed, extra, failed, skipped, insufficient or misbound evidence,
nonzero exit with a valid-looking receipt, pre-execution hash mismatch, and enforce
actual disk/PID/memory exhaustion, output/clock limits and cancellation. Every
started run must confirm container removal and emit a non-mock receipt.

The Meteor image installs release 3.5.2 and the locked npm dependency tree, pins the
Mocha driver to 3.4.0 in staged package constraints (the CLI receives its bare
package name), records installer/release/Node/npm provenance, and warms the
real test suite while provisioning. Execution then copies the warehouse into a
6 GiB bounded writable scratch mount, preserving relative symlinks, and overlays
protected tests/configuration onto an ephemeral candidate copy. Candidate/verifier
mounts and the image remain read-only; uid 65534, no capabilities, no external
network, 6 GiB memory, 2 CPUs, 256 PIDs and a 30-minute wall budget remain enforced.
The fresh Mocha JSON report must have at least 40 passing tests, matching result
arrays, no failures/pending tests, and the real DDP publication and structured
recipe Mongo/DDP suites. Actual observed counts are in the receipt, not hardcoded
as a claim of executed tests. Missing warmed dependencies cause failure, not an
online install fallback.

Evidence is written to `.ai-artifacts/harness-fixtures` and
`.ai-artifacts/harness-meteor`, then archived as GitHub Actions artifacts alongside
resolved image identities and the Meteor provisioning log. `qualification.json`
summarizes each case; per-container JSON contains immutable tree hashes, limits'
observed outcome, command, process logs, cleanup and the verifier receipt. A job
that has not actually run successfully is not qualified merely because this recipe
exists.

These runs qualify the stated container boundary and the reviewed test collector,
not model effectiveness or universal hostile-code isolation. An application and
its in-process tests share a writable scratch namespace and can influence the
same test runtime; a determined malicious application could attack its own test
process/report. Independent black-box acceptance/security oracles are still needed
for that threat model. Docker is not a defense against a privileged/compromised
host, kernel or daemon. No passing receipt by itself grants task acceptance.
