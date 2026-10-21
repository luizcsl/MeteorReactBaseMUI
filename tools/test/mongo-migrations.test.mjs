import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import {
	migrateMongo,
	inspectMongoMigration,
	releaseMongoMigrationLock,
	connectMongoMigration
} from '../migrations/mongo.mjs';

const plan = {
	version: 1,
	id: 'rename-title',
	fromVersion: 0,
	toVersion: 1,
	operations: [
		{ kind: 'rename-field', from: 'title', to: 'name' },
		{ kind: 'add-default', field: 'active', value: true }
	]
};
const documents = () =>
	['a', 'b', 'c'].map((_id) => ({ _id, version: 0, schemaVersion: 0, title: _id.toUpperCase(), ownerId: 'owner' }));
const copy = (value) => structuredClone(value);
const field = (row, key) => {
	let value = row;
	for (const part of key.split('.')) {
		if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return { exists: false };
		value = value[part];
	}
	return { exists: true, value };
};
function matches(row, query) {
	return Object.entries(query).every(([key, expected]) => {
		if (key === '$and') return expected.every((condition) => matches(row, condition));
		if (key === '$expr') {
			const resolve = (value) =>
				typeof value === 'string' && value.startsWith('$') ? field(row, value.slice(1)).value : value.$literal;
			return isDeepStrictEqual(resolve(expected.$eq[0]), resolve(expected.$eq[1]));
		}
		const { value, exists } = field(row, key);
		if (!expected || typeof expected !== 'object' || Array.isArray(expected) || expected instanceof Date)
			return isDeepStrictEqual(value, expected);
		return Object.entries(expected).every(([operator, wanted]) => {
			if (operator === '$exists') return exists === wanted;
			if (operator === '$eq') return isDeepStrictEqual(value, wanted);
			if (operator === '$ne') return !isDeepStrictEqual(value, wanted);
			if (operator === '$gt')
				return (
					typeof value === typeof wanted && Buffer.compare(Buffer.from(String(value)), Buffer.from(String(wanted))) > 0
				);
			if (operator === '$type') return typeof value === wanted;
			if (operator === '$not') return !matches(row, { [key]: wanted });
			throw new Error(`Fake does not implement ${operator}`);
		});
	});
}
function set(row, key, value, remove = false) {
	const parts = key.split('.');
	let target = row;
	for (const part of parts.slice(0, -1)) {
		if (!Object.hasOwn(target, part)) target[part] = {};
		target = target[part];
	}
	if (remove) delete target[parts.at(-1)];
	else target[parts.at(-1)] = copy(value);
}

// A small deterministic fault-injection port, not Mongo qualification. The real
// driver suite below runs the same adapter against an explicitly local mongod.
class MemoryCollection {
	constructor(namespace, rows = []) {
		this.namespace = namespace;
		this.rows = copy(rows);
		this.writes = 0;
	}
	async findOne(query) {
		return copy(this.rows.find((row) => matches(row, query)) ?? null);
	}
	async countDocuments(query) {
		return this.rows.filter((row) => matches(row, query)).length;
	}
	find(query, options) {
		const values = copy(
			this.rows
				.filter((row) => matches(row, query))
				.sort((a, b) => Buffer.compare(Buffer.from(String(a._id)), Buffer.from(String(b._id))))
				.slice(0, options.limit)
		);
		let i = 0;
		return { next: async () => values[i++] ?? null, close: async () => {} };
	}
	async insertOne(row) {
		this.writes++;
		if (this.rows.some((existing) => existing._id === row._id))
			throw Object.assign(new Error('duplicate key'), { code: 11000 });
		this.rows.push(copy(row));
		return { acknowledged: true, insertedId: row._id };
	}
	async updateOne(query, update) {
		this.writes++;
		if (this.beforeUpdate) await this.beforeUpdate(query, update);
		const row = this.rows.find((row) => matches(row, query));
		if (!row) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
		for (const [key, value] of Object.entries(update.$set ?? {})) set(row, key, value);
		for (const [key, value] of Object.entries(update.$inc ?? {})) set(row, key, field(row, key).value + value);
		for (const key of Object.keys(update.$unset ?? {})) set(row, key, null, true);
		if (this.afterUpdate) await this.afterUpdate(query, update);
		return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
	}
	async deleteOne(query) {
		this.writes++;
		const index = this.rows.findIndex((row) => matches(row, query));
		if (index >= 0) this.rows.splice(index, 1);
		return { acknowledged: true, deletedCount: Number(index >= 0) };
	}
}
function fixture(rows = documents()) {
	return {
		collection: new MemoryCollection('migration_test.records', rows),
		metadata: new MemoryCollection('migration_test.control'),
		plan: copy(plan)
	};
}
async function recover(input) {
	const state = await inspectMongoMigration(input);
	assert.ok(state.lock);
	await releaseMongoMigrationLock({ ...input, ownerToken: state.lock.ownerToken, assertNoActiveRunner: true });
}
const rule = (code) => (error) => error.rule === code;

