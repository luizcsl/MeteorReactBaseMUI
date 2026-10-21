import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMeteorReport } from './report.mjs';
const make = () => {
	const passes = Array.from({ length: 40 }, (_, i) => ({
		fullTitle:
			i === 0
				? 'logged profile publication over real DDP checks projection'
				: i === 1
					? 'structured recipes over authenticated DDP and Mongo checks isolation'
					: `protected test ${i}`
	}));
	return {
		stats: { tests: 40, passes: 40, failures: 0, pending: 0 },
		tests: [...passes],
		passes,
		failures: [],
		pending: []
	};
};
test('Meteor collector requires actual arrays, passing counts and named DDP/Mongo suites', () => {
	assert.deepEqual(validateMeteorReport(make()), { total: 40, passed: 40, failed: 0, skipped: 0 });
});
test('Meteor collector rejects missing, zero, failed, pending, insufficient and inconsistent evidence', () => {
	assert.throws(() => validateMeteorReport(null));
	for (const patch of [
		{ tests: 0, passes: 0 },
		{ failures: 1 },
		{ pending: 1 },
		{ tests: 39, passes: 39 },
		{ passes: 39 },
		{ tests: Infinity },
		{ tests: '40' }
	]) {
		const report = make();
		Object.assign(report.stats, patch);
		assert.throws(() => validateMeteorReport(report));
	}
	const missingArray = make();
	delete missingArray.passes;
	assert.throws(() => validateMeteorReport(missingArray));
	const incorrectArray = make();
	incorrectArray.tests.pop();
	assert.throws(() => validateMeteorReport(incorrectArray));
	const missingSuite = make();
	missingSuite.passes[0] = { fullTitle: 'unrelated' };
	assert.throws(() => validateMeteorReport(missingSuite));
});
