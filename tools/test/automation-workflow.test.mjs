import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import { renderWorkflow, validateWorkflow } from '../automation/generators/workflow.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const definition = {
	schemaVersion: 1,
	name: 'workflowcases',
	profile: 'owner',
	fields: [
		{ name: 'title', label: 'Title', type: 'string', required: true, maxLength: 100 },
		{ name: 'count', label: 'Count', type: 'integer', required: true, min: 0, max: 100 },
		{ name: 'amount', label: 'Amount', type: 'money', required: true, min: 0, max: 10000, currency: 'BRL', scale: 2 },
		{ name: 'ready', label: 'Ready', type: 'boolean', required: true },
		{ name: 'category', label: 'Category', type: 'enum', required: true, values: ['first', 'second'] },
		{ name: 'day', label: 'Day', type: 'date', required: true },
		{ name: 'optional', label: 'Optional', type: 'integer', required: false, min: 0, max: 100 }
	],
	filters: ['ready'],
	states: ['draft', 'approved', 'cancelled'],
	transitions: [
		{ from: 'draft', to: 'approved', roles: ['owner'] },
		{ from: 'draft', to: 'cancelled', roles: ['owner'] }
	],
	permissions: { read: ['owner'], write: ['owner'] }
};
const data = {
	title: 'Example',
	count: 10,
	amount: 2500,
	ready: true,
	category: 'first',
	day: '2026-10-21',
	optional: null
};
const epoch = new Date('2026-10-21T12:00:00.000Z');
const after = (ms) => new Date(epoch.getTime() + ms);
const record = (overrides = {}) => ({
	_id: 'doc',
	creationFingerprint: 'fingerprint',
	ownerId: 'alice',
	deleted: false,
	version: 1,
	state: 'draft',
	data: structuredClone(data),
	updatedAt: new Date(epoch),
	...overrides
});
const condition = (field = 'ready', op = 'eq', value = true) => ({ field, op, value });
const config = (rule = {}) => ({
	transitions: [{ from: 'draft', to: 'approved', conditions: [condition()], ...rule }]
});
const deadline = (mode = 'before', afterMs = 1000) => ({ anchor: 'updatedAt', afterMs, mode });
const code = (expected) => (error) => error.code === expected;
async function load(file) {
	const output = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false });
	return import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
}
const runtime = await load(path.join(root, 'imports/core/recipes/server/workflow.ts'));
const { recipeService } = await load(path.join(root, 'imports/core/recipes/server/engine.ts'));

test('workflow generator and typed runtime share strict validation and detach accepted configuration', () => {
	const raw = config(),
		accepted = validateWorkflow(raw, definition);
	assert.deepEqual(accepted, runtime.validateWorkflowConfig(raw, definition));
	raw.transitions[0].conditions[0].value = false;
	assert.equal(accepted.transitions[0].conditions[0].value, true);
	assert.deepEqual(
		renderWorkflow({ definition, workflow: accepted }),
		renderWorkflow({ definition, workflow: accepted })
	);
});

test('workflow DSL rejects expressions, arbitrary fields, timers, unknown properties and duplicate rules', () => {
	const invalid = [
		null,
		{},
		{ transitions: [] },
		{ transitions: new Array(1) },
		{ ...config(), scheduler: 'every minute' },
		{ transitions: [{ from: 'draft', to: 'approved' }] },
		config({ expression: 'process.exit()' }),
		config({ from: 'approved', to: 'draft' }),
		config({ conditions: [] }),
		config({ conditions: undefined }),
		config({ conditions: null }),
		config({ conditions: [condition('ownerId', 'eq', 'alice')] }),
		config({ conditions: [condition('data.count', 'eq', 10)] }),
		config({ conditions: [condition('ready', 'eval', true)] }),
		config({ conditions: [{ ...condition(), expression: 'true' }] }),
		config({ conditions: [condition(), condition()] }),
		{ transitions: [...config().transitions, ...config().transitions] },
		config({ deadline: undefined }),
		config({ deadline: { ...deadline(), anchor: 'data.day' } }),
		config({ deadline: { ...deadline(), mode: 'schedule' } }),
		config({ deadline: { ...deadline(), afterMs: 0 } }),
		config({ deadline: { ...deadline(), afterMs: 1.5 } }),
		config({ deadline: { ...deadline(), afterMs: 31_536_000_001 } }),
		config({ deadline: { ...deadline(), afterMs: '1000' } }),
		config({ deadline: { ...deadline(), job: 'approve' } })
	];
	for (const value of invalid) {
		assert.throws(() => validateWorkflow(value, definition), undefined, JSON.stringify(value));
		assert.throws(() => runtime.validateWorkflowConfig(value, definition));
	}
});

