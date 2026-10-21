import { createHash, randomUUID } from 'node:crypto';
import { serialize } from 'node:v8';
import { exact, fail, hash } from '../lib.mjs';
import { validateMigration } from './runner.mjs';

const writeConcern = { w: 'majority', j: true, wtimeoutMS: 10000 };
const updateOptions = { writeConcern, collation: { locale: 'simple' } };
const canonical = (value) =>
	JSON.stringify(value, (_, item) =>
		item && typeof item === 'object' && !Array.isArray(item)
			? Object.fromEntries(
					Object.keys(item)
						.sort()
						.map((key) => [key, item[key]])
				)
			: item
	);
const own = (object, key) => Object.hasOwn(object, key);
const plain = (value) =>
	value &&
	typeof value === 'object' &&
	!Array.isArray(value) &&
	[Object.prototype, null].includes(Object.getPrototypeOf(value));
const idOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const validId = (value) =>
	typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 512 && !value.includes('\0');
const equal = (a, b) => canonical(a) === canonical(b);
const acknowledged = (result) => {
	if (result?.acknowledged !== true)
		fail('migration-write', 'Mongo write was not acknowledged; inspect the retained lock before recovery');
};

function context(collection, metadata, plan, options = {}) {
	// The offline validator remains the common operation allowlist. Metadata fields
	// have additional meaning in this adapter and must never be migration targets.
	validateMigration(plan);
	if (!Number.isSafeInteger(plan.fromVersion) || !Number.isSafeInteger(plan.toVersion))
		fail('migration-schema', 'Schema versions must be safe integers');
	plan = JSON.parse(canonical(plan));
	plan.operations.forEach(Object.freeze);
	Object.freeze(plan.operations);
	Object.freeze(plan);
	for (const operation of plan.operations) {
		for (const field of operation.kind === 'add-default' ? [operation.field] : [operation.from, operation.to]) {
			if (field === 'schemaVersion') fail('migration-schema', 'schemaVersion is adapter-owned');
		}
	}
	const namespace = collection?.namespace;
	if (
		typeof namespace !== 'string' ||
		!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(namespace) ||
		typeof metadata?.namespace !== 'string' ||
		metadata.namespace === namespace ||
		metadata.namespace.split('.')[0] !== namespace.split('.')[0]
	) {
		fail(
			'migration-collection',
			'Use distinct native collections in one database, with simple database/collection names'
		);
	}
	for (const method of ['find', 'findOne', 'updateOne', 'countDocuments']) {
		if (typeof collection[method] !== 'function') fail('migration-port', `Collection port requires ${method}`);
	}
	for (const method of ['findOne', 'insertOne', 'updateOne', 'deleteOne']) {
		if (typeof metadata[method] !== 'function') fail('migration-port', `Metadata port requires ${method}`);
	}
	exact(options, ['apply', 'batchSize', 'maxRecords', 'maxBatches', 'maxScanBytes', 'maxTimeMS'], []);
	const settings = {
		apply: false,
		batchSize: 100,
		maxRecords: 100000,
		maxBatches: 100,
		maxScanBytes: 64 * 1024 * 1024,
		maxTimeMS: 30000,
		...options
	};
	if (typeof settings.apply !== 'boolean') fail('migration-options', 'apply must be boolean');
	for (const [key, max] of Object.entries({
		batchSize: 1000,
		maxRecords: 1000000,
		maxBatches: 10000,
		maxScanBytes: 256 * 1024 * 1024,
		maxTimeMS: 120000
	})) {
		if (!Number.isSafeInteger(settings[key]) || settings[key] < 1 || settings[key] > max)
			fail('migration-bounds', `Invalid ${key}; expected 1..${max}`);
	}
	const planHash = hash(canonical(plan));
	const namespaceHash = hash(namespace);
	return {
		collection,
		metadata,
		plan,
		planHash,
		namespace,
		...settings,
		lockId: `lock:${namespaceHash}`,
		ledgerId: `migration:${namespaceHash}:${plan.id}`,
		readOptions: {
			collation: { locale: 'simple' },
			readPreference: 'primary',
			readConcern: { level: 'majority' },
			maxTimeMS: settings.maxTimeMS
		}
	};
}

