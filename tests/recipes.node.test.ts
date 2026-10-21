import test from 'node:test';
import assert from 'node:assert/strict';
import {
	validateDefinition,
	parseRecipeData,
	parseRecipeFilters,
	type RecipeDefinition
} from '../imports/core/recipes/definition';
import {
	recipeService,
	type RecipeRecord,
	type RecipeRepository,
	type RecipeScope
} from '../imports/core/recipes/server/engine';
import { authorizeLinkedAttachment } from '../imports/core/recipes/server/attachments';
import { prepareImport, jobTransition } from '../imports/core/recipes/batch';
const base: RecipeDefinition = {
	schemaVersion: 1,
	name: 'notes',
	profile: 'owner',
	fields: [
		{ name: 'title', label: 'Title', type: 'string', required: true, maxLength: 80 },
		{ name: 'count', label: 'Count', type: 'integer', required: true, min: 0, max: 100 }
	],
	filters: ['title'],
	states: ['draft', 'submitted', 'approved'],
	transitions: [{ from: 'draft', to: 'submitted', roles: ['owner'] }],
	permissions: { read: ['owner'], write: ['owner'] }
};
function fixture(definition: RecipeDefinition = base) {
	const rows = new Map<string, RecipeRecord>();

	const matches = (s: RecipeScope, r: RecipeRecord) =>
		Object.entries(s).every(([k, v]) => (k === 'tenantId' ? (r.tenantId ?? null) : r[k as keyof RecipeRecord]) === v);
	const repo: RecipeRepository = {
		find: async (s, id) => {
			const r = rows.get(id);
			return r && !r.deleted && matches(s, r) ? structuredClone(r) : null;
		},
		list: async (s, f, l) =>
			[...rows.values()]
				.filter((r) => !r.deleted && matches(s, r) && Object.entries(f).every(([k, v]) => r.data[k] === v))
				.slice(0, l)
				.map((r) => structuredClone(r)),
		insert: async (r) => {
			if (rows.has(r._id)) return structuredClone(rows.get(r._id)!);
			rows.set(r._id, structuredClone(r));
			return structuredClone(r);
		},
		compareAndSet: async (s, id, v, next) => {
			const r = rows.get(id);
			if (!r || !matches(s, r) || r.version !== v) return false;
			rows.set(id, { ...r, ...structuredClone(next) });
			return true;
		},
		remove: async (s, id, v) => {
			const r = rows.get(id);
			if (!r || !matches(s, r) || r.version !== v) return false;
			rows.set(id, { ...r, deleted: true, data: {}, version: v + 1 });
			return true;
		}
	};
	const service = recipeService(definition, {
		repository: repo,
		resolveIdentity: async (userId) => {
			if (userId === 'disabled') throw new Error('inactive');
			return {
				userId,
				...(['team', 'approval'].includes(definition.profile)
					? { tenantId: userId.startsWith('other') ? 'other' : 'tenant' }
					: {}),
				roles: userId.includes('reviewer') ? ['member', 'reviewer'] : ['member']
			};
		},
		parentExists: async (s, id) => id === `parent-${s.ownerId}`
	});
	return { service, rows, repo };
}
test('strict definition and DTO reject reserved keys, unknown options and operators', () => {
	for (const name of ['ownerId', 'tenantId', 'constructor', 'prototype', '$where', 'x.y'])
		assert.throws(() => validateDefinition({ ...base, fields: [{ ...base.fields[0], name }] }));
	assert.throws(() => validateDefinition({ ...base, foo: true }));
	assert.throws(() => validateDefinition({ ...base, fields: [{ ...base.fields[0], maxLength: Infinity }] }));
	assert.throws(() => parseRecipeData(base, { title: 'x', count: 1, ownerId: 'victim' }));
	assert.throws(() => parseRecipeData(base, { title: { $regex: '.*' }, count: 1 }));
	assert.throws(() => parseRecipeFilters(base, { $where: 'x' }));
	assert.deepEqual(parseRecipeData(base, { title: 'ok', count: 1 }), { title: 'ok', count: 1 });
});
test('owner-isolation property across multiple owners and every operation', async () => {
	const { service } = fixture();
	for (let i = 0; i < 20; i++) {
		const owner = `owner${i}`,
			attacker = `attacker${i}`;
		const row = await service.create(owner, {
			mutationId: 'create1',
			data: { title: 'private', count: i },
			parentId: null
		});
		assert.deepEqual(await service.list(attacker, { filters: {}, limit: 100 }), []);
		await assert.rejects(service.update(attacker, { id: row.id, version: 1, data: { title: 'stolen', count: 0 } }));
		await assert.rejects(service.transition(attacker, { id: row.id, version: 1, to: 'submitted' }));
		await assert.rejects(service.remove(attacker, { id: row.id, version: 1 }));
	}
});
test('identity is server-owned; inactive/anonymous denied and projection strips ownership', async () => {
	const { service } = fixture();
	await assert.rejects(service.create(null, { mutationId: 'create1', data: { title: 'x', count: 0 }, parentId: null }));
	await assert.rejects(
		service.create('disabled', { mutationId: 'create1', data: { title: 'x', count: 0 }, parentId: null })
	);
	await assert.rejects(
		service.create('owner', {
			mutationId: 'create1',
			data: { title: 'x', count: 0 },
			parentId: null,
			tenantId: 'victim'
		})
	);
	const row = await service.create('owner', { mutationId: 'create1', data: { title: 'x', count: 0 }, parentId: null });
	assert.deepEqual(Object.keys(row).sort(), ['data', 'id', 'parentId', 'state', 'version']);
});
test('compare and set admits one winner and refuses stale deletion', async () => {
	const { service } = fixture();
	const row = await service.create('owner', { mutationId: 'create1', data: { title: 'x', count: 0 }, parentId: null });
	const results = await Promise.allSettled(
		[1, 2].map((count) => service.update('owner', { id: row.id, version: 1, data: { title: 'new', count } }))
	);
	assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
	await assert.rejects(service.remove('owner', { id: row.id, version: 1 }));
});
test('team membership from resolver scopes tenant and never honors tenant in input', async () => {
	const { service } = fixture({ ...base, profile: 'team', permissions: { read: ['member'], write: ['member'] } });
	await service.create('alice', { mutationId: 'create1', data: { title: 'shared', count: 0 }, parentId: null });
	assert.equal((await service.list('bob', { filters: {}, limit: 100 })).length, 1);
	assert.deepEqual(await service.list('otherbob', { filters: {}, limit: 100 }), []);
	await assert.rejects(service.list('bob', { filters: { tenantId: 'other' }, limit: 100 }));
});
test('approval requires reviewer, denies self-approval and changes to submitted data', async () => {
	const { service } = fixture({
		...base,
		profile: 'approval',
		permissions: { read: ['owner', 'reviewer'], write: ['owner'] },
		transitions: [...base.transitions, { from: 'submitted', to: 'approved', roles: ['reviewer'] }]
	});
	const row = await service.create('reviewerOwner', {
		mutationId: 'create1',
		data: { title: 'claim', count: 1 },
		parentId: null
	});
	await service.transition('reviewerOwner', { id: row.id, version: 1, to: 'submitted' });
	await assert.rejects(service.transition('reviewerOwner', { id: row.id, version: 2, to: 'approved' }));
	await assert.rejects(service.transition('bob', { id: row.id, version: 2, to: 'approved' }));
	await assert.rejects(service.transition('otherreviewer', { id: row.id, version: 2, to: 'approved' }));
	await assert.rejects(
		service.update('reviewerOwner', { id: row.id, version: 2, data: { title: 'changed', count: 2 } })
	);
	await assert.rejects(service.remove('reviewerOwner', { id: row.id, version: 2 }));
	const approved = await service.transition('reviewerBob', { id: row.id, version: 2, to: 'approved' });
	assert.equal(approved.state, 'approved');
});
test('master-detail requires owned parent and refuses cross-owner link', async () => {
	const { service } = fixture({ ...base, profile: 'master-detail' });
	await assert.rejects(
		service.create('alice', { mutationId: 'create1', data: { title: 'child', count: 0 }, parentId: 'parent-bob' })
	);
	const row = await service.create('alice', {
		mutationId: 'create1',
		data: { title: 'child', count: 0 },
		parentId: 'parent-alice'
	});
	assert.equal(row.parentId, 'parent-alice');
	assert.equal((await service.list('alice', { filters: {}, limit: 10, parentId: 'parent-alice' })).length, 1);
	await assert.rejects(service.list('alice', { filters: {}, limit: 10, parentId: 'parent-bob' }));
	await assert.rejects(service.list('alice', { filters: {}, limit: 10 }));
});
test('linked attachment requires independent document, link and file authorization', async () => {
	for (const values of [
		[false, true, true],
		[true, false, true],
		[true, true, false]
	])
		await assert.rejects(
			authorizeLinkedAttachment('u', 'd', 'f', {
				canReadDocument: async () => values[0],
				linked: async () => values[1],
				canReadFile: async () => values[2]
			})
		);
	await authorizeLinkedAttachment('u', 'd', 'f', {
		canReadDocument: async () => true,
		linked: async () => true,
		canReadFile: async () => true
	});
});
test('imports validate entire bounded batch before writes; job terminal states do not revive', () => {
	assert.equal(prepareImport(base, [{ title: 'a', count: 1 }]).length, 1);
	assert.throws(() =>
		prepareImport(base, [
			{ title: 'a', count: 1 },
			{ title: 'b', count: -1 }
		])
	);
	assert.throws(() => prepareImport(base, Array(101).fill({ title: 'a', count: 1 })));
	for (const terminal of ['succeeded', 'failed', 'cancelled'] as const)
		for (const next of ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const)
			assert.throws(() => jobTransition(terminal, next));
	assert.equal(jobTransition('queued', 'running'), 'running');
});

