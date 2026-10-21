import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { planAutomation } from '../automation/planner/plan.mjs';
import { applyAutomation, recoverAutomation } from '../automation/runner/execute.mjs';
import { renderIntegration } from '../integrate.mjs';

const request = {
	schemaVersion: 1,
	operations: [
		{
			id: 'create',
			kind: 'feature',
			input: {
				schemaVersion: 3,
				intent: 'create-feature',
				name: 'notes',
				archetype: 'owner',
				fields: [{ name: 'title', label: 'Title', type: 'string', required: true, maxLength: 80 }],
				permissions: { read: ['owner'], write: ['owner'] }
			}
		}
	]
};
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-security-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, 'imports/modules'), { recursive: true });
	return root;
}
function write(root, file, text) {
	const full = path.join(root, file);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, text);
}
function read(root, file) {
	const full = path.join(root, file);
	return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}
function journal(root, changes) {
	write(
		root,
		'.agent-state/automation-journal.json',
		JSON.stringify({
			schemaVersion: 1,
			planHash: 'forged',
			status: 'applying',
			changes,
			applied: changes.map((c) => c.path)
		})
	);
}

test('recovery rejects forged protected-file journal without overwriting independent acceptance', async (t) => {
	const root = fixture(t),
		file = 'imports/modules/notes/custom/server/acceptance.test.ts';
	write(root, file, 'independent immutable acceptance');
	journal(root, [{ path: file, before: 'weakened acceptance', after: 'independent immutable acceptance' }]);
	await assert.rejects(async () => recoverAutomation(root));
	assert.equal(read(root, file), 'independent immutable acceptance');
});
test('recovery validates the entire journal before restoring even one file', async (t) => {
	const root = fixture(t);
	write(root, 'imports/safe.ts', 'current');
	journal(root, [
		{ path: '../escape.ts', before: 'malicious', after: null },
		{ path: 'imports/safe.ts', before: 'old', after: 'current' }
	]);
	await assert.rejects(async () => recoverAutomation(root));
	assert.equal(read(root, 'imports/safe.ts'), 'current');
});
test('recovery rejects malformed journal data rather than accepting unvalidated terminal states', async (t) => {
	const root = fixture(t);
	write(
		root,
		'.agent-state/automation-journal.json',
		JSON.stringify({ schemaVersion: 999, status: 'applied', changes: 'not changes' })
	);
	await assert.rejects(async () => recoverAutomation(root));
});
test('failed semantic operation blocks whole composed plan, never silently applies preceding feature', async (t) => {
	const root = fixture(t),
		composed = structuredClone(request);
	composed.operations.push({
		id: 'invalid',
		kind: 'codemod',
		dependsOn: ['create'],
		input: { kind: 'rename-field', file: 'imports/not-found.ts', symbol: 'title', newName: 'caption' }
	});
	await assert.rejects(() => planAutomation(root, composed));
	assert.deepEqual(fs.readdirSync(path.join(root, 'imports/modules')), []);
});
test('codemod cannot alter protected independent test even through semantic references', async (t) => {
	const root = fixture(t);
	write(root, 'imports/model.ts', 'export interface Model { title: string; }');
	write(root, 'imports/model.test.ts', 'import { Model } from "./model"; const example: Model = { title: "fixed" };');
	const operation = {
		schemaVersion: 1,
		operations: [
			{
				id: 'rename',
				kind: 'codemod',
				input: { kind: 'rename-field', file: 'imports/model.ts', symbol: 'title', newName: 'caption' }
			}
		]
	};
	await assert.rejects(() => planAutomation(root, operation), /protected|Protected/);
	assert.equal(
		read(root, 'imports/model.test.ts'),
		'import { Model } from "./model"; const example: Model = { title: "fixed" };'
	);
});
test('failure on second live file rolls back all earlier writes', async (t) => {
	const root = fixture(t),
		plan = await planAutomation(root, request),
		rename = fs.renameSync;
	let count = 0;
	fs.renameSync = (from, to) => {
		if (String(from).startsWith(root + path.sep) && String(from).endsWith('.automation-tmp') && ++count === 2)
			throw new Error('injected-live-write-failure');
		return rename(from, to);
	};
	try {
		await assert.rejects(() => applyAutomation(root, plan), /injected-live-write-failure/);
	} finally {
		fs.renameSync = rename;
	}
	for (const change of plan.changes) assert.equal(read(root, change.path), change.before, change.path);
});
test('rollback conflicts retain the transaction lock and unresolved journal', async (t) => {
	const root = fixture(t),
		plan = await planAutomation(root, request),
		rename = fs.renameSync;
	let count = 0;
	fs.renameSync = (from, to) => {
		if (String(from).startsWith(root + path.sep) && String(from).endsWith('.automation-tmp')) {
			count++;
			if (count === 2) throw new Error('injected-live-write-failure');
			const result = rename(from, to);
			if (count === 1) fs.writeFileSync(to, 'concurrent human change');
			return result;
		}
		return rename(from, to);
	};
	try {
		await assert.rejects(() => applyAutomation(root, plan), /Concurrent|rollback|recovery/i);
	} finally {
		fs.renameSync = rename;
	}
	assert.equal(fs.existsSync(path.join(root, '.agent-state/automation.lock')), true);
	const state = JSON.parse(read(root, '.agent-state/automation-journal.json'));
	assert.notEqual(state.status, 'rolled-back');
});
test('an unresolved journal blocks a new transaction even if a stale lock was manually removed', async (t) => {
	const root = fixture(t),
		plan = await planAutomation(root, request);
	journal(root, []);
	await assert.rejects(() => applyAutomation(root, plan), /journal|recover|transaction/i);
	for (const change of plan.changes) assert.equal(read(root, change.path), change.before);
});
test('integration replay is a true no-op with no lock left in snapshot', async (t) => {
	const root = fixture(t);
	for (const [file, content] of Object.entries(renderIntegration(root, [])))
		write(root, 'imports/integration/' + file, content);
	await applyAutomation(root, await planAutomation(root, request));
	write(root, 'imports/modules/notes/custom/server/ports.ts', 'export const ports = {};');
	write(root, 'imports/modules/notes/custom/server/acceptance.test.ts', 'export const independentlyReviewed = true;');
	const integration = {
		schemaVersion: 1,
		operations: [{ id: 'integrate', kind: 'integrate', input: { schemaVersion: 1, module: 'notes', label: 'Notes' } }]
	};
	const first = await planAutomation(root, integration);
	await applyAutomation(root, first, { planHash: first.planHash, reviews: first.requiresReview });
	const second = await planAutomation(root, integration);
	assert.deepEqual(second.changes, []);
	const result = await applyAutomation(root, second, { planHash: second.planHash, reviews: second.requiresReview });
	assert.equal(result.status, 'unchanged');
	assert.equal(read(root, 'imports/.integration.lock'), null);
});

