import fs from 'node:fs';
import { astBoundaries } from './ast.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { allowed, confined, files, fail, validateTask } from './lib.mjs';
function git(root, args) {
	const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
	if (result.status !== 0) fail('git', 'Git inspection failed');
	return result.stdout;
}
export function changedFiles(root) {
	return [
		...new Set(
			[
				// A rename changes both paths; rename detection would hide the source from scope checks.
				...git(root, ['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--']).split('\0'),
				// Do not use --exclude-standard: an ignored source file still affects execution.
				// Only fixed root-level build/dependency caches are excluded, never nested source paths.
				...git(root, [
					'ls-files',
					'--others',
					'-z',
					'--',
					'.',
					':(top,exclude)node_modules/**',
					':(top,exclude).meteor/**',
					':(top,exclude).git/**',
					':(top,exclude).agent-state/**',
					':(top,exclude).ai-artifacts/**',
					':(top,exclude).cypress/screenshots/**',
					':(top,exclude).cypress/videos/**',
					':(top,exclude).cypress/results/**',
					':(top,exclude).cypress/cucumber-json/**'
				]).split('\0')
			].filter(Boolean)
		)
	].sort();
}
export function patchCheck(root, input) {
	const task = validateTask(input),
		changed = changedFiles(root);
	const violations = changed.filter((file) => !allowed(file, task.allowedPaths));
	for (const file of changed) confined(root, file, { missing: true });
	if (violations.length) fail('patch-scope', `Out-of-scope/protected files: ${violations.join(', ')}`);
	if (changed.length > task.budget.files)
		fail('patch-budget', `Changed ${changed.length} files; budget ${task.budget.files}`);
	return {
		status: 'passed',
		changed,
		notice: 'Scope check only. Not an OS sandbox, test verdict, or approval to integrate.'
	};
}
export function boundaries(root) {
	return astBoundaries(root);
}
export function docsCheck(root) {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	const diagnostics = [];
	const candidates = ['AGENTS.md', ...files(path.join(root, 'docs')).map((x) => 'docs/' + x)].filter(
		(file) => fs.existsSync(path.join(root, file)) && file.endsWith('.md')
	);
	for (const file of candidates) {
		const content = fs.readFileSync(confined(root, file), 'utf8');
		for (const match of content.matchAll(/npm run ([a-z][a-z0-9:_-]*)/g))
			if (!Object.hasOwn(pkg.scripts, match[1]))
				diagnostics.push({
					file,
					line: content.slice(0, match.index).split('\n').length,
					rule: 'docs-command',
					message: `Unknown npm script: ${match[1]}`,
					command: 'npm run docs:verify'
				});
		for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
			const link = match[1].split('#')[0];
			if (!link || /^(?:[a-z]+:|\/)/i.test(link)) continue;
			const target = path.resolve(root, path.dirname(file), link);
			if (!target.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(target))
				diagnostics.push({
					file,
					line: content.slice(0, match.index).split('\n').length,
					rule: 'docs-link',
					message: `Missing or out-of-root link: ${link}`,
					command: 'npm run docs:verify'
				});
		}
	}
	return {
		status: diagnostics.length ? 'failed' : 'passed',
		diagnostics,
		notice:
			'Checks local links and npm script references; generated template tests and typecheck validate code examples separately.'
	};
}
export function doctor(root) {
	const checks = [];
	const major = Number(process.versions.node.split('.')[0]);
	checks.push({
		name: 'node',
		status: major === 24 ? 'passed' : 'failed',
		message: `Node ${process.versions.node}; supported major 24`
	});
	const meteor = spawnSync('meteor', ['--version'], { cwd: root, encoding: 'utf8', timeout: 15000 });
	checks.push({
		name: 'meteor',
		status: meteor.status === 0 ? 'passed' : 'failed',
		message: meteor.status === 0 ? 'Meteor executable available' : 'Meteor executable missing or not responsive'
	});
	checks.push({
		name: 'dependencies',
		status: fs.existsSync(path.join(root, 'node_modules/typescript')) ? 'passed' : 'failed',
		message: 'Local TypeScript dependency installation'
	});
	checks.push({
		name: 'mongo-config',
		status: process.env.MONGO_URL ? 'present' : 'absent',
		message: process.env.MONGO_URL
			? 'MONGO_URL is present; value redacted. Connectivity and replica-set semantics are not checked.'
			: 'MONGO_URL is absent from this process. Meteor may provide local development Mongo; explicit isolated integration configuration still required.'
	});
	checks.push({
		name: 'mongo',
		status: 'not-checked',
		message:
			'Run integration tests with an isolated Mongo replica set; doctor never connects to a database automatically.'
	});
	checks.push({
		name: 'configuration',
		status: 'not-checked',
		message: 'Startup validates environment. Secret values are never included in doctor output.'
	});
	return { status: checks.some((x) => x.status === 'failed') ? 'failed' : 'passed', checks, qualified: false };
}
export function taskTransition(task, evidence) {
	validateTask(task);
	if (
		!evidence ||
		!Number.isFinite(evidence.seconds) ||
		!Number.isFinite(evidence.tokens) ||
		!Number.isFinite(evidence.costUSD) ||
		!Number.isInteger(evidence.attempts) ||
		[evidence.seconds, evidence.tokens, evidence.costUSD, evidence.attempts].some((x) => x < 0)
	)
		fail('execution-evidence', 'Valid nonnegative usage evidence required');
	const exhausted = ['seconds', 'tokens', 'costUSD', 'attempts'].some((k) => evidence[k] >= task.budget[k]);
	// A harness can request review; toolkit never trusts a model's claimed test success.
	return {
		...task,
		state: exhausted ? 'needs-review' : 'running',
		usage: evidence,
		qualification: 'Requires independent protected evaluator evidence; no passed transition from self-report.'
	};
}

export function saveTaskState(root, task, evidence) {
	validateTask(task);
	const directory = confined(root, '.agent-state', { missing: true });
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const destination = confined(root, `.agent-state/${task.id}.json`, { missing: true });
	const lock = destination + '.lock';
	let fd;
	try {
		fd = fs.openSync(lock, 'wx', 0o600);
	} catch {
		fail('task-locked', 'State update already in progress', task.id);
	}
	const temporary = destination + '.tmp';
	try {
		const previous = fs.existsSync(destination) ? JSON.parse(fs.readFileSync(destination, 'utf8')) : null;
		if (
			previous &&
			JSON.stringify({ ...previous, usage: undefined, qualification: undefined, state: undefined }) !==
				JSON.stringify({ ...task, state: undefined })
		)
			fail('task-changed', 'Existing task contract changed; use a new reviewed task id', task.id);
		if (previous && ['passed', 'failed', 'needs-review'].includes(previous.state))
			fail('task-terminal', 'Terminal tasks require a new reviewed task id', task.id);
		const delta = taskTransition(task, evidence).usage;
		const usage = Object.fromEntries(
			['seconds', 'tokens', 'costUSD', 'attempts'].map((k) => [k, (previous?.usage?.[k] || 0) + delta[k]])
		);
		const updated = taskTransition(task, usage);
		fs.writeFileSync(temporary, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
		fs.renameSync(temporary, destination);
		return updated;
	} finally {
		fs.closeSync(fd);
		fs.rmSync(lock, { force: true });
		fs.rmSync(temporary, { force: true });
	}
}
