/** Separate supervisor-reviewed workflow. Never reachable through the ordinary protected-path apply. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { confined } from '../lib.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) =>
	JSON.stringify(value, (_key, item) =>
		item && typeof item === 'object' && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en')))
			: item
	);
const fail = (message) => {
	throw new Error('dependency-review: ' + message);
};
const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const exactVersion = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const registrySpec = (value) =>
	typeof value === 'string' &&
	value.length > 0 &&
	value.length <= 160 &&
	/[0-9*xX]/.test(value) &&
	/^[0-9A-Za-z*~^<>=|.+ -]+$/.test(value);
const packageName = /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/;
export const DEPENDENCY_COMMAND = Object.freeze({
	command: 'npm',
	args: Object.freeze([
		'install',
		'--package-lock-only',
		'--ignore-scripts',
		'--no-audit',
		'--no-fund',
		'--registry=https://registry.npmjs.org'
	])
});
function object(v, keys, required = keys) {
	if (
		!v ||
		typeof v !== 'object' ||
		Array.isArray(v) ||
		Object.getPrototypeOf(v) !== Object.prototype ||
		Reflect.ownKeys(v).some(
			(k) =>
				typeof k !== 'string' || !keys.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), 'value')
		) ||
		required.some((k) => !Object.hasOwn(v, k))
	)
		fail('invalid object');
	return v;
}
function parse(text) {
	try {
		return JSON.parse(text);
	} catch {
		fail('invalid JSON');
	}
}
function updates(raw) {
	object(raw, ['updates']);
	if (
		!Array.isArray(raw.updates) ||
		!raw.updates.length ||
		raw.updates.length > 30 ||
		Reflect.ownKeys(raw.updates).length !== raw.updates.length + 1
	)
		fail('1..30 updates required');
	const names = new Set();
	return raw.updates
		.map((v) => {
			object(v, ['name', 'from', 'to']);
			if (
				typeof v.name !== 'string' ||
				!packageName.test(v.name) ||
				names.has(v.name) ||
				!registrySpec(v.from) ||
				typeof v.to !== 'string' ||
				!exactVersion.test(v.to) ||
				v.from === v.to
			)
				fail('unique existing names, exact current declaration and exact target version required');
			names.add(v.name);
			return { ...v };
		})
		.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
function safeManifest(manifest, lockEntry = false) {
	if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('invalid package manifest');
	for (const key of lockEntry ? [] : ['workspaces', 'resolutions', 'bundledDependencies', 'bundleDependencies'])
		if (Object.hasOwn(manifest, key)) fail('unsupported manifest ' + key);
	if (manifest.overrides !== undefined) {
		const check = (value, depth = 0) => {
			if (depth > 12) fail('override nesting too deep');
			if (typeof value === 'string') {
				if (!registrySpec(value)) fail('only registry semver override values are supported');
				return;
			}
			if (
				!value ||
				typeof value !== 'object' ||
				Array.isArray(value) ||
				Object.getPrototypeOf(value) !== Object.prototype ||
				Object.keys(value).length > 1000
			)
				fail('invalid override tree');
			for (const [key, child] of Object.entries(value)) {
				if (key !== '.' && !packageName.test(key)) fail('unsupported override selector');
				check(child, depth + 1);
			}
		};
		check(manifest.overrides);
	}
	for (const section of sections) {
		const values = manifest[section];
		if (values !== undefined) {
			if (!values || typeof values !== 'object' || Array.isArray(values)) fail('invalid dependency section');
			for (const [name, value] of Object.entries(values)) {
				if (!packageName.test(name) || !registrySpec(value)) fail('only registry semver specifications are supported');
			}
		}
	}
}
function updatedManifest(before, request) {
	safeManifest(before);
	const after = structuredClone(before);
	for (const update of request) {
		const found = sections.filter((section) => Object.hasOwn(before[section] ?? {}, update.name));
		if (found.length !== 1) fail('update must target exactly one existing dependency section: ' + update.name);
		if (before[found[0]][update.name] !== update.from) fail('stale dependency version: ' + update.name);
		after[found[0]][update.name] = update.to;
	}
	return after;
}
function safeLock(lock) {
	if (
		!lock ||
		typeof lock !== 'object' ||
		![2, 3].includes(lock.lockfileVersion) ||
		!lock.packages ||
		typeof lock.packages !== 'object' ||
		Array.isArray(lock.packages) ||
		!lock.packages['']
	)
		fail('npm package-lock v2/v3 with packages required');
	if (lock.dependencies) {
		const visit = (entries) => {
			if (!entries || typeof entries !== 'object' || Array.isArray(entries)) fail('invalid legacy lock dependencies');
			for (const item of Object.values(entries)) {
				if (!item || typeof item !== 'object') fail('invalid legacy lock entry');
				if (item.resolved !== undefined) {
					let u;
					try {
						u = new URL(item.resolved);
					} catch {
						fail('invalid legacy lock URL');
					}
					if (
						u.protocol !== 'https:' ||
						u.hostname !== 'registry.npmjs.org' ||
						u.username ||
						u.password ||
						u.search ||
						u.hash ||
						u.port
					)
						fail('unsafe legacy lock URL');
				}
				if (item.dependencies) visit(item.dependencies);
			}
		};
		visit(lock.dependencies);
	}
	for (const [key, pkg] of Object.entries(lock.packages)) {
		if (
			key !== '' &&
			(!key.startsWith('node_modules/') || key.includes('..') || key.includes('\\') || key.split('/').some((x) => !x))
		)
			fail('unsafe lock package path');
		if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg) || pkg.link)
			fail('linked/local lock packages unsupported');
		safeManifest(pkg, true);
		if (pkg.resolved !== undefined) {
			let u;
			try {
				u = new URL(pkg.resolved);
			} catch {
				fail('invalid resolved URL');
			}
			if (
				u.protocol !== 'https:' ||
				u.hostname !== 'registry.npmjs.org' ||
				u.username ||
				u.password ||
				u.search ||
				u.hash ||
				u.port
			)
				fail('lock sources must use official npm registry HTTPS URLs');
		}
		if (key !== '' && (typeof pkg.version !== 'string' || !exactVersion.test(pkg.version)))
			fail('exact locked package version required');
		if (
			pkg.integrity !== undefined &&
			(typeof pkg.integrity !== 'string' || !/^(?:sha512|sha384|sha256|sha1)-[A-Za-z0-9+/]+={0,2}$/.test(pkg.integrity))
		)
			fail('invalid package integrity');
	}
}
function validateChange(originalPackage, nextPackage, originalLock, nextLock, request) {
	const before = parse(originalPackage),
		after = parse(nextPackage),
		oldLock = parse(originalLock),
		newLock = parse(nextLock);
	const expected = updatedManifest(before, request);
	if (canonical(after) !== canonical(expected)) fail('manifest contains unrequested changes');
	safeLock(oldLock);
	safeLock(newLock);
	if (newLock.lockfileVersion !== oldLock.lockfileVersion) fail('lock format change requires a separate review');
	const oldMeta = { ...oldLock },
		newMeta = { ...newLock };
	delete oldMeta.packages;
	delete oldMeta.dependencies;
	delete newMeta.packages;
	delete newMeta.dependencies;
	if (canonical(oldMeta) !== canonical(newMeta)) fail('unrequested lock metadata changes');
	const oldRoot = oldLock.packages[''],
		newRoot = newLock.packages[''];
	const expectedRoot = structuredClone(oldRoot);
	for (const update of request) {
		const section = sections.find((s) => Object.hasOwn(before[s] ?? {}, update.name));
		if (oldRoot[section]?.[update.name] !== update.from) fail('original lock root does not match manifest');
		expectedRoot[section][update.name] = update.to;
		const entry = newLock.packages['node_modules/' + update.name];
		if (!entry || entry.version !== update.to || !entry.resolved || !entry.integrity)
			fail('requested version not locked with registry integrity: ' + update.name);
	}
	if (canonical(newRoot) !== canonical(expectedRoot)) fail('unrequested lock root changes');
	for (const section of sections)
		if (canonical(newRoot[section] ?? {}) !== canonical(after[section] ?? {}))
			fail('lock and manifest dependency declarations differ');
	return { before, after };
}
function fileState(root) {
	if (fs.readdirSync(root).some((name) => name.startsWith('.dependency-review-stage-')))
		fail('unfinished dependency transaction requires supervised recovery');
	return Object.fromEntries(
		['package.json', 'package-lock.json'].map((file) => {
			const target = confined(root, file);
			if (!fs.statSync(target).isFile()) fail('expected regular file ' + file);
			const bytes = fs.readFileSync(target, 'utf8');
			if (Buffer.byteLength(bytes) > 30_000_000) fail('input too large');
			return [file, bytes];
		})
	);
}
function diff(file, before, after) {
	return (
		'--- a/' +
		file +
		'\n+++ b/' +
		file +
		'\n@@ full reviewed replacement @@\n' +
		before
			.split('\n')
			.map((s) => '-' + s)
			.join('\n') +
		'\n' +
		after
			.split('\n')
			.map((s) => '+' + s)
			.join('\n') +
		'\n'
	);
}
function planHash(plan) {
	const { hash: ignored, ...body } = plan;
	return hash(JSON.stringify(body));
}
async function planWithExecutor(root, raw, executor) {
	const request = updates(raw),
		source = fileState(root),
		before = parse(source['package.json']);
	const manifest = updatedManifest(before, request);
	safeLock(parse(source['package-lock.json']));
	const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-review-'));
	try {
		fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
		fs.writeFileSync(path.join(stage, 'package-lock.json'), source['package-lock.json']);
		fs.writeFileSync(path.join(stage, 'user.npmrc'), '');
		fs.writeFileSync(path.join(stage, 'global.npmrc'), '');
		const invocation = {
			command: DEPENDENCY_COMMAND.command,
			args: [...DEPENDENCY_COMMAND.args],
			cwd: stage,
			env: {
				PATH: process.env.PATH ?? '',
				HOME: stage,
				TMPDIR: stage,
				NPM_CONFIG_USERCONFIG: path.join(stage, 'user.npmrc'),
				NPM_CONFIG_GLOBALCONFIG: path.join(stage, 'global.npmrc'),
				NPM_CONFIG_CACHE: path.join(stage, 'cache')
			},
			timeout: 120000,
			maxBuffer: 1000000,
			shell: false
		};
		await executor(invocation);
		const result = fileState(stage);
		validateChange(
			source['package.json'],
			result['package.json'],
			source['package-lock.json'],
			result['package-lock.json'],
			request
		);
		const fresh = fileState(root);
		if (Object.keys(source).some((file) => fresh[file] !== source[file])) fail('source changed during planning');
		const changes = Object.keys(source).map((file) => ({
			file,
			beforeHash: hash(source[file]),
			afterHash: hash(result[file]),
			before: source[file],
			after: result[file],
			diff: diff(file, source[file], result[file])
		}));
		const plan = {
			schemaVersion: 1,
			kind: 'supervisor-dependency-update',
			root: fs.realpathSync(root),
			request: { updates: request },
			command: DEPENDENCY_COMMAND,
			changes,
			requiresApproval: true,
			qualified: false
		};
		return { ...plan, hash: planHash(plan) };
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
	}
}
export function planDependencies(root, input) {
	return planWithExecutor(root, input, async (invocation) => {
		const { command, args, ...options } = invocation;
		const result = spawnSync(command, args, { ...options, encoding: 'utf8' });
		if (result.error) fail('isolated lock generation failed: ' + result.error.code);
		if (result.status !== 0) fail('isolated npm lock generation failed with exit ' + result.status);
	});
}
/** Internal deterministic test hook. Not part of a CLI/MCP JSON schema or the supervisor approval surface. */
export const _planDependenciesWithExecutor = planWithExecutor;
function validatePlan(root, plan, approval) {
	object(plan, [
		'schemaVersion',
		'kind',
		'root',
		'request',
		'command',
		'changes',
		'requiresApproval',
		'qualified',
		'hash'
	]);
	if (
		plan.schemaVersion !== 1 ||
		plan.kind !== 'supervisor-dependency-update' ||
		plan.root !== fs.realpathSync(root) ||
		plan.requiresApproval !== true ||
		plan.qualified !== false ||
		typeof approval !== 'string' ||
		approval !== plan.hash ||
		planHash(plan) !== plan.hash ||
		JSON.stringify(plan.command) !== JSON.stringify(DEPENDENCY_COMMAND)
	)
		fail('invalid plan or exact supervisor approval hash');
	const request = updates(plan.request);
	if (!Array.isArray(plan.changes) || plan.changes.length !== 2) fail('exactly package and lock changes required');
	for (const [i, file] of ['package.json', 'package-lock.json'].entries()) {
		const c = object(plan.changes[i], ['file', 'beforeHash', 'afterHash', 'before', 'after', 'diff']);
		if (
			c.file !== file ||
			typeof c.before !== 'string' ||
			typeof c.after !== 'string' ||
			Buffer.byteLength(c.before) > 30_000_000 ||
			Buffer.byteLength(c.after) > 30_000_000 ||
			c.beforeHash !== hash(c.before) ||
			c.afterHash !== hash(c.after) ||
			c.diff !== diff(file, c.before, c.after)
		)
			fail('modified change payload');
	}
	validateChange(plan.changes[0].before, plan.changes[0].after, plan.changes[1].before, plan.changes[1].after, request);
	const current = fileState(root);
	if (plan.changes.some((c) => current[c.file] !== c.before)) fail('stale package or lock bytes');
}
export function applyDependencies(root, plan, approval) {
	validatePlan(root, plan, approval);
	const lock = confined(root, '.dependency-review.lock', { missing: true });
	let fd;
	try {
		fd = fs.openSync(lock, 'wx', 0o600);
	} catch {
		fail('dependency workflow is locked');
	}
	let stage;
	let needsRecovery = false;
	const written = [];
	try {
		validatePlan(root, plan, approval);
		stage = fs.mkdtempSync(path.join(fs.realpathSync(root), '.dependency-review-stage-'));
		for (const c of plan.changes) {
			fs.writeFileSync(path.join(stage, c.file), c.after, { mode: fs.statSync(confined(root, c.file)).mode });
			fs.writeFileSync(path.join(stage, c.file + '.backup'), c.before, {
				mode: fs.statSync(confined(root, c.file)).mode
			});
		}
		for (const c of plan.changes) {
			if (fs.readFileSync(confined(root, c.file), 'utf8') !== c.before) fail('concurrent edit before write: ' + c.file);
			fs.renameSync(path.join(stage, c.file), confined(root, c.file));
			written.push(c.file);
		}
		for (const c of plan.changes)
			if (fs.readFileSync(confined(root, c.file), 'utf8') !== c.after) fail('concurrent edit after write: ' + c.file);
		return {
			schemaVersion: 1,
			status: 'applied',
			hash: plan.hash,
			files: plan.changes.map((c) => c.file),
			installed: false,
			scriptsExecuted: false,
			qualified: false
		};
	} catch (error) {
		const failures = [];
		for (const file of written.reverse()) {
			try {
				const expected = plan.changes.find((change) => change.file === file).after;
				if (fs.readFileSync(confined(root, file), 'utf8') !== expected)
					throw new Error('concurrent edit preserved; manual recovery required');
				fs.renameSync(path.join(stage, file + '.backup'), confined(root, file));
			} catch (rollback) {
				failures.push(file + ': ' + rollback.message);
			}
		}
		if (failures.length) {
			fs.writeFileSync(
				path.join(stage, 'RECOVERY_REQUIRED.json'),
				JSON.stringify({ files: failures, planHash: plan.hash })
			);
			needsRecovery = true;
			throw new Error(
				'dependency-review: rollback failed; retain .dependency-review-stage-* backups for supervised recovery'
			);
		}
		throw error;
	} finally {
		if (stage && !needsRecovery) fs.rmSync(stage, { recursive: true, force: true });
		fs.closeSync(fd);
		if (!needsRecovery) fs.unlinkSync(lock);
	}
}