function validateLedger(ctx, ledger) {
	if (!ledger) return;
	exact(ledger, [
		'_id',
		'namespace',
		'id',
		'planHash',
		'fromVersion',
		'toVersion',
		'sourceCount',
		'sourceIdHash',
		'cursor',
		'processed',
		'status'
	]);
	if (ledger.planHash !== ctx.planHash) fail('migration-drift', 'Migration ID changed its immutable plan hash');
	if (
		ledger._id !== ctx.ledgerId ||
		ledger.namespace !== ctx.namespace ||
		ledger.id !== ctx.plan.id ||
		ledger.fromVersion !== ctx.plan.fromVersion ||
		ledger.toVersion !== ctx.plan.toVersion ||
		!Number.isSafeInteger(ledger.sourceCount) ||
		ledger.sourceCount < 0 ||
		ledger.sourceCount > ctx.maxRecords ||
		!/^[a-f0-9]{64}$/.test(ledger.sourceIdHash) ||
		!Number.isSafeInteger(ledger.processed) ||
		ledger.processed < 0 ||
		ledger.processed > ledger.sourceCount ||
		!(ledger.cursor === null || validId(ledger.cursor)) ||
		(ledger.processed === 0) !== (ledger.cursor === null) ||
		!['running', 'complete'].includes(ledger.status) ||
		(ledger.status === 'complete' && ledger.processed !== ledger.sourceCount)
	) {
		fail('migration-checkpoint', 'Malformed or incompatible migration checkpoint');
	}
}

function describeRow(ctx, row, ledger) {
	if (
		!plain(row) ||
		!validId(row._id) ||
		!Number.isSafeInteger(row.version) ||
		row.version < 0 ||
		!Number.isSafeInteger(row.schemaVersion) ||
		row.schemaVersion < 0
	) {
		fail(
			'migration-record',
			'Every record requires a nonempty string _id, nonnegative safe version and explicit schemaVersion'
		);
	}
	if (own(row, '_migrations') && (!plain(row._migrations) || Object.keys(row._migrations).length > 128)) {
		fail('migration-marker', `Malformed migration markers on ${row._id}`);
	}
	for (const [id, previous] of Object.entries(row._migrations ?? {})) {
		if (
			!/^[a-z][a-z0-9-]{2,63}$/.test(id) ||
			!plain(previous) ||
			Object.keys(previous).sort().join(',') !== 'fromVersion,planHash,toVersion' ||
			typeof previous.planHash !== 'string' ||
			!/^[a-f0-9]{64}$/.test(previous.planHash) ||
			!Number.isSafeInteger(previous.fromVersion) ||
			previous.fromVersion < 0 ||
			!Number.isSafeInteger(previous.toVersion) ||
			previous.toVersion !== previous.fromVersion + 1 ||
			previous.toVersion > row.schemaVersion
		)
			fail('migration-marker', `Malformed historical migration marker on ${row._id}`);
	}
	const marker = row._migrations && own(row._migrations, ctx.plan.id) ? row._migrations[ctx.plan.id] : undefined;
	const expected = { planHash: ctx.planHash, fromVersion: ctx.plan.fromVersion, toVersion: ctx.plan.toVersion };
	if (marker !== undefined) {
		if (!ledger || !plain(marker) || !equal(marker, expected) || row.schemaVersion !== ctx.plan.toVersion) {
			fail('migration-marker', `Incompatible or orphan migration marker on ${row._id}`);
		}
		return { migrated: true, changed: false };
	}
	if (row.schemaVersion !== ctx.plan.fromVersion)
		fail('migration-version', `Unexpected schemaVersion on ${row._id}; no rows are silently skipped`);
	if (row.version === Number.MAX_SAFE_INTEGER) fail('migration-record', 'Record version cannot be incremented safely');
	if (ledger?.cursor !== null && ledger?.cursor !== undefined && idOrder(row._id, ledger.cursor) <= 0) {
		fail('migration-checkpoint', `Checkpoint would skip an unmigrated record: ${row._id}`);
	}
	if (row._migrations && Object.keys(row._migrations).length >= 128)
		fail('migration-marker', 'Migration marker capacity reached; a separately reviewed archival plan is required');
	const set = { schemaVersion: ctx.plan.toVersion, [`_migrations.${ctx.plan.id}`]: expected };
	const unset = {};
	const guards = [
		{ $expr: { $eq: ['$version', { $literal: row.version }] } },
		{ $expr: { $eq: ['$schemaVersion', { $literal: ctx.plan.fromVersion }] } }
	];
	let changed = false;
	for (const operation of ctx.plan.operations) {
		const fields = operation.kind === 'add-default' ? [operation.field] : [operation.from, operation.to];
		for (const field of fields) {
			if (own(row, field)) {
				if (row[field] === undefined) fail('migration-record', `Undefined source field on ${row._id}`);
				// Query-level $eq also matches an array containing the old value. Use
				// expression equality to guard the whole value, not array membership.
				guards.push({ [field]: { $exists: true } }, { $expr: { $eq: [`$${field}`, { $literal: row[field] }] } });
			} else guards.push({ [field]: { $exists: false } });
		}
		if (operation.kind === 'add-default' && !own(row, operation.field)) {
			set[operation.field] = operation.value;
			changed = true;
		}
		if (operation.kind === 'rename-field' && own(row, operation.from)) {
			if (own(row, operation.to))
				fail('migration-collision', `Destination ${operation.to} already exists for ${row._id}`);
			set[operation.to] = row[operation.from];
			unset[operation.from] = '';
			changed = true;
		}
	}
	const filter = {
		_id: row._id,
		version: row.version,
		schemaVersion: ctx.plan.fromVersion,
		[`_migrations.${ctx.plan.id}`]: { $exists: false },
		$and: guards
	};
	// Protect the metadata container too: another actor must not replace it or
	// introduce an invalid parent while the per-record marker is being written.
	if (own(row, '_migrations'))
		guards.push(
			{ _migrations: { $exists: true } },
			{ $expr: { $eq: ['$_migrations', { $literal: row._migrations }] } }
		);
	else guards.push({ _migrations: { $exists: false } });
	const update = { $set: set, $inc: { version: 1 } };
	if (Object.keys(unset).length) update.$unset = unset;
	return { migrated: false, changed, filter, update };
}

