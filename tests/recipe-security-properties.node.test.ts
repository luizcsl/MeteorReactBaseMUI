/** Supervisor-owned properties: no generated tests or application-specific fixtures are imported. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	recipeService,
	type RecipeIdentity,
	type RecipeRecord,
	type RecipeRepository,
	type RecipeScope
} from '../imports/core/recipes/server/engine';
import { validateDefinition, parseRecipeData, type RecipeDefinition } from '../imports/core/recipes/definition';
import { authorizeLinkedAttachment } from '../imports/core/recipes/server/attachments';
import { prepareImport, jobTransition } from '../imports/core/recipes/batch';

const definition: RecipeDefinition = {
	schemaVersion: 1,
	name: 'securityprobe',
	profile: 'owner',
	fields: [{ name: 'title', label: 'Title', type: 'string', required: true, maxLength: 80 }],
	filters: ['title'],
	states: ['draft', 'submitted', 'approved'],
	transitions: [{ from: 'draft', to: 'submitted', roles: ['owner'] }],
	permissions: { read: ['owner'], write: ['owner'] }
};
const creation = (mutationId = 'request', title = 'private') => ({ data: { title }, parentId: null, mutationId });
const clone = <T>(value: T): T => structuredClone(value);
function harness(d = definition) {
	const rows = new Map<string, RecipeRecord>();
	let current: RecipeIdentity = { userId: 'alice', roles: [] };
	let revoked = false;
	let writes = 0;
	let parentAllowed = true;
	const selectors: RecipeScope[] = [];
	// Independent exact matching, including presence: never reuse service scope construction.
	const matches = (scope: RecipeScope, row: RecipeRecord) =>
		Object.entries(scope).every(([key, value]) =>
			key === 'tenantId' && value === null ? row.tenantId === undefined : row[key as keyof RecipeRecord] === value
		);
	const repository: RecipeRepository = {
		find: async (scope, id) => {
			selectors.push(clone(scope));
			const row = rows.get(id);
			return row && !row.deleted && matches(scope, row) ? clone(row) : null;
		},
		list: async (scope, filters, limit) => {
			selectors.push(clone(scope));
			return [...rows.values()]
				.filter(
					(row) =>
						!row.deleted &&
						matches(scope, row) &&
						Object.entries(filters).every(([key, value]) => row.data[key] === value)
				)
				.slice(0, limit)
				.map(clone);
		},
		insert: async (row) => {
			const existing = rows.get(row._id);
			if (existing) return clone(existing);
			writes++;
			rows.set(row._id, clone(row));
			return clone(row);
		},
		compareAndSet: async (scope, id, version, next) => {
			const row = rows.get(id);
			if (!row || row.deleted || !matches(scope, row) || row.version !== version) return false;
			writes++;
			rows.set(id, { ...row, ...clone(next) });
			return true;
		},
		remove: async (scope, id, version) => {
			const row = rows.get(id);
			if (!row || row.deleted || !matches(scope, row) || row.version !== version) return false;
			writes++;
			rows.set(id, { ...row, deleted: true, data: {}, version: version + 1 });
			return true;
		}
	};
	const service = recipeService(d, {
		repository,
		resolveIdentity: async () => {
			if (revoked) throw new Error('Revoked');
			return clone(current);
		},
		parentExists: async (scope) =>
			parentAllowed && scope.ownerId === current.userId && (scope.tenantId ?? null) === (current.tenantId ?? null)
	});
	return {
		service,
		rows,
		repository,
		selectors,
		as(identity: RecipeIdentity) {
			current = clone(identity);
		},
		revoke() {
			revoked = true;
		},
		revokeParent() {
			parentAllowed = false;
		},
		writes: () => writes
	};
}
const approval: RecipeDefinition = {
	...definition,
	profile: 'approval',
	permissions: { read: ['owner', 'member', 'reviewer'], write: ['owner'] },
	transitions: [...definition.transitions, { from: 'submitted', to: 'approved', roles: ['reviewer'] }]
};

test('recipe property: personal selectors explicitly exclude tenant records for the same owner', async () => {
	const h = harness();
	for (const tenantId of ['one', 'two', undefined]) {
		h.as({ userId: 'alice', tenantId, roles: [] });
		await h.service.create('alice', creation('same-request', tenantId ?? 'personal'));
	}
	assert.equal(h.rows.size, 3);
	for (const tenantId of ['one', 'two', undefined]) {
		h.as({ userId: 'alice', tenantId, roles: [] });
		const list = await h.service.list('alice', { filters: {}, limit: 10 });
		assert.deepEqual(
			list.map((row) => row.data.title),
			[tenantId ?? 'personal']
		);
		assert.deepEqual(h.selectors.at(-1), { ownerId: 'alice', tenantId: tenantId ?? null });
	}
});

test('recipe property: service independently rejects repository cross-owner and cross-tenant reads', async () => {
	const h = harness();
	const dto = await h.service.create('alice', creation());
	const original = clone(h.rows.get(dto.id)!);
	for (const corruption of [{ ownerId: 'mallory' }, { tenantId: 'foreign' }]) {
		const row = { ...original, ...corruption };
		h.repository.list = async () => [clone(row)];
		h.repository.find = async () => clone(row);
		const before = h.writes();
		await assert.rejects(h.service.list('alice', { filters: {}, limit: 10 }));
		await assert.rejects(h.service.update('alice', { id: dto.id, version: 1, data: { title: 'changed' } }));
		await assert.rejects(h.service.transition('alice', { id: dto.id, version: 1, to: 'submitted' }));
		await assert.rejects(h.service.remove('alice', { id: dto.id, version: 1 }));
		assert.equal(h.writes(), before);
	}
});

test('recipe property: forged identity and revoked membership fail before repository writes', async () => {
	const h = harness({ ...definition, profile: 'team', permissions: { read: ['member'], write: ['member'] } });
	for (const identity of [
		{ userId: 'mallory', tenantId: 'one', roles: ['member'] },
		{ userId: 'alice', roles: ['member'] },
		{ userId: 'alice', tenantId: 'one', roles: ['administrator'] }
	] as RecipeIdentity[]) {
		h.as(identity);
		await assert.rejects(h.service.create('alice', creation()));
		assert.equal(h.writes(), 0);
	}
	h.as({ userId: 'alice', tenantId: 'one', roles: ['member'] });
	await h.service.create('alice', creation());
	h.revoke();
	await assert.rejects(h.service.list('alice', { filters: {}, limit: 10 }));
	await assert.rejects(h.service.create('alice', creation('next')));
	assert.equal(h.writes(), 1);
});

test('recipe property: review requires another current reviewer in the same tenant', async () => {
	const h = harness(approval);
	h.as({ userId: 'alice', tenantId: 'one', roles: ['member', 'reviewer'] });
	const dto = await h.service.create('alice', creation());
	await h.service.transition('alice', { id: dto.id, version: 1, to: 'submitted' });
	const before = h.writes();
	for (const identity of [
		{ userId: 'alice', tenantId: 'one', roles: ['reviewer'] },
		{ userId: 'bob', tenantId: 'one', roles: ['member'] },
		{ userId: 'eve', tenantId: 'two', roles: ['reviewer'] }
	] as RecipeIdentity[]) {
		h.as(identity);
		await assert.rejects(h.service.transition(identity.userId, { id: dto.id, version: 2, to: 'approved' }));
		assert.equal(h.writes(), before);
	}
	h.as({ userId: 'carol', tenantId: 'one', roles: ['reviewer'] });
	assert.equal((await h.service.transition('carol', { id: dto.id, version: 2, to: 'approved' })).state, 'approved');
});

test('recipe property: submitted approval data cannot change or disappear', async () => {
	const h = harness(approval);
	h.as({ userId: 'alice', tenantId: 'one', roles: [] });
	const dto = await h.service.create('alice', creation());
	await h.service.transition('alice', { id: dto.id, version: 1, to: 'submitted' });
	const before = h.writes();
	await assert.rejects(h.service.update('alice', { id: dto.id, version: 2, data: { title: 'altered' } }));
	await assert.rejects(h.service.remove('alice', { id: dto.id, version: 2 }));
	assert.equal(h.writes(), before);
	assert.equal(h.rows.get(dto.id)?.data.title, 'private');
});

test('recipe property: corrupt persisted envelopes fail before any mutation and private keys never project', async () => {
	const h = harness();
	const dto = await h.service.create('alice', creation());
	assert.deepEqual(Object.keys(dto).sort(), ['data', 'id', 'parentId', 'state', 'version']);
	const original = clone(h.rows.get(dto.id)!);
	h.repository.list = async () => [clone(h.rows.get(dto.id)!)];
	h.repository.find = async () => clone(h.rows.get(dto.id)!);
	for (const corruption of [
		{ _id: '$invalid' },
		{ ownerId: '' },
		{ version: 0 },
		{ version: 1.25 },
		{ version: Number.MAX_SAFE_INTEGER },
		{ state: 'not-declared' },
		{ parentId: 'foreign' },
		{ data: { title: 'private', secret: 'must-not-leak' } }
	]) {
		h.rows.set(dto.id, { ...original, ...corruption } as RecipeRecord);
		const before = h.writes();
		await assert.rejects(h.service.list('alice', { filters: {}, limit: 10 }));
		await assert.rejects(h.service.update('alice', { id: dto.id, version: 1, data: { title: 'altered' } }));
		await assert.rejects(h.service.transition('alice', { id: dto.id, version: 1, to: 'submitted' }));
		await assert.rejects(h.service.remove('alice', { id: dto.id, version: 1 }));
		assert.equal(h.writes(), before);
	}
});

test('recipe property: mutation replay binds the original payload and cannot resurrect a tombstone', async () => {
	const h = harness();
	const [a, b] = await Promise.all([h.service.create('alice', creation()), h.service.create('alice', creation())]);
	assert.equal(a.id, b.id);
	assert.equal(h.rows.size, 1);
	assert.equal(h.writes(), 1);
	await assert.rejects(h.service.create('alice', creation('request', 'replaced')));
	await h.service.remove('alice', { id: a.id, version: 1 });
	const before = h.writes();
	await assert.rejects(h.service.create('alice', creation()));
	assert.equal(h.writes(), before);
	assert.equal(h.rows.get(a.id)?.deleted, true);
	assert.deepEqual(h.rows.get(a.id)?.data, {});
	assert.deepEqual(await h.service.list('alice', { filters: {}, limit: 10 }), []);
});

test('recipe property: tombstones never project or permit writes even when an adapter returns them', async () => {
	const h = harness();
	const dto = await h.service.create('alice', creation());
	const tombstone = { ...clone(h.rows.get(dto.id)!), deleted: true };
	h.repository.list = async () => [clone(tombstone)];
	h.repository.find = async () => clone(tombstone);
	await assert.rejects(h.service.list('alice', { filters: {}, limit: 10 }));
	await assert.rejects(h.service.update('alice', { id: dto.id, version: 1, data: { title: 'resurrected' } }));
	await assert.rejects(h.service.remove('alice', { id: dto.id, version: 1 }));
	assert.equal(h.writes(), 1);
});

test('recipe property: transitions require declared edges and current versions', async () => {
	const h = harness();
	const dto = await h.service.create('alice', creation());
	await assert.rejects(h.service.transition('alice', { id: dto.id, version: 1, to: 'approved' }));
	await h.service.transition('alice', { id: dto.id, version: 1, to: 'submitted' });
	await assert.rejects(h.service.transition('alice', { id: dto.id, version: 1, to: 'submitted' }));
	await assert.rejects(h.service.update('alice', { id: dto.id, version: 1, data: { title: 'stale' } }));
	await assert.rejects(h.service.remove('alice', { id: dto.id, version: 1 }));
	assert.equal(h.writes(), 2);
});

test('recipe property: every child operation revalidates its currently authorized parent', async () => {
	const h = harness({ ...definition, profile: 'master-detail' });
	const dto = await h.service.create('alice', { ...creation(), parentId: 'parent' });
	h.revokeParent();
	await assert.rejects(h.service.list('alice', { filters: {}, limit: 10, parentId: 'parent' }));
	await assert.rejects(h.service.create('alice', { ...creation('next'), parentId: 'parent' }));
	await assert.rejects(h.service.update('alice', { id: dto.id, version: 1, data: { title: 'orphan' } }));
	await assert.rejects(h.service.transition('alice', { id: dto.id, version: 1, to: 'submitted' }));
	await assert.rejects(h.service.remove('alice', { id: dto.id, version: 1 }));
	assert.equal(h.writes(), 1);
});

test('recipe property: linked attachments require all three independent live permissions', async () => {
	for (let mask = 0; mask < 8; mask++) {
		const ports = {
			canReadDocument: async () => !!(mask & 1),
			linked: async () => !!(mask & 2),
			canReadFile: async () => !!(mask & 4)
		};
		if (mask === 7) await authorizeLinkedAttachment('alice', 'document', 'file', ports);
		else await assert.rejects(authorizeLinkedAttachment('alice', 'document', 'file', ports));
		await assert.rejects(authorizeLinkedAttachment(null, 'document', 'file', ports));
	}
});

test('recipe property: hostile fields and operation-supplied authority never reach writes', async () => {
	for (const name of ['ownerId', 'tenantId', 'userId', 'roles', 'constructor', '__proto__', '$where', 'nested.key'])
		assert.throws(() => validateDefinition({ ...definition, fields: [{ ...definition.fields[0], name }] }));
	const h = harness();
	for (const extra of [
		{ ownerId: 'mallory' },
		{ tenantId: 'foreign' },
		{ roles: ['reviewer'] },
		{ state: 'approved' },
		{ version: 99 }
	])
		await assert.rejects(h.service.create('alice', { ...creation(), ...extra }));
	for (const data of [
		{ title: { $ne: null } },
		{ title: 'safe', ownerId: 'mallory' },
		Object.create({ title: 'inherited' })
	])
		assert.throws(() => parseRecipeData(definition, data));
	assert.equal(h.writes(), 0);
});

test('recipe property: imports validate every row and terminal jobs never reopen', () => {
	assert.deepEqual(prepareImport(definition, [{ title: '=not-executed' }]), [{ title: '=not-executed' }]);
	for (let index = 0; index < 12; index++) {
		const rows: unknown[] = Array.from({ length: 12 }, () => ({ title: 'valid' }));
		rows[index] = { title: { $where: 'malicious' } };
		assert.throws(() => prepareImport(definition, rows));
	}
	assert.throws(() =>
		prepareImport(
			definition,
			Array.from({ length: 101 }, () => ({ title: 'valid' }))
		)
	);
	for (const terminal of ['succeeded', 'failed', 'cancelled'] as const)
		for (const next of ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const)
			assert.throws(() => jobTransition(terminal, next));
});

test('recipe property: accepted metadata is dense plain data without executable coercion hooks', () => {
	let invoked = 0;
	const coercible = {
		toString() {
			invoked++;
			return 'owner';
		}
	};
	const cases: unknown[] = [
		{ ...definition, profile: coercible },
		{ ...definition, states: Array(1) },
		{ ...definition, filters: Array(1) },
		{ ...definition, permissions: { read: Array(1), write: ['owner'] } },
		{ ...definition, transitions: [{ from: 'draft', to: 'submitted', roles: Array(1) }] },
		{
			...definition,
			transitions: [
				{
					from: {
						toString() {
							invoked++;
							return 'draft';
						}
					},
					to: 'submitted',
					roles: ['owner']
				}
			]
		},
		{
			...definition,
			fields: Object.assign([...definition.fields], {
				toJSON() {
					invoked++;
					return [];
				}
			})
		}
	];
	const accessor = { ...definition };
	Object.defineProperty(accessor, 'profile', {
		enumerable: true,
		get() {
			invoked++;
			return 'owner';
		}
	});
	cases.push(accessor);
	for (const value of cases) assert.throws(() => validateDefinition(value));
	assert.equal(invoked, 0);
	const accepted = validateDefinition(definition);
	assert.deepEqual(accepted, definition);
	accepted.states[0] = 'changed';
	assert.equal(definition.states[0], 'draft');
});

test('recipe property: sparse or executable import arrays reject without running user hooks', () => {
	let invoked = 0;
	for (const rows of [
		Array(1),
		Object.assign([{ title: 'safe' }], {
			toJSON() {
				invoked++;
				return [];
			}
		}),
		[
			{
				title: 'safe',
				toJSON() {
					invoked++;
					return { title: 'safe' };
				}
			}
		]
	])
		assert.throws(() => prepareImport(definition, rows));
	const rows = [{ title: 'safe' }];
	Object.defineProperty(rows, '0', {
		enumerable: true,
		get() {
			invoked++;
			return { title: 'safe' };
		}
	});
	assert.throws(() => prepareImport(definition, rows));
	assert.equal(invoked, 0);
});

test('recipe property: repository reads cannot redirect mutations to another same-scope id', async () => {
	const h = harness();
	const first = await h.service.create('alice', creation('first'));
	const second = await h.service.create('alice', creation('second', 'unrelated'));
	h.repository.find = async () => clone(h.rows.get(second.id)!);
	const before = h.writes();
	await assert.rejects(h.service.update('alice', { id: first.id, version: 1, data: { title: 'redirected' } }));
	await assert.rejects(h.service.transition('alice', { id: first.id, version: 1, to: 'submitted' }));
	await assert.rejects(h.service.remove('alice', { id: first.id, version: 1 }));
	assert.equal(h.writes(), before);
	assert.equal(h.rows.get(second.id)?.data.title, 'unrelated');
});

test('recipe property: replay rejects deleted receipts even if historical data remains', async () => {
	const h = harness();
	const dto = await h.service.create('alice', creation());
	h.rows.set(dto.id, { ...h.rows.get(dto.id)!, deleted: true });
	await assert.rejects(h.service.create('alice', creation()));
	assert.equal(h.writes(), 1);
});
