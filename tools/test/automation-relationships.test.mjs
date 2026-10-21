import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';
import { renderRelationships, validateRelationships } from '../automation/generators/relationships.mjs';
const root = path.resolve(import.meta.dirname, '../..');
async function load(file) {
	const result = await build({
		entryPoints: [path.join(root, file)],
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false
	});
	return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const runtime = await load('imports/core/recipes/server/relationships.ts');
const { recipeService } = await load('imports/core/recipes/server/engine.ts');
const { createMongoRelationshipAdapter } = await load('imports/core/recipes/server/mongoRelationships.ts');
const definition = (name, fields = [], profile = 'owner') => ({
	schemaVersion: 1,
	name,
	profile,
	fields: [{ name: 'title', label: 'Title', type: 'string', required: true, maxLength: 80 }, ...fields],
	filters: [],
	states: ['active'],
	transitions: [],
	permissions: { read: ['owner'], write: ['owner'] }
});
const reference = (name, target, required = false) => ({ name, label: name, type: 'reference', target, required });
const config = (incoming = [], outgoing = [], maxTotal = 10) => ({ incoming, outgoing, maxTotal });
const policy = (source = 'children', field = 'parent', action = 'restrict', maxAffected = 5) => ({
	name: `${source}Link`,
	source,
	field,
	policy: action,
	maxAffected
});
const record = (id, data = {}, extra = {}) => ({
	_id: id,
	ownerId: 'alice',
	version: 1,
	state: 'active',
	deleted: false,
	creationFingerprint: 'same',
	data: { title: id, ...data },
	...extra
});
function graph(action = 'restrict', options = {}) {
	const parent = definition('parents'),
		child = definition(
			'children',
			options.masterDetail ? [] : [reference('parent', 'parents', options.required ?? false)],
			options.masterDetail ? 'master-detail' : 'owner'
		);
	const field = options.masterDetail ? 'parentId' : 'parent';
	return [
		{
			definition: parent,
			relationships: config([policy('children', field, action, options.maxAffected ?? 5)], [], options.maxTotal ?? 10),
			collection: 'recipe_parents'
		},
		{ definition: child, relationships: config([], [{ field, target: 'parents' }]), collection: 'recipe_children' }
	];
}
const scopeMatches = (scope, row) =>
	(!scope.ownerId || row.ownerId === scope.ownerId) &&
	(row.tenantId ?? null) === scope.tenantId &&
	(!scope.parentId || row.parentId === scope.parentId);
/** Deliberate deterministic transaction model, not evidence of a live Mongo deployment. */
function fixture(
	modules = graph(),
	initial = { parents: [record('parent1')], children: [record('child1', { parent: 'parent1' })] }
) {
	let tables = new Map(
		modules.map((module) => [
			module.definition.name,
			new Map((initial[module.definition.name] ?? []).map((row) => [row._id, structuredClone(row)]))
		])
	);
	let queue = Promise.resolve(),
		failMutation = '',
		poisonReferences = null;
	const effects = [];
	const adapter = {
		modules,
		async run(scope, work) {
			runtime.assertRelationshipScope(scope);
			const previous = queue;
			let release;
			queue = new Promise((resolve) => {
				release = resolve;
			});
			await previous;
			const draft = structuredClone(tables),
				pending = [];
			const tx = {
				async find(module, scope, id) {
					const row = draft.get(module).get(id);
					return row && !row.deleted && scopeMatches(scope, row) ? structuredClone(row) : null;
				},
				async references(module, scope, field, target, limit) {
					if (poisonReferences) return [structuredClone(poisonReferences)];
					return [...draft.get(module).values()]
						.filter(
							(row) =>
								!row.deleted &&
								scopeMatches(scope, row) &&
								(field === 'parentId' ? row.parentId : row.data[field]) === target
						)
						.slice(0, limit)
						.map((row) => structuredClone(row));
				},
				async insert(module, row) {
					const table = draft.get(module);
					if (!table.has(row._id)) {
						table.set(row._id, structuredClone(row));
						pending.push(['insert', module, row._id]);
					}
					return structuredClone(table.get(row._id));
				},
				async compareAndSet(module, scope, id, version, next) {
					if (`${module}:${id}` === failMutation) return false;
					const row = await tx.find(module, scope, id);
					if (!row || row.version !== version) return false;
					draft.get(module).set(id, { ...row, ...structuredClone(next) });
					pending.push(['update', module, id]);
					return true;
				},
				async remove(module, scope, id, version) {
					if (`${module}:${id}` === failMutation) return false;
					const row = await tx.find(module, scope, id);
					if (!row || row.version !== version) return false;
					draft.get(module).set(id, { ...row, deleted: true, data: {}, version: version + 1 });
					pending.push(['remove', module, id]);
					return true;
				}
			};
			try {
				const result = await work(tx);
				tables = draft;
				effects.push(...pending);
				return result;
			} finally {
				release();
			}
		}
	};
	const ports = (name = 'parents', identity = async (userId) => ({ userId, roles: [] })) => {
		const module = modules.find((module) => module.definition.name === name);
		const base = { resolveIdentity: identity, parentExists: async () => true, referenceExists: async () => true };
		const wrapped = runtime.withRelationshipPorts(base, module.definition, module.relationships, adapter);
		const repository = {
			async find(scope, id) {
				const row = tables.get(name).get(id);
				return row && !row.deleted && scopeMatches(scope, row) ? structuredClone(row) : null;
			},
			async list(scope, _filters, limit) {
				return [...tables.get(name).values()].filter((row) => !row.deleted && scopeMatches(scope, row)).slice(0, limit);
			},
			async insert() {
				throw Error('unsafe fallback insert');
			},
			async compareAndSet() {
				throw Error('unsafe fallback CAS');
			},
			async remove() {
				throw Error('unsafe fallback remove');
			}
		};
		return { ...wrapped, repository: wrapped.configureRepository(repository) };
	};
	return {
		adapter,
		effects,
		ports,
		row: (name, id) => structuredClone(tables.get(name).get(id)),
		service: (name = 'parents', identity) =>
			recipeService(modules.find((module) => module.definition.name === name).definition, ports(name, identity)),
		fail(id) {
			failMutation = id;
		},
		poison(row) {
			poisonReferences = row;
		}
	};
}
const conflict = (error) => error.code === 'conflict';

test('relationship contract is deterministic, rejects arbitrary keys and requires every reference', () => {
	const [parent, child] = graph();
	assert.deepEqual(validateRelationships(parent.relationships, parent.definition), parent.relationships);
	for (const value of [
		{ ...parent.relationships, command: 'removeAll' },
		{ ...parent.relationships, maxTotal: 501 },
		{ ...parent.relationships, incoming: [policy('children', '$where')] },
		{ ...parent.relationships, incoming: [policy(), policy()] }
	]) {
		assert.throws(() => validateRelationships(value, parent.definition));
	}
	assert.throws(() => validateRelationships({ ...child.relationships, outgoing: [] }, child.definition));
	const files = renderRelationships({ definition: parent.definition, relationships: parent.relationships });
	assert.deepEqual(files, renderRelationships({ definition: parent.definition, relationships: parent.relationships }));
	const code = files['imports/modules/parents/generated/relationships/server/index.ts'];
	assert.match(code, /withRelationshipPorts\(ports, definition, relationshipConfiguration, adapter\)/);
	assert.equal(
		ts.transpileModule(code, {
			compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
			reportDiagnostics: true
		}).diagnostics.length,
		0
	);
});

test('registry validates inverse policies, optional-only nullification and immutable snapshots', () => {
	assert.throws(() => runtime.validateRelationshipRegistry(graph('set-null', { required: true })), /optional/);
	assert.throws(
		() => runtime.validateRelationshipRegistry(graph('set-null', { masterDetail: true })),
		/cannot be nullified/
	);
	const modules = graph();
	modules[1].relationships.outgoing = [];
	assert.throws(() => runtime.validateRelationshipRegistry(modules));
	const valid = graph(),
		frozen = runtime.validateRelationshipRegistry(valid);
	valid[0].relationships.incoming[0].policy = 'cascade';
	assert.equal(frozen[0].relationships.incoming[0].policy, 'restrict');
	assert.throws(() => {
		frozen[0].relationships.incoming[0].policy = 'cascade';
	});
});

test('restrict rejects live scoped references without deleting either record; tombstones do not restrict', async () => {
	const f = fixture();
	await assert.rejects(() => f.service().remove('alice', { id: 'parent1', version: 1 }), conflict);
	assert.deepEqual(f.effects, []);
	assert.equal(f.row('parents', 'parent1').deleted, false);
	const g = fixture(graph(), {
		parents: [record('parent1')],
		children: [record('child1', { parent: 'parent1' }, { deleted: true })]
	});
	assert.deepEqual(await g.service().remove('alice', { id: 'parent1', version: 1 }), { removed: true });
	assert.equal(g.row('parents', 'parent1').version, 2);
	assert.deepEqual(g.row('parents', 'parent1').data, {});
});

test('cascade atomically deletes children before root, preserving inaccessible tombstones', async () => {
	const f = fixture(graph('cascade'));
	await f.service().remove('alice', { id: 'parent1', version: 1 });
	assert.deepEqual(f.effects, [
		['remove', 'children', 'child1'],
		['remove', 'parents', 'parent1']
	]);
	for (const [name, id] of [
		['parents', 'parent1'],
		['children', 'child1']
	]) {
		assert.equal(f.row(name, id).deleted, true);
		assert.equal(f.row(name, id).version, 2);
		assert.deepEqual(f.row(name, id).data, {});
	}
});

test('master-detail immutable parentId lifecycle is enforced by the same transaction path', async () => {
	const modules = graph('cascade', { masterDetail: true });
	const f = fixture(modules, {
		parents: [record('parent1')],
		children: [record('child1', {}, { parentId: 'parent1' })]
	});
	await f.service().remove('alice', { id: 'parent1', version: 1 });
	assert.equal(f.row('children', 'child1').deleted, true);
	await assert.rejects(
		() =>
			f.service('children').create('alice', { data: { title: 'new' }, parentId: 'parent1', mutationId: 'newChild' }),
		(error) => error.code === 'not-found'
	);
});

test('set-null preserves source record and changes only the nullable field with CAS', async () => {
	const f = fixture(graph('set-null'));
	await f.service().remove('alice', { id: 'parent1', version: 1 });
	const child = f.row('children', 'child1');
	assert.equal(child.deleted, false);
	assert.equal(child.version, 2);
	assert.deepEqual(child.data, { title: 'child1', parent: null });
	assert.equal(f.row('parents', 'parent1').deleted, true);
});

test('late root CAS failure aborts all cascade and set-null effects', async () => {
	for (const action of ['cascade', 'set-null']) {
		const f = fixture(graph(action));
		f.fail('parents:parent1');
		await assert.rejects(() => f.service().remove('alice', { id: 'parent1', version: 1 }), conflict);
		assert.deepEqual(f.effects, []);
		assert.equal(f.row('children', 'child1').version, 1);
		assert.equal(f.row('parents', 'parent1').deleted, false);
	}
});

test('stale root and per-link or total overflow fail before any writes', async () => {
	const f = fixture(graph('cascade'));
	await assert.rejects(() => f.service().remove('alice', { id: 'parent1', version: 2 }), conflict);
	assert.deepEqual(f.effects, []);
	for (const options of [{ maxTotal: 1 }, { maxAffected: 1 }]) {
		const g = fixture(graph('cascade', options), {
			parents: [record('parent1')],
			children: [record('child1', { parent: 'parent1' }), record('child2', { parent: 'parent1' })]
		});
		await assert.rejects(() => g.service().remove('alice', { id: 'parent1', version: 1 }), conflict);
		assert.deepEqual(g.effects, []);
	}
});

test('recursive cascades respect downstream restriction and rollback the entire root operation', async () => {
	const modules = graph('cascade');
	modules[1].relationships.incoming.push(policy('grandchildren', 'child', 'restrict'));
	modules.push({
		definition: definition('grandchildren', [reference('child', 'children')]),
		relationships: config([], [{ field: 'child', target: 'children' }]),
		collection: 'recipe_grandchildren'
	});
	const f = fixture(modules, {
		parents: [record('parent1')],
		children: [record('child1', { parent: 'parent1' })],
		grandchildren: [record('grand1', { child: 'child1' })]
	});
	await assert.rejects(() => f.service().remove('alice', { id: 'parent1', version: 1 }), conflict);
	assert.deepEqual(f.effects, []);
});

test('owner and tenant confinement prevent collateral deletion and unsafe cross-owner references', async () => {
	const f = fixture(graph('cascade'), {
		parents: [record('parent1')],
		children: [
			record('child1', { parent: 'parent1' }),
			record('foreignTenant', { parent: 'parent1' }, { tenantId: 'team1' }),
			record('foreignOwner', { parent: 'parent1' }, { ownerId: 'bob' })
		]
	});
	await f.service().remove('alice', { id: 'parent1', version: 1 });
	assert.equal(f.row('children', 'foreignTenant').deleted, false);
	assert.equal(f.row('children', 'foreignOwner').deleted, false);
	const g = fixture(graph(), { parents: [record('parent1', {}, { ownerId: 'bob' })], children: [] });
	await assert.rejects(
		() =>
			g
				.service('children')
				.create('alice', { data: { title: 'new', parent: 'parent1' }, parentId: null, mutationId: 'newChild' }),
		(error) => error.code === 'not-found'
	);
	assert.deepEqual(g.effects, []);
	const h = fixture(graph('cascade'));
	h.poison(record('outside', { parent: 'parent1' }, { tenantId: 'other' }));
	await assert.rejects(() => h.service().remove('alice', { id: 'parent1', version: 1 }), conflict);
	assert.deepEqual(h.effects, []);
});

test('transaction scope rejects missing tenant constraint, personal unowned scope and injected keys', async () => {
	for (const scope of [{}, { ownerId: 'alice' }, { tenantId: null }, { tenantId: 'team', $where: 'true' }])
		assert.throws(() => runtime.assertRelationshipScope(scope));
	runtime.assertRelationshipScope({ tenantId: 'team' });
	runtime.assertRelationshipScope({ ownerId: 'alice', tenantId: null });
});

test('all configured writes use transaction repositories; concurrent insertion cannot slip behind deletion', async () => {
	const f = fixture(graph(), { parents: [record('parent1')], children: [] });
	const service = f.service('children');
	const created = await service.create('alice', {
		data: { title: 'new', parent: 'parent1' },
		parentId: null,
		mutationId: 'childMutation'
	});
	await service.update('alice', { id: created.id, version: 1, data: { title: 'updated', parent: 'parent1' } });
	assert.equal(f.row('children', created.id).version, 2);
	await assert.rejects(() => f.service().remove('alice', { id: 'parent1', version: 1 }), conflict);
	const g = fixture(graph(), { parents: [record('parent1')], children: [] });
	const results = await Promise.allSettled([
		g.service().remove('alice', { id: 'parent1', version: 1 }),
		g
			.service('children')
			.create('alice', { data: { title: 'racing', parent: 'parent1' }, parentId: null, mutationId: 'race' })
	]);
	assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
	if (g.row('parents', 'parent1').deleted)
		assert.equal(
			g.effects.some((item) => item[0] === 'insert'),
			false
		);
});

/** Fake native-driver surface executes the ACTUAL Mongo adapter. Live replica-set qualification is separate. */
function mongoFixture(modules = graph('cascade')) {
	let tables = new Map(modules.map((module) => [module.collection, new Map()]));
	tables.set('recipe_relationship_fences', new Map());
	const traces = [];
	let failId = '',
		noTransaction = false,
		ended = 0;
	const matches = (row, query) =>
		Object.entries(query).every(([field, expected]) => {
			const actual = field.split('.').reduce((value, key) => value?.[key], row);
			return expected && typeof expected === 'object' && '$exists' in expected
				? (actual !== undefined) === expected.$exists
				: actual === expected;
		});
	const db = {
		collection(name) {
			if (!tables.has(name)) tables.set(name, new Map());
			const get = (options) => (options?.session?.draft ?? tables).get(name);
			return {
				async findOne(query, options) {
					traces.push(['find', name, structuredClone(query), options?.session]);
					return structuredClone([...get(options).values()].find((row) => matches(row, query)) ?? null);
				},
				find(query, options) {
					traces.push(['references', name, structuredClone(query), options?.session]);
					let limit;
					return {
						sort() {
							return this;
						},
						limit(value) {
							limit = value;
							return this;
						},
						async toArray() {
							return [...get(options).values()]
								.filter((row) => matches(row, query))
								.slice(0, limit)
								.map((row) => structuredClone(row));
						}
					};
				},
				async updateOne(query, update, options) {
					traces.push(['update', name, structuredClone(query), options?.session]);
					const table = get(options);
					let row = [...table.values()].find((row) => matches(row, query));
					if (name !== 'recipe_relationship_fences' && query._id === failId)
						return { modifiedCount: 0, matchedCount: 0 };
					if (!row && options?.upsert) {
						row = { _id: query._id, ...update.$setOnInsert };
						table.set(row._id, row);
					}
					if (!row) return { modifiedCount: 0, matchedCount: 0 };
					Object.assign(row, structuredClone(update.$set ?? {}));
					for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] += value;
					return { modifiedCount: 1, matchedCount: 1 };
				},
				async insertOne(record, options) {
					traces.push(['insert', name, record._id, options?.session]);
					get(options).set(record._id, structuredClone(record));
					return { insertedId: record._id };
				}
			};
		}
	};
	const startSession = () => ({
		async withTransaction(work, options) {
			assert.equal(options.readConcern.level, 'snapshot');
			assert.equal(options.writeConcern.w, 'majority');
			if (noTransaction) throw Error('Transactions require a replica set');
			this.draft = structuredClone(tables);
			try {
				await work();
				tables = this.draft;
			} finally {
				delete this.draft;
			}
		},
		async endSession() {
			ended++;
		}
	});
	const adapter = createMongoRelationshipAdapter({ database: db, startSession, modules });
	return {
		adapter,
		traces,
		put(name, row) {
			tables.get(`recipe_${name}`).set(row._id, structuredClone(row));
		},
		row(name, id) {
			return structuredClone(tables.get(`recipe_${name}`).get(id));
		},
		fail(id) {
			failId = id;
		},
		disableTransactions() {
			noTransaction = true;
		},
		get ended() {
			return ended;
		}
	};
}

