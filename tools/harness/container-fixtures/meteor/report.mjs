import assert from 'node:assert/strict';
/** Count the actual Mocha JSON result, never infer success from process exit alone. */
export function validateMeteorReport(report, minimumTests = 40) {
	assert.ok(report && typeof report === 'object' && report.stats, 'Missing Mocha report');
	const { tests, passes, failures, pending } = report.stats;
	for (const value of [tests, passes, failures, pending])
		assert.ok(Number.isSafeInteger(value) && value >= 0, 'Invalid Mocha counts');
	assert.ok(tests >= minimumTests, `Expected at least ${minimumTests} real Meteor tests, received ${tests}`);
	assert.equal(tests, passes, 'All required tests must pass');
	assert.equal(failures, 0);
	assert.equal(pending, 0);
	for (const [key, count] of [
		['tests', tests],
		['passes', passes],
		['failures', failures],
		['pending', pending]
	]) {
		assert.ok(Array.isArray(report[key]), `Missing Mocha ${key} array`);
		assert.equal(report[key].length, count, `Inconsistent Mocha ${key} count`);
	}
	for (const group of [
		'logged profile publication over real DDP',
		'structured recipes over authenticated DDP and Mongo'
	])
		assert.ok(
			report.passes.some((test) => typeof test.fullTitle === 'string' && test.fullTitle.startsWith(group + ' ')),
			`Missing required suite: ${group}`
		);
	return { total: tests, passed: passes, failed: failures, skipped: pending };
}
