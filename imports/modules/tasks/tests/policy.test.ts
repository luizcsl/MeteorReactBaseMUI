/// <reference types="mocha" />
/** Meteor/Mongo integration suite. Import only from the SERVER test entrypoint. */
import assert from 'node:assert/strict';
import { Meteor } from 'meteor/meteor';
import { DDP } from 'meteor/ddp';
import { registerOperation } from '../../../core/server/meteor';
import { activeAccountContext } from '../../../core/server/identity';
import { createTaskOperations } from '../server/operations';
import { taskRepository, TasksCollection } from '../server/repository';
import type { TaskDto } from '../contracts';

type RegisteredMethod = (this: { userId: string | null }, ...args: unknown[]) => Promise<unknown>;
const methods = () => (Meteor as unknown as { server: { method_handlers: Record<string, RegisteredMethod> } }).server.method_handlers;
const alice = 'tasks-test-alice';
const bob = 'tasks-test-bob';
const prefix = 'tasks.integration.';
const context = activeAccountContext(async id => id === alice || id === bob, () => 'integration-request');

if (Meteor.isServer) describe('tasks registered Meteor boundary and Mongo CAS', function () {
  this.timeout(20_000);
  before(async function () {
    const operations = createTaskOperations(taskRepository);
    registerOperation({ ...operations.create, name: prefix + 'create' }, context);
    registerOperation({ ...operations.get, name: prefix + 'get' }, context);
    registerOperation({ ...operations.list, name: prefix + 'list' }, context);
    registerOperation({ ...operations.update, name: prefix + 'update' }, context);
    registerOperation({ ...operations.remove, name: prefix + 'remove' }, context);
    await TasksCollection.removeAsync({ ownerId: { $in: [alice, bob] } });
  });
  after(async () => { await TasksCollection.removeAsync({ ownerId: { $in: [alice, bob] } }); });
  const invoke = (operation: string, userId: string | null, ...args: unknown[]) => methods()[prefix + operation].apply({ userId }, args);

  it('rejects anonymous, inactive, extra arguments and unknown fields at registered wrapper', async function () {
    await assert.rejects(invoke('list', null, { after: null, limit: 5 }), { error: 'unauthenticated' });
    await assert.rejects(invoke('list', 'disabled', { after: null, limit: 5 }), { error: 'forbidden' });
    await assert.rejects(invoke('list', bob, { after: null, limit: 5 }, { userId: alice }), { error: 'invalid-input' });
    await assert.rejects(invoke('create', bob, { title: 'x', ownerId: alice }), { error: 'invalid-input' });
  });
  it('isolates owners and performs an atomic version-conditioned Mongo write', async function () {
    const [task, replay] = await Promise.all([
      invoke('create', alice, { mutationId: 'mongo-create', title: 'Mongo task' }),
      invoke('create', alice, { mutationId: 'mongo-create', title: 'Mongo task' })
    ]) as [TaskDto, TaskDto];
    assert.equal('ownerId' in task, false);
    assert.equal(replay.id, task.id);
    await assert.rejects(invoke('create', alice, { mutationId: 'mongo-create', title: 'changed payload' }), { error: 'conflict' });
    await assert.rejects(invoke('get', bob, { id: task.id }), { error: 'not-found' });
    await assert.rejects(invoke('remove', bob, { id: task.id, version: 1 }), { error: 'conflict' });
    const results = await Promise.allSettled(['A', 'B'].map(title => invoke('update', alice, { id: task.id, version: 1, title, status: 'done' })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const current = await invoke('get', alice, { id: task.id }) as TaskDto;
    assert.equal(current.version, 2);
    assert.deepEqual(await invoke('remove', alice, { id: task.id, version: 2 }), { deleted: true });
    await assert.rejects(invoke('create', alice, { mutationId: 'mongo-create', title: 'Mongo task' }), { error: 'not-found' });
  });
  it('rejects forged identity over a real DDP connection', async function () {
    const connection = DDP.connect(Meteor.absoluteUrl());
    const call = (name: string, ...args: unknown[]) => new Promise((resolve, reject) => {
      connection.call(name, ...args, (error: Error | undefined, value: unknown) => error ? reject(error) : resolve(value));
    });
    try {
      await assert.rejects(call(prefix + 'list', { after: null, limit: 5 }), { error: 'unauthenticated' });
      await assert.rejects(call(prefix + 'list', { after: null, limit: 5 }, { userId: alice }), { error: 'invalid-input' });
      await assert.rejects(call(prefix + 'create', { title: 'bad', userId: alice }), { error: 'invalid-input' });
    } finally { connection.disconnect(); }
  });
});