test('concrete Mongo adapter binds every operation to one session after shared fence acquisition', async () => {
	const f = mongoFixture();
	f.put('parents', record('parent1'));
	f.put('children', record('child1', { parent: 'parent1' }));
	const module = f.adapter.modules[0];
	const ports = runtime.withRelationshipPorts(
		{ resolveIdentity: async (userId) => ({ userId, roles: [] }) },
		module.definition,
		module.relationships,
		f.adapter
	);
	await ports.removeWithRelations({ ownerId: 'alice', tenantId: null }, record('parent1'), 1);
	assert.equal(f.row('children', 'child1').deleted, true);
	assert.equal(f.row('parents', 'parent1').deleted, true);
	assert.equal(f.ended, 1);
	const transactional = f.traces.filter((item) => item[3]);
	assert.equal(transactional[0][1], 'recipe_relationship_fences');
	assert.equal(new Set(transactional.map((item) => item[3])).size, 1);
	for (const trace of transactional.filter((item) => item[1] !== 'recipe_relationship_fences')) {
		assert.equal(trace[2].ownerId, 'alice');
		assert.deepEqual(trace[2].tenantId, { $exists: false });
		assert.equal(trace[2].deleted, false);
	}
	assert.equal(f.traces.filter((item) => item[1] !== 'recipe_relationship_fences' && !item[3]).length, 0);
});

