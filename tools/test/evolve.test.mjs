import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash } from '../lib.mjs';
import { createRecipe } from '../recipes.mjs';
import { planEvolution, applyEvolution, recoverEvolution } from '../evolve.mjs';
const base = {
	schemaVersion: 1,
	name: 'notes',
	profile: 'owner',
	fields: [{ name: 'title', label: 'Title', type: 'string', required: true, maxLength: 160 }],
	filters: [],
	states: ['active'],
	transitions: [],
	permissions: { read: ['owner'], write: ['owner'] }
};
const input = {
	schemaVersion: 1,
	module: 'notes',
	operations: [
		{ kind: 'add-field', field: { name: 'done', label: 'Done', type: 'boolean', required: false } },
		{ kind: 'add-filter', field: 'done' }
	]
};
function setup(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolve-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, 'imports/modules'), { recursive: true });
	createRecipe(root, base);
	return root;
}
const modulePath = (root) => path.join(root, 'imports/modules/notes');
test('dry run returns deterministic diffs without writes; apply preserves custom extensions and is idempotent', (t) => {
	const root = setup(t),
		custom = path.join(modulePath(root), 'custom/logic.ts');
	fs.writeFileSync(custom, 'export const custom=42;');
	const before = fs.readFileSync(path.join(modulePath(root), 'module.definition.json'), 'utf8');
	const plan = planEvolution(root, input);
	assert(plan.changes.length >= 2);
	assert.match(plan.changes[0].diff, /--- a\//);
	assert.equal(fs.readFileSync(path.join(modulePath(root), 'module.definition.json'), 'utf8'), before);
	assert.deepEqual(planEvolution(root, input), plan);
	assert.equal(applyEvolution(root, plan).status, 'applied');
	assert.equal(fs.readFileSync(custom, 'utf8'), 'export const custom=42;');
	assert.equal(applyEvolution(root, planEvolution(root, input)).status, 'unchanged');
});
test('generated customizations and forged plans cannot be overwritten', (t) => {
	const root = setup(t);
	const plan = planEvolution(root, input);
	plan.changes[0].content = 'malicious';
	assert.throws(() => applyEvolution(root, plan), /modified/);
	fs.appendFileSync(path.join(modulePath(root), 'generated/Page.tsx'), '// customized');
	assert.throws(() => planEvolution(root, input), /customization/);
});
test('all source snapshot preconditions include custom files and reject stale plans', (t) => {
	const root = setup(t),
		plan = planEvolution(root, input);
	fs.writeFileSync(path.join(modulePath(root), 'custom/change.txt'), 'new');
	assert.throws(() => applyEvolution(root, plan), /changed after planning/);
	assert(fs.readFileSync(path.join(modulePath(root), 'module.definition.json'), 'utf8').includes('title'));
});
test('strict structural operations reject destructive edits, injection, traversal and unknown keys', (t) => {
	const root = setup(t);
	assert.throws(() => planEvolution(root, { ...input, module: '../../escape' }));
	assert.throws(() => planEvolution(root, { ...input, extra: true }));
	assert.throws(() => planEvolution(root, { ...input, operations: [{ kind: 'delete-field', field: 'title' }] }));
	assert.throws(
		() =>
			planEvolution(root, {
				...input,
				operations: [{ kind: 'add-field', field: { ...base.fields[0], maxLength: 4 } }]
			}),
		/differs/
	);
	assert.throws(() =>
		planEvolution(root, {
			...input,
			operations: [{ kind: 'add-field', field: { name: 'ownerId', label: 'Attack', type: 'boolean', required: false } }]
		})
	);
	assert.throws(() => planEvolution(root, { ...input, operations: [{ kind: 'add-filter', field: 'absent' }] }));
});
test('required fields surface migration warning and applied changes clear qualification', (t) => {
	const root = setup(t),
		manifestPath = path.join(modulePath(root), 'module.manifest.json'),
		manifest = JSON.parse(fs.readFileSync(manifestPath));
	manifest.qualified = true;
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
	const plan = planEvolution(root, {
		...input,
		operations: [
			{ kind: 'add-field', field: { name: 'count', label: 'Count', type: 'integer', required: true, min: 0, max: 20 } }
		]
	});
	assert.equal(plan.migrationRequired, true);
	applyEvolution(root, plan);
	assert.equal(JSON.parse(fs.readFileSync(manifestPath)).qualified, false);
});
test('module symlinks and concurrent transactions fail closed', (t) => {
	const root = setup(t);
	fs.writeFileSync(path.join(root, 'imports/modules/.evolve-notes.lock'), 'existing');
	assert.throws(() => applyEvolution(root, planEvolution(root, input)), /locked/);
	fs.rmSync(path.join(root, 'imports/modules/.evolve-notes.lock'));
	fs.symlinkSync('/tmp', path.join(modulePath(root), 'custom/link'));
	assert.throws(() => planEvolution(root, input), /Symbolic/);
});
test('state and permission evolution is validated and preserves existing state', (t) => {
	const root = setup(t),
		plan = planEvolution(root, {
			...input,
			operations: [
				{ kind: 'add-state', state: 'archived', transitions: [{ from: 'active', to: 'archived', roles: ['owner'] }] },
				{ kind: 'replace-permissions', permissions: { read: ['owner'], write: ['owner'] } }
			]
		});
	applyEvolution(root, plan);
	const definition = JSON.parse(fs.readFileSync(path.join(modulePath(root), 'module.definition.json')));
	assert.deepEqual(definition.states, ['active', 'archived']);
	assert.equal(definition.transitions.length, 1);
});
test('failed directory replacement rolls back the original tree and releases lock', (t) => {
	const root = setup(t),
		plan = planEvolution(root, input),
		before = fs.readFileSync(path.join(modulePath(root), 'module.definition.json'), 'utf8'),
		rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		if (from.endsWith('.stage')) throw new Error('injected rename failure');
		return rename(from, to);
	};
	try {
		assert.throws(() => applyEvolution(root, plan), /injected/);
	} finally {
		fs.renameSync = rename;
	}
	assert.equal(fs.readFileSync(path.join(modulePath(root), 'module.definition.json'), 'utf8'), before);
	assert.equal(fs.existsSync(path.join(root, 'imports/modules/.evolve-notes.lock')), false);
	assert.equal(applyEvolution(root, plan).status, 'applied');
});
test('custom files in normally ignored directory names survive complete-tree evolution', (t) => {
	const root = setup(t),
		custom = path.join(modulePath(root), 'custom/.staging/notes.txt');
	fs.mkdirSync(path.dirname(custom), { recursive: true });
	fs.writeFileSync(custom, 'keep me');
	applyEvolution(root, planEvolution(root, input));
	assert.equal(fs.readFileSync(custom, 'utf8'), 'keep me');
});

