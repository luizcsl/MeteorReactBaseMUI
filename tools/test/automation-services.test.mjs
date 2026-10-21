import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { renderServices, validateServices } from '../automation/generators/services.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const definition = {
	schemaVersion: 1,
	name: 'invoices',
	profile: 'owner',
	fields: [
		{ name: 'title', label: 'Title', type: 'string', required: true, maxLength: 160 },
		{ name: 'amount', label: 'Amount', type: 'integer', required: true, min: 0, max: 100000 },
		{ name: 'done', label: 'Done', type: 'boolean', required: true }
	],
	filters: ['done'],
	states: ['active'],
	transitions: [],
	permissions: { read: ['owner'], write: ['owner'] }
};
async function load(file) {
	const b = await build({
		entryPoints: [path.join(root, file)],
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false
	});
	return import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));
}
const runtime = await load('imports/automationServices/server/runtime.ts'),
	jobs = await load('imports/automationServices/server/jobs.ts'),
	api = await load('imports/automationServices/server/api.ts');
function fixture() {
	const records = new Map();
	const effects = [];
	const ports = {
		resolveIdentity: async (userId) => ({ userId, roles: [] }),
		repository: {
			find: async (scope, id) => {
				const r = records.get(id);
				return r && (!scope.ownerId || r.ownerId === scope.ownerId) && (r.tenantId ?? null) === scope.tenantId
					? r
					: null;
			},
			list: async (scope, _filters, limit) =>
				[...records.values()].filter((r) => r.ownerId === scope.ownerId).slice(0, limit),
			insert: async (r) => {
				effects.push(r);
				if (!records.has(r._id)) records.set(r._id, r);
				return records.get(r._id);
			},
			compareAndSet: async () => false,
			remove: async () => false
		}
	};
	records.set('doc', {
		_id: 'doc',
		ownerId: 'alice',
		version: 1,
		state: 'active',
		deleted: false,
		data: { title: 'Hello', amount: 10, done: false }
	});
	return { ports, records, effects };
}
const services = {
	attachments: { maxBytes: 1024, mimeTypes: ['application/pdf'] },
	csv: { fields: ['title', 'amount', 'done'], maxRows: 10 },
	notifications: { events: ['created'], subjectTemplate: 'New {{title}}', textTemplate: 'Amount {{amount}}' },
	jobs: { maxAttempts: 3, leaseMs: 1000 },
	search: { fields: ['done'], pageSize: 2 },
	audit: { events: ['updated'], retentionDays: 30 },
	reports: {
		metrics: [
			{ name: 'total', op: 'sum', field: 'amount' },
			{ name: 'count', op: 'count' }
		]
	}
};
test('services render deterministic map, server-only runtime and explicit integration blockers', async () => {
	assert.deepEqual(renderServices({ definition, services }), renderServices({ definition, services }));
	const files = renderServices({ definition, services });
	assert.match(files['imports/modules/invoices/generated/services/server/create.ts'], /attachmentService/);
	assert.equal(
		JSON.parse(files['imports/modules/invoices/generated/services/integration.json']).status,
		'needs-integration'
	);
	for (const [file, contents] of Object.entries(files).filter(([file]) => file.endsWith('.ts')))
		await build({
			stdin: { contents, loader: 'ts', resolveDir: root },
			bundle: true,
			write: false,
			platform: 'node',
			external: ['*']
		});
});
test('strict schema denies unknown variants, unsafe fields, excessive limits and malformed objects', () => {
	for (const s of [
		{ xlsx: { fields: ['title'] } },
		{ csv: { fields: ['title', 'amount', 'done'], maxRows: 10001 } },
		{ attachments: { maxBytes: 1, mimeTypes: ['image/svg+xml'] } },
		{ reports: { metrics: [{ name: 'leak', op: 'sum', field: 'ownerId' }] } },
		{ notifications: { events: ['created'], subjectTemplate: '{{ownerId}}', textTemplate: 'x' } },
		{ jobs: null },
		{ jobs: { maxAttempts: 2, leaseMs: 1000, adapter: 'memory' } }
	])
		assert.throws(() => validateServices(s, definition));
	const accessor = {};
	Object.defineProperty(accessor, 'jobs', {
		get() {
			throw new Error('getter executed');
		}
	});
	assert.throws(() => validateServices(accessor, definition), /unknown/);
});
test('CSV parser handles quoting, newlines and rejects malformed rows and row excess', () => {
	assert.deepEqual(runtime.parseCsv('a,b\r\n"x,y","line\nnext"\r\n', ['a', 'b'], 1), [['x,y', 'line\nnext']]);
	for (const text of ['a,b\n1', 'a,b\n"x', 'a,b\n"x"oops,2', 'a,b\n1,2\n3,4'])
		assert.throws(() => runtime.parseCsv(text, ['a', 'b'], 1));
});
test('CSV import validates all rows before writes; retries use recipe idempotency and export escapes formula injection', async () => {
	const { ports, effects, records } = fixture();
	const csv = runtime.csvService(definition, services.csv, ports);
	await assert.rejects(csv.import('alice', 'title,amount,done\nA,10,false\nB,bad,false', 'run'));
	assert.equal(effects.length, 0);
	const text = 'title,amount,done\nA,10,false';
	assert.deepEqual(await csv.import('alice', text, 'run'), { completed: 1, total: 1, failedRow: null });
	await csv.import('alice', text, 'run');
	assert.equal(records.size, 2);
	records.get('doc').data.title = '=EVIL()';
	assert.match(await csv.export('alice'), /"'=EVIL\(\)"/);
	await assert.rejects(csv.import(null, text, 'run'));
});
test('private attachments enforce scope, linked permission, bounds and compensation', async () => {
	const { ports } = fixture();
	const calls = [];
	let linked = false;
	const store = {
		putPrivate: async () => {
			calls.push('put');
			return { id: 'file' };
		},
		removePrivate: async () => {
			calls.push('remove');
		},
		canReadFile: async (user) => user === 'alice',
		linked: async () => linked,
		link: async () => {
			linked = true;
			return true;
		},
		readPrivate: async () => new Uint8Array([1])
	};
	const svc = runtime.attachmentService(definition, services.attachments, ports, store);
	const input = { documentId: 'doc', bytes: new Uint8Array([1]), mimeType: 'application/pdf', name: 'a.pdf' };
	await assert.rejects(svc.upload('bob', input));
	assert.deepEqual(calls, []);
	await svc.upload('alice', input);
	assert.deepEqual(await svc.download('alice', { documentId: 'doc', fileId: 'file' }), new Uint8Array([1]));
	await assert.rejects(svc.download('bob', { documentId: 'doc', fileId: 'file' }));
	await assert.rejects(svc.upload('alice', { ...input, name: '../a.pdf' }));
	linked = false;
	await assert.rejects(svc.download('alice', { documentId: 'doc', fileId: 'file' }));
	store.link = async () => false;
	await assert.rejects(svc.upload('alice', input));
	assert.deepEqual(calls, ['put', 'put', 'remove']);
});
test('notifications use scoped recipients, projected template and stable provider idempotency', async () => {
	const { ports } = fixture();
	const sent = [];
	const svc = runtime.notificationService(definition, services.notifications, ports, {
		recipients: async (scope) => {
			assert.equal(scope.ownerId, 'alice');
			return ['alice', 'alice'];
		},
		send: async (item) => sent.push(item)
	});
	await svc.emit('alice', 'created', 'doc', 'event');
	await svc.emit('alice', 'created', 'doc', 'event');
	assert.equal(sent.length, 2);
	assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey);
	assert.equal(sent[0].subject, 'New Hello');
	await assert.rejects(svc.emit('bob', 'created', 'doc', 'event'));
	await assert.rejects(svc.emit('alice', 'arbitrary', 'doc', 'event'));
});
test('cursor scope/filter binding cannot cross users and search output excludes secrets', async () => {
	const { ports } = fixture();
	let selector;
	const query = {
		find: async (s, o) => {
			selector = s;
			assert.equal(o.limit, 3);
			return ['a', 'b', 'c'].map((_id) => ({
				_id,
				version: 1,
				state: 'active',
				data: { title: 'Hi', amount: 10, done: false },
				secret: 'x'
			}));
		},
		aggregate: async () => []
	};
	const svc = runtime.searchService(definition, services.search, ports, query);
	const result = await svc.page('alice', { filters: { done: false } });
	assert.equal(selector.ownerId, 'alice');
	assert.equal(selector.deleted, false);
	assert.equal(result.items.length, 2);
	assert.equal(result.items[0].secret, undefined);
	await assert.rejects(svc.page('bob', { filters: { done: false }, cursor: result.nextCursor }));
	await assert.rejects(svc.page('alice', { filters: { done: true }, cursor: result.nextCursor }));
	await assert.rejects(svc.page('alice', { filters: { $where: '1' } }));
	await svc.page('alice', { filters: { done: false }, cursor: result.nextCursor });
	assert.deepEqual(selector._id, { $gt: 'b' });
});
test('reports apply owner/deleted scope before aggregation and project only metrics', async () => {
	const { ports } = fixture();
	let pipeline;
	const report = runtime.reportService(definition, services.reports, ports, {
		find: async () => [],
		aggregate: async (p) => {
			pipeline = p;
			return [{ total: 20, count: 2, secret: 100 }];
		}
	});
	assert.deepEqual(await report.run('alice'), { total: 20, count: 2 });
	assert.deepEqual(pipeline[0], { $match: { ownerId: 'alice', tenantId: null, deleted: false } });
	await assert.rejects(report.run(null));
});
test('audit history requires document access and retention is explicit', async () => {
	const { ports } = fixture();
	const events = [];
	const audit = runtime.auditService(definition, services.audit, ports, {
		append: async (r) => events.push(r),
		list: async () => events
	});
	await audit.append('alice', 'updated', 'doc', { title: 'Hi', amount: 20, done: true });
	assert.equal(events[0].expiresAt - events[0].at, 30 * 86400000);
	await assert.rejects(audit.history('bob', 'doc'));
	const history = await audit.history('alice', 'doc');
	assert.equal(history[0].scope, undefined);
	assert.equal(history[0].expiresAt, undefined);
});
function durableFixture() {
	const rows = new Map();
	const selectors = [];
	const match = (row, s) =>
		Object.entries(s).every(([k, v]) =>
			k === '$or'
				? v.some((x) => match(row, x))
				: v && typeof v === 'object' && !(v instanceof Date)
					? Object.entries(v).every(([op, b]) =>
							op === '$lte'
								? row[k] <= b
								: op === '$lt'
									? row[k] < b
									: op === '$gte'
										? row[k] >= b
										: op === '$gt'
											? row[k] > b
											: false
						)
					: row[k] === v
		);
	const apply = (r, u) => {
		Object.assign(r, u.$set);
		for (const [k, v] of Object.entries(u.$inc ?? {})) r[k] += v;
	};
	return {
		rows,
		selectors,
		collection: {
			createIndex: async () => {},
			findOne: async (s) => rows.get(s._id) ?? null,
			updateOne: async (s, u, o) => {
				selectors.push(s);
				let r = [...rows.values()].find((r) => match(r, s));
				if (!r && o?.upsert) {
					r = structuredClone(u.$setOnInsert);
					rows.set(r._id, r);
					return { matchedCount: 0, upsertedCount: 1 };
				}
				if (!r) return { matchedCount: 0 };
				apply(r, u);
				return { matchedCount: 1 };
			},
			findOneAndUpdate: async (s, u) => {
				selectors.push(s);
				const r = [...rows.values()].find((r) => match(r, s));
				if (!r) return null;
				apply(r, u);
				return structuredClone(r);
			}
		}
	};
}
test('durable queue requires initialization, persists idempotency, retries and recovers expired leases', async () => {
	const f = durableFixture();
	const q = jobs.durableJobs({ maxAttempts: 3, leaseMs: 1000 }, f.collection);
	await assert.rejects(q.enqueue('key', { a: 1 }));
	await q.initialize();
	await q.enqueue('key', { a: 1 }, new Date(0));
	await q.enqueue('key', { a: 1 });
	await assert.rejects(q.enqueue('key', { a: 2 }), /conflict/);
	let count = 0;
	assert.equal((await q.runOne(async () => count++, new Date(0))).status, 'done');
	assert.equal(count, 1);
	assert.equal((await q.runOne(async () => count++)).status, 'idle');
	await q.enqueue('recover', { a: 2 }, new Date(0));
	Object.assign(f.rows.get('recover'), { state: 'running', attempts: 1, leaseUntil: new Date(1), leaseToken: 'stale' });
	assert.equal(
		(
			await q.runOne(async (_p, c) => {
				assert.equal(c.idempotencyKey, 'recover');
				assert.notEqual(c.leaseToken, 'stale');
			}, new Date(2))
		).status,
		'done'
	);
	assert.equal(f.rows.get('recover').attempts, 2);
});
test('durable completion fences stale workers; failed handlers requeue and exhausted crashes terminate', async () => {
	const f = durableFixture();
	const q = jobs.durableJobs({ maxAttempts: 2, leaseMs: 1000 }, f.collection);
	await q.initialize();
	await q.enqueue('key', {});
	assert.equal(
		(
			await q.runOne(async () => {
				f.rows.get('key').leaseToken = 'new-worker';
			})
		).status,
		'lease-lost'
	);
	Object.assign(f.rows.get('key'), { leaseUntil: new Date(0), attempts: 2 });
	await q.runOne(async () => {});
	assert.equal(f.rows.get('key').state, 'failed');
	await q.enqueue('retry', {});
	assert.equal(
		(
			await q.runOne(async () => {
				throw new Error('oops');
			})
		).status,
		'retry-or-failed'
	);
	assert.equal(f.rows.get('retry').state, 'pending');
	assert.equal(await q.renew('retry', 'wrong'), false);
});
const objectSchema = (name) => ({
	type: 'object',
	properties: { [name]: { type: 'string' } },
	required: [name],
	additionalProperties: false
});
const openapi = {
	openapi: '3.0.3',
	info: { title: 'Example', version: '1' },
	servers: [{ url: 'https://api.example.com' }],
	paths: {
		'/items': {
			post: {
				operationId: 'createItem',
				requestBody: { required: true, content: { 'application/json': { schema: objectSchema('title') } } },
				responses: {
					'201': { description: 'Created', content: { 'application/json': { schema: objectSchema('id') } } }
				}
			}
		}
	}
};
test('OpenAPI generates bounded typed client; unsupported refs and URL forms fail closed', () => {
	const files = renderServices({ definition, services: { api: { openapi } } });
	const source = files['imports/modules/invoices/generated/services/server/api.ts'];
	assert.match(source, /export type createItemInput/);
	assert.match(source, /Promise<createItemOutput>/);
	for (const url of [
		'http://api.example.com',
		'https://localhost',
		'https://127.0.0.1',
		'https://user:password@api.example.com'
	]) {
		const copy = structuredClone(openapi);
		copy.servers[0].url = url;
		assert.throws(() => validateServices({ api: { openapi: copy } }, definition));
	}
	const copy = structuredClone(openapi);
	copy.paths['/items'].post.requestBody.content['application/json'].schema = { $ref: '#/components/x' };
	assert.throws(() => validateServices({ api: { openapi: copy } }, definition));
});
test('API client validates request and response, fixes destination and masks transport errors', async () => {
	const operation = {
		id: 'list',
		method: 'GET',
		path: '/items',
		input: null,
		output: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
		status: 200
	};
	const client = api.externalClient(
		'https://api.example.com',
		[operation],
		api.mockTransport({ 'GET https://api.example.com/items': { status: 200, body: { id: 'one' } } })
	);
	assert.deepEqual(await client.call('list', null), { id: 'one' });
	await assert.rejects(client.call('list', {}));
	const failure = api.externalClient('https://api.example.com', [operation], {
		request: async () => {
			throw new Error('secret-token');
		}
	});
	await assert.rejects(
		failure.call('list', null),
		(e) => e.kind === 'transport' && !e.message.includes('secret-token')
	);
	assert.throws(() => api.parseApi(operation.output, { id: 'one', secret: 'token' }));
});
test('dependency automation only produces explicit approval recipe; no package mutation', () => {
	const before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
	const files = renderServices({
		definition,
		services: { dependencies: { updates: [{ name: 'test-package', from: '1.0.0', to: '2.0.0' }] } }
	});
	const review = JSON.parse(files['imports/modules/invoices/generated/services/dependency-review.json']);
	assert.equal(review.automaticInstall, false);
	assert.equal(review.status, 'needs-review');
	assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before);
	assert.throws(
		() =>
			renderServices(
				{ definition, services: { dependencies: { updates: [{ name: 'test-package', from: '1.0.0', to: '2.0.0' }] } } },
				root
			),
		/precondition/
	);
});
test('emitted server factories execute against real helper imports, not template-only assertions', async () => {
	const files = renderServices({ definition, services });
	const filename = 'imports/modules/invoices/generated/services/server/create.ts';
	const result = await build({
		stdin: { contents: files[filename], loader: 'ts', resolveDir: path.dirname(path.join(root, filename)) },
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		plugins: [
			{
				name: 'fixture-definition',
				setup(b) {
					b.onResolve({ filter: /automationServices\/server\// }, (args) => {
						const resolved = path.resolve(path.dirname(path.join(root, filename)), args.path) + '.ts';
						assert.ok(fs.existsSync(resolved), resolved);
						return { path: resolved };
					});
					b.onResolve({ filter: /^\.\.\/\.\.\/definition$/ }, () => ({ path: 'definition', namespace: 'fixture' }));
					b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
						contents: 'export const definition = ' + JSON.stringify(definition) + ';',
						loader: 'ts'
					}));
				}
			}
		]
	});
	const emitted = await import(
		'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
	);
	const { ports } = fixture();
	const csv = emitted.createCsv(ports);
	assert.deepEqual(csv.parse('title,amount,done\nA,10,true'), [{ title: 'A', amount: 10, done: true }]);
	const reports = emitted.createReports(ports, {
		find: async () => [],
		aggregate: async () => [{ total: 25, count: 1 }]
	});
	assert.deepEqual(await reports.run('alice'), { total: 25, count: 1 });
	await assert.rejects(reports.run(null));
});
test('optional service and OpenAPI fields reject explicit null instead of silently omitting them', () => {
	for (const key of [
		'attachments',
		'csv',
		'notifications',
		'jobs',
		'search',
		'audit',
		'api',
		'reports',
		'dependencies'
	])
		assert.throws(() => validateServices({ [key]: null }, definition));
	for (const body of [null, false, 0, '']) {
		const spec = structuredClone(openapi);
		spec.paths['/items'].post.requestBody = body;
		assert.throws(() => validateServices({ api: { openapi: spec } }, definition));
	}
	for (const key of ['required', 'properties', 'additionalProperties']) {
		const spec = structuredClone(openapi);
		spec.paths['/items'].post.requestBody.content['application/json'].schema[key] = null;
		assert.throws(() => validateServices({ api: { openapi: spec } }, definition));
	}
	for (const schema of [
		{ type: 'string', maxLength: null },
		{ type: 'array', items: null, maxItems: 10 },
		{ type: 'array', items: { type: 'string' }, maxItems: null }
	]) {
		const spec = structuredClone(openapi);
		spec.paths['/items'].post.requestBody.content['application/json'].schema = schema;
		assert.throws(() => validateServices({ api: { openapi: spec } }, definition));
	}
	assert.throws(() =>
		validateServices({ reports: { metrics: [{ name: 'count', op: 'count', field: null }] } }, definition)
	);
});
test('generated report dashboard strictly typechecks, validates metrics and renders accessible loading state without transport', async () => {
	const files = renderServices({ definition, services: { reports: services.reports } });
	const source = files['imports/modules/invoices/generated/services/ReportDashboard.tsx'];
	assert.ok(source);
	const filename = path.join(root, '__automation_services_dashboard__.tsx');
	const options = {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.Preserve,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		esModuleInterop: true,
		skipLibCheck: true,
		noEmit: true,
		jsx: ts.JsxEmit.ReactJSX
	};
	const host = ts.createCompilerHost(options);
	const read = host.readFile.bind(host),
		exists = host.fileExists.bind(host),
		getSource = host.getSourceFile.bind(host);
	host.readFile = (file) => (file === filename ? source : read(file));
	host.fileExists = (file) => file === filename || exists(file);
	host.getSourceFile = (file, language, onError, shouldCreate) =>
		file === filename
			? ts.createSourceFile(file, source, language, true, ts.ScriptKind.TSX)
			: getSource(file, language, onError, shouldCreate);
	const program = ts.createProgram([filename], options, host);
	const diagnostics = ts.getPreEmitDiagnostics(program);
	assert.equal(
		diagnostics.length,
		0,
		ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCurrentDirectory: () => root,
			getCanonicalFileName: (x) => x,
			getNewLine: () => '\n'
		})
	);
	const compiled = await build({
		stdin: { contents: source, loader: 'tsx', resolveDir: root },
		bundle: true,
		platform: 'node',
		format: 'cjs',
		packages: 'external',
		write: false
	});
	const require = createRequire(path.join(root, 'package.json'));
	const module = { exports: {} };
	new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
	const dashboard = module.exports;
	assert.deepEqual(dashboard.validateMetricMap({ total: 10, count: 2 }), { total: 10, count: 2 });
	for (const invalid of [
		{ total: 10 },
		{ total: 10, count: 2, secret: 1 },
		{ total: Infinity, count: 2 },
		{ total: Number.MAX_SAFE_INTEGER + 1, count: 1 },
		null
	])
		assert.throws(() => dashboard.validateMetricMap(invalid));
	const accessor = { count: 1 };
	Object.defineProperty(accessor, 'total', {
		enumerable: true,
		get() {
			throw new Error('getter should not execute');
		}
	});
	assert.throws(() => dashboard.validateMetricMap(accessor), /Invalid report/);
	let calls = 0;
	const markup = require('react-dom/server').renderToStaticMarkup(
		require('react').createElement(dashboard.default, {
			scopeKey: 'alice',
			load: async () => {
				calls++;
				return { total: 10, count: 2 };
			}
		})
	);
	assert.match(markup, /Loading report/);
	assert.match(markup, /aria-busy="true"/);
	assert.equal(calls, 0);
	assert.match(source, /cancelled = true/);
	assert.match(source, /if \(!cancelled\)/);
	assert.match(source, /state.scopeKey === scopeKey/);
	assert.match(source, /\[scopeKey, load, refresh\]/);
	assert.match(source, /No activity for this selection/);
	assert.match(source, /Unable to load this report/);
	assert.doesNotMatch(source, /Meteor\.call|fetch\(|server\//);
});
test('generated strict service registration and client round-trip use the shared transports and deny unauthorized actors', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-composition-'));
	try {
		const generated = renderServices({ definition, services });
		generated['imports/modules/invoices/generated/definition.ts'] =
			"import {validateDefinition} from '../../../core/recipes/definition'; export const definition=validateDefinition(" +
			JSON.stringify(definition) +
			');';
		for (const [name, source] of Object.entries(generated)) {
			const target = path.join(dir, name);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, source);
		}
		for (const name of ['core', 'automationServices', 'api'])
			fs.symlinkSync(path.join(root, 'imports', name), path.join(dir, 'imports', name), 'dir');
		fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
		const options = {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.Preserve,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			strict: true,
			esModuleInterop: true,
			skipLibCheck: true,
			noEmit: true,
			jsx: ts.JsxEmit.ReactJSX
		};
		const program = ts.createProgram(
			Object.keys(generated)
				.filter((name) => /\.tsx?$/.test(name))
				.map((name) => path.join(dir, name)),
			options
		);
		const diagnostics = ts.getPreEmitDiagnostics(program);
		assert.equal(
			diagnostics.length,
			0,
			ts.formatDiagnosticsWithColorAndContext(diagnostics, {
				getCurrentDirectory: () => root,
				getCanonicalFileName: (x) => x,
				getNewLine: () => '\n'
			})
		);
		const methods = {},
			limits = [],
			seen = [];
		let actor = 'alice',
			connected = true;
		class MeteorError extends Error {
			constructor(error, reason) {
				super(reason);
				this.error = error;
			}
		}
		const Meteor = {
			isServer: true,
			Error: MeteorError,
			methods: (input) => Object.assign(methods, input),
			status: () => ({ connected }),
			call(name, input, callback) {
				seen.push(name);
				Promise.resolve()
					.then(() => methods[name].call({ userId: actor }, input))
					.then(
						(value) => callback(undefined, value),
						(error) => callback(error)
					);
			}
		};
		const require = createRequire(path.join(root, 'package.json'));
		async function evaluate(relative) {
			const out = await build({
				entryPoints: [path.join(dir, relative)],
				bundle: true,
				platform: 'node',
				format: 'cjs',
				external: ['meteor/*'],
				write: false
			});
			const module = { exports: {} };
			new Function('require', 'module', 'exports', out.outputFiles[0].text)(
				(name) =>
					name === 'meteor/meteor'
						? { Meteor }
						: name === 'meteor/ddp-rate-limiter'
							? { DDPRateLimiter: { addRule: (...args) => limits.push(args) } }
							: require(name),
				module,
				module.exports
			);
			return module.exports;
		}
		const registration = await evaluate('imports/modules/invoices/generated/services/server/register.ts');
		const { ports, records } = fixture();
		const sent = [];
		const adapters = {
			query: {
				find: async (selector, options) =>
					[...records.values()].filter((r) => r.ownerId === selector.ownerId).slice(0, options.limit),
				aggregate: async (pipeline) => [
					{
						count: [...records.values()].filter((r) => r.ownerId === pipeline[0].$match.ownerId).length,
						total: pipeline[0].$match.ownerId === 'alice' ? 10 : 0
					}
				]
			},
			audit: {
				append: async () => {},
				list: async () => [
					{
						actorId: 'alice',
						event: 'updated',
						at: new Date('2026-01-01T00:00:00Z'),
						changes: { title: 'Hi', amount: 10, done: false }
					}
				]
			},
			attachments: {
				putPrivate: async () => ({ id: 'file' }),
				removePrivate: async () => {},
				canReadFile: async (user) => user === 'alice',
				linked: async () => true,
				link: async () => true,
				readPrivate: async () => new Uint8Array([1, 2])
			},
			notifications: { recipients: async () => ['alice'], send: async (item) => sent.push(item) }
		};
		assert.throws(() => registration.registerServices(ports, {}), /Missing approved/);
		assert.equal(Object.keys(methods).length, 0);
		registration.registerServices(ports, adapters);
		assert.equal(Object.keys(methods).length, 8);
		assert.equal(limits.length, 16);
		assert.throws(() => registration.registerServices(ports, adapters), /already/);
		const client = (await evaluate('imports/modules/invoices/generated/services/client.ts')).createServiceClient();
		assert.deepEqual(await client.report({ filters: {} }), { total: 10, count: 1 });
		const page = await client.search({ filters: {}, cursor: null, limit: 2, order: 'asc' });
		assert.equal(page.items[0].parentId, null);
		assert.equal(page.items[0].id, 'doc');
		assert.equal(page.items[0].ownerId, undefined);
		assert.equal((await client.history({ documentId: 'doc' }))[0].at, '2026-01-01T00:00:00.000Z');
		assert.deepEqual(await client.downloadAttachment({ documentId: 'doc', fileId: 'file' }), new Uint8Array([1, 2]));
		assert.deepEqual(
			await client.uploadAttachment({
				documentId: 'doc',
				bytes: new Uint8Array([1]),
				mimeType: 'application/pdf',
				name: 'a.pdf'
			}),
			{ id: 'file' }
		);
		assert.equal((await client.notify({ event: 'created', documentId: 'doc', eventId: 'event' })).delivered, 1);
		assert.equal(sent.length, 1);
		assert.equal(
			(await client.importCsv({ text: 'title,amount,done\nNew,20,false', mutationPrefix: 'batch' })).completed,
			1
		);
		assert.match(await client.exportCsv({ filters: {} }), /New/);
		const priorCalls = seen.length;
		await assert.rejects(client.report({ filters: {}, ownerId: 'other' }));
		assert.equal(seen.length, priorCalls);
		await assert.rejects(
			methods['invoices.services.report'].call({ userId: 'alice' }, { filters: {}, ownerId: 'other' }),
			(error) => error.error === 'invalid-input'
		);
		actor = 'bob';
		await assert.rejects(
			client.downloadAttachment({ documentId: 'doc', fileId: 'file' }),
			(error) => error.error === 'not-found'
		);
		await assert.rejects(client.history({ documentId: 'doc' }), (error) => error.error === 'not-found');
		assert.deepEqual(await client.report({ filters: {} }), { total: 0, count: 0 });
		actor = null;
		await assert.rejects(client.report({ filters: {} }), (error) => error.error === 'unauthenticated');
		actor = 'alice';
		connected = false;
		await assert.rejects(client.report({ filters: {} }), (error) => error.error === 'offline');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
test('cursor limit and direction are bounded and bound into the cursor, including descending selector', async () => {
	const { ports } = fixture();
	const calls = [];
	const service = runtime.searchService(definition, { fields: ['done'], pageSize: 3 }, ports, {
		find: async (selector, options) => {
			calls.push({ selector, options });
			return ['z', 'y', 'x']
				.slice(0, options.limit)
				.map((_id) => ({ _id, version: 1, state: 'active', data: { title: 'row', amount: 1, done: false } }));
		},
		aggregate: async () => []
	});
	const page = await service.page('alice', { filters: {}, cursor: null, limit: 2, order: 'desc' });
	assert.equal(calls[0].options.sort._id, -1);
	assert.equal(calls[0].options.limit, 3);
	await service.page('alice', { filters: {}, cursor: page.nextCursor, limit: 2, order: 'desc' });
	assert.deepEqual(calls[1].selector._id, { $lt: 'y' });
	await assert.rejects(service.page('alice', { filters: {}, cursor: page.nextCursor, limit: 2, order: 'asc' }));
	await assert.rejects(service.page('alice', { filters: {}, cursor: page.nextCursor, limit: 1, order: 'desc' }));
	for (const input of [
		{ limit: 4, order: 'asc' },
		{ limit: 1, order: 'random' },
		{ limit: 1, order: { toString: () => 'asc' } }
	])
		await assert.rejects(service.page('alice', { filters: {}, cursor: null, ...input }));
});
