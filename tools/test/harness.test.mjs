import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
	sandboxArguments,
	validateEnvelope,
	preflight,
	runVerifier,
	treeHash,
	validateVerificationReport
} from '../harness/executor.mjs';

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-'));
	for (const d of ['candidate', 'verifier', 'output']) fs.mkdirSync(path.join(root, d));
	fs.writeFileSync(path.join(root, 'candidate', 'app.js'), 'export const value=1;\n');
	fs.writeFileSync(path.join(root, 'verifier', 'run'), '#!/bin/sh\nexit 0\n');
	const config = {
		version: 1,
		image: 'registry.example/test@sha256:' + 'a'.repeat(64),
		candidate: path.join(root, 'candidate'),
		verifier: path.join(root, 'verifier'),
		output: path.join(root, 'output'),
		command: ['/verifier/run'],
		verification: { kind: 'acceptance', minimumTests: 2 },
		limits: { seconds: 1, memoryMB: 256, cpus: 1, pids: 32, outputBytes: 4096, diskMB: 512 }
	};
	return { root, config, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function report(c, overrides = {}) {
	return {
		protocol: 'ai-verifier/v1',
		kind: c.verification.kind,
		candidateTreeHash: treeHash(c.candidate),
		verifierTreeHash: treeHash(c.verifier),
		tests: { total: 2, passed: 2, failed: 0, skipped: 0 },
		...overrides
	};
}
function runtime(c, action, options = {}) {
	const calls = [];
	return {
		calls,
		spawnSync(engine, args, settings) {
			calls.push({ engine, args, settings });
			if (args[0] === 'version') return { status: 0, stdout: '1.0' };
			if (args[0] === 'image') return { status: 0, stdout: JSON.stringify([c.image]) };
			return { status: 0, stdout: '', stderr: '', ...options.cleanup };
		},
		spawn(engine, args, settings) {
			calls.push({ engine, args, settings });
			const child = new EventEmitter();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.kill = (signal) => calls.push({ killed: signal });
			queueMicrotask(() => action(child));
			return child;
		}
	};
}

test('sandbox pins image and prohibits network, host credentials, writes and extra privileges', () => {
	const f = fixture();
	try {
		const args = sandboxArguments(f.config, 'ai-verify-1234567890abcdef');
		for (const required of [
			'--network=none',
			'--read-only',
			'--cap-drop=ALL',
			'--security-opt=no-new-privileges',
			'--user=65534:65534',
			'--pull=never',
			'--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m',
			'--tmpfs=/scratch:rw,nosuid,nodev,exec,size=512m'
		])
			assert.ok(args.includes(required));
		assert.equal(args.filter((x) => x.includes('type=bind')).length, 2);
		assert.ok(args.filter((x) => x.includes('type=bind')).every((x) => x.endsWith(',readonly')));
		assert.ok(!args.some((x) => x.includes('docker.sock') || x.includes(f.config.output)));
	} finally {
		f.cleanup();
	}
});
test('sandbox rejects tag-only images, overlap, files as roots, unsafe entrypoints and excessive budgets', () => {
	const f = fixture(),
		c = f.config;
	try {
		for (const patch of [
			{ image: 'node:24' },
			{ verifier: c.candidate },
			{ candidate: path.join(c.candidate, 'app.js') },
			{ command: ['node', '/candidate/run.js'] },
			{ command: ['/verifier/../verifier/run'] },
			{ command: ['/verifier//run'] },
			{ limits: { ...c.limits, seconds: 999999 } },
			{ limits: { ...c.limits, diskMB: 999999 } },
			{ verification: { kind: 'acceptance', minimumTests: 0 } }
		])
			assert.throws(() => validateEnvelope({ ...c, ...patch }));
		assert.throws(() => preflight(c, { engine: '/tmp/evil' }));
		fs.symlinkSync(path.join(c.verifier, 'run'), path.join(c.verifier, 'link'));
		assert.throws(() => validateEnvelope({ ...c, command: ['/verifier/link'] }));
	} finally {
		f.cleanup();
	}
});
test('tree binding includes modes and empty directories and rejects links', () => {
	const f = fixture();
	try {
		const root = f.config.candidate,
			first = treeHash(root);
		fs.mkdirSync(path.join(root, 'empty'));
		assert.notEqual(treeHash(root), first);
		fs.rmdirSync(path.join(root, 'empty'));
		fs.chmodSync(path.join(root, 'app.js'), 0o755);
		assert.notEqual(treeHash(root), first);
		fs.linkSync(path.join(root, 'app.js'), path.join(root, 'hard'));
		assert.throws(() => treeHash(root), { rule: 'candidate-tree' });
		fs.unlinkSync(path.join(root, 'hard'));
		fs.symlinkSync('/etc/passwd', path.join(root, 'link'));
		assert.throws(() => treeHash(root), { rule: 'candidate-tree' });
	} finally {
		f.cleanup();
	}
});
test('preflight is fail-closed without runtime or exact pinned image and never pulls', () => {
	const f = fixture();
	try {
		const calls = [];
		const unavailable = {
			spawnSync(engine, args) {
				calls.push(args);
				return { status: null, error: new Error('ENOENT') };
			}
		};
		assert.equal(preflight(f.config, { runtime: unavailable }).rule, 'sandbox-unavailable');
		assert.deepEqual(
			calls.map((x) => x[0]),
			['version']
		);
		const mismatch = {
			spawnSync(engine, args) {
				return { status: 0, stdout: args[0] === 'version' ? 'v1' : JSON.stringify([f.config.image + 'evil']) };
			}
		};
		assert.equal(preflight(f.config, { runtime: mismatch }).rule, 'image-unavailable');
	} finally {
		f.cleanup();
	}
});
test('valid report binds all trees and nonzero required counts; exit zero alone cannot verify', async () => {
	const f = fixture(),
		c = f.config;
	try {
		const mock = runtime(c, (child) => {
			child.stdout.write(JSON.stringify(report(c)));
			child.stderr.write('bounded diagnostic');
			child.emit('close', 0);
		});
		const result = await runVerifier(c, { runtime: mock });
		assert.equal(result.status, 'verified');
		assert.equal(result.fixture, true);
		assert.equal(result.verification.tests.total, 2);
		assert.equal(JSON.parse(fs.readFileSync(result.evidenceFile)).candidateTreeHash, treeHash(c.candidate));
		assert.ok(
			mock.calls.every((call) => !call.settings || Object.keys(call.settings.env).sort().join(',') === 'HOME,PATH')
		);
		for (const body of [
			'',
			JSON.stringify({ accepted: true }),
			JSON.stringify(report(c, { tests: { total: 0, passed: 0, failed: 0, skipped: 0 } })),
			JSON.stringify(report(c, { candidateTreeHash: 'b'.repeat(64) })),
			JSON.stringify(report(c, { kind: 'security' })),
			JSON.stringify(report(c)) + '\n' + JSON.stringify(report(c))
		]) {
			const invalid = await runVerifier(c, {
				runtime: runtime(c, (child) => {
					child.stdout.write(body);
					child.emit('close', 0);
				})
			});
			assert.equal(invalid.status, 'blocked');
			assert.equal(invalid.verification, null);
		}
		const noPolicy = { ...c };
		delete noPolicy.verification;
		assert.equal(
			(await runVerifier(noPolicy, { runtime: runtime(c, (child) => child.emit('close', 0)) })).reason,
			'verification-required'
		);
	} finally {
		f.cleanup();
	}
});
test('protocol rejects skips, failures, undercounts, extras and unsafe count values', () => {
	const f = fixture(),
		c = f.config;
	try {
		const expected = {
			...c.verification,
			candidateTreeHash: treeHash(c.candidate),
			verifierTreeHash: treeHash(c.verifier)
		};
		for (const tests of [
			{ total: 1, passed: 1, failed: 0, skipped: 0 },
			{ total: 2, passed: 1, failed: 1, skipped: 0 },
			{ total: 2, passed: 2, failed: 0, skipped: 1 },
			{ total: 2, passed: 2, failed: 0, skipped: 0, accepted: true },
			{ total: 2, passed: 2.5, failed: 0, skipped: 0 }
		])
			assert.throws(() => validateVerificationReport(report(c, { tests }), expected));
		assert.throws(() => validateVerificationReport({ ...report(c), accepted: true }, expected));
	} finally {
		f.cleanup();
	}
});
test('candidate and verifier mutation blocks acceptance, including auxiliary verifier files', async () => {
	for (const which of ['candidate', 'verifier']) {
		const f = fixture(),
			c = f.config;
		try {
			const before = report(c);
			const mock = runtime(c, (child) => {
				fs.writeFileSync(path.join(c[which], 'injected'), 'changed');
				child.stdout.write(JSON.stringify(before));
				child.emit('close', 0);
			});
			const result = await runVerifier(c, { runtime: mock });
			assert.equal(result.reason, 'tree-mutation');
			assert.equal(result.status, 'blocked');
			assert.equal(result.verification, null);
		} finally {
			f.cleanup();
		}
	}
});
test('output limits, timeouts, cancellation and spawn failures clean up without trusting late output', async () => {
	const f = fixture(),
		c = f.config;
	try {
		for (const [action, reason] of [
			[(child) => child.stdout.write('x'.repeat(5000)), 'output-budget'],
			[() => {}, 'timeout'],
			[(child) => child.emit('error', Object.assign(new Error('no engine'), { code: 'ENOENT' })), 'ENOENT']
		]) {
			const mock = runtime(c, action);
			const result = await runVerifier(c, { runtime: mock });
			assert.equal(result.reason, reason);
			assert.equal(result.status, 'blocked');
			assert.ok(mock.calls.some((call) => call.args?.[0] === 'rm'));
			assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= c.limits.outputBytes);
		}
		const abort = new AbortController(),
			mock = runtime(c, (child) => {
				abort.abort();
				child.stdout.write(JSON.stringify(report(c)));
				child.emit('close', 0);
			});
		const result = await runVerifier(c, { runtime: mock, signal: abort.signal });
		assert.equal(result.status, 'cancelled');
		assert.ok(mock.calls.some((call) => call.args?.[0] === 'kill'));
		assert.ok(mock.calls.some((call) => call.killed === 'SIGKILL'));
		const preAbort = new AbortController();
		preAbort.abort();
		const never = runtime(c, () => assert.fail('must not spawn'));
		assert.equal((await runVerifier(c, { runtime: never, signal: preAbort.signal })).status, 'cancelled');
		const uncertain = runtime(
			c,
			(child) => {
				child.stdout.write(JSON.stringify(report(c)));
				child.emit('close', 0);
			},
			{ cleanup: { status: 1, stderr: 'daemon disconnected' } }
		);
		assert.equal((await runVerifier(c, { runtime: uncertain })).reason, 'cleanup-unconfirmed');
	} finally {
		f.cleanup();
	}
});
test('reviewed local builds require an exact full immutable image ID, never a tag or partial ID', () => {
	const f = fixture();
	try {
		const image = 'sha256:' + 'b'.repeat(64),
			config = { ...f.config, image };
		assert.equal(validateEnvelope(config).image, image);
		const runtime = {
			spawnSync(_engine, args) {
				return { status: 0, stdout: args[0] === 'version' ? 'v1' : image + '\n' };
			}
		};
		assert.equal(preflight(config, { runtime }).status, 'ready');
		assert.equal(
			preflight(config, {
				runtime: {
					spawnSync(_engine, args) {
						return { status: 0, stdout: args[0] === 'version' ? 'v1' : 'sha256:' + 'c'.repeat(64) };
					}
				}
			}).rule,
			'image-unavailable'
		);
		assert.throws(() => validateEnvelope({ ...config, image: 'sha256:1234' }));
	} finally {
		f.cleanup();
	}
});
