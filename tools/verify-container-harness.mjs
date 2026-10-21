#!/usr/bin/env node
/** Real runtime qualification. No mock runtime, no implicit pull, and no skip on missing Docker. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { preflight, runVerifier, treeHash } from './harness/executor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = Object.fromEntries(
	process.argv.slice(2).map((arg) => {
		const match = /^--(image|output|mode)=(.+)$/.exec(arg);
		if (!match)
			throw new Error(
				'Usage: node tools/verify-container-harness.mjs --image=IMMUTABLE_IMAGE [--output=DIR] [--mode=fixtures|meteor]'
			);
		return match.slice(1);
	})
);
if (!options.image)
	throw new Error('--image must name an already provisioned immutable image; this script never pulls');
const mode = options.mode || 'fixtures';
assert.ok(['fixtures', 'meteor'].includes(mode), 'Unknown qualification mode');
const output = path.resolve(options.output || `.ai-artifacts/harness-${mode}`);
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'real-harness-'));
fs.chmodSync(temporary, 0o755);
const candidate = path.join(temporary, 'candidate'),
	verifier = path.join(temporary, 'verifier');
fs.mkdirSync(candidate);
fs.mkdirSync(verifier);
const summary = {
	version: 1,
	mode,
	status: 'running',
	image: options.image,
	cases: [],
	notice: 'Real container qualification, not real-model productivity evidence or universal sandbox security proof.'
};
const writeSummary = () =>
	fs.writeFileSync(path.join(output, 'qualification.json'), JSON.stringify(summary, null, 2) + '\n');
const config = {
	version: 1,
	image: options.image,
	candidate,
	verifier,
	output: fs.realpathSync(output),
	command: ['/verifier/run.mjs'],
	verification: { kind: 'security', minimumTests: 1 },
	limits: { seconds: 30, memoryMB: 256, cpus: 0.5, pids: 32, outputBytes: 65536, diskMB: 8 }
};
const assertCleaned = (result) => {
	assert.equal(result.fixture, false, 'A mocked runtime must never count as container qualification');
	assert.equal(result.cleanup?.confirmed, true, 'Container cleanup was not confirmed');
	const name = path.basename(result.evidenceFile, '.json');
	const inspect = spawnSync('docker', ['container', 'inspect', name], { encoding: 'utf8' });
	assert.notEqual(inspect.status, 0, 'Container still exists after completion');
	assert.match(inspect.stderr, /No such (?:object|container)/i, 'Cannot confirm removal');
	assert.deepEqual(JSON.parse(fs.readFileSync(result.evidenceFile, 'utf8')).status, result.status);
};
async function qualify(name, overrides, expectations, runtimeOptions) {
	const input = { ...config, ...overrides, limits: { ...config.limits, ...overrides?.limits } };
	const result = await runVerifier(input, runtimeOptions);
	summary.cases.push({
		name,
		status: result.status,
		reason: result.reason || result.rule || null,
		exitCode: result.exitCode,
		tests: result.verification?.tests,
		evidence: result.evidenceFile ? path.basename(result.evidenceFile) : null
	});
	writeSummary();
	for (const [key, value] of Object.entries(expectations))
		assert.equal(result[key], value, `${name}: unexpected ${key}; ${JSON.stringify(result)}`);
	assertCleaned(result);
	console.log(`${name}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
	return result;
}
try {
	if (mode === 'fixtures') {
		fs.copyFileSync(path.join(root, 'tools/harness/container-fixtures/attack.mjs'), path.join(candidate, 'attack.mjs'));
		await build({
			entryPoints: [path.join(root, 'tools/harness/container-fixtures/fixture-verifier.mjs')],
			bundle: true,
			platform: 'node',
			format: 'esm',
			outfile: path.join(verifier, 'run.mjs')
		});
		// Deliberately writable host modes prevent Unix permissions from masking a missing read-only mount.
		fs.chmodSync(candidate, 0o777);
		fs.chmodSync(verifier, 0o777);
		fs.chmodSync(path.join(candidate, 'attack.mjs'), 0o777);
		fs.chmodSync(path.join(verifier, 'run.mjs'), 0o777);
		const ready = preflight(config);
		assert.equal(ready.status, 'ready', JSON.stringify(ready));
		process.env.AI_HARNESS_SECRET_SENTINEL = 'must-not-cross-boundary';
		const initialCandidate = treeHash(candidate),
			initialVerifier = treeHash(verifier);
		const command = (name) => ['/verifier/run.mjs', name, output];
		await qualify(
			'isolated-positive',
			{ command: command('positive'), verification: { kind: 'security', minimumTests: 19 } },
			{ status: 'verified' }
		);
		for (const [name, reason] of [
			['zero', 'verification-counts'],
			['failed', 'verification-counts'],
			['skipped', 'verification-counts'],
			['missing', 'verification-protocol'],
			['malformed', 'verification-protocol'],
			['extra-output', 'verification-protocol'],
			['candidate-hash', 'verification-binding'],
			['verifier-hash', 'verification-binding'],
			['wrong-gate', 'verification-binding']
		])
			await qualify(name, { command: command(name) }, { status: 'blocked', reason });
		await qualify(
			'below-required-count',
			{ command: command('valid'), verification: { kind: 'security', minimumTests: 3 } },
			{ status: 'blocked', reason: 'verification-counts' }
		);
		await qualify('nonzero-even-with-receipt', { command: command('nonzero') }, { status: 'failed', exitCode: 7 });
		await qualify('disk-capacity', { command: command('disk') }, { status: 'verified' });
		await qualify('pid-exhaustion', { command: command('pids') }, { status: 'verified' });
		await qualify(
			'memory-exhaustion',
			{ command: command('oom'), limits: { memoryMB: 64 } },
			{ status: 'failed', exitCode: 137 }
		);
		await qualify(
			'output-budget',
			{ command: command('output'), limits: { outputBytes: 4096 } },
			{ status: 'blocked', reason: 'output-budget' }
		);
		await qualify(
			'wall-time-budget',
			{ command: command('hang'), limits: { seconds: 2 } },
			{ status: 'blocked', reason: 'timeout' }
		);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1500);
		try {
			await qualify(
				'cancellation',
				{ command: command('hang') },
				{ status: 'cancelled', reason: 'cancelled' },
				{ signal: controller.signal }
			);
		} finally {
			clearTimeout(timer);
		}
		const stale = await runVerifier(config, { expectedCandidateTreeHash: '0'.repeat(64) });
		assert.equal(stale.status, 'blocked');
		assert.equal(stale.rule, 'tree-mutation');
		summary.cases.push({ name: 'pre-execution-hash-binding', status: stale.status, reason: stale.rule });
		assert.equal(treeHash(candidate), initialCandidate);
		assert.equal(treeHash(verifier), initialVerifier);
	} else {
		// Copy only tracked, reviewed application inputs. No .git, settings.json, credentials or host modules.
		const tracked = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
		assert.equal(tracked.status, 0, tracked.stderr);
		const allowed =
			/^(?:imports\/|tests\/|client\/|server\/|public\/|private\/|\.meteor\/[^/]+$|package(?:-lock)?\.json$|tsconfig\.json$|\.meteorignore$)/;
		for (const name of tracked.stdout.split('\0').filter((name) => name && allowed.test(name))) {
			const from = path.join(root, name),
				to = path.join(candidate, name);
			assert.ok(fs.lstatSync(from).isFile(), `Nonregular candidate input: ${name}`);
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.copyFileSync(from, to);
		}
		assert.equal(fs.readFileSync(path.join(candidate, '.meteor/release'), 'utf8').trim(), 'METEOR@3.5.2');
		// Protected test/config overlay comes from this reviewed checkout, independently of candidate edits.
		const overlay = path.join(verifier, 'overlay');
		fs.mkdirSync(overlay);
		for (const name of ['tests', '.meteor', 'package.json', 'package-lock.json', 'tsconfig.json', '.meteorignore'])
			fs.cpSync(path.join(candidate, name), path.join(overlay, name), { recursive: true });
		await build({
			entryPoints: [path.join(root, 'tools/harness/container-fixtures/meteor/verify.mjs')],
			bundle: true,
			platform: 'node',
			format: 'esm',
			outfile: path.join(verifier, 'run.mjs')
		});
		fs.chmodSync(path.join(verifier, 'run.mjs'), 0o755);
		await qualify(
			'meteor-mongo-ddp-security',
			{
				verification: { kind: 'security', minimumTests: 40 },
				limits: { seconds: 1800, memoryMB: 6144, cpus: 2, pids: 256, outputBytes: 1048576, diskMB: 6144 }
			},
			{ status: 'verified' }
		);
	}
	summary.status = 'passed';
} catch (error) {
	summary.status = 'failed';
	summary.error = error.message;
	throw error;
} finally {
	writeSummary();
	fs.rmSync(temporary, { recursive: true, force: true });
}
