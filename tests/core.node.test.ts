import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strictObject, string } from '../imports/core/contracts/schema';
import { activeAccountContext } from '../imports/core/server/identity';
import { operationHandler, OperationError, type Invocation } from '../imports/core/server/operations';
import { ownerScope, scopeSelector, tenantScope, type Scope } from '../imports/core/server/policy';
import { transactionRunner } from '../imports/core/server/transaction';
import { createTaskOperations } from '../imports/modules/tasks/server/operations';
import type { TaskRecord, TaskRepository } from '../imports/modules/tasks/server/repository';

function fixture() {
  const rows = new Map<string, TaskRecord>();
  let reads = 0;
  const matches = (scope: Scope, row: TaskRecord) => scope.kind === 'owner' ? row.ownerId === scope.ownerId && row.tenantId === null : row.tenantId === scope.tenantId;
  const repository: TaskRepository = {
    async insert(row) { if (!rows.has(row._id)) rows.set(row._id, { ...row }); return { ...rows.get(row._id)! }; },
    async get(scope, id) { reads++; const row = rows.get(id); return row && row.deletedAt === null && matches(scope, row) ? { ...row } : null; },
    async list(scope, after, limit) { reads++; return [...rows.values()].filter(row => row.deletedAt === null && matches(scope, row) && (!after || row._id > after)).sort((a, b) => a._id.localeCompare(b._id)).slice(0, limit); },
    async update(scope, id, version, patch) { const row = rows.get(id); if (!row || row.deletedAt !== null || !matches(scope, row) || row.version !== version) return false; rows.set(id, { ...row, ...patch, version: version + 1 }); return true; },
    async remove(scope, id, version) { const row = rows.get(id); if (!row || row.deletedAt !== null || !matches(scope, row) || row.version !== version) return false; rows.set(id, { ...row, deletedAt: 2000, version: version + 1 }); return true; }
  };
  const operations = createTaskOperations(repository, () => 1000);
  const context = activeAccountContext(async id => ['alice', 'bob'].includes(id), () => 'request');
  return { rows, reads: () => reads, operations, context, call: <I, O>(op: Parameters<typeof operationHandler<I, O>>[0], userId: Invocation['userId'], ...args: unknown[]) => operationHandler(op, context).apply({ userId }, args) };
}

