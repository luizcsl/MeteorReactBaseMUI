import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
	applyModelFiles,
	campaignOrder,
	exportCommit,
	requestLocalModel,
	runCampaign,
	validateCampaign
} from '../harness/benchmark.mjs';
import { treeHash } from '../harness/executor.mjs';

const arms = ['original', 'docs', 'contracts'],
	kinds = ['acceptance', 'security', 'regression', 'scope'];
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-'));
	for (const dir of ['repo', 'output', 'verifier']) fs.mkdirSync(path.join(root, dir));
	const repository = path.join(root, 'repo');
	fs.writeFileSync(path.join(repository, 'app.js'), 'original');
	const git = (...args) => {
		const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	git('init', '-q');
	git('add', 'app.js');
	git(
		'-c',
		'user.name=Fixture',
		'-c',
		'user.email=fixture@example.invalid',
		'-c',
		'core.hooksPath=/dev/null',
		'commit',
		'-qm',
		'Fixture only'
	);
	const commit = git('rev-parse', 'HEAD');
	fs.writeFileSync(path.join(root, 'verifier', 'run'), '#!/bin/sh\nexit 0\n');
	const config = {
		version: 1,
		id: 'fixture-campaign',
		repository,
		output: path.join(root, 'output'),
		model: {
			endpoint: 'http://127.0.0.1:9999/v1/chat/completions',
			name: 'controlled-fixture-not-real-model',
			maxTokens: 128,
			seconds: 5,
			responseBytes: 10000
		},
		budget: { seconds: 30, tokens: 50000 },
		repetitions: 1,
		seed: 91,
		arms: Object.fromEntries(arms.map((arm) => [arm, { commit }])),
		tasks: [
			{
				id: 'fix-value',
				split: 'heldout',
				prompt: 'Replace app.js with the correct value.',
				context: Object.fromEntries(arms.map((arm) => [arm, ['app.js']])),
				allowedPaths: ['app.js'],
				attempts: 2,
				checks: Object.fromEntries(kinds.map((kind) => [kind, { command: ['/verifier/run'], minimumTests: 2 }]))
			}
		],
		sandbox: {
			image: 'registry.example/test@sha256:' + 'a'.repeat(64),
			verifier: path.join(root, 'verifier'),
			engine: 'docker',
			limits: { seconds: 1, memoryMB: 256, cpus: 1, pids: 32, outputBytes: 4096 }
		}
	};
	return { root, config, git, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function wire(patch = { files: [{ path: 'app.js', content: 'correct' }] }, extra = {}) {
	return {
		model: 'fixture',
		choices: [{ message: { role: 'assistant', content: JSON.stringify(patch) }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
		...extra
	};
}
const response = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function mockRuntime(config, { exitOnly = false, mutate, failOnce = false } = {}) {
	const calls = [],
		seen = new Set();
	return {
		calls,
		spawnSync(engine, args, options) {
			calls.push({ engine, args, options });
			return {
				status: 0,
				stdout: args[0] === 'image' ? JSON.stringify([config.sandbox.image]) : 'fixture',
				stderr: ''
			};
		},
		spawn(engine, args, options) {
			calls.push({ engine, args, options });
			const child = new EventEmitter();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.kill = () => {};
			queueMicrotask(() => {
				const mount = (key) =>
					args
						.find((value) => value.startsWith('type=bind,src=') && value.includes(`dst=/${key},`))
						.split(',')[1]
						.slice(4);
				const candidate = mount('candidate'),
					verifier = mount('verifier'),
					kind = args
						.find((value) => value.startsWith('--env=AI_VERIFY_KIND='))
						.split('=')
						.at(-1),
					baselineCommit = args
						.find((value) => value.startsWith('--env=AI_VERIFY_BASELINE='))
						.split('=')
						.at(-1);
				if (failOnce && !seen.has(candidate)) {
					seen.add(candidate);
					child.stderr.write('\x1b[31mExpected correct value, received wrong\x1b[0m\x00');
					child.emit('close', 1);
					return;
				}
				const report = {
					protocol: 'ai-verifier/v1',
					kind,
					baselineCommit,
					candidateTreeHash: treeHash(candidate),
					verifierTreeHash: treeHash(verifier),
					tests: { total: 2, passed: 2, failed: 0, skipped: 0 }
				};
				if (mutate) mutate({ candidate, verifier, kind });
				if (!exitOnly) child.stdout.write(JSON.stringify(report));
				child.emit('close', 0);
			});
			return child;
		}
	};
}

test('campaign rejects remote/credential/query endpoints, unreviewed scopes, bad commits and missing heldout', () => {
	const f = fixture(),
		c = f.config;
	try {
		for (const endpoint of [
			'https://127.0.0.1/v1/chat/completions',
			'http://localhost/v1/chat/completions',
			'http://evil.example/v1/chat/completions',
			'http://127.0.0.1.evil.example/v1/chat/completions',
			'http://2130706433/v1/chat/completions',
			'http://127.1/v1/chat/completions',
			'http://user:pass@127.0.0.1/v1/chat/completions',
			'http://127.0.0.1/v1/chat/completions?token=secret',
			'http://127.0.0.1/v1/chat/completions#x'
		])
			assert.throws(() => validateCampaign({ ...c, model: { ...c.model, endpoint } }), { rule: 'model-endpoint' });
		assert.throws(() => validateCampaign({ ...c, tasks: [{ ...c.tasks[0], allowedPaths: ['tools/'] }] }));
		assert.throws(() => validateCampaign({ ...c, tasks: [{ ...c.tasks[0], split: 'development' }] }), {
			rule: 'campaign-heldout'
		});
		assert.throws(() => validateCampaign({ ...c, arms: { ...c.arms, original: { commit: 'HEAD' } } }));
		assert.throws(() => validateCampaign({ ...c, budget: { seconds: 1, tokens: 0 } }));
		assert.equal(
			validateCampaign({ ...c, model: { ...c.model, endpoint: 'http://[::1]:9999/v1/chat/completions' } }).version,
			1
		);
	} finally {
		f.cleanup();
	}
});
test('patches are strict replacements and reject self-acceptance, evaluator writes, traversal, duplicates, collisions and links', () => {
	const f = fixture(),
		root = f.config.repository;
	try {
		for (const patch of [
			{ accepted: true, files: [] },
			{ files: [{ path: '../outside', content: 'x' }] },
			{ files: [{ path: 'tools/verifier.mjs', content: 'x' }] },
			{
				files: [
					{ path: 'app.js', content: 'one' },
					{ path: 'app.js', content: 'two' }
				]
			},
			{
				files: [
					{ path: 'new', content: 'x' },
					{ path: 'new/child', content: 'x' }
				]
			},
			{ files: [{ path: 'app.js', content: 'x\0y' }] }
		])
			assert.throws(() => applyModelFiles(root, patch, ['app.js', 'new', 'new/', 'tools/']));
		assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'original');
		assert.equal(fs.existsSync(path.join(root, 'new')), false);
		fs.symlinkSync(path.join(root, 'app.js'), path.join(root, 'link'));
		assert.throws(() => applyModelFiles(root, { files: [{ path: 'link', content: 'x' }] }, ['link']));
		fs.unlinkSync(path.join(root, 'link'));
		fs.linkSync(path.join(root, 'app.js'), path.join(root, 'hard'));
		assert.throws(() => applyModelFiles(root, { files: [{ path: 'hard', content: 'x' }] }, ['hard']));
		fs.unlinkSync(path.join(root, 'hard'));
		assert.deepEqual(applyModelFiles(root, { files: [{ path: 'app.js', content: 'correct' }] }, ['app.js']), [
			'app.js'
		]);
	} finally {
		f.cleanup();
	}
});
test('immutable export ignores dirty worktree and rejects symlinks; cell order is seeded', () => {
	const f = fixture(),
		c = f.config;
	try {
		fs.writeFileSync(path.join(c.repository, 'app.js'), 'dirty');
		const target = path.join(f.root, 'export');
		exportCommit(c.repository, c.arms.original.commit, target);
		assert.equal(fs.readFileSync(path.join(target, 'app.js'), 'utf8'), 'original');
		assert.equal(fs.existsSync(path.join(target, '.git')), false);
		assert.ok(fs.statSync(target).mode & 0o004);
		assert.deepEqual(campaignOrder(c), campaignOrder(c));
		assert.equal(campaignOrder(c).length, 3);
		assert.notDeepEqual(
			campaignOrder({ ...c, repetitions: 2, seed: 92 }),
			campaignOrder({ ...c, repetitions: 2, seed: 91 })
		);
		fs.symlinkSync('/etc/passwd', path.join(c.repository, 'escape'));
		f.git('add', 'escape');
		f.git(
			'-c',
			'user.name=Fixture',
			'-c',
			'user.email=fixture@example.invalid',
			'-c',
			'core.hooksPath=/dev/null',
			'commit',
			'-qm',
			'Bad link'
		);
		assert.throws(() => exportCommit(c.repository, f.git('rev-parse', 'HEAD'), path.join(f.root, 'bad')), {
			rule: 'campaign-export'
		});
	} finally {
		f.cleanup();
	}
});
test('model adapter uses structured JSON, no credentials and redirect refusal; malformed/self-reported success cannot be a patch', async () => {
	const f = fixture(),
		model = f.config.model;
	try {
		let options;
		const valid = await requestLocalModel(model, [{ role: 'user', content: 'fixture' }], {
			fetchImpl: async (url, input) => {
				assert.equal(url.hostname, '127.0.0.1');
				options = input;
				return response(wire());
			}
		});
		assert.equal(options.redirect, 'error');
		assert.equal(options.credentials, 'omit');
		assert.deepEqual(Object.keys(options.headers), ['Content-Type']);
		assert.deepEqual(JSON.parse(options.body).response_format, { type: 'json_object' });
		assert.equal(valid.patch.files[0].path, 'app.js');
		const malformed = [
			wire({ accepted: true }),
			wire(undefined, { choices: [] }),
			wire(undefined, {
				choices: [{ message: { role: 'assistant', content: '```json\n{}\n```' }, finish_reason: 'stop' }]
			}),
			wire(undefined, { choices: [{ message: { role: 'assistant', content: '{}' }, finish_reason: 'length' }] }),
			wire(undefined, {
				choices: [{ message: { role: 'assistant', content: '{}', tool_calls: [{}] }, finish_reason: 'stop' }]
			})
		];
		for (const value of malformed)
			await assert.rejects(
				requestLocalModel(model, [{ role: 'user', content: 'fixture' }], { fetchImpl: async () => response(value) })
			);
		await assert.rejects(
			requestLocalModel(model, [{ role: 'user', content: 'fixture' }], {
				fetchImpl: async () => ({ ok: true, redirected: true, url: 'http://evil.example' })
			}),
			{ rule: 'model-endpoint' }
		);
		await assert.rejects(
			requestLocalModel({ ...model, responseBytes: 10 }, [{ role: 'user', content: 'fixture' }], {
				fetchImpl: async () => response(wire())
			}),
			{ rule: 'model-output' }
		);
		await assert.rejects(
			requestLocalModel(model, [{ role: 'user', content: 'fixture' }], {
				fetchImpl: async () => new Response('bad', { status: 503 })
			}),
			{ rule: 'model-http' }
		);
	} finally {
		f.cleanup();
	}
});
test('absent runtime blocks before any model call or export, without an unsandboxed fallback', async () => {
	const f = fixture();
	try {
		let calls = 0;
		const result = await runCampaign(f.config, {
			runtime: {
				spawnSync() {
					return { status: null, error: new Error('ENOENT') };
				}
			},
			fetchImpl: async () => {
				calls++;
				assert.fail('model must not be contacted');
			}
		});
		assert.equal(result.status, 'blocked');
		assert.equal(result.rule, 'sandbox-unavailable');
		assert.equal(result.modelCalls, 0);
		assert.equal(calls, 0);
		assert.deepEqual(fs.readdirSync(f.config.output), []);
	} finally {
		f.cleanup();
	}
});
test('controlled E2E three-arm campaign repairs failures with bounded diagnostics and independent verified evidence', async () => {
	const f = fixture(),
		c = f.config;
	try {
		const sent = [],
			mock = mockRuntime(c, { failOnce: true });
		let calls = 0;
		const result = await runCampaign(c, {
			runtime: mock,
			fetchImpl: async (url, options) => {
				calls++;
				const body = JSON.parse(options.body);
				sent.push(body);
				return response(wire({ files: [{ path: 'app.js', content: body.messages.length > 2 ? 'correct' : 'wrong' }] }));
			}
		});
		assert.equal(result.status, 'completed');
		assert.equal(result.fixture, true);
		assert.equal(result.modelCalls, 6);
		assert.equal(calls, 6);
		assert.equal(result.cells.length, 3);
		assert.ok(
			result.cells.every(
				(cell) => cell.accepted && cell.attempts.length === 2 && !cell.attempts[0].passed && cell.attempts[1].passed
			)
		);
		assert.ok(result.summary.every((arm) => arm.accepted === 1 && arm.firstAttempt === 0));
		const repair = sent.find((body) => body.messages.length > 2);
		const feedback = JSON.parse(repair.messages.at(-1).content);
		assert.equal(feedback.currentFiles[0].content, 'wrong');
		assert.ok(feedback.failedChecks[0].diagnostic.includes('Expected correct'));
		assert.ok(!feedback.failedChecks[0].diagnostic.includes('\x1b'));
		assert.ok(result.budget.reservedTokens > result.budget.reportedTokens);
		assert.equal(result.budget.reportedTokens, 120);
		assert.equal(result.cells[0].attempts[0].costUsd, null);
		const saved = JSON.parse(fs.readFileSync(path.join(c.output, c.id, 'results.json')));
		assert.deepEqual(saved, result);
		await assert.rejects(runCampaign(c, { runtime: mock }), { rule: 'campaign-exists' });
	} finally {
		f.cleanup();
	}
});
test('model self-report, empty exit-zero verifier and mutation never produce acceptance', async () => {
	for (const mode of ['self-report', 'exit-zero', 'mutation']) {
		const f = fixture(),
			c = f.config;
		try {
			const mock = mockRuntime(c, {
				exitOnly: mode === 'exit-zero',
				mutate:
					mode === 'mutation'
						? ({ verifier }) => fs.writeFileSync(path.join(verifier, 'changed'), 'untrusted')
						: undefined
			});
			const result = await runCampaign(c, {
				runtime: mock,
				fetchImpl: async () =>
					response(
						wire(
							mode === 'self-report' ? { accepted: true, files: [{ path: 'app.js', content: 'correct' }] } : undefined
						)
					)
			});
			assert.equal(result.status, 'blocked');
			assert.ok(result.cells.every((cell) => !cell.accepted));
			assert.equal(result.modelCalls, 1);
			assert.ok(result.summary.every((arm) => arm.accepted === 0));
		} finally {
			f.cleanup();
		}
	}
});
test('cumulative token budget, missing usage and pre-cancellation stop further calls', async () => {
	for (const mode of ['budget', 'usage', 'cancel']) {
		const f = fixture(),
			c = f.config;
		try {
			if (mode === 'budget') c.budget.tokens = 900;
			const abort = new AbortController();
			if (mode === 'cancel') abort.abort();
			let calls = 0;
			const result = await runCampaign(c, {
				runtime: mockRuntime(c),
				signal: abort.signal,
				fetchImpl: async () => {
					calls++;
					return response(wire(undefined, mode === 'usage' ? { usage: null } : {}));
				}
			});
			assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'blocked');
			if (mode === 'cancel') assert.equal(calls, 0);
			else if (mode === 'usage') {
				assert.equal(calls, 1);
				assert.equal(result.blockedReason, 'campaign-usage');
			} else {
				assert.ok(calls < 3);
				assert.equal(result.blockedReason, 'campaign-token-budget');
				assert.ok(result.budget.reservedTokens <= c.budget.tokens);
			}
		} finally {
			f.cleanup();
		}
	}
});

test('campaign deadline cancels an in-flight provider and persists a blocked terminal result', async () => {
	const f = fixture(),
		c = f.config;
	c.budget.seconds = 1;
	let calls = 0;
	try {
		const result = await runCampaign(c, {
			runtime: mockRuntime(c),
			fetchImpl: async (url, options) => {
				calls++;
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => resolve(response(wire())), 2000);
					options.signal.addEventListener(
						'abort',
						() => {
							clearTimeout(timer);
							reject(options.signal.reason);
						},
						{ once: true }
					);
				});
			}
		});
		assert.equal(calls, 1);
		assert.equal(result.status, 'blocked');
		assert.equal(result.blockedReason, 'campaign-time-budget');
		assert.ok(result.budget.elapsedSeconds >= 0.9);
		assert.ok(result.cells.every((cell) => !cell.accepted));
		assert.equal(JSON.parse(fs.readFileSync(path.join(c.output, c.id, 'results.json'))).status, 'blocked');
	} finally {
		f.cleanup();
	}
});
test('context corruption fails closed and persists a terminal result before any provider call', async () => {
	const f = fixture(),
		c = f.config;
	c.tasks[0].context.original = ['missing.js'];
	c.tasks[0].context.docs = ['missing.js'];
	c.tasks[0].context.contracts = ['missing.js'];
	try {
		const result = await runCampaign(c, {
			runtime: mockRuntime(c),
			fetchImpl: async () => assert.fail('must not call model')
		});
		assert.equal(result.status, 'blocked');
		assert.equal(result.blockedReason, 'missing-file');
		assert.equal(result.modelCalls, 0);
		assert.equal(JSON.parse(fs.readFileSync(path.join(c.output, c.id, 'results.json'))).status, 'blocked');
	} finally {
		f.cleanup();
	}
});

