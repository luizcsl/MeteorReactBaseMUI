import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { planProject, applyProject, _applyProjectWithHook } from '../automation/project.mjs';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const input = { source: 'boilerplate', destination: 'new-app', name: 'new-app' };
function put(root, name, content) {
	fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
	fs.writeFileSync(path.join(root, name), content);
}
function git(root, ...args) {
	const result = spawnSync(
		'git',
		['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args],
		{
			shell: false,
			encoding: 'utf8',
			timeout: 10000,
			env: {
				PATH: process.env.PATH ?? '',
				HOME: root,
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CONFIG_GLOBAL: '/dev/null',
				LC_ALL: 'C'
			}
		}
	);
	assert.equal(result.status, 0, result.stderr);
}
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-scaffold-test-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const source = path.join(root, 'boilerplate');
	fs.mkdirSync(source);
	put(
		source,
		'package.json',
		JSON.stringify({
			name: 'boilerplate',
			private: true,
			scripts: { postinstall: 'echo MUST_NOT_RUN', start: 'meteor run' }
		})
	);
	put(
		source,
		'package-lock.json',
		JSON.stringify({
			name: 'boilerplate',
			lockfileVersion: 3,
			requires: true,
			packages: { '': { name: 'boilerplate' } }
		})
	);
	for (const [name, content] of Object.entries({
		'.meteor/packages': 'meteor-base\n',
		'.meteor/versions': 'meteor-base@1.5.2\n',
		'.meteor/release': 'METEOR@3.5.2\n',
		'.meteor/platforms': 'browser\nserver\n',
		'.meteor/.finished-upgraders': 'upgrader\n',
		'.meteor/.id': 'SOURCE_APP_ID',
		'.meteor/local/build/main.js': 'CACHE',
		'.env': 'DO_NOT_COPY',
		'.env.production': 'DO_NOT_COPY',
		'.env.example': 'PUBLIC_URL=\n',
		'settings.json': 'DO_NOT_COPY',
		'settings.production.json': 'DO_NOT_COPY',
		'settings.example.json': '{"public":{}}',
		'.npmrc': 'DO_NOT_COPY',
		'.aws/credentials': 'DO_NOT_COPY',
		'private/server.key': 'DO_NOT_COPY',
		'node_modules/sample/index.js': 'DO_NOT_COPY',
		'.agent-state/run.json': 'DO_NOT_COPY',
		'.ai-artifacts/run.json': 'DO_NOT_COPY',
		'artifacts/build.json': 'DO_NOT_COPY',
		'.cypress/screenshots/screen.png': 'DO_NOT_COPY',
		'client/main.ts': 'console.log("Hello");\n',
		'server/main.ts': 'export {};\n',
		'private/templateEmail.html': '<p>Welcome</p>\n',
		'.gitignore': 'node_modules\n.meteor/local\n',
		'README.md': '# Approved boilerplate\n',
		'bin/check.sh': '#!/bin/sh\necho reviewed-not-executed\n'
	}))
		put(source, name, content);
	put(source, 'public/logo.png', Buffer.from([0, 255, 128, 1, 2]));
	fs.chmodSync(path.join(source, 'bin/check.sh'), 0o755);
	git(source, 'init', '--quiet');
	git(source, 'add', '--force', '--', '.');
	put(source, 'untracked-local.txt', 'DO_NOT_COPY');
	return { root, source, target: path.join(root, input.destination) };
}
function resign(plan) {
	const { hash: _hash, ...body } = plan;
	const canonical = JSON.stringify(body, (_key, value) =>
		value && typeof value === 'object' && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: value
	);
	plan.hash = digest(canonical);
	return plan;
}
test('plans actual tracked Meteor source deterministically with complete bytes and zero source/destination mutations', (t) => {
	const { root, source, target } = fixture(t),
		before = fs.readFileSync(path.join(source, 'package.json'));
	const plan = planProject(root, input);
	assert.deepEqual(planProject(root, input), plan);
	assert.equal(fs.existsSync(target), false);
	assert.deepEqual(fs.readFileSync(path.join(source, 'package.json')), before);
	assert.equal(plan.source.files.length, plan.files.length);
	for (const file of plan.files) {
		const bytes = Buffer.from(file.content, file.encoding);
		assert.equal(bytes.length, file.size);
		assert.equal(digest(bytes), file.sha256);
	}
	assert.equal(plan.files.find((file) => file.file === 'public/logo.png').encoding, 'base64');
	assert.equal(plan.requiresApproval, true);
	assert.equal(plan.qualified, false);
	assert.equal(plan.installed, false);
	assert.equal(plan.scriptsExecuted, false);
});
test('approved plan creates usable Meteor files, renames both lock roots, retains binary/modes and never executes scripts', (t) => {
	const { root, source, target } = fixture(t),
		plan = planProject(root, input);
	assert.throws(() => applyProject(root, plan, 'yes'), /approval/);
	const result = applyProject(root, plan, plan.hash);
	assert.equal(result.status, 'applied');
	assert.equal(result.installed, false);
	assert.equal(result.scriptsExecuted, false);
	assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'))).name, 'new-app');
	const lock = JSON.parse(fs.readFileSync(path.join(target, 'package-lock.json')));
	assert.equal(lock.name, 'new-app');
	assert.equal(lock.packages[''].name, 'new-app');
	assert.equal(JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).name, 'boilerplate');
	assert.equal(fs.readFileSync(path.join(target, '.meteor/release'), 'utf8'), 'METEOR@3.5.2\n');
	assert.deepEqual(fs.readFileSync(path.join(target, 'public/logo.png')), Buffer.from([0, 255, 128, 1, 2]));
	assert.equal(fs.statSync(path.join(target, 'bin/check.sh')).mode & 0o777, 0o755);
	assert.equal(fs.existsSync(path.join(target, '.git')), false);
	assert.equal(fs.existsSync(path.join(root, '.project-scaffold.lock')), false);
	assert.throws(() => applyProject(root, plan, plan.hash), /must not exist/);
});
test('excludes tracked secrets, dependency caches, generated artifacts and app identity; untracked files never copy', (t) => {
	const { root, target } = fixture(t),
		plan = planProject(root, input);
	const excluded = [
		'.env',
		'.env.production',
		'.npmrc',
		'settings.json',
		'settings.production.json',
		'.aws/credentials',
		'private/server.key',
		'.meteor/.id',
		'.meteor/local/build/main.js',
		'node_modules/sample/index.js',
		'.agent-state/run.json',
		'.ai-artifacts/run.json',
		'artifacts/build.json',
		'.cypress/screenshots/screen.png'
	];
	for (const file of excluded) assert.ok(plan.source.excluded.includes(file), file);
	assert.equal(
		plan.files.some((file) => file.file === 'untracked-local.txt'),
		false
	);
	assert.equal(
		plan.files.some((file) => file.content.includes('DO_NOT_COPY')),
		false
	);
	applyProject(root, plan, plan.hash);
	for (const file of [...excluded, 'untracked-local.txt'])
		assert.equal(fs.existsSync(path.join(target, file)), false, file);
	assert.ok(fs.existsSync(path.join(target, '.env.example')));
	assert.ok(fs.existsSync(path.join(target, 'settings.example.json')));
	assert.ok(fs.existsSync(path.join(target, 'private/templateEmail.html')));
});
test('rejects plan tampering even after attacker recomputes the review hash', (t) => {
	const { root, target } = fixture(t),
		plan = planProject(root, input);
	for (const change of [
		(p) => {
			p.files[0].content += 'injected';
		},
		(p) => {
			p.files[0].file = '../escape.txt';
		},
		(p) => {
			p.files.push({ ...p.files[0], file: 'untracked.txt' });
		},
		(p) => {
			p.source.files[0].sha256 = '0'.repeat(64);
		},
		(p) => {
			p.qualified = true;
		},
		(p) => {
			p.request.command = 'echo PWNED';
		}
	]) {
		const tampered = structuredClone(plan);
		change(tampered);
		resign(tampered);
		assert.throws(() => applyProject(root, tampered, tampered.hash));
	}
	assert.equal(fs.existsSync(target), false);
});
test('source content, tracked additions and tracked mode changes invalidate a reviewed plan', (t) => {
	const { root, source, target } = fixture(t),
		plan = planProject(root, input);
	put(source, 'client/main.ts', 'changed');
	assert.throws(() => applyProject(root, plan, plan.hash), /stale/);
	const second = planProject(root, input);
	put(source, 'new-file.ts', 'tracked');
	git(source, 'add', '--', 'new-file.ts');
	assert.throws(() => applyProject(root, second, second.hash), /stale/);
	const third = planProject(root, input);
	git(source, 'update-index', '--chmod=+x', '--', 'client/main.ts');
	assert.throws(() => applyProject(root, third, third.hash), /stale/);
	assert.equal(fs.existsSync(target), false);
});
test('rejects existing destination including empty directories and files without modifying them', (t) => {
	const { root, target } = fixture(t);
	fs.mkdirSync(target);
	assert.throws(() => planProject(root, input), /must not exist/);
	put(target, 'keep.txt', 'unrelated');
	assert.throws(() => planProject(root, input), /must not exist/);
	assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'unrelated');
});
test('requires explicit canonical workspace and bounded data-only relative requests', (t) => {
	const { root } = fixture(t);
	for (const value of [
		'../outside',
		'/tmp/outside',
		'new/../../outside',
		'new\\outside',
		'new//outside',
		'new/.',
		'.git/new',
		'node_modules/new'
	]) {
		assert.throws(() => planProject(root, { ...input, destination: value }), /path|destination/);
	}
	for (const value of ['../outside', '/tmp', 'boilerplate/../boilerplate'])
		assert.throws(() => planProject(root, { ...input, source: value }));
	assert.throws(() => planProject('.', input), /absolute/);
	assert.throws(() => planProject(root, { ...input, command: 'npm install' }), /object/);
	assert.throws(() => planProject(root, { ...input, name: 'x;evil' }), /name/);
	assert.throws(
		() => planProject(root, { source: 'boilerplate', destination: 'boilerplate', name: 'new-app' }),
		/destination/
	);
	const getter = { ...input };
	Object.defineProperty(getter, 'name', {
		get() {
			assert.fail('must not invoke getters');
		}
	});
	assert.throws(() => planProject(root, getter), /object/);
});
test('rejects source, destination-parent, tracked-file and Git symlinks instead of reading or writing through them', (t) => {
	const { root, source } = fixture(t);
	fs.symlinkSync(source, path.join(root, 'source-link'));
	assert.throws(() => planProject(root, { ...input, source: 'source-link' }), /symlink/);
	fs.symlinkSync(root, path.join(root, 'output-link'));
	assert.throws(() => planProject(root, { ...input, destination: 'output-link/new-app' }), /symlink/);
	fs.unlinkSync(path.join(source, 'client/main.ts'));
	fs.symlinkSync(path.join(root, 'not-a-secret'), path.join(source, 'client/main.ts'));
	assert.throws(() => planProject(root, input), /symlink/);
	fs.unlinkSync(path.join(source, 'client/main.ts'));
	put(source, 'client/main.ts', 'regular');
	fs.renameSync(path.join(source, '.git'), path.join(root, 'git-metadata'));
	fs.symlinkSync(path.join(root, 'git-metadata'), path.join(source, '.git'));
	assert.throws(() => planProject(root, input), /symlink/);
});
test('does not open excluded tracked secret files even when replaced by dangling symlinks', (t) => {
	const { root, source } = fixture(t);
	fs.unlinkSync(path.join(source, '.env'));
	fs.symlinkSync('/nonexistent/do-not-open', path.join(source, '.env'));
	const plan = planProject(root, input);
	assert.ok(plan.source.excluded.includes('.env'));
});
test('rejects missing required Meteor metadata and inconsistent package/lock names', (t) => {
	const { root, source } = fixture(t);
	put(
		source,
		'package-lock.json',
		JSON.stringify({ name: 'wrong', lockfileVersion: 3, packages: { '': { name: 'wrong' } } })
	);
	assert.throws(() => planProject(root, input), /names must match/);
	git(source, 'rm', '--cached', '--', '.meteor/release');
	assert.throws(() => planProject(root, input), /Meteor boilerplate/);
});
test('caught failure rolls back owned writes and directories with no source or unrelated workspace edits', (t) => {
	const { root, source, target } = fixture(t),
		plan = planProject(root, input);
	put(root, 'unrelated.txt', 'KEEP');
	let writes = 0;
	assert.throws(
		() =>
			_applyProjectWithHook(root, plan, plan.hash, () => {
				if (++writes === 5) throw new Error('injected write failure');
			}),
		/injected write failure/
	);
	assert.equal(fs.existsSync(target), false);
	assert.equal(fs.existsSync(path.join(root, '.project-scaffold.lock')), false);
	assert.equal(fs.readFileSync(path.join(root, 'unrelated.txt'), 'utf8'), 'KEEP');
	assert.equal(JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).name, 'boilerplate');
	assert.equal(applyProject(root, plan, plan.hash).status, 'applied');
});
test('concurrent file edits survive rollback, retaining a lock for supervised recovery', (t) => {
	const { root, target } = fixture(t),
		plan = planProject(root, input);
	let edited;
	assert.throws(
		() =>
			_applyProjectWithHook(root, plan, plan.hash, ({ file }) => {
				edited = file;
				put(target, file, 'CONCURRENT EDIT');
				throw new Error('stop');
			}),
		/rollback conflict/
	);
	assert.equal(fs.readFileSync(path.join(target, edited), 'utf8'), 'CONCURRENT EDIT');
	assert.ok(fs.existsSync(path.join(root, '.project-scaffold.lock')));
});
test('foreign files created during apply are preserved and block cleanup', (t) => {
	const { root, target } = fixture(t),
		plan = planProject(root, input);
	assert.throws(
		() =>
			_applyProjectWithHook(root, plan, plan.hash, () => {
				put(target, 'foreign.txt', 'KEEP');
				throw new Error('stop');
			}),
		/rollback conflict/
	);
	assert.equal(fs.readFileSync(path.join(target, 'foreign.txt'), 'utf8'), 'KEEP');
	assert.ok(fs.existsSync(path.join(root, '.project-scaffold.lock')));
});
test('exclusive lock blocks an additional project writer without changing its destination', (t) => {
	const { root, target } = fixture(t),
		plan = planProject(root, input);
	put(root, '.project-scaffold.lock', 'active writer');
	assert.throws(() => applyProject(root, plan, plan.hash), /locked/);
	assert.equal(fs.existsSync(target), false);
	assert.equal(fs.readFileSync(path.join(root, '.project-scaffold.lock'), 'utf8'), 'active writer');
});
test('apply rejects a source changed during writes and rolls back copied output', (t) => {
	const { root, source, target } = fixture(t),
		plan = planProject(root, input);
	let changed = false;
	assert.throws(
		() =>
			_applyProjectWithHook(root, plan, plan.hash, () => {
				if (!changed) {
					changed = true;
					put(source, 'client/main.ts', 'CONCURRENT SOURCE EDIT');
				}
			}),
		/source changed/
	);
	assert.equal(fs.existsSync(target), false);
	assert.equal(fs.readFileSync(path.join(source, 'client/main.ts'), 'utf8'), 'CONCURRENT SOURCE EDIT');
});
test('root source can create a child project without including its untracked output', (t) => {
	const { source } = fixture(t),
		req = { source: '.', destination: 'new-app', name: 'new-app' };
	const plan = planProject(source, req);
	applyProject(source, plan, plan.hash);
	assert.equal(fs.existsSync(path.join(source, 'new-app/package.json')), true);
	assert.equal(fs.existsSync(path.join(source, 'new-app/new-app')), false);
});
test('detects foreign destination files even when no write hook fails', (t) => {
	const { root, target } = fixture(t),
		plan = planProject(root, input);
	let injected = false;
	assert.throws(
		() =>
			_applyProjectWithHook(root, plan, plan.hash, () => {
				if (!injected) {
					injected = true;
					put(target, 'foreign.txt', 'KEEP');
				}
			}),
		/unexpected concurrent destination entry.*rollback conflict/
	);
	assert.equal(fs.readFileSync(path.join(target, 'foreign.txt'), 'utf8'), 'KEEP');
});
test('destination ancestor symlink substitution during apply never writes through it', (t) => {
	const { root, target } = fixture(t),
		plan = planProject(root, input);
	const outside = path.join(root, 'outside');
	fs.mkdirSync(outside);
	let replaced = false;
	assert.throws(
		() =>
			_applyProjectWithHook(root, plan, plan.hash, () => {
				if (!replaced) {
					replaced = true;
					fs.renameSync(target, target + '-moved');
					fs.symlinkSync(outside, target);
				}
			}),
		/symlink.*rollback conflict/
	);
	assert.deepEqual(fs.readdirSync(outside), []);
	assert.ok(fs.lstatSync(target).isSymbolicLink());
	assert.ok(fs.existsSync(path.join(root, '.project-scaffold.lock')));
});