test('strict DTO rejects inherited, unknown, missing, array and injected context fields', () => {
  const schema = strictObject({ title: string(1, 10) });
  for (const bad of [{ title: 'ok', userId: 'alice' }, { title: 'ok', [Symbol('hidden')]: 'unknown' }, {}, [], Object.create({ title: 'ok' }), { title: { $ne: '' } }, null]) assert.throws(() => schema.parse(bad));
  assert.deepEqual(schema.parse({ title: 'ok' }), { title: 'ok' });
});
test('single DTO boundary prevents context shifting and blocks anonymous/disabled before data access', async () => {
  const f = fixture();
  await assert.rejects(f.call(f.operations.list, 'alice', { after: null, limit: 10 }, { userId: 'bob' }), { code: 'invalid-input' });
  await assert.rejects(f.call(f.operations.list, null, { after: null, limit: 10 }), { code: 'unauthenticated' });
  await assert.rejects(f.call(f.operations.list, 'disabled', { after: null, limit: 10 }), { code: 'forbidden' });
  assert.equal(f.reads(), 0);
});
test('owner CRUD projects every response and rejects cross-owner read/write/delete', async () => {
  const f = fixture();
  const task = await f.call(f.operations.create, 'alice', { mutationId: 'create-1', title: '  First  ' });
  assert.equal(task.title, 'First'); assert.equal('ownerId' in task, false); assert.equal('tenantId' in task, false);
  await assert.rejects(f.call(f.operations.get, 'bob', { id: task.id }), { code: 'not-found' });
  assert.deepEqual(await f.call(f.operations.list, 'bob', { after: null, limit: 10 }), { items: [], next: null });
  await assert.rejects(f.call(f.operations.update, 'bob', { id: task.id, version: 1, title: 'stolen', status: 'done' }), { code: 'conflict' });
  await assert.rejects(f.call(f.operations.remove, 'bob', { id: task.id, version: 1 }), { code: 'conflict' });
  assert.equal((await f.call(f.operations.get, 'alice', { id: task.id })).title, 'First');
  await assert.rejects(f.call(f.operations.create, 'alice', { title: 'x', ownerId: 'bob' }), { code: 'invalid-input' });
});
test('CAS allows only one concurrent write, stale delete fails, projected delete succeeds', async () => {
  const f = fixture(); const task = await f.call(f.operations.create, 'alice', { mutationId: 'create-1', title: 'First' });
  const results = await Promise.allSettled(['A', 'B'].map(title => f.call(f.operations.update, 'alice', { id: task.id, version: 1, title, status: 'done' })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await f.call(f.operations.get, 'alice', { id: task.id })).version, 2);
  await assert.rejects(f.call(f.operations.remove, 'alice', { id: task.id, version: 1 }), { code: 'conflict' });
  assert.deepEqual(await f.call(f.operations.remove, 'alice', { id: task.id, version: 2 }), { deleted: true });
});
test('pagination advances and owner scope cannot include tenant records', async () => {
  const f = fixture(); for (let i = 0; i < 3; i++) await f.call(f.operations.create, 'alice', { mutationId: `create-${i}`, title: `task ${i}` });
  const ids = [...f.rows.keys()].sort(); f.rows.get(ids[2])!.tenantId = 'secret-tenant';
  const page = await f.call(f.operations.list, 'alice', { after: null, limit: 1 });
  assert.equal(page.next, ids[0]);
  const last = await f.call(f.operations.list, 'alice', { after: page.next, limit: 1 });
  assert.equal(last.items[0].id, ids[1]); assert.equal(last.next, null);
  await assert.rejects(f.call(f.operations.list, 'alice', { after: null, limit: 0 }));
  assert.deepEqual(scopeSelector(ownerScope({ userId: 'alice', requestId: 'r' })), { ownerId: 'alice', tenantId: null });
});
test('tenant policy uses verified current membership and denies role, revocation and forged identity', async () => {
  const ctx = { userId: 'alice', requestId: 'r' }; let active = true;
  const lookup = async () => ({ userId: 'alice', tenantId: 't1', role: 'editor' as const, active });
  assert.deepEqual(await tenantScope(ctx, 't1', ['editor'], lookup), { kind: 'tenant', tenantId: 't1' });
  await assert.rejects(tenantScope(ctx, 't2', ['editor'], lookup), { code: 'forbidden' });
  await assert.rejects(tenantScope(ctx, 't1', ['admin'], lookup), { code: 'forbidden' });
  active = false; await assert.rejects(tenantScope(ctx, 't1', ['editor'], lookup), { code: 'forbidden' });
  await assert.rejects(tenantScope({ ...ctx, userId: 'bob' }, 't1', ['editor'], lookup), { code: 'forbidden' });
  await assert.rejects(tenantScope(ctx, 't1', ['admin'], async () => null), { code: 'forbidden' });
});
test('output schema refuses accidental private-field leakage and policy denies before handler', async () => {
  const f = fixture(); let called = false;
  const denied = { ...f.operations.create, policy: async () => { throw new OperationError('forbidden'); }, handler: async () => { called = true; throw new Error(); } };
  await assert.rejects(f.call(denied, 'alice', { mutationId: 'create-1', title: 'x' }), { code: 'forbidden' }); assert.equal(called, false);
  const leaking = { ...f.operations.create, handler: async () => ({ id: 'id', title: 'x', status: 'open' as const, version: 1, createdAt: 1, updatedAt: 1, privateToken: 'secret' }) };
  await assert.rejects(f.call(leaking, 'alice', { mutationId: 'create-1', title: 'x' }));
});
test('transaction port propagates rollback errors and always closes session', async () => {
  let closed = false; let bound = false;
  const session = { withTransaction: async <T>(work: () => Promise<T>) => work(), endSession: async () => { closed = true; } };
  const runner = transactionRunner(() => session, actual => { bound = actual === session; return { id: 'bound' }; });
  await assert.rejects(runner.run(async () => { throw new Error('rollback'); }), /rollback/);
  assert.ok(bound && closed);
});

test('create mutation replay is concurrent-safe, payload-bound, owner-bound and never resurrects a tombstone', async () => {
  const f = fixture(); const input = { mutationId: 'same-retry', title: 'original' };
  const [a, b] = await Promise.all([f.call(f.operations.create, 'alice', input), f.call(f.operations.create, 'alice', input)]);
  assert.equal(a.id, b.id); assert.equal(f.rows.size, 1);
  await assert.rejects(f.call(f.operations.create, 'alice', { ...input, title: 'changed' }), { code: 'conflict' });
  const other = await f.call(f.operations.create, 'bob', input); assert.notEqual(other.id, a.id);
  assert.equal('mutationId' in a, false); assert.equal('creationTitle' in a, false);
  await f.call(f.operations.remove, 'alice', { id: a.id, version: 1 });
  await assert.rejects(f.call(f.operations.create, 'alice', input), { code: 'not-found' });
  assert.deepEqual(await f.call(f.operations.list, 'alice', { after: null, limit: 10 }), { items: [], next: null });
  assert.equal(f.rows.size, 2);
});

import "./form-login.node.test";