test('creation replay is bounded to verified owner, identical payload and surviving tombstone', async () => {
	const { service, rows } = fixture();
	const input = { mutationId: 'request1', data: { title: 'first', count: 1 }, parentId: null };
	const [a, b] = await Promise.all([service.create('alice', input), service.create('alice', input)]);
	assert.equal(a.id, b.id);
	assert.equal(rows.size, 1);
	await assert.rejects(service.create('alice', { ...input, data: { title: 'different', count: 1 } }));
	const other = await service.create('bob', input);
	assert.notEqual(a.id, other.id);
	await service.remove('alice', { id: a.id, version: 1 });
	assert.deepEqual(await service.list('alice', { filters: {}, limit: 100 }), []);
	await assert.rejects(service.create('alice', input));
	assert.deepEqual(rows.get(a.id)?.data, {});
});
test('tenant revocation and scope changes take effect on the next request', async () => {
	const { repo } = fixture();
	let active = true;
	let tenantId = 'tenant1';
	const service = recipeService(
		{ ...base, profile: 'team', permissions: { read: ['member'], write: ['member'] } },
		{
			repository: repo,
			resolveIdentity: async (userId) => {
				if (!active) throw new Error('Membership revoked');
				return { userId, tenantId, roles: ['member'] };
			}
		}
	);
	const row = await service.create('alice', { mutationId: 'm1', data: { title: 'private', count: 1 }, parentId: null });
	tenantId = 'tenant2';
	assert.deepEqual(await service.list('alice', { filters: {}, limit: 10 }), []);
	await assert.rejects(service.update('alice', { id: row.id, version: 1, data: { title: 'moved', count: 1 } }));
	active = false;
	await assert.rejects(service.list('alice', { filters: {}, limit: 10 }));
	await assert.rejects(service.create('alice', { mutationId: 'm2', data: { title: 'x', count: 1 }, parentId: null }));
});
test('defensive projection rejects a repository that ignores ownership or returns excessive rows', async () => {
	const { repo, rows, service } = fixture();
	await service.create('alice', { mutationId: 'm1', data: { title: 'private', count: 1 }, parentId: null });
	repo.list = async () => [...rows.values()];
	await assert.rejects(service.list('bob', { filters: {}, limit: 10 }));
	repo.list = async () => Array(11).fill([...rows.values()][0]);
	await assert.rejects(service.list('alice', { filters: {}, limit: 10 }));
	repo.find = async () => [...rows.values()][0];
	await assert.rejects(service.remove('bob', { id: [...rows.keys()][0], version: 1 }));
});
test('attachment access revalidates current tenant and both independent resources', async () => {
	let tenant = 'one';
	const ports = {
		canReadDocument: async () => tenant === 'one',
		linked: async () => true,
		canReadFile: async () => tenant === 'one'
	};
	await authorizeLinkedAttachment('alice', 'doc', 'file', ports);
	tenant = 'two';
	await assert.rejects(authorizeLinkedAttachment('alice', 'doc', 'file', ports));
	await assert.rejects(authorizeLinkedAttachment(null, 'doc', 'file', ports));
});