async function page(ctx, after) {
	const cursor = ctx.collection.find(after === null ? {} : { _id: { $gt: after } }, {
		...ctx.readOptions,
		sort: { _id: 1 },
		limit: ctx.batchSize,
		batchSize: Math.min(ctx.batchSize, 100)
	});
	const rows = [];
	let bytes = 0;
	try {
		for (let row = await cursor.next(); row !== null; row = await cursor.next()) {
			bytes += serialize(row).byteLength;
			if (bytes > ctx.maxScanBytes) fail('migration-bounds', 'Serialized page bytes exceed the configured bound');
			rows.push(row);
		}
		return rows;
	} finally {
		await cursor.close();
	}
}

async function scan(ctx, ledger) {
	// A string-key range query type-brackets in Mongo. Check other _id types
	// explicitly so a numeric/ObjectId document cannot disappear between pages.
	if (await ctx.collection.findOne({ _id: { $not: { $type: 'string' } } }, ctx.readOptions)) {
		fail('migration-record', 'This bounded adapter requires string _id values on EVERY record');
	}
	const digest = createHash('sha256');
	let cursor = null,
		count = 0,
		bytes = 0,
		pending = 0,
		changed = 0,
		checkpointCount = 0;
	while (true) {
		const rows = await page(ctx, cursor);
		if (!rows.length) break;
		for (const row of rows) {
			count += 1;
			if (count > ctx.maxRecords) fail('migration-bounds', 'Record count exceeds the configured bound');
			bytes += serialize(row).byteLength;
			if (bytes > ctx.maxScanBytes) fail('migration-bounds', 'Serialized scan bytes exceed the configured bound');
			const result = describeRow(ctx, row, ledger);
			if (cursor !== null && idOrder(row._id, cursor) <= 0)
				fail('migration-order', 'Collection cursor is not strictly ordered');
			cursor = row._id;
			digest.update(`${Buffer.byteLength(row._id)}:`).update(row._id);
			pending += Number(!result.migrated);
			changed += Number(result.changed);
			if (ledger?.cursor !== null && ledger?.cursor !== undefined && idOrder(row._id, ledger.cursor) <= 0)
				checkpointCount += 1;
		}
	}
	if ((await ctx.collection.countDocuments({}, ctx.readOptions)) !== count)
		fail('migration-concurrent', 'Collection membership changed during preflight');
	const sourceIdHash = digest.digest('hex');
	if (
		ledger &&
		(ledger.sourceCount !== count || ledger.sourceIdHash !== sourceIdHash || checkpointCount !== ledger.processed)
	) {
		fail('migration-concurrent', 'Collection IDs or checkpoint changed; resume requires the original membership');
	}
	if (ledger?.status === 'complete' && pending)
		fail('migration-checkpoint', 'Completed checkpoint contains unmigrated records');
	return { count, pending, changed, sourceIdHash, scannedBytes: bytes };
}