test('Mongo dry run is genuinely read-only and reports every source row', async () => {
	const input = fixture();
	const before = copy(input.collection.rows);
	const result = await migrateMongo(input);
	assert.equal(result.status, 'planned');
	assert.equal(result.records, 3);
	assert.equal(result.pending, 3);
	assert.equal(result.changed, 3);
	assert.equal(result.snapshot, false);
	assert.deepEqual(input.collection.rows, before);
	assert.equal(input.collection.writes, 0);
	assert.equal(input.metadata.writes, 0);
});

test('Mongo bounded pause, checkpoint resume and rerun increment each version exactly once', async () => {
	const input = fixture();
	const paused = await migrateMongo({ ...input, apply: true, batchSize: 1, maxBatches: 1 });
	assert.equal(paused.status, 'paused');
	assert.equal(paused.cursor, 'a');
	assert.equal((await inspectMongoMigration(input)).lock, null);
	assert.deepEqual(
		input.collection.rows.map((row) => row.version),
		[1, 0, 0]
	);
	const dry = await migrateMongo(input);
	assert.equal(dry.pending, 2);
	assert.equal((await migrateMongo({ ...input, apply: true, batchSize: 1 })).status, 'complete');
	assert.equal((await migrateMongo({ ...input, apply: true })).status, 'unchanged');
	assert.deepEqual(
		input.collection.rows.map((row) => row.version),
		[1, 1, 1]
	);
	for (const row of input.collection.rows) {
		assert.equal(row.name, row._id.toUpperCase());
		assert.equal(row.ownerId, 'owner');
		assert.equal(row.active, true);
		assert.equal(row.schemaVersion, 1);
		assert.ok(!Object.hasOwn(row, 'title'));
		assert.equal(row._migrations[plan.id].planHash, paused.planHash);
	}
});

test('Mongo preflight sees a collision on a later page before any record write', async () => {
	const input = fixture();
	input.collection.rows[2].name = 'occupied';
	const before = copy(input.collection.rows);
	await assert.rejects(migrateMongo({ ...input, apply: true, batchSize: 1 }), rule('migration-collision'));
	assert.deepEqual(input.collection.rows, before);
	assert.equal(input.collection.writes, 0);
	assert.equal(input.metadata.rows.length, 0);
});

test('Mongo rejects malformed rows, mixed ID types, unsafe versions, and foreign schema versions', async () => {
	for (const change of [
		(row) => delete row.version,
		(row) => (row.version = -1),
		(row) => (row.version = Number.MAX_SAFE_INTEGER),
		(row) => (row.schemaVersion = 1),
		(row) => delete row.schemaVersion,
		(row) => (row._id = 42),
		(row) => (row._id = ''),
		(row) => (row._migrations = []),
		(row) => (row._migrations = { previous: { planHash: 'wrong' } })
	]) {
		const input = fixture();
		change(input.collection.rows[2]);
		await assert.rejects(migrateMongo({ ...input, apply: true, batchSize: 1 }));
		assert.equal(input.collection.writes, 0);
		assert.equal(input.metadata.rows.length, 0);
	}
});