function crashed(root, { live = false, gap = false } = {}) {
	const plan = planEvolution(root, input),
		parent = path.dirname(modulePath(root)),
		id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
		backup = path.join(parent, `.evolve-${id}.backup`),
		staged = path.join(parent, `.evolve-${id}.stage`);
	fs.cpSync(modulePath(root), backup, { recursive: true });
	applyEvolution(root, plan);
	const expected = Object.fromEntries(
		Object.keys(plan.preconditions).map((file) => [file, hash(fs.readFileSync(path.join(modulePath(root), file)))])
	);
	if (gap) fs.renameSync(modulePath(root), staged);
	const journal = {
		schemaVersion: 1,
		module: 'imports/modules/notes',
		ownerPid: live ? process.pid : 2147483647,
		staged,
		backup,
		preconditions: plan.preconditions,
		expected
	};
	const lock = path.join(parent, '.evolve-notes.lock');
	fs.writeFileSync(lock, JSON.stringify(journal));
	return { journal, lock, backup, staged };
}
test('recovery rolls back verified committed and between-renames crash states', (t) => {
	for (const gap of [false, true]) {
		const root = setup(t);
		crashed(root, { gap });
		assert.equal(recoverEvolution(root, 'notes').status, 'rolled-back');
		assert.equal(JSON.parse(fs.readFileSync(path.join(modulePath(root), 'module.definition.json'))).fields.length, 1);
		assert.equal(fs.existsSync(path.join(path.dirname(modulePath(root)), '.evolve-notes.lock')), false);
	}
});
test('recovery refuses live owners, altered trees and forged journal paths', (t) => {
	const root = setup(t),
		state = crashed(root, { live: true });
	assert.throws(() => recoverEvolution(root, 'notes'), /PID is live/);
	state.journal.ownerPid = 2147483647;
	state.journal.backup = '/tmp/outside';
	fs.writeFileSync(state.lock, JSON.stringify(state.journal));
	assert.throws(() => recoverEvolution(root, 'notes'), /transaction paths/);
	state.journal.backup = state.backup;
	fs.writeFileSync(state.lock, JSON.stringify(state.journal));
	fs.writeFileSync(path.join(modulePath(root), 'custom/intervening.txt'), 'do not erase');
	assert.throws(() => recoverEvolution(root, 'notes'), /Current module changed/);
	assert.equal(fs.readFileSync(path.join(modulePath(root), 'custom/intervening.txt'), 'utf8'), 'do not erase');
});