async function rejectUnfinishedOtherPlan(ctx) {
	if (
		await ctx.metadata.findOne(
			{ namespace: ctx.namespace, status: 'running', _id: { $ne: ctx.ledgerId } },
			ctx.readOptions
		)
	) {
		fail(
			'migration-unfinished',
			'Another migration has an unfinished checkpoint; finish that immutable plan before starting another'
		);
	}
}

/**
 * Native Mongo Collection adapter. Entire-collection preflight, bounded pages,
 * atomic per-record CAS, durable cursor checkpoints. No transactions or rollback
 * are implied. Collection membership must be frozen by the operator.
 */
export async function migrateMongo({ collection, metadata, plan, ...options }) {
	const ctx = context(collection, metadata, plan, options);
	plan = ctx.plan;
	let ledger = await metadata.findOne({ _id: ctx.ledgerId }, ctx.readOptions);
	validateLedger(ctx, ledger);
	if (!ctx.apply) {
		await rejectUnfinishedOtherPlan(ctx);
		const summary = await scan(ctx, ledger);
		return {
			status: 'planned',
			id: plan.id,
			planHash: ctx.planHash,
			namespace: ctx.namespace,
			records: summary.count,
			pending: summary.pending,
			changed: summary.changed,
			cursor: ledger?.cursor ?? null,
			fromVersion: plan.fromVersion,
			toVersion: plan.toVersion,
			snapshot: false
		};
	}
	const ownerToken = randomUUID();
	try {
		const result = await metadata.insertOne(
			{
				_id: ctx.lockId,
				namespace: ctx.namespace,
				migrationId: plan.id,
				planHash: ctx.planHash,
				ownerToken,
				acquiredAt: new Date()
			},
			{ writeConcern }
		);
		acknowledged(result);
	} catch (error) {
		if (error?.code === 11000)
			fail('migration-locked', 'Another run owns the collection lock; it never expires automatically');
		throw error;
	}
	let retainLock = false;
	try {
		// Another run could have finished between the first read and lock acquisition.
		ledger = await metadata.findOne({ _id: ctx.ledgerId }, ctx.readOptions);
		validateLedger(ctx, ledger);
		await rejectUnfinishedOtherPlan(ctx);
		const summary = await scan(ctx, ledger);
		if (ledger?.status === 'complete')
			return { status: 'unchanged', id: plan.id, records: summary.count, planHash: ctx.planHash };
		if (!ledger) {
			ledger = {
				_id: ctx.ledgerId,
				namespace: ctx.namespace,
				id: plan.id,
				planHash: ctx.planHash,
				fromVersion: plan.fromVersion,
				toVersion: plan.toVersion,
				sourceCount: summary.count,
				sourceIdHash: summary.sourceIdHash,
				cursor: null,
				processed: 0,
				status: 'running'
			};
			retainLock = true;
			acknowledged(await metadata.insertOne(ledger, { writeConcern }));
		}
		let batches = 0;
		while (batches < ctx.maxBatches) {
			const rows = await page(ctx, ledger.cursor);
			if (!rows.length) break;
			if (ledger.processed + rows.length > ledger.sourceCount)
				fail('migration-concurrent', 'Collection grew after preflight');
			for (const row of rows) {
				const described = describeRow(ctx, row, ledger);
				if (described.migrated) continue; // Crash after row commit, before checkpoint.
				retainLock = true;
				const result = await collection.updateOne(described.filter, described.update, updateOptions);
				acknowledged(result);
				if (result.matchedCount !== 1 || result.modifiedCount !== 1)
					fail('migration-concurrent', `CAS rejected record ${row._id}; no blind overwrite or automatic retry`);
			}
			const next = { cursor: rows.at(-1)._id, processed: ledger.processed + rows.length };
			retainLock = true;
			const checkpoint = await metadata.updateOne(
				{
					_id: ctx.ledgerId,
					planHash: ctx.planHash,
					status: 'running',
					cursor: ledger.cursor,
					processed: ledger.processed
				},
				{ $set: next },
				updateOptions
			);
			acknowledged(checkpoint);
			if (checkpoint.matchedCount !== 1 || checkpoint.modifiedCount !== 1)
				fail('migration-checkpoint', 'Checkpoint CAS failed');
			Object.assign(ledger, next);
			batches += 1;
		}
		if (ledger.processed !== ledger.sourceCount) {
			// Even a bounded pause must detect a removed/inserted record before claiming
			// that its checkpoint is resumable.
			await scan(ctx, ledger);
			retainLock = false;
			return {
				status: 'paused',
				id: plan.id,
				cursor: ledger.cursor,
				processed: ledger.processed,
				total: ledger.sourceCount,
				planHash: ctx.planHash
			};
		}
		const verified = await scan(ctx, ledger);
		if (verified.pending) fail('migration-incomplete', 'Unmigrated records remain after traversal');
		retainLock = true;
		const completed = await metadata.updateOne(
			{
				_id: ctx.ledgerId,
				planHash: ctx.planHash,
				status: 'running',
				cursor: ledger.cursor,
				processed: ledger.processed
			},
			{ $set: { status: 'complete' } },
			updateOptions
		);
		acknowledged(completed);
		if (completed.matchedCount !== 1 || completed.modifiedCount !== 1)
			fail('migration-checkpoint', 'Completion checkpoint CAS failed');
		retainLock = false;
		return {
			status: 'complete',
			id: plan.id,
			records: ledger.sourceCount,
			toVersion: plan.toVersion,
			planHash: ctx.planHash
		};
	} catch (error) {
		// Unknown write outcomes, including write-concern timeouts, fail closed.
		// A crashed process leaves this same non-expiring lock behind.
		if (retainLock && error && typeof error === 'object' && Object.isExtensible(error))
			error.migrationLockRetained = true;
		throw error;
	} finally {
		if (!retainLock) {
			const released = await metadata.deleteOne({ _id: ctx.lockId, ownerToken }, updateOptions);
			acknowledged(released);
			if (released.deletedCount !== 1)
				fail('migration-locked', 'Lock ownership changed while releasing; inspect metadata');
		}
	}
}