test('concrete Mongo adapter rolls back child mutation on late CAS failure and has no transaction fallback', async () => {
	const f = mongoFixture();
	f.put('parents', record('parent1'));
	f.put('children', record('child1', { parent: 'parent1' }));
	f.fail('parent1');
	const module = f.adapter.modules[0],
		ports = runtime.withRelationshipPorts(
			{ resolveIdentity: async (userId) => ({ userId, roles: [] }) },
			module.definition,
			module.relationships,
			f.adapter
		);
	await assert.rejects(
		() => ports.removeWithRelations({ ownerId: 'alice', tenantId: null }, record('parent1'), 1),
		conflict
	);
	assert.equal(f.row('children', 'child1').deleted, false);
	assert.equal(f.row('parents', 'parent1').deleted, false);
	assert.equal(f.ended, 1);
	const g = mongoFixture();
	g.disableTransactions();
	await assert.rejects(
		() =>
			g.adapter.run({ ownerId: 'alice', tenantId: null }, async () => {
				throw Error('must not reach');
			}),
		/replica set/
	);
	assert.equal(g.ended, 1);
	assert.equal(
		g.traces.every((item) => item[1] === 'recipe_relationship_fences'),
		true
	);
});

test('Mongo transaction port denies tenant/owner escape and undeclared relationship field', async () => {
	const f = mongoFixture();
	for (const operation of [
		(tx) => tx.find('parents', { ownerId: 'alice', tenantId: 'other' }, 'id'),
		(tx) => tx.find('parents', { ownerId: 'bob', tenantId: null }, 'id'),
		(tx) => tx.references('children', { ownerId: 'alice', tenantId: null }, '$where', 'id', 1),
		(tx) => tx.find('parents', { ownerId: 'alice', tenantId: null }, ''),
		(tx) => tx.remove('parents', { ownerId: 'alice', tenantId: null }, '', 1)
	]) {
		await assert.rejects(() => f.adapter.run({ ownerId: 'alice', tenantId: null }, operation));
	}
	assert.equal(
		f.traces.some((item) => item[1] !== 'recipe_relationship_fences'),
		false
	);
});
