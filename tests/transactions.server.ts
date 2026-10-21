/// <reference types="mocha" />
/** Optional transaction PORT qualification, not a claim that owner CRUD repositories use sessions. */
import assert from 'node:assert/strict';
import { Mongo } from 'meteor/mongo';
import type { ClientSession } from 'mongodb';
import { transactionRunner } from '../imports/core/server/transaction';

const records = new Mongo.Collection<{ _id: string; value: string }>('transaction_port_qualification');
const raw = records.rawCollection();
const database = records.rawDatabase();
const sessions: ClientSession[] = [];
// Meteor bundles mongodb 6; its public Db.client is absent from the app's older transitive driver typings.
const driverDatabase = database as typeof database & { readonly client: { startSession(): ClientSession } };
const start = () => { const session = driverDatabase.client.startSession(); sessions.push(session); return session; };
const runner = () => transactionRunner(start, session => {
  const native = session as ClientSession;
  return {
    first: { session, write: (id: string) => raw.insertOne({ _id: id, value: 'first' }, { session: native }) },
    second: { session, write: (id: string) => raw.insertOne({ _id: id, value: 'second' }, { session: native }) }
  };
});

describe('replica-set transaction port qualification', function () {
  this.timeout(30000);
  before(async () => {
    assert.equal(process.env.TEST_TRANSACTIONS, '1', 'Explicit TEST_TRANSACTIONS=1 required');
    const hello = await database.admin().command({ hello: 1 });
    assert.ok(typeof hello.setName === 'string' && hello.setName.length, 'Requested transaction qualification requires a real Mongo replica set; standalone is not qualified');
    await raw.deleteMany({});
    // Create the collection before entering transactions.
    await raw.insertOne({ _id: 'preexisting', value: 'unchanged' });
  });
  afterEach(() => { assert.ok(sessions.every(session => session.hasEnded), 'Every actual driver session must be ended'); });
  after(async () => { await raw.deleteMany({}); });

  it('binds both repository ports to one real session and commits both writes', async () => {
    const result = await runner().run(async repositories => {
      assert.equal(repositories.first.session, repositories.second.session);
      assert.equal(repositories.first.session, sessions.at(-1));
      await repositories.first.write('commit-first');
      await repositories.second.write('commit-second');
      return { committed: true };
    });
    assert.deepEqual(result, { committed: true });
    assert.equal(await raw.countDocuments({ _id: { $in: ['commit-first', 'commit-second'] } }), 2);
  });

  it('rolls back writes in both repositories and preserves the callback error identity', async () => {
    const failure = new Error('intentional transaction callback failure');
    await assert.rejects(runner().run(async repositories => {
      await repositories.first.write('rollback-first');
      await repositories.second.write('rollback-second');
      throw failure;
    }), error => error === failure);
    assert.equal(await raw.countDocuments({ _id: { $in: ['rollback-first', 'rollback-second'] } }), 0);
  });

  it('propagates a real duplicate-key driver error and rolls back an earlier write', async () => {
    await assert.rejects(runner().run(async repositories => {
      await repositories.first.write('driver-rollback');
      await repositories.second.write('preexisting');
    }), (error: unknown) => (error as { code?: number }).code === 11000);
    assert.equal(await raw.countDocuments({ _id: 'driver-rollback' }), 0);
    assert.equal((await raw.findOne({ _id: 'preexisting' }))?.value, 'unchanged');
  });

  it('propagates repository-binding failure and ends its real driver session', async () => {
    const failure = new Error('intentional bind failure');
    const broken = transactionRunner(start, () => { throw failure; });
    await assert.rejects(broken.run(async () => 'unreachable'), error => error === failure);
  });
});
