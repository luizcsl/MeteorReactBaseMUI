import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { confined, hash, fail } from './lib.mjs';
import { validateDefinition, renderDefinition } from './recipes.mjs';
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const equal = (a, b) => json(a) === json(b);
function exact(value, keys, label) {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		Object.keys(value).sort().join('|') !== [...keys].sort().join('|')
	)
		fail('evolution-schema', `Invalid ${label} keys`);
}
export function validateEvolution(input) {
	exact(input, ['schemaVersion', 'module', 'operations'], 'evolution');
	if (
		input.schemaVersion !== 1 ||
		typeof input.module !== 'string' ||
		!/^[a-z][a-z0-9]{2,31}$/.test(input.module) ||
		!Array.isArray(input.operations) ||
		input.operations.length < 1 ||
		input.operations.length > 32
	)
		fail('evolution-schema', 'Invalid module or operations');
	for (const op of input.operations) {
		const keys = {
			'add-field': ['kind', 'field'],
			'add-filter': ['kind', 'field'],
			'add-state': ['kind', 'state', 'transitions'],
			'replace-permissions': ['kind', 'permissions']
		}[op?.kind];
		if (!keys) fail('evolution-operation', 'Unsupported structural operation');
		exact(op, keys, 'operation');
		if (op.kind === 'add-filter' && typeof op.field !== 'string')
			fail('evolution-schema', 'Filter field must be a string');
		if (op.kind === 'add-state' && (typeof op.state !== 'string' || !Array.isArray(op.transitions)))
			fail('evolution-schema', 'Invalid state or transitions');
	}
	return structuredClone(input);
}
function evolve(definition, input) {
	const next = structuredClone(definition);
	for (const op of input.operations) {
		if (op.kind === 'add-field') {
			const old = next.fields.find((field) => field.name === op.field?.name);
			if (old && !equal(old, op.field))
				fail('evolution-conflict', 'Existing field differs; destructive replacement is not supported');
			if (!old) next.fields.push(op.field);
		}
		if (op.kind === 'add-filter' && !next.filters.includes(op.field)) next.filters.push(op.field);
		if (op.kind === 'add-state') {
			if (!next.states.includes(op.state)) next.states.push(op.state);
			for (const transition of op.transitions) {
				const old = next.transitions.find((t) => t.from === transition.from && t.to === transition.to);
				if (old && !equal(old, transition)) fail('evolution-conflict', 'Existing transition differs');
				if (!old) next.transitions.push(transition);
			}
		}
		if (op.kind === 'replace-permissions') next.permissions = op.permissions;
	}
	return validateDefinition(next);
}
function moduleFiles(root, prefix = '') {
	const output = [];
	for (const entry of fs.readdirSync(prefix ? confined(root, prefix) : root, { withFileTypes: true })) {
		const name = prefix ? prefix + '/' + entry.name : entry.name;
		const target = confined(root, name);
		if (entry.isDirectory()) output.push(...moduleFiles(root, name));
		else if (entry.isFile()) output.push(name);
		else fail('evolution-file', 'Only regular files and directories are supported', name);
	}
	return output.sort();
}
function readModule(root, file, limit) {
	const fd = fs.openSync(confined(root, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > limit) fail('evolution-budget', 'Module content exceeds byte budget');
		const buffer = Buffer.alloc(stat.size + 1);
		let loaded = 0,
			count;
		while (loaded < buffer.length && (count = fs.readSync(fd, buffer, loaded, buffer.length - loaded, loaded)) > 0)
			loaded += count;
		if (loaded !== stat.size) fail('evolution-stale', 'File changed during bounded read');
		return buffer.subarray(0, loaded);
	} finally {
		fs.closeSync(fd);
	}
}
function snapshot(root) {
	const names = moduleFiles(root);
	if (names.length > 500) fail('evolution-budget', 'Module exceeds 500 files');
	let bytes = 0;
	return Object.fromEntries(
		names.map((file) => {
			const content = readModule(root, file, 8 * 1024 * 1024 - bytes);
			bytes += content.length;
			return [file, hash(content)];
		})
	);
}
function readJson(root, file) {
	return JSON.parse(readModule(root, file, 1024 * 1024).toString('utf8'));
}
export function planEvolution(root, raw) {
	const input = validateEvolution(raw),
		relative = `imports/modules/${input.module}`,
		directory = confined(root, relative),
		before = snapshot(directory);
	const original = validateDefinition(readJson(directory, 'module.definition.json'));
	if (original.name !== input.module) fail('evolution-module', 'Definition/module identity mismatch');
	const manifest = readJson(directory, 'module.manifest.json'),
		rendered = renderDefinition(original);
	if (
		manifest.schemaVersion !== 1 ||
		manifest.templateVersion !== '2.0.0' ||
		manifest.definitionHash !== hash(json(original)) ||
		!equal(Object.keys(manifest.files || {}).sort(), Object.keys(rendered).sort())
	)
		fail('evolution-manifest', 'Unsupported or stale generated manifest');
	for (const [file, content] of Object.entries(rendered)) {
		if (before[file] !== hash(content) || manifest.files[file] !== hash(content))
			fail(
				'evolution-customization',
				`Generated customization detected: ${file}; move customization into custom/ before evolving`
			);
	}
	const definition = evolve(original, input),
		generated = renderDefinition(definition),
		changed = !equal(original, definition);
	const nextManifest = {
		...manifest,
		definitionHash: hash(json(definition)),
		files: Object.fromEntries(Object.entries(generated).map(([file, content]) => [file, hash(content)])),
		qualified: changed ? false : manifest.qualified
	};
	const outputs = {
		...generated,
		'module.definition.json': json(definition),
		'module.manifest.json': json(nextManifest)
	};
	const changes = Object.entries(outputs)
		.filter(([file, content]) => before[file] !== hash(content))
		.map(([file, content]) => ({
			file,
			before: before[file] || null,
			after: hash(content),
			content,
			diff: `--- a/${relative}/${file}\n+++ b/${relative}/${file}\n@@ replace whole generated file @@\n${readModule(
				directory,
				file,
				8 * 1024 * 1024
			)
				.toString('utf8')
				.split('\n')
				.map((line) => '-' + line)
				.join('\n')}\n${content
				.split('\n')
				.map((line) => '+' + line)
				.join('\n')}\n`
		}));
	return {
		schemaVersion: 1,
		module: input.module,
		input,
		preconditions: before,
		changes,
		migrationRequired: input.operations.some((op) => op.kind === 'add-field' && op.field.required) && changed,
		notice:
			'Required fields need a separately reviewed data backfill. Permission/state changes need independent security tests. Apply clears qualification; no automatic registration or production migration.'
	};
}
export function applyEvolution(root, plan) {
	if (!plan || plan.schemaVersion !== 1) fail('evolution-plan', 'Invalid plan');
	const input = validateEvolution(plan.input),
		relative = `imports/modules/${input.module}`,
		directory = confined(root, relative),
		parent = path.dirname(directory);
	const lock = path.join(parent, `.evolve-${input.module}.lock`);
	let fd;
	try {
		fd = fs.openSync(lock, 'wx', 0o600);
	} catch (error) {
		if (error.code === 'EEXIST')
			fail('evolution-locked', 'Module evolution is locked; inspect stale transaction before recovery');
		throw error;
	}
	let staged,
		backup,
		swapped = false;
	try {
		if (!equal(snapshot(directory), plan.preconditions))
			fail('evolution-stale', 'Module changed after planning; regenerate plan');
		const fresh = planEvolution(root, input);
		if (!equal(fresh, plan)) fail('evolution-plan', 'Plan has been modified; regenerate it');
		if (!plan.changes.length) return { status: 'unchanged', module: input.module, files: [] };
		const id = randomUUID();
		staged = path.join(parent, `.evolve-${id}.stage`);
		backup = path.join(parent, `.evolve-${id}.backup`);
		// No application code executes. Complete validated tree is staged before replacing it.
		fs.mkdirSync(staged, { mode: fs.statSync(directory).mode & 0o777 });
		for (const file of Object.keys(plan.preconditions)) {
			const target = confined(staged, file, { missing: true });
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.copyFileSync(confined(directory, file), target);
			fs.chmodSync(target, fs.statSync(confined(directory, file)).mode & 0o777);
		}
		for (const change of plan.changes) fs.writeFileSync(confined(staged, change.file), change.content);
		if (!equal(snapshot(directory), plan.preconditions)) fail('evolution-stale', 'Module changed during staging');
		fs.writeFileSync(
			fd,
			json({
				schemaVersion: 1,
				module: relative,
				ownerPid: process.pid,
				staged,
				backup,
				preconditions: plan.preconditions,
				expected: snapshot(staged)
			})
		);
		fs.fsyncSync(fd);
		fs.renameSync(directory, backup);
		swapped = true;
		try {
			fs.renameSync(staged, directory);
			staged = undefined;
		} catch (error) {
			fs.renameSync(backup, directory);
			swapped = false;
			throw error;
		}
		fs.rmSync(backup, { recursive: true });
		backup = undefined;
		swapped = false;
		return { status: 'applied', module: input.module, files: plan.changes.map((c) => c.file), qualified: false };
	} finally {
		fs.closeSync(fd);
		if (staged) fs.rmSync(staged, { recursive: true, force: true });
		// Preserve journal and original tree if interruption/recovery failed; never silently delete it.
		if (!swapped) fs.rmSync(lock, { force: true });
	}
}