test('Mongo immutable plan hash rejects changed definitions but not object key order', async () => {
	const input = fixture();
	await migrateMongo({ ...input, apply: true, batchSize: 1, maxBatches: 1 });
	const changed = { ...input.plan, operations: [{ kind: 'add-default', field: 'different', value: 1 }] };
	await assert.rejects(migrateMongo({ ...input, plan: changed }), rule('migration-drift'));
	const reordered = Object.fromEntries(Object.entries(input.plan).reverse());
	assert.equal((await migrateMongo({ ...input, plan: reordered, apply: true })).status, 'complete');
});

test('Mongo CAS rejects concurrent versions, retains its lock, and recovery requires exact ownership', async () => {
	const input = fixture();
	input.collection.beforeUpdate = async () => {
		input.collection.rows[0].version++;
		input.collection.beforeUpdate = null;
	};
	await assert.rejects(
		migrateMongo({ ...input, apply: true }),
		(error) => error.rule === 'migration-concurrent' && error.migrationLockRetained
	);
	assert.equal(input.collection.rows[0].title, 'A');
	const state = await inspectMongoMigration(input);
	await assert.rejects(migrateMongo({ ...input, apply: true }), rule('migration-locked'));
	await assert.rejects(
		releaseMongoMigrationLock({ ...input, ownerToken: state.lock.ownerToken }),
		rule('migration-recovery')
	);
	await assert.rejects(
		releaseMongoMigrationLock({ ...input, ownerToken: 'wrong', assertNoActiveRunner: true }),
		rule('migration-recovery')
	);
	await recover(input);
	await migrateMongo({ ...input, apply: true });
	assert.deepEqual(
		input.collection.rows.map((row) => row.version),
		[2, 1, 1]
	);
});

test('Mongo CAS guards touched values and field absence even for non-cooperating writers', async () => {
	for (const mutate of [
		(row) => (row.title = 'concurrent'),
		(row) => (row.title = ['A']),
		(row) => (row.name = null),
		(row) => (row.active = false),
		(row) => (row._migrations = { other: {} })
	]) {
		const input = fixture();
		input.collection.beforeUpdate = async () => {
			mutate(input.collection.rows[0]);
			input.collection.beforeUpdate = null;
		};
		await assert.rejects(migrateMongo({ ...input, apply: true }), rule('migration-concurrent'));
		assert.equal(input.collection.rows[0].schemaVersion, 0);
	}
});

test('Mongo operator updates preserve unrelated fields and BSON-like source values', async () => {
	const input = fixture();
	const complex = { when: new Date('2026-01-01T00:00:00Z'), nested: ['a', { count: 2 }] };
	input.collection.rows[0].title = complex;
	input.collection.beforeUpdate = async () => {
		input.collection.rows[0].unrelated = 'retained';
		input.collection.beforeUpdate = null;
	};
	await migrateMongo({ ...input, apply: true });
	assert.deepEqual(input.collection.rows[0].name, complex);
	assert.equal(input.collection.rows[0].unrelated, 'retained');
});

test('Mongo crash after a row commit resumes via marker without double application', async () => {
	const input = fixture();
	input.collection.afterUpdate = async () => {
		input.collection.afterUpdate = null;
		throw new Error('lost write response');
	};
	await assert.rejects(migrateMongo({ ...input, apply: true }), /lost write response/);
	let state = await inspectMongoMigration(input);
	assert.equal(state.checkpoint.cursor, null);
	assert.equal(input.collection.rows[0].schemaVersion, 1);
	assert.equal(input.collection.rows[0].version, 1);
	await recover(input);
	assert.equal((await migrateMongo({ ...input, apply: true })).status, 'complete');
	assert.deepEqual(
		input.collection.rows.map((row) => row.version),
		[1, 1, 1]
	);
	state = await inspectMongoMigration(input);
	assert.equal(state.checkpoint.processed, 3);
});

