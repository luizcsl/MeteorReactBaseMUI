#!/usr/bin/env node
/** Prepare a separate immutable verifier directory from a reviewed checkout, never from model output. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { hash, confined, exact, fail } from '../lib.mjs';
const [rootArg, destinationArg, policyFile] = process.argv.slice(2);
if (!rootArg || !destinationArg || !policyFile)
	throw Error('Usage: node tools/harness/prepare-verifier.mjs REVIEWED_ROOT NEW_VERIFIER_DIR POLICY.json');
const root = fs.realpathSync(rootArg),
	destination = path.resolve(destinationArg),
	policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
exact(policy, ['version', 'gates', 'scope', 'overlay', 'baselineCommits']);
if (policy.version !== 1 || !Array.isArray(policy.overlay) || !policy.overlay.length)
	fail('verifier-policy', 'Reviewed overlay paths are mandatory');
if (fs.existsSync(destination) || destination.startsWith(root + '/'))
	fail('verifier-destination', 'Use a new directory outside the checkout');
const baselines = {};
const blobCache = new Map();
if (!Array.isArray(policy.baselineCommits) || !policy.baselineCommits.length || policy.baselineCommits.length > 3)
	fail('verifier-baseline', 'Provide 1–3 reviewed full commit hashes');
const git = (args) => {
	const r = spawnSync('git', ['-C', root, ...args], { maxBuffer: 256000000, timeout: 60000 });
	if (r.status !== 0) fail('verifier-git', 'Cannot read reviewed Git object');
	return r.stdout;
};
for (const commit of policy.baselineCommits) {
	if (
		!/^[a-f0-9]{40}$/.test(commit) ||
		git(['rev-parse', `${commit}^{commit}`])
			.toString()
			.trim() !== commit
	)
		fail('verifier-baseline', 'Full commit required');
	const baseline = {};
	for (const entry of git(['ls-tree', '-rz', '--full-tree', commit]).toString().split('\0').filter(Boolean)) {
		const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/s.exec(entry);
		if (!match) fail('verifier-baseline', 'Unsupported Git tree entry');
		const [, mode, oid, name] = match;
		confined(root, name, { missing: true });
		if (!blobCache.has(oid)) blobCache.set(oid, hash(git(['cat-file', 'blob', oid])));
		baseline[name] = blobCache.get(oid);
	}
	baselines[commit] = baseline;
}
fs.mkdirSync(destination, { mode: 0o755 });
fs.mkdirSync(path.join(destination, 'overlay'));
for (const name of policy.overlay) {
	const source = confined(root, name),
		target = confined(path.join(destination, 'overlay'), name, { missing: true });
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.cpSync(source, target, { recursive: true });
}
await build({
	entryPoints: [path.join(root, 'tools/harness/verifier/run.mjs')],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: path.join(destination, 'run.mjs'),
	banner: { js: 'process.env.AI_VERIFIER_ENTRY="1";' }
});
fs.copyFileSync(path.join(root, 'tools/harness/verifier/gate.mjs'), path.join(destination, 'gate.mjs'));
fs.chmodSync(path.join(destination, 'run.mjs'), 0o755);
fs.writeFileSync(
	path.join(destination, 'policy.json'),
	JSON.stringify({ version: 1, gates: policy.gates, scope: policy.scope, baselines }, null, 2)
);
console.log(
	JSON.stringify({
		status: 'prepared',
		directory: destination,
		notice: 'Review policy and image, then mount read-only. This preparation is not sandbox qualification.'
	})
);
