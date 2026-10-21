#!/usr/bin/env node
/** Trusted wrapper. Build a standalone bundle with prepare-verifier.mjs; never run from a candidate checkout. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { treeHash } from '../executor.mjs';
import { exact, fail, confined, hash, allowed } from '../../lib.mjs';
export function parseTapSummary(output, minimumTests) {
	const values = {};
	for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
		const matches = [...output.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
		if (matches.length !== 1) fail('verifier-summary', `Expected exactly one TAP ${key} summary`);
		values[key] = Number(matches[0][1]);
	}
	if (
		values.tests < minimumTests ||
		values.tests !== values.pass ||
		values.fail ||
		values.cancelled ||
		values.skipped ||
		values.todo
	)
		fail('verifier-tests', 'Required tests did not all pass');
	return { total: values.tests, passed: values.pass, failed: values.fail, skipped: values.skipped };
}
export function checkScope(candidate, baseline, scope) {
	if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline) || !Array.isArray(scope) || !scope.length)
		fail('verifier-scope', 'Reviewed baseline hashes and scope required');
	const files = {};
	const walk = (dir, prefix = '') => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const name = prefix + e.name;
			if (e.isDirectory()) walk(path.join(dir, e.name), name + '/');
			else if (e.isFile()) files[name] = hash(fs.readFileSync(path.join(dir, e.name)));
			else fail('verifier-scope', 'Nonregular entry');
		}
	};
	walk(candidate);
	const changed = [...new Set([...Object.keys(files), ...Object.keys(baseline)])].filter(
		(name) => files[name] !== baseline[name]
	);
	for (const name of changed)
		if (!allowed(name, scope)) fail('verifier-scope', `Protected or out-of-scope change: ${name}`);
	return {
		total: Math.max(1, Object.keys(files).length),
		passed: Math.max(1, Object.keys(files).length),
		failed: 0,
		skipped: 0
	};
}
export function executeTrustedGate({
	candidate = '/candidate',
	verifier = '/verifier',
	scratch = '/scratch',
	kind = process.env.AI_VERIFY_KIND
} = {}) {
	const beforeCandidate = treeHash(candidate),
		beforeVerifier = treeHash(verifier);
	const policy = JSON.parse(fs.readFileSync(confined(verifier, 'policy.json'), 'utf8'));
	exact(policy, ['version', 'gates', 'scope', 'baselines']);
	if (policy.version !== 1 || !['acceptance', 'security', 'regression', 'scope'].includes(kind))
		fail('verifier-policy', 'Invalid policy/gate');
	const baselineCommit = process.env.AI_VERIFY_BASELINE;
	if (!/^[a-f0-9]{40}$/.test(baselineCommit || '') || !Object.hasOwn(policy.baselines, baselineCommit))
		fail('verifier-baseline', 'Reviewed baseline commit is required');
	let tests;
	if (kind === 'scope') tests = checkScope(candidate, policy.baselines[baselineCommit], policy.scope);
	else {
		const gate = policy.gates[kind];
		exact(gate, ['command', 'minimumTests']);
		if (
			!Array.isArray(gate.command) ||
			!gate.command.length ||
			!gate.command[0].startsWith('/opt/toolchain/') ||
			gate.command.some((x) => typeof x !== 'string' || x.includes('\0')) ||
			!Number.isSafeInteger(gate.minimumTests) ||
			gate.minimumTests < 1
		)
			fail('verifier-policy', 'Reviewed toolchain command and nonzero test count required');
		// Candidate mount stays immutable. Only an ephemeral copy can compile/write caches.
		const work = path.join(scratch, 'candidate');
		fs.mkdirSync(scratch, { recursive: true });
		if (fs.existsSync(work)) fail('verifier-scratch', 'Scratch must be fresh');
		fs.cpSync(candidate, work, { recursive: true });
		const overlay = confined(verifier, 'overlay');
		for (const name of fs.readdirSync(overlay)) {
			const from = confined(overlay, name),
				to = path.join(work, name);
			fs.rmSync(to, { recursive: true, force: true });
			fs.cpSync(from, to, { recursive: true });
		}
		fs.symlinkSync('/opt/toolchain/node_modules', path.join(work, 'node_modules'), 'dir');
		const result = spawnSync(gate.command[0], gate.command.slice(1), {
			cwd: work,
			encoding: 'utf8',
			timeout: 900000,
			maxBuffer: 8000000,
			env: {
				PATH: '/opt/toolchain/bin:/usr/local/bin:/usr/bin:/bin',
				HOME: path.join(scratch, 'home'),
				TMPDIR: scratch,
				CI: 'true',
				NODE_TEST_CONTEXT: '',
				TEST_SERVER_ONLY: '1',
				METEOR_ALLOW_SUPERUSER: '1'
			}
		});
		// Logs are diagnostic only. Never forward candidate output as the outer JSON receipt.
		if (result.stderr) process.stderr.write(result.stderr.slice(-16000));
		if (result.error || result.status !== 0) fail('verifier-command', 'Protected gate process failed');
		tests = parseTapSummary(result.stdout, gate.minimumTests);
	}
	if (treeHash(candidate) !== beforeCandidate || treeHash(verifier) !== beforeVerifier)
		fail('verifier-mutated', 'Read-only trees changed');
	return {
		protocol: 'ai-verifier/v1',
		kind,
		baselineCommit,
		candidateTreeHash: beforeCandidate,
		verifierTreeHash: beforeVerifier,
		tests
	};
}
if (process.env.AI_VERIFIER_ENTRY === '1') {
	try {
		console.log(JSON.stringify(executeTrustedGate()));
	} catch (error) {
		console.error(JSON.stringify({ rule: error.rule || 'verifier', message: error.message }));
		process.exitCode = 1;
	}
}