/** Read-only inspection for a reviewed recovery. Never reclaim a lock by age. */
export async function inspectMongoMigration({ collection, metadata, plan }) {
	const ctx = context(collection, metadata, plan);
	return {
		namespace: ctx.namespace,
		planHash: ctx.planHash,
		lock: await metadata.findOne({ _id: ctx.lockId }, ctx.readOptions),
		checkpoint: await metadata.findOne({ _id: ctx.ledgerId }, ctx.readOptions)
	};
}

/** Only after the operator stopped every old runner and resolved uncertain writes. */
export async function releaseMongoMigrationLock({ collection, metadata, plan, ownerToken, assertNoActiveRunner }) {
	const ctx = context(collection, metadata, plan);
	if (assertNoActiveRunner !== true || typeof ownerToken !== 'string' || !ownerToken) {
		fail('migration-recovery', 'Recovery requires the inspected ownerToken and explicit assertNoActiveRunner=true');
	}
	const result = await metadata.deleteOne(
		{ _id: ctx.lockId, namespace: ctx.namespace, ownerToken, migrationId: plan.id, planHash: ctx.planHash },
		updateOptions
	);
	acknowledged(result);
	if (result.deletedCount !== 1)
		fail('migration-recovery', 'Lock identity changed or is absent; inspect again instead of retrying blindly');
	return { status: 'released', namespace: ctx.namespace };
}

/**
 * Optional executable connection route. Prefer Meteor rawCollection() ports in
 * a trusted admin process. The driver must be installed by the operator; never
 * install packages or discover credentials automatically.
 */
export async function connectMongoMigration({ uri, database, collectionName, metadataName = '_migration_control' }) {
	for (const value of [database, collectionName, metadataName]) {
		if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
			fail('migration-collection', 'Explicit simple database and collection names are required');
	}
	if (collectionName === metadataName || typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//.test(uri))
		fail('migration-connection', 'A Mongo URI and distinct target/metadata collections are required');
	let driver;
	try {
		driver = await import('mongodb');
	} catch {
		fail(
			'migration-driver',
			'Official mongodb driver is unavailable; inject native Collection ports or install a reviewed driver in the operator environment'
		);
	}
	const client = new driver.MongoClient(uri, {
		appName: 'bounded-migration-adapter',
		readPreference: 'primary',
		serverSelectionTimeoutMS: 10000,
		connectTimeoutMS: 10000,
		socketTimeoutMS: 30000,
		retryWrites: false,
		writeConcern
	});
	try {
		await client.connect();
		const db = client.db(database);
		return {
			collection: db.collection(collectionName),
			metadata: db.collection(metadataName),
			close: () => client.close()
		};
	} catch (error) {
		await client.close();
		throw error;
	}
}