test('direct loopback HTTP transport handles only a controlled fixture, never follows redirects or sends credentials', async () => {
	const { createServer } = await import('node:http');
	const { once } = await import('node:events');
	const f = fixture();
	let requests = 0;
	const server = createServer((request, res) => {
		requests++;
		assert.equal(request.headers.authorization, undefined);
		assert.equal(request.headers.cookie, undefined);
		if (requests === 1) {
			res.writeHead(302, { location: 'http://127.0.0.1:1/forbidden' });
			res.end();
		} else {
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify(wire()));
		}
	});
	try {
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const model = { ...f.config.model, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions` };
		await assert.rejects(requestLocalModel(model, [{ role: 'user', content: 'controlled fixture, not a model' }]), {
			rule: 'model-http'
		});
		const result = await requestLocalModel(model, [{ role: 'user', content: 'controlled fixture, not a model' }]);
		assert.equal(result.patch.files[0].content, 'correct');
		assert.equal(requests, 2);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		f.cleanup();
	}
});

test('campaign refuses credential paths even when a task explicitly requests them', () => {
	const f = fixture();
	try {
		for (const name of ['.env', 'config/secrets.json', '.ssh/id_rsa', 'private.key']) {
			const config = structuredClone(f.config);
			config.tasks[0].context.original = [name];
			assert.throws(() => validateCampaign(config), /Credential/);
		}
		const config = structuredClone(f.config);
		config.tasks[0].allowedPaths = ['.env'];
		assert.throws(() => validateCampaign(config), /authorize/);
	} finally {
		f.cleanup();
	}
});
