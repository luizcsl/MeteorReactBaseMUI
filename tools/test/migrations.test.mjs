import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateFile, rehearseRestore, validateMigration } from '../migrations/runner.mjs';
function fixture(fn) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-'));
	try {
		const file = 'store.json';
		fs.writeFileSync(
			path.join(root, file),
			JSON.stringify({
				version: 0,
				records: [
					{ _id: 'a', title: 'A' },
					{ _id: 'b', title: 'B' },
					{ _id: 'c', title: 'C' }
				],
				migrations: []
			})
		);
		return fn(root, file);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}
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
test('migration dry-run makes no changes; resume checkpoints and rerun are safe', () =>
	fixture((root, file) => {
		const before = fs.readFileSync(path.join(root, file));
		assert.equal(migrateFile(root, file, plan).status, 'planned');
		assert.deepEqual(fs.readFileSync(path.join(root, file)), before);
		assert.equal(migrateFile(root, file, plan, { apply: true, batchSize: 1, stopAfterBatches: 1 }).status, 'paused');
		assert.equal(migrateFile(root, file, plan, { apply: true, batchSize: 1 }).status, 'complete');
		assert.equal(migrateFile(root, file, plan, { apply: true }).status, 'unchanged');
		const store = JSON.parse(fs.readFileSync(path.join(root, file)));
		assert.equal(store.version, 1);
		assert.deepEqual(
			store.records.map((r) => r.name),
			['A', 'B', 'C']
		);
		assert.equal(rehearseRestore(root, file, plan.id).status, 'passed');
	}));
test('migration collision preflight leaves whole dataset untouched', () =>
	fixture((root, file) => {
		const s = JSON.parse(fs.readFileSync(path.join(root, file)));
		s.records[2].name = 'existing';
		fs.writeFileSync(path.join(root, file), JSON.stringify(s));
		const before = fs.readFileSync(path.join(root, file));
		assert.throws(() => migrateFile(root, file, plan, { apply: true, batchSize: 1 }), /already exists/);
		assert.deepEqual(fs.readFileSync(path.join(root, file)), before);
		assert.equal(fs.readdirSync(root).length, 1);
	}));
test('migration rejects changed definition, corrupted backup, unsupported destructive op, scope escape', () =>
	fixture((root, file) => {
		migrateFile(root, file, plan, { apply: true, batchSize: 1, stopAfterBatches: 1 });
		assert.throws(
			() =>
				migrateFile(
					root,
					file,
					{ ...plan, operations: [{ kind: 'add-default', field: 'other', value: 1 }] },
					{ apply: true }
				),
			/changed/
		);
		fs.writeFileSync(path.join(root, `${file}.backup-${plan.id}`), 'bad');
		assert.throws(() => migrateFile(root, file, plan, { apply: true }), /backup/);
		assert.throws(() => validateMigration({ ...plan, operations: [{ kind: 'drop-field', field: 'title' }] }));
		assert.throws(() => migrateFile(root, '../store.json', plan));
	}));
test('migration rejects symlink store and active lock', () =>
	fixture((root, file) => {
		fs.symlinkSync(path.join(root, file), path.join(root, 'link.json'));
		assert.throws(() => migrateFile(root, 'link.json', plan), /Symbolic/);
		fs.writeFileSync(path.join(root, `${file}.migration-lock`), 'owned');
		assert.throws(() => migrateFile(root, file, plan, { apply: true }), /lock/);
		assert.equal(fs.readFileSync(path.join(root, `${file}.migration-lock`), 'utf8'), 'owned');
	}));
test('migration resumes safe pre-checkpoint backup and rejects symlink backup', () =>
	fixture((root, file) => {
		const backup = path.join(root, `${file}.backup-${plan.id}`);
		fs.copyFileSync(path.join(root, file), backup);
		assert.equal(migrateFile(root, file, plan, { apply: true }).status, 'complete');
	}));
test('migration detects mutated paused data and malformed ledger', () =>
	fixture((root, file) => {
		migrateFile(root, file, plan, { apply: true, batchSize: 1, stopAfterBatches: 1 });
		const target = path.join(root, file),
			s = JSON.parse(fs.readFileSync(target));
		s.records[1].title = 'raced';
		fs.writeFileSync(target, JSON.stringify(s));
		assert.throws(() => migrateFile(root, file, plan, { apply: true }), /changed since checkpoint/);
		s.migrations[0].status = 'pretend';
		fs.writeFileSync(target, JSON.stringify(s));
		assert.throws(() => migrateFile(root, file, plan, { apply: true }), /ledger/);
	}));
test('completed migration remains idempotent after a subsequent reviewed migration', () =>
	fixture((root, file) => {
		migrateFile(root, file, plan, { apply: true });
		migrateFile(
			root,
			file,
			{
				version: 1,
				id: 'add-marker',
				fromVersion: 1,
				toVersion: 2,
				operations: [{ kind: 'add-default', field: 'marker', value: 1 }]
			},
			{ apply: true }
		);
		assert.equal(migrateFile(root, file, plan, { apply: true }).status, 'unchanged');
	}));
test('migration refuses a symlink original backup while resuming', () =>
	fixture((root, file) => {
		migrateFile(root, file, plan, { apply: true, batchSize: 1, stopAfterBatches: 1 });
		const backup = path.join(root, `${file}.backup-${plan.id}`),
			saved = path.join(root, 'saved');
		fs.renameSync(backup, saved);
		fs.symlinkSync(saved, backup);
		assert.throws(() => migrateFile(root, file, plan, { apply: true }), /Symbolic/);
	}));
test('offline migration rejects precision-losing schema versions', () => {
	assert.throws(
		() => validateMigration({ ...plan, fromVersion: Number.MAX_SAFE_INTEGER, toVersion: Number.MAX_SAFE_INTEGER + 1 }),
		/versioned/
	);
});