test('same owner cannot cross personal and tenant scopes including a faulty repository', async () => {
	const { repo, rows } = fixture();
	let tenantId: string | undefined = 'one';
	const service = recipeService(base, {
		repository: repo,
		resolveIdentity: async (userId) => ({ userId, tenantId, roles: [] })
	});
	const tenant = await service.create('alice', {
		mutationId: 'm',
		data: { title: 'tenant', count: 1 },
		parentId: null
	});
	tenantId = 'two';
	assert.deepEqual(await service.list('alice', { filters: {}, limit: 10 }), []);
	tenantId = undefined;
	assert.deepEqual(await service.list('alice', { filters: {}, limit: 10 }), []);
	await assert.rejects(service.update('alice', { id: tenant.id, version: 1, data: { title: 'stolen', count: 1 } }));
	const personal = await service.create('alice', {
		mutationId: 'm',
		data: { title: 'personal', count: 1 },
		parentId: null
	});
	assert.notEqual(personal.id, tenant.id);
	tenantId = 'one';
	assert.deepEqual(
		(await service.list('alice', { filters: {}, limit: 10 })).map((r) => r.id),
		[tenant.id]
	);
	await assert.rejects(service.remove('alice', { id: personal.id, version: 1 }));
	tenantId = undefined;
	repo.list = async () => [rows.get(tenant.id)!];
	repo.find = async () => rows.get(tenant.id)!;
	await assert.rejects(service.list('alice', { filters: {}, limit: 10 }));
	await assert.rejects(service.remove('alice', { id: tenant.id, version: 1 }));
});
test('projection and mutations reject corrupted persisted DTO envelope before writes', async () => {
	const { service, rows } = fixture();
	const row = await service.create('alice', { mutationId: 'm', data: { title: 'x', count: 1 }, parentId: null });
	const original = structuredClone(rows.get(row.id)!);
	for (const corruption of [
		{ _id: '$bad' },
		{ version: 0 },
		{ version: 1.5 },
		{ version: Number.MAX_SAFE_INTEGER },
		{ state: 'unknown' },
		{ parentId: 'unexpected' }
	]) {
		rows.set(row.id, { ...original, ...corruption });
		await assert.rejects(service.list('alice', { filters: {}, limit: 10 }));
		await assert.rejects(service.update('alice', { id: row.id, version: 1, data: { title: 'overwrite', count: 1 } }));
		assert.equal(rows.get(row.id)?.data.title, 'x');
	}
});