test('workflow config rejects getters, symbols, hidden properties and nonstandard or accessor arrays without invoking accessors', () => {
	let calls = 0;
	const getter = {
		get transitions() {
			calls++;
			return config().transitions;
		}
	};
	const ruleGetter = config();
	Object.defineProperty(ruleGetter.transitions[0], 'deadline', {
		enumerable: true,
		get() {
			calls++;
			return deadline();
		}
	});
	const arrayGetter = config();
	Object.defineProperty(arrayGetter.transitions[0].conditions, '0', {
		enumerable: true,
		get() {
			calls++;
			return condition();
		}
	});
	const hidden = config();
	Object.defineProperty(hidden, 'secret', { value: true });
	const symbol = config();
	symbol[Symbol('x')] = true;
	const arrayExtra = config();
	arrayExtra.transitions.note = true;
	const weird = config();
	Object.setPrototypeOf(weird.transitions, null);
	for (const value of [getter, ruleGetter, arrayGetter, hidden, symbol, arrayExtra, weird, Object.create(config())])
		assert.throws(() => validateWorkflow(value, definition));
	assert.equal(calls, 0);
});

test('condition literals enforce declared bounds, enum membership, civil dates and nullability', () => {
	for (const invalid of [
		condition('count', 'eq', '10'),
		condition('count', 'eq', 10.5),
		condition('count', 'eq', Infinity),
		condition('count', 'eq', 101),
		condition('ready', 'eq', 1),
		condition('ready', 'eq', null),
		condition('category', 'eq', 'third'),
		condition('day', 'eq', '2026-02-30'),
		condition('day', 'eq', '2026-10-21T12:00:00Z'),
		condition('title', 'eq', ''),
		condition('title', 'eq', 'x'.repeat(101)),
		condition('title', 'gt', 'A'),
		condition('category', 'gt', 'first'),
		condition('ready', 'lt', true),
		condition('optional', 'lte', null),
		condition('amount', 'eq', 25.5)
	])
		assert.throws(() => validateWorkflow(config({ conditions: [invalid] }), definition));
	assert.doesNotThrow(() => validateWorkflow(config({ conditions: [condition('optional', 'eq', null)] }), definition));
});

test('all six comparisons execute on real typed row values without coercion', () => {
	for (const [op, literal, accepted] of [
		['eq', 10, true],
		['eq', 9, false],
		['ne', 9, true],
		['ne', 10, false],
		['lt', 11, true],
		['lt', 10, false],
		['lte', 10, true],
		['lte', 9, false],
		['gt', 9, true],
		['gt', 10, false],
		['gte', 10, true],
		['gte', 11, false]
	]) {
		const invoke = () =>
			runtime.evaluateWorkflow(
				definition,
				config({ conditions: [condition('count', op, literal)] }),
				record(),
				'approved',
				epoch
			);
		if (accepted) assert.equal(invoke().allowed, true);
		else assert.throws(invoke, code('forbidden'));
	}
});

test('dates compare as validated civil dates, money uses minor units, all conditions are AND, null is explicit', () => {
	const rules = [
		condition('day', 'gte', '2026-10-20'),
		condition('day', 'lt', '2026-10-22'),
		condition('amount', 'eq', 2500),
		condition('title', 'ne', 'Other'),
		condition('category', 'eq', 'first'),
		condition('optional', 'eq', null)
	];
	assert.equal(
		runtime.evaluateWorkflow(definition, config({ conditions: rules }), record(), 'approved', epoch).allowed,
		true
	);
	assert.throws(
		() =>
			runtime.evaluateWorkflow(
				definition,
				config({ conditions: [...rules, condition('ready', 'eq', false)] }),
				record(),
				'approved',
				epoch
			),
		code('forbidden')
	);
	assert.throws(
		() =>
			runtime.evaluateWorkflow(
				definition,
				config({ conditions: [condition('optional', 'gte', 0)] }),
				record(),
				'approved',
				epoch
			),
		code('forbidden')
	);
	assert.throws(
		() =>
			runtime.evaluateWorkflow(
				definition,
				config({ conditions: [condition('optional', 'ne', null)] }),
				record(),
				'approved',
				epoch
			),
		code('forbidden')
	);
	assert.equal(
		runtime.evaluateWorkflow(
			definition,
			config({ conditions: [condition('optional', 'ne', 0)] }),
			record(),
			'approved',
			epoch
		).allowed,
		true
	);
});

