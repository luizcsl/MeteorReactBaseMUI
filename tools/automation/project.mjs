/** Supervisor-reviewed creation of a new local project. No installs, hooks, runtime or deployment. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const canonical = (value) =>
	JSON.stringify(value, (_key, item) =>
		item && typeof item === 'object' && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b)))
			: item
	);
const fail = (message) => {
	throw new Error('project-review: ' + message);
};
const LIMITS = Object.freeze({ files: 5000, fileBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 });
const LOCK = '.project-scaffold.lock';
const REQUIRED = [
	'package.json',
	'package-lock.json',
	'.meteor/packages',
	'.meteor/versions',
	'.meteor/release',
	'.meteor/platforms'
];
export const PROJECT_LIMITS = LIMITS;

function object(value, keys) {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Reflect.ownKeys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key)) ||
		Reflect.ownKeys(value).some(
			(key) =>
				typeof key !== 'string' ||
				!keys.includes(key) ||
				!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')
		)
	)
		fail('invalid object');
	return value;
}
function relative(value, dot = false) {
	if (dot && value === '.') return value;
	if (
		typeof value !== 'string' ||
		!value ||
		value.length > 500 ||
		value
			.split('/')
			.some((part) => !/^[A-Za-z0-9_.@+-]+$/.test(part) || ['.', '..'].includes(part) || /[. ]$/.test(part))
	)
		fail('safe portable relative path required');
	return value;
}
function request(raw) {
	object(raw, ['source', 'destination', 'name']);
	const source = relative(raw.source, true),
		destination = relative(raw.destination);
	if (typeof raw.name !== 'string' || !/^[a-z][a-z0-9-]{1,62}$/.test(raw.name))
		fail('project name must use 2..63 lowercase letters, digits or hyphens');
	if (excluded(destination) || source === destination || source.startsWith(destination + '/'))
		fail('unsafe or overlapping destination');
	return { source, destination, name: raw.name };
}
function workspace(root) {
	if (typeof root !== 'string' || !path.isAbsolute(root)) fail('explicit absolute workspace root required');
	const resolved = path.resolve(root);
	if (fs.realpathSync(root) !== resolved || !fs.lstatSync(root).isDirectory())
		fail('workspace must be a real directory, without symlink ancestors');
	return resolved;
}
function safePath(root, name, missing = false) {
	if (name === '.') return root;
	relative(name);
	let current = root;
	const parts = name.split('/');
	for (let i = 0; i < parts.length; i++) {
		current = path.join(current, parts[i]);
		let stat;
		try {
			stat = fs.lstatSync(current);
		} catch (error) {
			if (missing && error.code === 'ENOENT') continue;
			throw error;
		}
		if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()))
			fail('symlink or non-directory path component: ' + name);
	}
	return current;
}
function existingStat(file) {
	try {
		return fs.lstatSync(file);
	} catch (error) {
		if (error.code === 'ENOENT') return null;
		throw error;
	}
}
function readFile(root, file, limit = LIMITS.fileBytes) {
	const full = safePath(root, file),
		stat = fs.lstatSync(full);
	if (!stat.isFile() || stat.size > limit) fail('bounded regular file required: ' + file);
	const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const opened = fs.fstatSync(fd);
		if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > limit)
			fail('file changed while opening: ' + file);
		const bytes = fs.readFileSync(fd);
		if (bytes.length > limit) fail('file exceeded size limit: ' + file);
		return bytes;
	} finally {
		fs.closeSync(fd);
	}
}
// Excluded paths are never opened. Examples remain reviewable but real settings, auth and key files never copy.
function excluded(file) {
	const parts = file.toLowerCase().split('/'),
		base = parts.at(-1);
	return (
		parts.some(
			(part) =>
				[
					'.git',
					'node_modules',
					'.aws',
					'.ssh',
					'.gnupg',
					'.codex',
					'.agents',
					'.agent-state',
					'.ai-artifacts',
					'.generated-staging',
					'.staging',
					'.cache',
					'.idea',
					'.vscode',
					'artifacts',
					'coverage',
					'dist',
					'build',
					'logs',
					'secrets',
					'credentials'
				].includes(part) || /^\.(?:dependency-review|project-scaffold)(?:[.-]|$)/.test(part)
		) ||
		/^\.meteor\/(?:local(?:\/|$)|\.id$)/.test(file.toLowerCase()) ||
		/^\.cypress\/(?:results|screenshots|videos|cucumber-json)(?:\/|$)/.test(file.toLowerCase()) ||
		(/^\.env(?:\.|$)/.test(base) && base !== '.env.example') ||
		(/^settings(?:\.[^/]+)?\.json$/.test(base) && base !== 'settings.example.json') ||
		[
			'.npmrc',
			'.yarnrc',
			'.yarnrc.yml',
			'.netrc',
			'_netrc',
			'.git-credentials',
			'.gitmodules',
			'id_rsa',
			'id_dsa',
			'id_ecdsa',
			'id_ed25519'
		].includes(base) ||
		/\.(?:pem|key|p12|pfx|keystore|jks|log|tsbuildinfo)$/.test(base) ||
		/^(?:secrets?|credentials?)(?:[.-]|$)/.test(base)
	);
}
function tracked(root) {
	const git = safePath(root, '.git');
	if (!fs.lstatSync(git).isDirectory() || existingStat(path.join(git, 'commondir')))
		fail('normal local Git checkout required, not linked worktree');
	// No shell, caller flags, inherited Git configuration, hooks, credential lookup, network or fsmonitor command.
	const result = spawnSync(
		'git',
		[
			'-c',
			'core.fsmonitor=false',
			'-c',
			'core.hooksPath=/dev/null',
			'-c',
			'core.untrackedCache=false',
			'--no-pager',
			'-C',
			root,
			'ls-files',
			'--cached',
			'--stage',
			'-z',
			'--'
		],
		{
			encoding: 'buffer',
			shell: false,
			timeout: 15000,
			maxBuffer: 4 * 1024 * 1024,
			env: {
				PATH: process.env.PATH ?? '',
				HOME: root,
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_TERMINAL_PROMPT: '0',
				GIT_OPTIONAL_LOCKS: '0',
				LC_ALL: 'C'
			}
		}
	);
	if (result.error || result.status !== 0) fail('read-only Git tracked-file listing failed');
	const text = result.stdout.toString('utf8');
	if (!Buffer.from(text).equals(result.stdout) || !text.endsWith('\0')) fail('invalid or empty tracked-file listing');
	const entries = text
		.slice(0, -1)
		.split('\0')
		.map((line) => {
			const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t(.+)$/.exec(line);
			if (!match || match[3] !== '0') fail('unmerged or malformed tracked entry');
			return { file: relative(match[4]), mode: match[1], object: match[2] };
		})
		.sort((a, b) => compare(a.file, b.file));
	if (entries.length > LIMITS.files || new Set(entries.map((e) => e.file.toLowerCase())).size !== entries.length)
		fail('file count or portable case-collision limit');
	return entries;
}
function snapshot(root) {
	const entries = tracked(root),
		files = [],
		skipped = [];
	let size = 0;
	for (const entry of entries) {
		if (excluded(entry.file)) {
			skipped.push(entry.file);
			continue;
		}
		if (!['100644', '100755'].includes(entry.mode))
			fail('tracked links, submodules and special files are unsupported: ' + entry.file);
		const bytes = readFile(root, entry.file);
		size += bytes.length;
		if (size > LIMITS.totalBytes) fail('source byte budget exceeded');
		files.push({
			file: entry.file,
			mode: entry.mode === '100755' ? 0o755 : 0o644,
			size: bytes.length,
			sha256: hash(bytes),
			bytes
		});
	}
	for (const file of REQUIRED)
		if (!files.some((entry) => entry.file === file)) fail('tracked Meteor boilerplate file required: ' + file);
	return { trackedHash: hash(canonical(entries)), skipped, files };
}
function snapshotSummary(value) {
	return {
		trackedHash: value.trackedHash,
		excluded: value.skipped,
		files: value.files.map(({ bytes, ...file }) => file)
	};
}
function json(bytes, file) {
	try {
		const value = JSON.parse(bytes.toString('utf8'));
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
		return value;
	} catch {
		fail('valid JSON object required: ' + file);
	}
}
function artifacts(source, name) {
	const manifest = json(source.files.find((v) => v.file === 'package.json').bytes, 'package.json');
	const lock = json(source.files.find((v) => v.file === 'package-lock.json').bytes, 'package-lock.json');
	if (
		!manifest.name ||
		![2, 3].includes(lock.lockfileVersion) ||
		!lock.packages?.[''] ||
		typeof lock.packages[''] !== 'object' ||
		Array.isArray(lock.packages[''])
	)
		fail('npm v2/v3 lock with root package required');
	if (lock.name !== manifest.name || lock.packages[''].name !== manifest.name)
		fail('package and lock root names must match');
	manifest.name = name;
	lock.name = name;
	lock.packages[''].name = name;
	return source.files.map((entry) => {
		const bytes =
			entry.file === 'package.json'
				? Buffer.from(JSON.stringify(manifest, null, '\t') + '\n')
				: entry.file === 'package-lock.json'
					? Buffer.from(JSON.stringify(lock, null, '\t') + '\n')
					: entry.bytes;
		const text = bytes.toString('utf8'),
			utf8 = Buffer.from(text).equals(bytes) && !text.includes('\0');
		return {
			file: entry.file,
			mode: entry.mode,
			size: bytes.length,
			sha256: hash(bytes),
			encoding: utf8 ? 'utf8' : 'base64',
			content: utf8 ? text : bytes.toString('base64')
		};
	});
}
function destination(root, req) {
	const full = safePath(root, req.destination, true);
	if (existingStat(full)) fail('destination must not exist; nothing may be overwritten');
	const parent = path.dirname(full);
	if (!fs.lstatSync(parent).isDirectory()) fail('destination parent directory must already exist');
	return full;
}
export function planProject(workspaceRoot, input) {
	const root = workspace(workspaceRoot),
		req = request(input),
		source = safePath(root, req.source);
	if (!fs.lstatSync(source).isDirectory()) fail('source directory required');
	destination(root, req);
	const before = snapshot(source),
		files = artifacts(before, req.name);
	const fresh = snapshot(source);
	if (canonical(snapshotSummary(before)) !== canonical(snapshotSummary(fresh))) fail('source changed during planning');
	const body = {
		schemaVersion: 1,
		kind: 'supervisor-project-scaffold',
		root,
		request: req,
		source: snapshotSummary(before),
		destinationPrecondition: 'absent',
		files,
		requiresApproval: true,
		installed: false,
		scriptsExecuted: false,
		qualified: false
	};
	return { ...body, hash: hash(canonical(body)) };
}
function data(value, depth = 0, budget = { nodes: 0, bytes: 0 }) {
	if (++budget.nodes > 100000 || depth > 16) fail('plan exceeds JSON limits');
	if (typeof value === 'string') {
		budget.bytes += Buffer.byteLength(value);
		if (budget.bytes > 2 * LIMITS.totalBytes) fail('plan exceeds byte limit');
		return value;
	}
	if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
		return value;
	if (
		!value ||
		typeof value !== 'object' ||
		![Object.prototype, Array.prototype].includes(Object.getPrototypeOf(value))
	)
		fail('plain JSON plan required');
	const array = Array.isArray(value),
		keys = Reflect.ownKeys(value);
	if (
		keys.some(
			(key) => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')
		) ||
		(array && keys.length !== value.length + 1)
	)
		fail('plain JSON plan required');
	if (array)
		return Array.from({ length: value.length }, (_, i) =>
			data(Object.getOwnPropertyDescriptor(value, String(i))?.value, depth + 1, budget)
		);
	return Object.fromEntries(
		keys.map((key) => [key, data(Object.getOwnPropertyDescriptor(value, key).value, depth + 1, budget)])
	);
}
function validate(root, raw, approval) {
	const plan = data(raw);
	object(plan, [
		'schemaVersion',
		'kind',
		'root',
		'request',
		'source',
		'destinationPrecondition',
		'files',
		'requiresApproval',
		'installed',
		'scriptsExecuted',
		'qualified',
		'hash'
	]);
	if (typeof approval !== 'string' || !/^[a-f0-9]{64}$/.test(approval) || plan.hash !== approval)
		fail('exact supervisor approval hash required');
	const fresh = planProject(root, plan.request);
	if (canonical(plan) !== canonical(fresh)) fail('modified plan or stale source snapshot');
	return fresh;
}
const identity = (stat) => ({ dev: stat.dev, ino: stat.ino });
const same = (stat, id) => stat && stat.dev === id.dev && stat.ino === id.ino;
function writeExclusive(file, bytes, mode) {
	const fd = fs.openSync(
		file,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
		mode
	);
	try {
		const id = identity(fs.fstatSync(fd));
		fs.writeFileSync(fd, bytes);
		fs.fsyncSync(fd);
		return id;
	} finally {
		fs.closeSync(fd);
	}
}
/** Internal failure-injection hook. Not part of any JSON, CLI or MCP surface. */
export function _applyProjectWithHook(workspaceRoot, raw, approval, hook = () => {}) {
	const root = workspace(workspaceRoot),
		plan = validate(root, raw, approval),
		target = destination(root, plan.request);
	const lock = safePath(root, LOCK, true);
	let lockId;
	try {
		lockId = writeExclusive(
			lock,
			JSON.stringify({ planHash: plan.hash, destination: plan.request.destination }) + '\n',
			0o600
		);
	} catch {
		fail('project workflow is locked');
	}
	const dirs = [],
		written = [];
	let retainLock = false;
	const checkedTarget = () => {
		workspace(root);
		safePath(root, plan.request.destination, true);
		for (const dir of dirs)
			if (!same(existingStat(dir.file), dir.id) || !fs.lstatSync(dir.file).isDirectory())
				fail('concurrent directory replacement');
	};
	try {
		validate(root, plan, approval);
		fs.mkdirSync(target, { mode: 0o755 });
		dirs.push({ file: target, id: identity(fs.lstatSync(target)) });
		for (const file of plan.files) {
			checkedTarget();
			let parent = target;
			for (const segment of file.file.split('/').slice(0, -1)) {
				parent = path.join(parent, segment);
				if (!dirs.some((entry) => entry.file === parent)) {
					fs.mkdirSync(parent, { mode: 0o755 });
					dirs.push({ file: parent, id: identity(fs.lstatSync(parent)) });
				}
			}
			const full = safePath(target, file.file, true),
				bytes = Buffer.from(file.content, file.encoding);
			// Register ownership immediately on open, including a subsequent write/fsync failure.
			const fd = fs.openSync(
				full,
				fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
				file.mode
			);
			const record = { file: full, relative: file.file, id: identity(fs.fstatSync(fd)), hash: hash(Buffer.alloc(0)) };
			written.push(record);
			try {
				let offset = 0;
				while (offset < bytes.length) {
					const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
					if (count <= 0) fail('incomplete file write');
					offset += count;
					record.hash = hash(bytes.subarray(0, offset));
				}
				fs.fchmodSync(fd, file.mode);
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			hook({ event: 'written', file: file.file, target, root });
		}
		checkedTarget();
		for (const file of written)
			if (!same(existingStat(file.file), file.id) || hash(readFile(target, file.relative)) !== file.hash)
				fail('concurrent file edit after write');
		const owned = new Set([...dirs, ...written].map((entry) => entry.file));
		for (const dir of dirs)
			for (const entry of fs.readdirSync(dir.file)) {
				if (!owned.has(path.join(dir.file, entry))) fail('unexpected concurrent destination entry');
			}
		if (canonical(snapshotSummary(snapshot(safePath(root, plan.request.source)))) !== canonical(plan.source))
			fail('source changed while applying');
		return {
			schemaVersion: 1,
			status: 'applied',
			hash: plan.hash,
			destination: plan.request.destination,
			files: plan.files.map((file) => file.file),
			installed: false,
			scriptsExecuted: false,
			qualified: false
		};
	} catch (error) {
		const failures = [];
		for (const file of written.reverse()) {
			try {
				checkedTarget();
				if (!same(existingStat(file.file), file.id) || hash(readFile(target, file.relative)) !== file.hash)
					fail('concurrent edit preserved');
				fs.unlinkSync(file.file);
			} catch {
				failures.push(file.relative);
			}
		}
		for (const dir of dirs.reverse()) {
			try {
				safePath(root, path.relative(root, dir.file));
				if (!same(existingStat(dir.file), dir.id)) fail('concurrent directory preserved');
				fs.rmdirSync(dir.file);
			} catch {
				failures.push(path.relative(root, dir.file));
			}
		}
		if (failures.length) {
			retainLock = true;
			fail(
				error.message +
					'; rollback conflict: preserve destination and ' +
					LOCK +
					' for supervised recovery (' +
					failures.join(', ') +
					')'
			);
		}
		throw error;
	} finally {
		if (!retainLock && same(existingStat(lock), lockId)) fs.unlinkSync(lock);
	}
}
export function applyProject(workspaceRoot, plan, approvedPlanHash) {
	return _applyProjectWithHook(workspaceRoot, plan, approvedPlanHash);
}
