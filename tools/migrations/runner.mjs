import fs from 'node:fs';
import path from 'node:path';
import { exact, fail, hash, confined } from '../lib.mjs';
const name = (v) =>
	typeof v === 'string' &&
	/^[a-z][a-zA-Z0-9]{0,63}$/.test(v) &&
	!['constructor', 'prototype', '__proto__', '_id', 'ownerId', 'tenantId', 'version'].includes(v);
const jsonValue = (v) =>
	v === null ||
	typeof v === 'boolean' ||
	(typeof v === 'string' && v.length <= 100000) ||
	(typeof v === 'number' && Number.isFinite(v));
export function validateMigration(plan) {
	exact(plan, ['version', 'id', 'fromVersion', 'toVersion', 'operations']);
	if (
		plan.version !== 1 ||
		!/^[a-z][a-z0-9-]{2,63}$/.test(plan.id) ||
		!Number.isSafeInteger(plan.fromVersion) ||
		plan.fromVersion < 0 ||
		!Number.isSafeInteger(plan.toVersion) ||
		plan.toVersion !== plan.fromVersion + 1 ||
		!Array.isArray(plan.operations) ||
		!plan.operations.length ||
		plan.operations.length > 50
	)
		fail('migration-schema', 'Invalid versioned migration');
	const touched = new Set();
	for (const op of plan.operations) {
		if (op.kind === 'add-default') {
			exact(op, ['kind', 'field', 'value']);
			if (!name(op.field) || !jsonValue(op.value)) fail('migration-schema', 'Invalid default field/value');
		} else if (op.kind === 'rename-field') {
			exact(op, ['kind', 'from', 'to']);
			if (!name(op.from) || !name(op.to) || op.from === op.to) fail('migration-schema', 'Invalid rename');
		} else fail('migration-operation', 'Only add-default and non-destructive rename are supported');
		for (const field of op.kind === 'add-default' ? [op.field] : [op.from, op.to]) {
			if (touched.has(field)) fail('migration-overlap', 'Operations overlap; split into reviewed migrations');
			touched.add(field);
		}
	}
	return plan;
}
export function transformRecord(record, plan) {
	const result = structuredClone(record);
	for (const op of plan.operations) {
		if (op.kind === 'add-default' && !Object.hasOwn(result, op.field)) result[op.field] = op.value;
		if (op.kind === 'rename-field' && Object.hasOwn(result, op.from)) {
			if (Object.hasOwn(result, op.to))
				fail('migration-collision', `Destination ${op.to} already exists for ${record._id}`);
			result[op.to] = result[op.from];
			delete result[op.from];
		}
	}
	return result;
}
function validateStore(store) {
	exact(store, ['version', 'records', 'migrations']);
	if (
		!Number.isSafeInteger(store.version) ||
		store.version < 0 ||
		!Array.isArray(store.records) ||
		store.records.length > 100000 ||
		!Array.isArray(store.migrations)
	)
		fail('migration-store', 'Invalid store');
	const migrationIds = new Set();
	for (const m of store.migrations) {
		exact(m, ['id', 'digest', 'status', 'cursor', 'backupHash', 'sourceCount', 'recordHash']);
		if (
			!/^[a-z][a-z0-9-]{2,63}$/.test(m.id) ||
			migrationIds.has(m.id) ||
			!['running', 'complete'].includes(m.status) ||
			![m.digest, m.backupHash, m.recordHash].every((x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)) ||
			!Number.isInteger(m.cursor) ||
			m.cursor < 0 ||
			!Number.isInteger(m.sourceCount) ||
			m.sourceCount < 0 ||
			m.cursor > m.sourceCount
		)
			fail('migration-ledger', 'Invalid checkpoint ledger');
		migrationIds.add(m.id);
	}
	const ids = new Set();
	for (const row of store.records) {
		if (
			!row ||
			Object.getPrototypeOf(row) !== Object.prototype ||
			typeof row._id !== 'string' ||
			!row._id ||
			ids.has(row._id)
		)
			fail('migration-record', 'Unique string _id required');
		ids.add(row._id);
	}
	return store;
}
function writeAtomic(file, value) {
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	const fd = fs.openSync(tmp, 'wx', 0o600);
	try {
		fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.renameSync(tmp, file);
		const dir = fs.openSync(path.dirname(file), 'r');
		try {
			fs.fsyncSync(dir);
		} finally {
			fs.closeSync(dir);
		}
	} finally {
		if (fs.existsSync(tmp)) fs.rmSync(tmp);
	}
}
/** Offline, synthetic/export store runner. Does not connect to production Mongo. Each checkpoint is one atomic store replacement. */
export function migrateFile(root, file, plan, { apply = false, batchSize = 100, stopAfterBatches = Infinity } = {}) {
	validateMigration(plan);
	if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
		fail('migration-batch', 'batchSize must be 1..1000');
	const target = confined(root, file);
	if (fs.statSync(target).size > 64 * 1024 * 1024) fail('migration-size', 'Store exceeds 64MiB');
	const original = fs.readFileSync(target, 'utf8'),
		store = validateStore(JSON.parse(original)),
		digest = hash(JSON.stringify(plan));
	let ledger = store.migrations.find((m) => m.id === plan.id);
	if (
		ledger &&
		ledger.status !== 'complete' &&
		(!Number.isInteger(ledger.cursor) ||
			ledger.cursor < 0 ||
			ledger.cursor > store.records.length ||
			ledger.sourceCount !== store.records.length ||
			ledger.recordHash !== hash(JSON.stringify(store.records)))
	)
		fail('migration-concurrent', 'Store changed since checkpoint');
	if (ledger && ledger.digest !== digest) fail('migration-drift', 'Migration ID changed its content');
	if (ledger?.status === 'complete') {
		if (store.version < plan.toVersion || ledger.cursor !== ledger.sourceCount)
			fail('migration-ledger', 'Incomplete committed checkpoint');
		return { status: 'unchanged', id: plan.id, version: store.version };
	}
	if (store.version !== plan.fromVersion) fail('migration-version', 'Unexpected source version');
	// Preflight the ENTIRE remaining dataset before any write, not only the first page.
	const start = ledger?.cursor || 0,
		proposed = store.records.slice(start).map((r) => transformRecord(r, plan));
	const changes = proposed.filter((r, i) => JSON.stringify(r) !== JSON.stringify(store.records[start + i])).length;
	if (!apply)
		return {
			status: 'planned',
			id: plan.id,
			sourceHash: hash(original),
			records: store.records.length,
			remaining: proposed.length,
			changed: changes,
			fromVersion: plan.fromVersion,
			toVersion: plan.toVersion
		};
	const lock = `${target}.migration-lock`;
	let lockFd;
	try {
		lockFd = fs.openSync(lock, 'wx', 0o600);
	} catch (e) {
		if (e.code === 'EEXIST')
			fail('migration-locked', 'Another migration owns the lock; verify process before manual recovery');
		throw e;
	}
	try {
		fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, id: plan.id }));
		if (fs.readFileSync(target, 'utf8') !== original) fail('migration-concurrent', 'Store changed after planning');
		const backup = confined(root, `${file}.backup-${plan.id}`, { missing: true });
		if (!ledger) {
			if (fs.existsSync(backup)) {
				if (fs.readFileSync(backup, 'utf8') !== original)
					fail('migration-backup', 'Existing pre-checkpoint backup differs');
			} else {
				const backupFd = fs.openSync(backup, 'wx', 0o600);
				try {
					fs.writeFileSync(backupFd, original);
					fs.fsyncSync(backupFd);
				} finally {
					fs.closeSync(backupFd);
				}
			}
			ledger = {
				id: plan.id,
				digest,
				status: 'running',
				cursor: 0,
				backupHash: hash(original),
				sourceCount: store.records.length,
				recordHash: hash(JSON.stringify(store.records))
			};
			store.migrations.push(ledger);
		} else if (!fs.existsSync(backup) || hash(fs.readFileSync(backup)) !== ledger.backupHash)
			fail('migration-backup', 'Resume requires intact original backup');
		let batches = 0;
		while (ledger.cursor < store.records.length) {
			const end = Math.min(ledger.cursor + batchSize, store.records.length);
			for (let i = ledger.cursor; i < end; i++) store.records[i] = transformRecord(store.records[i], plan);
			ledger.cursor = end;
			ledger.recordHash = hash(JSON.stringify(store.records));
			writeAtomic(target, store);
			batches++;
			if (batches >= stopAfterBatches)
				return { status: 'paused', id: plan.id, cursor: ledger.cursor, total: store.records.length };
		}
		ledger.status = 'complete';
		store.version = plan.toVersion;
		writeAtomic(target, store);
		return {
			status: 'complete',
			id: plan.id,
			version: store.version,
			records: store.records.length,
			backupHash: ledger.backupHash
		};
	} finally {
		if (lockFd !== undefined) fs.closeSync(lockFd);
		fs.rmSync(lock, { force: true });
	}
}
export function rehearseRestore(root, file, migrationId) {
	if (!/^[a-z][a-z0-9-]{2,63}$/.test(migrationId)) fail('migration-id', 'Invalid id');
	const target = confined(root, file),
		store = validateStore(JSON.parse(fs.readFileSync(target, 'utf8'))),
		ledger = store.migrations.find((m) => m.id === migrationId);
	if (!ledger) fail('migration-id', 'Unknown migration');
	const backup = confined(root, `${file}.backup-${migrationId}`),
		data = fs.readFileSync(backup);
	if (hash(data) !== ledger.backupHash) fail('migration-backup', 'Backup integrity failed');
	const restored = validateStore(JSON.parse(data));
	const probe = path.join(path.dirname(target), `.restore-rehearsal-${process.pid}-${Date.now()}`);
	try {
		fs.writeFileSync(probe, data, { flag: 'wx', mode: 0o600 });
		const reread = fs.readFileSync(probe);
		if (hash(reread) !== ledger.backupHash) fail('migration-restore', 'Restored bytes differ');
		return {
			status: 'passed',
			backupHash: ledger.backupHash,
			restoredVersion: restored.version,
			records: restored.records.length,
			scope: 'offline export only; not a Mongo/files deployment backup rehearsal'
		};
	} finally {
		fs.rmSync(probe, { force: true });
	}
}