test('reference comparisons accept only declared reference fields and do not resolve or grant authority', () => {
	const d = {
		...definition,
		fields: [
			...definition.fields,
			{ name: 'parent', label: 'Parent', type: 'reference', required: true, target: 'parents' }
		]
	};
	const c = config({ conditions: [condition('parent', 'eq', 'parent_1')] });
	assert.equal(
		runtime.evaluateWorkflow(d, c, record({ data: { ...data, parent: 'parent_1' } }), 'approved', epoch).allowed,
		true
	);
	assert.throws(() => validateWorkflow(config({ conditions: [condition('parent', 'eq', '$where')] }), d));
	assert.throws(() => validateWorkflow(config({ conditions: [condition('parent', 'gt', 'parent_1')] }), d));
});

test('before/after deadlines have an exact inclusive due boundary and expose bounded due status', () => {
	const before = config({ deadline: deadline('before') });
	assert.equal(runtime.evaluateWorkflow(definition, before, record(), 'approved', after(999)).deadline.due, false);
	for (const now of [after(1000), after(1001)])
		assert.throws(() => runtime.evaluateWorkflow(definition, before, record(), 'approved', now), code('conflict'));
	const later = config({ deadline: deadline('after') });
	assert.throws(() => runtime.evaluateWorkflow(definition, later, record(), 'approved', after(999)), code('conflict'));
	for (const now of [after(1000), after(1001)])
		assert.equal(runtime.evaluateWorkflow(definition, later, record(), 'approved', now).allowed, true);
	const states = runtime.workflowStatus(definition, before, record(), after(1000));
	assert.deepEqual(states[0], {
		from: 'draft',
		to: 'approved',
		conditionsMet: true,
		allowed: false,
		blockedBy: 'deadline',
		deadline: { dueAt: after(1000).toISOString(), due: true, mode: 'before' }
	});
	assert.deepEqual(states[1], {
		from: 'draft',
		to: 'cancelled',
		conditionsMet: true,
		allowed: true,
		blockedBy: null,
		deadline: null
	});
	assert.equal(runtime.evaluateWorkflow(definition, before, record(), 'cancelled', after(1000)).allowed, true);
});

test('deadline guards reject missing or forged trusted timestamps, invalid clocks, rollback and overflow', () => {
	const c = config({ deadline: deadline() });
	for (const updatedAt of [
		undefined,
		null,
		epoch.toISOString(),
		epoch.getTime(),
		new Date(NaN),
		new Date(8_640_000_000_000_000)
	])
		assert.throws(
			() => runtime.evaluateWorkflow(definition, c, record({ updatedAt }), 'approved', after(1)),
			code('conflict')
		);
	for (const now of [new Date(NaN), after(-1), epoch.toISOString(), null])
		assert.throws(() => runtime.evaluateWorkflow(definition, c, record(), 'approved', now), code('conflict'));
	const date = new Date(epoch);
	date.getTime = () => 0;
	assert.throws(
		() => runtime.evaluateWorkflow(definition, c, record({ updatedAt: date }), 'approved', epoch),
		code('conflict')
	);
	let inheritedCalls = 0;
	const inherited = record();
	delete inherited.updatedAt;
	Object.setPrototypeOf(inherited, {
		get updatedAt() {
			inheritedCalls++;
			return epoch;
		}
	});
	assert.throws(() => runtime.evaluateWorkflow(definition, c, inherited, 'approved', epoch), code('conflict'));
	assert.equal(inheritedCalls, 0);
	assert.throws(
		() =>
			runtime.evaluateWorkflow(
				definition,
				c,
				record({ updatedAt: new Date(8_640_000_000_000_000) }),
				'approved',
				new Date(8_640_000_000_000_000)
			),
		code('conflict')
	);
});

