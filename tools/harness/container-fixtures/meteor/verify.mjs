#!/usr/bin/env node
/** Trusted staged collector for the reviewed Meteor test suite. No installation/network fallback. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { treeHash } from '../../executor.mjs';
import { validateMeteorReport } from './report.mjs';
import { meteorTestDriver, pinMeteorTestDriver, verifyMeteorTestDriver } from './driver.mjs';

const candidateTreeHash = treeHash('/candidate'),
	verifierTreeHash = treeHash('/verifier');
const work = '/scratch/candidate',
	home = '/scratch/home',
	reportFile = '/scratch/meteor-report.json';
assert.equal(process.getuid(), 65534, 'Run as the unprivileged harness identity');
assert.deepEqual(fs.readdirSync('/scratch'), [], 'Scratch must be fresh');
assert.equal(fs.readFileSync('/opt/toolchain/meteor-release', 'utf8').trim(), 'Meteor 3.5.2');
fs.mkdirSync(home);
console.error('Staging writable pinned Meteor warehouse and candidate in bounded scratch.');
fs.cpSync('/opt/meteor-home/.meteor', path.join(home, '.meteor'), { recursive: true, verbatimSymlinks: true });
fs.cpSync('/candidate', work, { recursive: true });
for (const name of fs.readdirSync('/verifier/overlay')) {
	const target = path.join(work, name);
	fs.rmSync(target, { recursive: true, force: true });
	fs.cpSync(path.join('/verifier/overlay', name), target, { recursive: true });
}
pinMeteorTestDriver(work);
// Npm is locked/warmed during the image build. Runtime cannot fetch packages.
fs.symlinkSync('/opt/toolchain/node_modules', path.join(work, 'node_modules'), 'dir');
const meteor = path.join(home, '.meteor/meteor');
assert.ok(
	fs.realpathSync(meteor).startsWith(path.join(home, '.meteor') + '/'),
	'Meteor must execute from the writable staged warehouse'
);
console.error('Running protected Meteor/Mongo/DDP suites with external network disabled.');
const result = spawnSync(meteor, ['test', '--once', '--driver-package', meteorTestDriver, '--port', '3102'], {
	cwd: work,
	encoding: 'utf8',
	timeout: 1500000,
	maxBuffer: 16000000,
	env: {
		PATH: '/usr/local/bin:/usr/bin:/bin',
		HOME: home,
		TMPDIR: '/scratch',
		CI: 'true',
		TEST_CLIENT: '0',
		TEST_SERVER: '1',
		TEST_SERVER_ONLY: '1',
		SERVER_TEST_REPORTER: 'json',
		SERVER_MOCHA_OUTPUT: reportFile,
		ROOT_URL: 'http://127.0.0.1:3102',
		METEOR_OFFLINE_CATALOG: '1',
		METEOR_WAREHOUSE_DIR: path.join(home, '.meteor'),
		METEOR_PRETTY_OUTPUT: '0',
		METEOR_WATCH_FORCE_POLLING: 'true',
		DO_NOT_TRACK: '1',
		NODE_OPTIONS: '--max-old-space-size=1536'
	}
});
process.stderr.write((result.stdout || '').slice(-64000));
process.stderr.write((result.stderr || '').slice(-64000));
assert.equal(result.error, undefined, `Meteor failed: ${result.error?.message}`);
assert.equal(result.status, 0, `Meteor exited ${result.status}, signal ${result.signal}`);
verifyMeteorTestDriver(work);
const tests = validateMeteorReport(JSON.parse(fs.readFileSync(reportFile, 'utf8')));
assert.equal(treeHash('/candidate'), candidateTreeHash);
assert.equal(treeHash('/verifier'), verifierTreeHash);
console.log(
	JSON.stringify({
		protocol: 'ai-verifier/v1',
		kind: process.env.AI_VERIFY_KIND,
		candidateTreeHash,
		verifierTreeHash,
		tests
	})
);
