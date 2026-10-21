import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
export const meteorTestDriver = 'meteortesting:mocha';
export const meteorTestDriverVersion = '3.4.0';
/** Meteor's runtime expects a bare driver name; pin its version in staged constraints instead. */
export function pinMeteorTestDriver(directory) {
	const file = path.join(directory, '.meteor/packages');
	const lines = fs
		.readFileSync(file, 'utf8')
		.split(/\r?\n/)
		.filter((line) => line.trim().split(/[\s#]/)[0].split('@')[0] !== meteorTestDriver);
	fs.writeFileSync(file, lines.join('\n').trimEnd() + `\n${meteorTestDriver}@=${meteorTestDriverVersion}\n`);
}
export function verifyMeteorTestDriver(directory) {
	const versions = fs.readFileSync(path.join(directory, '.meteor/versions'), 'utf8').split(/\r?\n/);
	assert.deepEqual(
		versions.filter((line) => line.startsWith(meteorTestDriver + '@')),
		[`${meteorTestDriver}@${meteorTestDriverVersion}`],
		'Meteor must resolve the exact reviewed test-driver version'
	);
}