test('Mongo crash after a checkpoint commit is recoverable without trusting a stale local cursor', async () => {
	const input = fixture();
	input.metadata.afterUpdate = async () => {
		input.metadata.afterUpdate = null;
		throw new Error('checkpoint response lost');
	};
	await assert.rejects(migrateMongo({ ...input, apply: true, batchSize: 1 }), /checkpoint response lost/);
	assert.equal((await inspectMongoMigration(input)).checkpoint.cursor, 'a');
	await recover(input);
	await migrateMongo({ ...input, apply: true });
	assert.deepEqual(
		input.collection.rows.map((row) => row.version),
		[1, 1, 1]
	);
});

test('Mongo resume rejects membership drift and corrupted cursor markers rather than skipping rows', async () => {
	for (const mutate of [
		(rows) => rows.push({ _id: 'aa', version: 0, schemaVersion: 0 }),
		(rows) => rows.splice(1, 1),
		(rows) => {
			rows[0].schemaVersion = 0;
			delete rows[0]._migrations;
		}
	]) {
		const input = fixture();
		await migrateMongo({ ...input, apply: true, batchSize: 1, maxBatches: 1 });
		mutate(input.collection.rows);
		const before = copy(input.collection.rows);
		await assert.rejects(migrateMongo({ ...input, apply: true }));
		assert.deepEqual(input.collection.rows, before);
	}
});

test('Mongo collection lock excludes other migration IDs and never expires by clock age', async () => {
	const input = fixture();
	let enter, continueRun;
	const entered = new Promise((resolve) => (enter = resolve));
	const continued = new Promise((resolve) => (continueRun = resolve));
	input.collection.beforeUpdate = async () => {
		input.collection.beforeUpdate = null;
		enter();
		await continued;
	};
	const first = migrateMongo({ ...input, apply: true });
	await entered;
	const lock = input.metadata.rows.find((row) => row.ownerToken);
	lock.acquiredAt = new Date(0);
	await assert.rejects(
		migrateMongo({ ...input, plan: { ...input.plan, id: 'other-migration' }, apply: true }),
		rule('migration-locked')
	);
	continueRun();
	assert.equal((await first).status, 'complete');
});

test('Mongo scan, batch and operation limits fail closed before source mutations', async () => {
	for (const options of [
		{ batchSize: 0 },
		{ maxBatches: Infinity },
		{ maxRecords: 2 },
		{ maxScanBytes: 1 },
		{ apply: 'true' },
		{ surprise: true }
	]) {
		const input = fixture();
		await assert.rejects(migrateMongo({ ...input, ...options }));
		assert.equal(input.collection.writes, 0);
	}
	const input = fixture();
	for (const operations of [
		[{ kind: 'drop-field', field: 'title' }],
		[{ kind: 'add-default', field: 'schemaVersion', value: 3 }]
	]) {
		await assert.rejects(migrateMongo({ ...input, plan: { ...plan, operations } }));
	}
	await assert.rejects(migrateMongo({ ...input, metadata: input.collection }), rule('migration-collection'));
});

test('Mongo sequential migrations retain earlier hashes and support empty collections', async () => {
	const input = fixture();
	await migrateMongo({ ...input, apply: true });
	const second = {
		version: 1,
		id: 'add-label',
		fromVersion: 1,
		toVersion: 2,
		operations: [{ kind: 'add-default', field: 'label', value: 'new' }]
	};
	await migrateMongo({ ...input, plan: second, apply: true });
	for (const row of input.collection.rows) {
		assert.equal(row.version, 2);
		assert.deepEqual(Object.keys(row._migrations).sort(), ['add-label', 'rename-title']);
	}
	assert.equal((await migrateMongo({ ...fixture([]), apply: true })).records, 0);
});