test('corrupted persisted snapshots and nonexistent transitions fail closed', () => {
	for (const row of [
		null,
		{},
		record({ state: 'unknown' }),
		record({ data: { ...data, count: '10' } }),
		record({ data: { ...data, ownerId: 'alice' } })
	])
		assert.throws(() => runtime.evaluateWorkflow(definition, config(), row, 'approved', epoch), code('conflict'));
	let calls = 0;
	const row = record();
	Object.defineProperty(row, 'data', {
		enumerable: true,
		get() {
			calls++;
			return data;
		}
	});
	assert.throws(() => runtime.evaluateWorkflow(definition, config(), row, 'approved', epoch), code('conflict'));
	assert.equal(calls, 0);
	assert.throws(() => runtime.evaluateWorkflow(definition, config(), record(), 'missing', epoch), code('conflict'));
});

test('configured guard detaches both recipe definition and workflow configuration', async () => {
	const d = structuredClone(definition),
		c = config(),
		guard = runtime.createWorkflowGuard(d, c);
	c.transitions.length = 0;
	d.transitions.length = 0;
	await guard({ row: record(), to: 'approved', now: epoch });
	await assert.rejects(
		guard({ row: record({ data: { ...data, ready: false } }), to: 'approved', now: epoch }),
		code('forbidden')
	);
});

function fixture(workflow) {
	const rows = new Map([['doc', record()]]),
		calls = [];
	let now = new Date(epoch);
	const ports = {
		now: () => new Date(now),
		resolveIdentity: async (userId) => ({ userId, roles: [] }),
		beforeTransition: runtime.createWorkflowGuard(definition, workflow),
		repository: {
			find: async (scope, id) => {
				const row = rows.get(id);
				return row && row.ownerId === scope.ownerId ? structuredClone(row) : null;
			},
			list: async () => [],
			insert: async (row) => {
				if (!rows.has(row._id)) rows.set(row._id, structuredClone(row));
				return structuredClone(rows.get(row._id));
			},
			compareAndSet: async (scope, id, version, next) => {
				calls.push({ scope, id, version, next });
				const row = rows.get(id);
				if (!row || row.ownerId !== scope.ownerId || row.version !== version) return false;
				rows.set(id, { ...row, ...structuredClone(next) });
				return true;
			},
			remove: async () => false
		}
	};
	return {
		rows,
		calls,
		ports,
		service: recipeService(definition, ports),
		clock: (value) => {
			now = value;
		}
	};
}

test('real recipe transition enforces conditions and trusted deadlines before any write', async () => {
	const f = fixture(config({ deadline: deadline() }));
	f.rows.get('doc').data.ready = false;
	await assert.rejects(f.service.transition('alice', { id: 'doc', version: 1, to: 'approved' }), code('forbidden'));
	assert.equal(f.calls.length, 0);
	f.rows.get('doc').data.ready = true;
	f.clock(after(1000));
	await assert.rejects(f.service.transition('alice', { id: 'doc', version: 1, to: 'approved' }), code('conflict'));
	assert.equal(f.calls.length, 0);
	f.clock(after(999));
	const result = await f.service.transition('alice', { id: 'doc', version: 1, to: 'approved' });
	assert.equal(result.state, 'approved');
	assert.equal(result.version, 2);
	assert.equal(f.calls.length, 1);
	assert.equal(f.rows.get('doc').updatedAt.getTime(), after(999).getTime());
	assert.equal(Object.hasOwn(result, 'updatedAt'), false);
});

