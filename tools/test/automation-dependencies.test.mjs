import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DEPENDENCY_COMMAND, _planDependenciesWithExecutor, applyDependencies } from '../automation/dependencies.mjs';
const digest = (v) => createHash('sha256').update(v).digest('hex');
const request = { updates: [{ name: 'sample', from: '1.0.0', to: '1.1.0' }] };
function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-test-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const manifest = {
		name: 'fixture',
		version: '1.0.0',
		scripts: { postinstall: 'echo MUST_NOT_RUN' },
		dependencies: { sample: '1.0.0' },
		devDependencies: { helper: '2.0.0' }
	};
	const lock = {
		name: 'fixture',
		version: '1.0.0',
		lockfileVersion: 3,
		requires: true,
		packages: {
			'': structuredClone(manifest),
			'node_modules/sample': {
				version: '1.0.0',
				resolved: 'https://registry.npmjs.org/sample/-/sample-1.0.0.tgz',
				integrity: 'sha512-YWJj'
			},
			'node_modules/helper': {
				version: '2.0.0',
				resolved: 'https://registry.npmjs.org/helper/-/helper-2.0.0.tgz',
				integrity: 'sha512-YWJj'
			}
		}
	};
	delete lock.packages[''].scripts;
	for (const [name, v] of [
		['package.json', manifest],
		['package-lock.json', lock]
	])
		fs.writeFileSync(path.join(dir, name), JSON.stringify(v, null, 2) + '\n');
	return dir;
}
async function executor(invocation) {
	assert.equal(invocation.command, 'npm');
	assert.deepEqual(invocation.args, [
		'install',
		'--package-lock-only',
		'--ignore-scripts',
		'--no-audit',
		'--no-fund',
		'--registry=https://registry.npmjs.org'
	]);
	assert.equal(invocation.shell, false);
	assert.equal(invocation.env.HOME, invocation.cwd);
	assert.equal(invocation.env.NODE_OPTIONS, undefined);
	assert.equal(invocation.env.NPM_TOKEN, undefined);
	assert.equal(fs.readFileSync(invocation.env.NPM_CONFIG_USERCONFIG, 'utf8'), '');
	const p = JSON.parse(fs.readFileSync(path.join(invocation.cwd, 'package.json'))),
		lock = JSON.parse(fs.readFileSync(path.join(invocation.cwd, 'package-lock.json')));
	lock.packages[''].dependencies = p.dependencies;
	lock.packages['node_modules/sample'] = {
		version: p.dependencies.sample,
		resolved: 'https://registry.npmjs.org/sample/-/sample-' + p.dependencies.sample + '.tgz',
		integrity: 'sha512-ZGVm'
	};
	fs.writeFileSync(path.join(invocation.cwd, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
}
test('dependency planner uses fixed isolated no-script command and returns full reviewed bytes, hashes and diff', async (t) => {
	const root = fixture(t),
		before = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
	let stage;
	const plan = await _planDependenciesWithExecutor(root, request, async (invocation) => {
		stage = invocation.cwd;
		assert.notEqual(stage, root);
		await executor(invocation);
	});
	assert.equal(fs.existsSync(stage), false);
	assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), before);
	assert.equal(plan.changes.length, 2);
	for (const c of plan.changes) {
		assert.equal(c.beforeHash, digest(c.before));
		assert.equal(c.afterHash, digest(c.after));
		assert.match(c.diff, /--- a\/package/);
	}
	assert.equal(plan.requiresApproval, true);
	assert.equal(plan.qualified, false);
	assert.deepEqual(plan.command, DEPENDENCY_COMMAND);
});
test('exact approved plan applies only package and lock without executing installer or lifecycle scripts', async (t) => {
	const root = fixture(t),
		plan = await _planDependenciesWithExecutor(root, request, executor);
	assert.throws(() => applyDependencies(root, plan, 'yes'), /approval/);
	const result = applyDependencies(root, plan, plan.hash);
	assert.equal(result.installed, false);
	assert.equal(result.scriptsExecuted, false);
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).dependencies.sample, '1.1.0');
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'))).packages['node_modules/sample'].version,
		'1.1.0'
	);
	assert.deepEqual(fs.readdirSync(root).sort(), ['package-lock.json', 'package.json']);
	assert.throws(() => applyDependencies(root, plan, plan.hash), /stale/);
});
test('dependency requests reject arbitrary commands, new names, protocols, duplicate names and version ranges', async (t) => {
	const root = fixture(t);
	for (const input of [
		{ ...request, command: 'echo hacked' },
		{ updates: [{ name: 'new', from: '1.0.0', to: '1.1.0' }] },
		{ updates: [{ name: 'sample', from: '1.0.0', to: 'https://evil/a.tgz' }] },
		{ updates: [{ name: 'sample', from: '1.0.0', to: '^1.1.0' }] },
		{ updates: [{ name: 'sample;echo', from: '1.0.0', to: '1.1.0' }] },
		{ updates: [...request.updates, ...request.updates] }
	])
		await assert.rejects(_planDependenciesWithExecutor(root, input, () => assert.fail('executor must not run')));
	const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
	manifest.dependencies.evil = 'git+ssh://evil/a';
	fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
	await assert.rejects(
		_planDependenciesWithExecutor(root, request, () => assert.fail('executor must not run')),
		/registry/
	);
});
test('tampered payload, unrelated manifest edits, stale bytes and unsafe lock sources fail closed', async (t) => {
	const root = fixture(t),
		plan = await _planDependenciesWithExecutor(root, request, executor);
	const modified = structuredClone(plan);
	modified.changes[0].after += ' ';
	assert.throws(() => applyDependencies(root, modified, plan.hash), /plan|modified/);
	await assert.rejects(
		_planDependenciesWithExecutor(root, request, async (invocation) => {
			await executor(invocation);
			const p = JSON.parse(fs.readFileSync(path.join(invocation.cwd, 'package.json')));
			p.scripts.postinstall = 'evil';
			fs.writeFileSync(path.join(invocation.cwd, 'package.json'), JSON.stringify(p));
		}),
		/unrequested/
	);
	await assert.rejects(
		_planDependenciesWithExecutor(root, request, async (invocation) => {
			await executor(invocation);
			const file = path.join(invocation.cwd, 'package-lock.json'),
				lock = JSON.parse(fs.readFileSync(file));
			lock.packages['node_modules/sample'].resolved = 'https://attacker.example/pkg.tgz';
			fs.writeFileSync(file, JSON.stringify(lock));
		}),
		/registry/
	);
	fs.appendFileSync(path.join(root, 'package-lock.json'), '\n');
	assert.throws(() => applyDependencies(root, plan, plan.hash), /stale/);
});
test('second-file write failure rolls back the first file and preserves exact original bytes', async (t) => {
	const root = fixture(t),
		plan = await _planDependenciesWithExecutor(root, request, executor),
		before = Object.fromEntries(
			['package.json', 'package-lock.json'].map((name) => [name, fs.readFileSync(path.join(root, name), 'utf8')])
		);
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		if (from.includes('.dependency-review-stage-') && from.endsWith('/package-lock.json'))
			throw new Error('injected second write failure');
		return rename(from, to);
	};
	try {
		assert.throws(() => applyDependencies(root, plan, plan.hash), /injected/);
	} finally {
		fs.renameSync = rename;
	}
	for (const [name, bytes] of Object.entries(before))
		assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), bytes);
	assert.deepEqual(fs.readdirSync(root).sort(), ['package-lock.json', 'package.json']);
});
test('existing workflow lock, unsafe symlinks and source races are denied', async (t) => {
	const root = fixture(t),
		plan = await _planDependenciesWithExecutor(root, request, executor);
	fs.writeFileSync(path.join(root, '.dependency-review.lock'), 'busy');
	assert.throws(() => applyDependencies(root, plan, plan.hash), /locked/);
	fs.unlinkSync(path.join(root, '.dependency-review.lock'));
	await assert.rejects(
		_planDependenciesWithExecutor(root, request, async (invocation) => {
			await executor(invocation);
			fs.appendFileSync(path.join(root, 'package.json'), '\n');
		}),
		/changed during planning/
	);
	const other = fixture(t);
	fs.unlinkSync(path.join(other, 'package.json'));
	fs.symlinkSync(path.join(root, 'package.json'), path.join(other, 'package.json'));
	await assert.rejects(_planDependenciesWithExecutor(other, request, executor), /Symbolic/);
});
test('existing registry-only overrides are preserved and ranged from must match the manifest declaration exactly', async (t) => {
	const root = fixture(t),
		file = path.join(root, 'package.json'),
		lockFile = path.join(root, 'package-lock.json');
	const manifest = JSON.parse(fs.readFileSync(file)),
		lock = JSON.parse(fs.readFileSync(lockFile));
	manifest.dependencies.sample = '^1.0.0';
	manifest.overrides = { qs: '6.16.1', 'meteor-node-stubs': { url: { qs: '6.16.1' } }, pbkdf2: '3.1.7' };
	lock.packages[''].dependencies.sample = '^1.0.0';
	fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
	fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
	const ranged = { updates: [{ name: 'sample', from: '^1.0.0', to: '1.1.0' }] };
	const plan = await _planDependenciesWithExecutor(root, ranged, executor);
	assert.deepEqual(JSON.parse(plan.changes[0].after).overrides, manifest.overrides);
	await assert.rejects(
		_planDependenciesWithExecutor(root, request, () => assert.fail('must not execute')),
		/stale/
	);
	await assert.rejects(
		_planDependenciesWithExecutor(root, ranged, async (invocation) => {
			await executor(invocation);
			const target = path.join(invocation.cwd, 'package.json'),
				changed = JSON.parse(fs.readFileSync(target));
			changed.overrides.qs = '6.0.0';
			fs.writeFileSync(target, JSON.stringify(changed));
		}),
		/unrequested/
	);
	manifest.overrides.qs = 'https://evil.example/pkg.tgz';
	fs.writeFileSync(file, JSON.stringify(manifest));
	await assert.rejects(
		_planDependenciesWithExecutor(root, ranged, () => assert.fail('must not execute')),
		/override/
	);
});
test('actual repository package and lock preflight succeeds without npm or repository mutation', async () => {
	const root = path.resolve(import.meta.dirname, '../..');
	const original = Object.fromEntries(
		['package.json', 'package-lock.json'].map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')])
	);
	const manifest = JSON.parse(original['package.json']),
		lock = JSON.parse(original['package-lock.json']);
	const name = '@babel/runtime',
		from = manifest.dependencies[name],
		to = lock.packages['node_modules/' + name].version;
	assert.notEqual(from, to, 'fixture pins the existing locked version from its current range');
	let invoked = 0;
	const plan = await _planDependenciesWithExecutor(root, { updates: [{ name, from, to }] }, async (invocation) => {
		invoked++;
		assert.deepEqual(invocation.args, DEPENDENCY_COMMAND.args);
		const target = path.join(invocation.cwd, 'package-lock.json'),
			staged = JSON.parse(fs.readFileSync(target));
		staged.packages[''].dependencies[name] = to;
		fs.writeFileSync(target, JSON.stringify(staged, null, 2) + '\n');
	});
	assert.equal(invoked, 1);
	assert.deepEqual(JSON.parse(plan.changes[0].after).overrides, manifest.overrides);
	for (const [file, bytes] of Object.entries(original))
		assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), bytes);
});
test('concurrent lock edit between renames is preserved and the first file is rolled back', async (t) => {
	const root = fixture(t),
		plan = await _planDependenciesWithExecutor(root, request, executor),
		originalPackage = fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
		originalLock = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		const result = rename(from, to);
		if (from.includes('.dependency-review-stage-') && from.endsWith('/package.json'))
			fs.appendFileSync(path.join(root, 'package-lock.json'), '\n');
		return result;
	};
	try {
		assert.throws(() => applyDependencies(root, plan, plan.hash), /concurrent edit before write/);
	} finally {
		fs.renameSync = rename;
	}
	assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), originalPackage);
	assert.equal(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'), originalLock + '\n');
	assert.deepEqual(fs.readdirSync(root).sort(), ['package-lock.json', 'package.json']);
});
test('rollback never overwrites a concurrent edit to a written file and preserves recovery guard/backups', async (t) => {
	const root = fixture(t),
		plan = await _planDependenciesWithExecutor(root, request, executor);
	const rename = fs.renameSync;
	let externallyEdited;
	fs.renameSync = (from, to) => {
		if (from.includes('.dependency-review-stage-') && from.endsWith('/package-lock.json'))
			throw new Error('second rename failed');
		const result = rename(from, to);
		if (from.includes('.dependency-review-stage-') && from.endsWith('/package.json')) {
			fs.appendFileSync(path.join(root, 'package.json'), '\nEXTERNAL');
			externallyEdited = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
		}
		return result;
	};
	try {
		assert.throws(() => applyDependencies(root, plan, plan.hash), /rollback failed/);
	} finally {
		fs.renameSync = rename;
	}
	assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), externallyEdited);
	assert.ok(fs.existsSync(path.join(root, '.dependency-review.lock')));
	const stage = fs.readdirSync(root).find((name) => name.startsWith('.dependency-review-stage-'));
	assert.ok(stage);
	assert.equal(fs.readFileSync(path.join(root, stage, 'package.json.backup'), 'utf8'), plan.changes[0].before);
	assert.ok(fs.existsSync(path.join(root, stage, 'RECOVERY_REQUIRED.json')));
	await assert.rejects(_planDependenciesWithExecutor(root, request, executor), /supervised recovery/);
});
