import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { confined, hash, fail, exact } from '../../lib.mjs';
import { json } from '../contracts/validate.mjs';
import { planAutomation } from '../planner/plan.mjs';
import { put, snapshot, assertWritable } from './files.mjs';
function saveJournal(root, journal) {
	const target = confined(root, '.agent-state/automation-journal.json', { missing: true });
	const temporary = confined(root, `.agent-state/automation-journal-${randomUUID()}.tmp`, { missing: true });
	let fd;
	try {
		fd = fs.openSync(temporary, 'wx', 0o600);
		fs.writeFileSync(fd, json(journal));
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temporary, target);
		const directory = fs.openSync(path.dirname(target), 'r');
		try {
			fs.fsyncSync(directory);
		} finally {
			fs.closeSync(directory);
		}
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		fs.rmSync(temporary, { force: true });
	}
}
function assertSnapshot(root, expected) {
	const live = Object.fromEntries(Object.entries(snapshot(root)).map(([p, c]) => [p, hash(c)]));
	if (json(live) !== json(expected))
		fail('automation-stale', 'Source snapshot changed during asynchronous planning; replan');
}
export async function applyAutomation(root, plan, approval = {}) {
	exact(approval, ['planHash', 'reviews'], []);
	if (!plan || plan.schemaVersion !== 1) fail('automation-plan', 'Expected versioned plan');
	if (
		plan.requiresReview?.length &&
		(approval.planHash !== plan.planHash ||
			!Array.isArray(approval.reviews) ||
			plan.requiresReview.some((x) => !approval.reviews.includes(x)))
	)
		fail('needs-review', 'Explicit review of this exact plan hash required');
	const state = confined(root, '.agent-state', { missing: true });
	fs.mkdirSync(state, { recursive: true });
	const lock = confined(root, '.agent-state/automation.lock', { missing: true });
	let fd;
	try {
		fd = fs.openSync(lock, 'wx', 0o600);
	} catch (e) {
		if (e.code === 'EEXIST')
			fail('automation-locked', 'An interrupted or active transaction exists; inspect journal and recover');
		throw e;
	}
	const journalPath = confined(root, '.agent-state/automation-journal.json', { missing: true });
	let applied = [],
		journalCreated = false,
		preserveLock = false;
	try {
		if (fs.existsSync(journalPath) && JSON.parse(fs.readFileSync(journalPath, 'utf8')).status === 'applying')
			fail('automation-recovery-required', 'Unresolved applying journal must be recovered before new work');
		const fresh = await planAutomation(root, plan.request);
		if (json(fresh) !== json(plan)) fail('automation-stale', 'Plan modified or source drifted; plan again');
		assertSnapshot(root, plan.preconditions);
		const journal = {
			schemaVersion: 1,
			planHash: plan.planHash,
			status: 'applying',
			plan,
			changes: plan.changes,
			applied: []
		};
		saveJournal(root, journal);
		journalCreated = true;
		for (const change of fresh.changes) {
			const target = confined(root, change.path, { missing: true });
			const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
			if (current !== change.before) fail('automation-stale', 'Source changed during apply', change.path);
			if (change.after === null) fs.unlinkSync(target);
			else {
				const temporary = target + '.automation-tmp';
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(temporary, change.after, { flag: 'wx' });
				try {
					fs.renameSync(temporary, target);
				} catch (error) {
					fs.rmSync(temporary, { force: true });
					throw error;
				}
			}
			applied.push(change);
			journal.applied.push(change.path);
			saveJournal(root, journal);
		}
		journal.status = 'applied';
		saveJournal(root, journal);
		return {
			schemaVersion: 1,
			status: applied.length ? 'applied' : 'unchanged',
			planHash: plan.planHash,
			files: applied.map((c) => c.path),
			qualified: false,
			requiredGates: plan.requiredGates,
			migrations: plan.migrations
		};
	} catch (error) {
		for (const change of [...applied].reverse()) {
			const target = confined(root, change.path, { missing: true });
			const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
			if (current !== change.after) {
				preserveLock = true;
				fail(
					'automation-recovery-required',
					'Concurrent change prevents safe rollback; retain journal and lock',
					change.path
				);
			}
			if (change.before === null) fs.rmSync(target, { force: true });
			else put(root, change.path, change.before);
		}
		if (journalCreated && fs.existsSync(journalPath)) {
			const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
			journal.status = 'rolled-back';
			saveJournal(root, journal);
		}
		throw error;
	} finally {
		fs.closeSync(fd);
		if (!preserveLock) fs.rmSync(lock, { force: true });
	}
}
export async function recoverAutomation(root) {
	const file = confined(root, '.agent-state/automation-journal.json');
	const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
	exact(journal, ['schemaVersion', 'planHash', 'status', 'plan', 'changes', 'applied']);
	if (
		journal.schemaVersion !== 1 ||
		!['applying', 'applied', 'rolled-back', 'recovered'].includes(journal.status) ||
		!journal.plan ||
		!Array.isArray(journal.changes) ||
		!Array.isArray(journal.applied)
	)
		fail('automation-journal', 'Invalid recovery journal');
	if (journal.status !== 'applying') return { status: 'unchanged', journalStatus: journal.status };
	const lock = confined(root, '.agent-state/automation.lock', { missing: true });
	let fd;
	try {
		fd = fs.openSync(lock, 'wx', 0o600);
	} catch (error) {
		if (error.code === 'EEXIST')
			fail('automation-locked', 'Establish writer termination and remove stale lock manually before recovery');
		throw error;
	}
	const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-recover-'));
	try {
		exact(journal, ['schemaVersion', 'planHash', 'status', 'plan', 'changes', 'applied']);
		if (
			journal.schemaVersion !== 1 ||
			!journal.plan ||
			json(journal.changes) !== json(journal.plan.changes) ||
			journal.planHash !== journal.plan.planHash
		)
			fail('automation-journal', 'Invalid recovery journal');
		const original = snapshot(root);
		for (const change of journal.changes) {
			exact(change, ['path', 'before', 'after', 'beforeHash', 'afterHash', 'diff']);
			const originalKind = journal.plan.steps?.find(
				(step) => step.files?.includes(change.path) && step.kind === 'evolve'
			)
				? 'evolve'
				: 'recovery';
			assertWritable(change.path, change.before, originalKind);
			if (
				(change.before !== null && typeof change.before !== 'string') ||
				(change.after !== null && typeof change.after !== 'string') ||
				change.beforeHash !== (change.before === null ? null : hash(change.before)) ||
				change.afterHash !== (change.after === null ? null : hash(change.after))
			)
				fail('automation-journal', 'Invalid content hashes');
			const target = confined(root, change.path, { missing: true });
			const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
			if (current !== change.before && current !== change.after)
				fail('automation-recovery-conflict', 'File differs from both journal states', change.path);
			if (change.before === null) delete original[change.path];
			else original[change.path] = change.before;
		}
		for (const [name, content] of Object.entries(original)) put(stage, name, content);
		fs.mkdirSync(path.join(stage, 'imports/modules'), { recursive: true });
		if (fs.existsSync(path.join(root, 'node_modules')))
			fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(stage, 'node_modules'), 'dir');
		if (json(await planAutomation(stage, journal.plan.request)) !== json(journal.plan))
			fail('automation-journal', 'Journal is not a reproducible trusted plan');
		for (const change of [...journal.changes].reverse()) {
			const target = confined(root, change.path, { missing: true });
			const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
			if (current === change.before) continue;
			if (current !== change.after)
				fail('automation-recovery-conflict', 'Concurrent edit during recovery', change.path);
			if (change.before === null) fs.rmSync(target, { force: true });
			else put(root, change.path, change.before);
		}
		journal.status = 'recovered';
		saveJournal(root, journal);
		return { status: 'recovered' };
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
		fs.closeSync(fd);
		fs.rmSync(lock, { force: true });
	}
}