test('authentic interrupted transaction recovers while holding exclusive lock', async (t) => {
	const root = fixture(t),
		plan = await planAutomation(root, request);
	await applyAutomation(root, plan);
	const state = JSON.parse(read(root, '.agent-state/automation-journal.json'));
	state.status = 'applying';
	write(root, '.agent-state/automation-journal.json', JSON.stringify(state));
	const remove = fs.rmSync;
	let checked = false;
	fs.rmSync = (file, ...args) => {
		if (plan.changes.some((change) => path.join(root, change.path) === String(file))) {
			checked = true;
			assert.equal(fs.existsSync(path.join(root, '.agent-state/automation.lock')), true);
		}
		return remove(file, ...args);
	};
	try {
		assert.equal((await recoverAutomation(root)).status, 'recovered');
	} finally {
		fs.rmSync = remove;
	}
	assert.equal(checked, true);
	for (const change of plan.changes) assert.equal(read(root, change.path), change.before);
});
test('recovery must recheck after asynchronous reconstruction before overwriting a concurrent edit', async (t) => {
	const root = fixture(t),
		plan = await planAutomation(root, request);
	await applyAutomation(root, plan);
	const state = JSON.parse(read(root, '.agent-state/automation-journal.json'));
	state.status = 'applying';
	write(root, '.agent-state/automation-journal.json', JSON.stringify(state));
	const promise = recoverAutomation(root);
	// planAutomation reconstruction yields before the rollback phase.
	const target = plan.changes.at(-1).path;
	write(root, target, 'concurrent human modification');
	await assert.rejects(() => promise, /conflict|Concurrent|changed/i);
	assert.equal(read(root, target), 'concurrent human modification');
});
test('failed live write cleans its temporary artifact rather than poisoning later source snapshots', async (t) => {
	const root = fixture(t),
		plan = await planAutomation(root, request),
		rename = fs.renameSync;
	let temporary;
	fs.renameSync = (from, to) => {
		if (String(from).startsWith(root + path.sep) && String(from).endsWith('.automation-tmp')) {
			temporary = from;
			throw new Error('injected-rename-failure');
		}
		return rename(from, to);
	};
	try {
		await assert.rejects(() => applyAutomation(root, plan), /injected-rename-failure/);
	} finally {
		fs.renameSync = rename;
	}
	assert.ok(temporary);
	assert.equal(fs.existsSync(temporary), false);
	assert.deepEqual(await planAutomation(root, request), plan);
});

test('apply rechecks untouched dependency preconditions after asynchronous planning', async (t) => {
	const root = fixture(t);
	write(root, 'imports/policy.ts', 'export const trustedPolicy = "old";');
	const plan = await planAutomation(root, request);
	const promise = applyAutomation(root, plan);
	write(root, 'imports/policy.ts', 'export const trustedPolicy = "new concurrent policy";');
	await assert.rejects(() => promise, /stale|drift|changed|modified/i);
	for (const change of plan.changes) assert.equal(read(root, change.path), change.before);
});
