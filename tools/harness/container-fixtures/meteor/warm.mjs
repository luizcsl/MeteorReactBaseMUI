/** Build-time provisioning only: permitted network; no candidate/model execution. */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { validateMeteorReport } from './report.mjs';
const [directory, meteor, reportFile] = process.argv.slice(2);
if (!directory || !meteor || !reportFile)
	throw Error('Reviewed warm directory, pinned Meteor executable and fresh report path required');
if (fs.existsSync(reportFile)) throw Error('Warm report must be fresh');
const result = spawnSync(
	meteor,
	['test', '--once', '--driver-package', 'meteortesting:mocha@3.4.0', '--port', '3102'],
	{
		cwd: directory,
		encoding: 'utf8',
		timeout: 1200000,
		maxBuffer: 16000000,
		env: {
			...process.env,
			CI: 'true',
			TEST_CLIENT: '0',
			TEST_SERVER: '1',
			TEST_SERVER_ONLY: '1',
			SERVER_TEST_REPORTER: 'json',
			SERVER_MOCHA_OUTPUT: reportFile,
			ROOT_URL: 'http://127.0.0.1:3102',
			METEOR_ALLOW_SUPERUSER: '1',
			DO_NOT_TRACK: '1'
		}
	}
);
process.stderr.write((result.stdout || '').slice(-32000));
process.stderr.write((result.stderr || '').slice(-32000));
if (result.error || result.status !== 0)
	throw Error(`Pinned Meteor warm-up failed: ${result.error?.message || result.status}`);
console.log(
	JSON.stringify({
		status: 'warmed',
		meteor: '3.5.2',
		tests: validateMeteorReport(JSON.parse(fs.readFileSync(reportFile, 'utf8')))
	})
);
