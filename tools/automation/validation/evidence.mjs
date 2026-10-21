import { spawnSync } from 'node:child_process';
import { fail, exact } from '../../lib.mjs';
const gates = [
	'doctor',
	'typecheck',
	'test:core',
	'test:mutations',
	'test:toolkit',
	'boundaries:check',
	'templates:verify',
	'docs:verify',
	'verify',
	'test:browser'
];
export function verifyAutomation(root, options = {}) {
	exact(options, ['gates', 'timeoutMs'], []);
	const selected = options.gates ?? gates;
	if (
		!Array.isArray(selected) ||
		!selected.length ||
		selected.some((x) => !gates.includes(x)) ||
		new Set(selected).size !== selected.length
	)
		fail('automation-gates', 'Select only catalogued gates');
	const timeout = options.timeoutMs ?? 600000;
	if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 3600000)
		fail('automation-gates', 'timeoutMs must be 100..3600000');
	const results = gates.map((gate) => ({ gate, status: 'not-run' }));
	for (const gate of selected) {
		const result = spawnSync('npm', ['run', gate], {
			cwd: root,
			encoding: 'utf8',
			timeout,
			maxBuffer: 8 * 1024 * 1024
		});
		const output = (result.stdout ?? '') + (result.stderr ?? '');
		Object.assign(
			results.find((x) => x.gate === gate),
			{
				status: result.error ? 'blocked' : result.status === 0 ? 'passed' : 'failed',
				exitCode: result.status,
				signal: result.signal,
				output: output.slice(-20000),
				reason: result.error?.message ?? null
			}
		);
	}
	return {
		schemaVersion: 1,
		status: results.some((x) => x.status === 'failed')
			? 'failed'
			: results.some((x) => x.status === 'blocked')
				? 'blocked'
				: results.some((x) => x.status === 'not-run')
					? 'partial'
					: 'passed',
		qualified: false,
		results,
		notice:
			'Repository diagnostics are not independent qualification. A protected external supervisor must run full acceptance, Meteor/Mongo and browser gates.'
	};
}
export function reportAutomation(plan, evidence) {
	return {
		schemaVersion: 1,
		planHash: plan.planHash,
		changedFiles: plan.changes.map((c) => ({ path: c.path, beforeHash: c.beforeHash, afterHash: c.afterHash })),
		reviews: plan.requiresReview,
		migrations: plan.migrations,
		diagnostics: plan.diagnostics,
		verification: evidence ?? { status: 'not-run' },
		qualified: false
	};
}
