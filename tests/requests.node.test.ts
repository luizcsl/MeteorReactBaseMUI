import test from 'node:test';
import assert from 'node:assert/strict';
import { requestService, type RequestRecord, type RequestRepository } from '../imports/modules/requests/server/service';
import { createRequestOperations } from '../imports/modules/requests/server/operations';
import { operationHandler, type ContextBuilder } from '../imports/core/server/operations';
function fixture() {
	const rows = new Map<string, RequestRecord>();
	let assigned: string | null = 'reviewer';
	const clone = <T>(value: T): T => structuredClone(value);
	const repository: RequestRepository = {
		async insert(row) {
			if (!rows.has(row._id)) rows.set(row._id, clone(row));
			return clone(rows.get(row._id)!);
		},
		async get(userId, id) {
			const row = rows.get(id);
			return row && (row.ownerId === userId || row.reviewerId === userId) ? clone(row) : null;
		},
		async list(userId, limit) {
			return [...rows.values()]
				.filter((row) => row.ownerId === userId || row.reviewerId === userId)
				.slice(0, limit)
				.map(clone);
		},
		async compareAndSet(userId, id, version, next) {
			const row = rows.get(id);
			if (!row || row.version !== version || ![row.ownerId, row.reviewerId].includes(userId)) return false;
			rows.set(id, { ...row, ...clone(next) });
			return true;
		}
	};
	const ports = {
		repository,
		assignedReviewer: async (ownerId: string) => (ownerId === 'alice' ? assigned : null),
		now: () => 123
	};
	return {
		rows,
		repository,
		service: requestService(ports),
		ports,
		revoke: () => {
			assigned = null;
		},
		self: () => {
			assigned = 'alice';
		}
	};
}
test('complete request/items/approval/history journey projects only public fields', async () => {
	const { service } = fixture();
	const created = await service.create('alice', { title: 'Purchase', mutationId: 'one' });
	const item = await service.addItem('alice', {
		id: created.id,
		version: 1,
		item: { description: 'Paper', quantity: 3, unitPrice: 1010 }
	});
	assert.equal(item.total, 3030);
	const sent = await service.submit('alice', { id: item.id, version: 2 });
	const inbox = await service.list('reviewer', 10);
	assert.equal(inbox[0].id, sent.id);
	assert.equal(inbox[0].canReview, true);
	const approved = await service.decide('reviewer', { id: sent.id, version: 3, decision: 'approved' });
	assert.equal(approved.state, 'approved');
	assert.equal(approved.canReview, false);
	assert.deepEqual(
		approved.history.map((e) => e.action),
		['created', 'item-added', 'submitted', 'approved']
	);
	assert.deepEqual(
		approved.history.map((e) => e.version),
		[1, 2, 3, 4]
	);
	assert.deepEqual(Object.keys(approved).sort(), [
		'canEdit',
		'canReview',
		'history',
		'id',
		'items',
		'state',
		'title',
		'total',
		'version'
	]);
	assert.equal((await service.get('alice', sent.id)).state, 'approved');
	await assert.rejects(
		service.addItem('alice', { id: sent.id, version: 4, item: { description: 'Later', quantity: 1, unitPrice: 1 } }),
		{ code: 'forbidden' }
	);
});
test('unauthorized actors, self approval, empty submission and changed create replay are denied', async () => {
	const f = fixture(),
		row = await f.service.create('alice', { title: 'Purchase', mutationId: 'one' });
	await assert.rejects(f.service.create('alice', { title: 'Other', mutationId: 'one' }), { code: 'conflict' });
	await assert.rejects(f.service.submit('alice', { id: row.id, version: 1 }), { code: 'invalid-input' });
	for (const who of ['outsider', 'reviewer'])
		await assert.rejects(
			f.service.addItem(who, { id: row.id, version: 1, item: { description: 'Bad', quantity: 1, unitPrice: 1 } })
		);
	await assert.rejects(f.service.get('outsider', row.id), { code: 'not-found' });
	await f.service.addItem('alice', {
		id: row.id,
		version: 1,
		item: { description: 'Item', quantity: 1, unitPrice: 100 }
	});
	await f.service.submit('alice', { id: row.id, version: 2 });
	await assert.rejects(f.service.decide('alice', { id: row.id, version: 3, decision: 'approved' }), {
		code: 'forbidden'
	});
	f.self();
	await assert.rejects(f.service.create('alice', { title: 'Self', mutationId: 'two' }), { code: 'forbidden' });
});
test('CAS keeps items, state and history atomic with exactly one concurrent winner', async () => {
	const { service, rows } = fixture(),
		row = await service.create('alice', { title: 'Purchase', mutationId: 'one' });
	const results = await Promise.allSettled(
		[1, 2].map((n) =>
			service.addItem('alice', { id: row.id, version: 1, item: { description: 'Item' + n, quantity: 1, unitPrice: n } })
		)
	);
	assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
	assert.equal(rows.get(row.id)?.items.length, 1);
	assert.equal(rows.get(row.id)?.history.length, 2);
	await service.submit('alice', { id: row.id, version: 2 });
	const decisions = await Promise.allSettled(
		(['approved', 'rejected'] as const).map((decision) =>
			service.decide('reviewer', { id: row.id, version: 3, decision })
		)
	);
	assert.equal(decisions.filter((r) => r.status === 'fulfilled').length, 1);
	assert.equal(rows.get(row.id)?.history.length, 4);
});
test('revoking an assignment removes review access and prevents draft submission', async () => {
	const f = fixture(),
		row = await f.service.create('alice', { title: 'Purchase', mutationId: 'one' });
	await f.service.addItem('alice', {
		id: row.id,
		version: 1,
		item: { description: 'Item', quantity: 1, unitPrice: 1 }
	});
	f.revoke();
	await assert.rejects(f.service.get('reviewer', row.id), { code: 'not-found' });
	assert.deepEqual(await f.service.list('reviewer', 10), []);
	await assert.rejects(f.service.submit('alice', { id: row.id, version: 2 }), { code: 'forbidden' });
	assert.equal((await f.service.get('alice', row.id)).version, 2);
});
test('registered operation contracts reject forged identity, prices and extra arguments', async () => {
	const f = fixture(),
		ops = createRequestOperations(f.ports);
	const context: ContextBuilder = async ({ userId }) => ({ userId: userId!, requestId: 'test' });
	const create = operationHandler(ops.create, context).bind({ userId: 'alice' });
	await assert.rejects(create({ title: 'x', mutationId: 'one', reviewerId: 'alice' }), { code: 'invalid-input' });
	await assert.rejects(create({ title: 'x', mutationId: 'one' }, { userId: 'reviewer' }), { code: 'invalid-input' });
	const row = await create({ title: 'x', mutationId: 'one' });
	const add = operationHandler(ops.addItem, context).bind({ userId: 'alice' });
	await assert.rejects(add({ id: row.id, version: 1, item: { description: 'Item', quantity: 1, unitPrice: 0.1 } }), {
		code: 'invalid-input'
	});
	assert.equal(f.rows.get(row.id)?.history.length, 1);
});