test('real transition preserves authorization, DTO strictness, stale writes and CAS conflict around workflow checks', async () => {
	const f = fixture(config());
	let guarded = 0;
	const guard = f.ports.beforeTransition;
	f.ports.beforeTransition = async (context) => {
		guarded++;
		await guard(context);
	};
	for (const [user, input, expected] of [
		[null, { id: 'doc', version: 1, to: 'approved' }, 'unauthenticated'],
		['bob', { id: 'doc', version: 1, to: 'approved' }, 'not-found'],
		['alice', { id: 'doc', version: 2, to: 'approved' }, 'conflict'],
		['alice', { id: 'doc', version: 1, to: 'approved', updatedAt: epoch }, 'invalid-input'],
		['alice', { id: 'doc', version: 1, to: 'approved', now: epoch }, 'invalid-input']
	])
		await assert.rejects(f.service.transition(user, input), code(expected));
	assert.equal(guarded, 0);
	assert.equal(f.calls.length, 0);
	f.ports.repository.compareAndSet = async () => false;
	await assert.rejects(f.service.transition('alice', { id: 'doc', version: 1, to: 'approved' }), code('conflict'));
	assert.equal(guarded, 1);
	assert.equal(f.rows.get('doc').state, 'draft');
});

test('engine persists server time on creation and data update, and refuses a legacy deadline without inventing an anchor', async () => {
	const f = fixture(config({ deadline: deadline('after') }));
	delete f.rows.get('doc').updatedAt;
	await assert.rejects(f.service.transition('alice', { id: 'doc', version: 1, to: 'approved' }), code('conflict'));
	const created = await f.service.create('alice', { data, parentId: null, mutationId: 'mutation1' });
	assert.equal(f.rows.get(created.id).updatedAt.getTime(), epoch.getTime());
	f.clock(after(500));
	await f.service.update('alice', { id: 'doc', version: 1, data });
	assert.equal(f.rows.get('doc').updatedAt.getTime(), after(500).getTime());
	f.clock(after(1499));
	await assert.rejects(f.service.transition('alice', { id: 'doc', version: 2, to: 'approved' }), code('conflict'));
	f.clock(after(1500));
	assert.equal((await f.service.transition('alice', { id: 'doc', version: 2, to: 'approved' })).state, 'approved');
});

test('generated port wrapper typechecks and executes actual engine guards without replacing trusted hooks or transports', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-generated-'));
	try {
		fs.cpSync(path.join(root, 'imports/core'), path.join(dir, 'imports/core'), { recursive: true });
		const files = renderWorkflow({ definition, workflow: config() });
		const generated = `imports/modules/${definition.name}/generated`;
		files[`${generated}/definition.ts`] =
			`import { validateDefinition } from '../../../core/recipes/definition';\nexport const definition = validateDefinition(${JSON.stringify(definition)});\n`;
		for (const [relative, content] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
			fs.writeFileSync(path.join(dir, relative), content);
		}
		const entry = path.join(dir, `${generated}/workflow/server/index.ts`);
		const options = {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.Preserve,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			strict: true,
			skipLibCheck: true,
			noEmit: true,
			types: ['node'],
			typeRoots: [path.join(root, 'node_modules/@types')]
		};
		const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([entry], options));
		assert.deepEqual(
			diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
			[]
		);
		const module = await load(entry);
		const f = fixture(config());
		let priorCalls = 0;
		const base = {
			resolveIdentity: f.ports.resolveIdentity,
			now: f.ports.now,
			beforeTransition: async () => {
				priorCalls++;
			}
		};
		const wrapped = module.createWorkflowPorts(base);
		assert.equal(wrapped.resolveIdentity, base.resolveIdentity);
		assert.equal(wrapped.now, base.now);
		assert.equal(Object.hasOwn(wrapped, 'repository'), false);
		const service = recipeService(definition, { ...wrapped, repository: f.ports.repository });
		assert.equal((await service.transition('alice', { id: 'doc', version: 1, to: 'approved' })).state, 'approved');
		assert.equal(priorCalls, 1);
		const f2 = fixture(config());
		const denying = module.createWorkflowPorts({
			resolveIdentity: f2.ports.resolveIdentity,
			beforeTransition: async () => {
				throw Error('existing guard');
			}
		});
		await assert.rejects(
			recipeService(definition, { ...denying, repository: f2.ports.repository }).transition('alice', {
				id: 'doc',
				version: 1,
				to: 'approved'
			}),
			/existing guard/
		);
		assert.equal(f2.calls.length, 0);
		assert.equal(module.getWorkflowStatus(record(), epoch)[0].allowed, true);
		assert.doesNotMatch(fs.readFileSync(entry, 'utf8'), /Meteor\.methods|setTimeout|setInterval|eval\(|new Function/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