test('Mongo completed checkpoints still validate the actual collection', async () => {
	const input = fixture();
	await migrateMongo({ ...input, apply: true });
	delete input.collection.rows[2]._migrations;
	await assert.rejects(migrateMongo({ ...input, apply: true }), rule('migration-version'));
});

test('Mongo unfinished plan blocks another schema migration even if every row already committed', async () => {
	const input = fixture();
	input.metadata.beforeUpdate = async (_query, update) => {
		if (update.$set.status === 'complete') throw new Error('completion interrupted');
	};
	await assert.rejects(migrateMongo({ ...input, apply: true }), /completion interrupted/);
	assert.deepEqual(
		input.collection.rows.map((row) => row.schemaVersion),
		[1, 1, 1]
	);
	await recover(input);
	const next = { ...plan, id: 'next-plan', fromVersion: 1, toVersion: 2 };
	await assert.rejects(migrateMongo({ ...input, plan: next, apply: true }), rule('migration-unfinished'));
	input.metadata.beforeUpdate = null;
	assert.equal((await migrateMongo({ ...input, apply: true })).status, 'complete');
});

function interceptUpdate(collection, hook) {
	return new Proxy(collection, {
		get(target, key) {
			if (key === 'updateOne') return (filter, update, options) => hook(filter, update, options);
			const value = Reflect.get(target, key, target);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

test(
	'real local Mongo: native driver CAS, checkpoint recovery, marker idempotency and preflight',
	{
		skip: process.env.MONGO_MIGRATION_TEST_URI
			? false
			: 'NOT QUALIFIED: set MONGO_MIGRATION_TEST_URI to an explicitly local mongod'
	},
	async (t) => {
		const uri = process.env.MONGO_MIGRATION_TEST_URI;
		assert.match(
			uri,
			/^mongodb:\/\/127\.0\.0\.1:\d+\/$/,
			'This test refuses non-loopback databases, credentials and URI options'
		);
		const { close, ...ports } = await connectMongoMigration({
			uri,
			database: `migration_adapter_test_${process.pid}_${Date.now()}`,
			collectionName: 'records'
		});
		const input = { ...ports, plan };
		async function reset(rows = documents()) {
			await input.collection.deleteMany({});
			await input.metadata.deleteMany({});
			if (rows.length) await input.collection.insertMany(rows);
		}
		try {
			await t.test('read-only dry run, durable bounded resume, simple collation and replay', async () => {
				await reset();
				assert.equal((await migrateMongo(input)).pending, 3);
				assert.equal(await input.metadata.countDocuments({}), 0);
				assert.equal((await migrateMongo({ ...input, apply: true, batchSize: 1, maxBatches: 1 })).status, 'paused');
				assert.equal((await migrateMongo({ ...input, apply: true })).status, 'complete');
				assert.equal((await migrateMongo({ ...input, apply: true })).status, 'unchanged');
				const rows = await input.collection.find({}).sort({ _id: 1 }).toArray();
				assert.deepEqual(
					rows.map((row) => [row.version, row.schemaVersion, row.name]),
					[
						[1, 1, 'A'],
						[1, 1, 'B'],
						[1, 1, 'C']
					]
				);
			});
			await t.test('real duplicate-key collection lock rejects a concurrent contender', async () => {
				await reset();
				let enter, release;
				const entered = new Promise((resolve) => (enter = resolve));
				const released = new Promise((resolve) => (release = resolve));
				let once = true;
				const wrapped = interceptUpdate(input.collection, async (...args) => {
					if (once) {
						once = false;
						enter();
						await released;
					}
					return input.collection.updateOne(...args);
				});
				const running = migrateMongo({ ...input, collection: wrapped, apply: true });
				await entered;
				try {
					await assert.rejects(migrateMongo({ ...input, apply: true }), rule('migration-locked'));
				} finally {
					release();
				}
				assert.equal((await running).status, 'complete');
			});
			await t.test('real version predicate prevents an overwrite and safely recovers', async () => {
				await reset();
				let once = true;
				const wrapped = interceptUpdate(input.collection, async (...args) => {
					if (once) {
						once = false;
						await input.collection.updateOne({ _id: 'a' }, { $inc: { version: 1 }, $set: { title: 'writer' } });
					}
					return input.collection.updateOne(...args);
				});
				await assert.rejects(
					migrateMongo({ ...input, collection: wrapped, apply: true }),
					rule('migration-concurrent')
				);
				assert.equal((await input.collection.findOne({ _id: 'a' })).title, 'writer');
				await recover(input);
				await migrateMongo({ ...input, apply: true });
				assert.equal((await input.collection.findOne({ _id: 'a' })).name, 'writer');
			});
			await t.test('unknown write response after real commit is idempotent on resume', async () => {
				await reset();
				let once = true;
				const wrapped = interceptUpdate(input.collection, async (...args) => {
					const result = await input.collection.updateOne(...args);
					if (once) {
						once = false;
						throw new Error('simulated connection loss after server commit');
					}
					return result;
				});
				await assert.rejects(migrateMongo({ ...input, collection: wrapped, apply: true }), /connection loss/);
				assert.equal((await input.collection.findOne({ _id: 'a' })).version, 1);
				assert.equal((await inspectMongoMigration(input)).checkpoint.cursor, null);
				await recover(input);
				await migrateMongo({ ...input, apply: true });
				assert.deepEqual(
					(await input.collection.find({}).toArray()).map((row) => row.version),
					[1, 1, 1]
				);
			});
			await t.test('whole-value CAS rejects Mongo array-membership equality without a version increment', async () => {
				await reset();
				let once = true;
				const wrapped = interceptUpdate(input.collection, async (...args) => {
					if (once) {
						once = false;
						await input.collection.updateOne({ _id: 'a' }, { $set: { title: ['A'] } });
					}
					return input.collection.updateOne(...args);
				});
				await assert.rejects(
					migrateMongo({ ...input, collection: wrapped, apply: true }),
					rule('migration-concurrent')
				);
				assert.deepEqual((await input.collection.findOne({ _id: 'a' })).title, ['A']);
				assert.equal((await input.collection.findOne({ _id: 'a' })).schemaVersion, 0);
			});
			await t.test('late collision and a non-string ID cannot be silently bypassed', async () => {
				const rows = documents();
				rows[2].name = 'occupied';
				await reset(rows);
				await assert.rejects(migrateMongo({ ...input, apply: true, batchSize: 1 }), rule('migration-collision'));
				assert.equal(await input.collection.countDocuments({ version: 1 }), 0);
				await reset();
				await input.collection.insertOne({ _id: 42, version: 0, schemaVersion: 0 });
				await assert.rejects(migrateMongo({ ...input, apply: true, batchSize: 1 }), rule('migration-record'));
				assert.equal(await input.collection.countDocuments({ version: 1 }), 0);
			});
			await t.test('BSON Date, ObjectId and null values retain their native types', async () => {
				const { ObjectId } = await import('mongodb');
				const value = { when: new Date('2026-01-01T00:00:00Z'), related: new ObjectId(), nullable: null };
				await reset([{ _id: 'a', version: 0, schemaVersion: 0, title: value }]);
				await migrateMongo({ ...input, apply: true });
				const row = await input.collection.findOne({ _id: 'a' });
				assert.deepEqual(row.name, value);
				assert.ok(row.name.when instanceof Date);
				assert.ok(row.name.related instanceof ObjectId);
			});
		} finally {
			try {
				await input.collection.drop();
				await input.metadata.drop();
			} finally {
				await close();
			}
		}
	}
);