// Local-filesystem crash recovery only. Never recover a live writer or an altered tree.
export function recoverEvolution(root, module) {
	validateEvolution({ schemaVersion: 1, module, operations: [{ kind: 'add-filter', field: 'placeholder' }] });
	const relative = `imports/modules/${module}`,
		directory = confined(root, relative, { missing: true }),
		parent = path.dirname(directory),
		lockRelative = `imports/modules/.evolve-${module}.lock`,
		lock = confined(root, lockRelative);
	const journal = readJson(root, lockRelative);
	exact(journal, ['schemaVersion', 'module', 'ownerPid', 'staged', 'backup', 'preconditions', 'expected'], 'journal');
	if (
		journal.schemaVersion !== 1 ||
		journal.module !== relative ||
		!Number.isSafeInteger(journal.ownerPid) ||
		journal.ownerPid < 1
	)
		fail('evolution-journal', 'Invalid recovery journal');
	try {
		process.kill(journal.ownerPid, 0);
		fail('evolution-live', 'Refusing recovery while journal owner PID is live');
	} catch (error) {
		if (error.code !== 'ESRCH') throw error;
	}
	const stageName = path.basename(journal.staged),
		backupName = path.basename(journal.backup);
	if (
		!/^\.evolve-[0-9a-f-]{36}\.stage$/.test(stageName) ||
		backupName !== stageName.replace(/\.stage$/, '.backup') ||
		journal.staged !== path.join(parent, stageName) ||
		journal.backup !== path.join(parent, backupName)
	)
		fail('evolution-journal', 'Invalid transaction paths');
	for (const hashes of [journal.preconditions, journal.expected]) {
		if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes) || Object.keys(hashes).length > 500)
			fail('evolution-journal', 'Invalid snapshot');
		for (const [file, digest] of Object.entries(hashes)) {
			confined(root, `${relative}/${file}`, { missing: true });
			if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
				fail('evolution-journal', 'Invalid snapshot digest');
		}
	}
	const stage = confined(root, `imports/modules/${stageName}`, { missing: true }),
		backup = confined(root, `imports/modules/${backupName}`, { missing: true });
	const hasOriginal = fs.existsSync(directory),
		hasStage = fs.existsSync(stage),
		hasBackup = fs.existsSync(backup);
	const current = hasOriginal ? snapshot(directory) : null;
	if (hasStage && !equal(snapshot(stage), journal.expected))
		fail('evolution-recovery-conflict', 'Staged tree changed; manual review required');
	if (hasBackup && !equal(snapshot(backup), journal.preconditions))
		fail('evolution-recovery-conflict', 'Backup changed; manual review required');
	if (current && !equal(current, journal.preconditions) && !equal(current, journal.expected))
		fail('evolution-recovery-conflict', 'Current module changed; manual review required');
	if (!hasOriginal && !hasBackup) fail('evolution-recovery-conflict', 'Original and backup missing; cannot recover');
	let status = 'rolled-back';
	if (hasBackup) {
		if (hasOriginal && equal(current, journal.preconditions)) fs.rmSync(backup, { recursive: true });
		else if (hasOriginal) {
			if (hasStage) fail('evolution-recovery-conflict', 'Ambiguous duplicate new trees');
			fs.renameSync(directory, stage);
			try {
				fs.renameSync(backup, directory);
			} catch (error) {
				fs.renameSync(stage, directory);
				throw error;
			}
			fs.rmSync(stage, { recursive: true });
		} else fs.renameSync(backup, directory);
	} else if (equal(current, journal.expected)) status = 'already-applied';
	if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true });
	fs.rmSync(lock);
	return {
		status,
		module,
		notice: 'Recovery verifies byte hashes, not power-loss durability. Rerun all qualification gates.'
	};
}
