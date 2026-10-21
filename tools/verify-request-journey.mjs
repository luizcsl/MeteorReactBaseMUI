// Disposable real-app/browser gate. Never accepts an external database or application URL.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { prepareRuntimeFixture } from './verify-template-runtime.mjs';
import { findBundledMongo } from './verify-mongo-migrations.mjs';
import { hash, confined, files } from './lib.mjs';
const root = process.cwd(),
	temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'request-journey-'));
const evidence = {
	schemaVersion: 1,
	status: 'failed',
	realBrowser: true,
	realDDP: true,
	realMongo: true,
	startedAt: new Date().toISOString(),
	sources: {}
};
const children = [];
let syntheticPassword = '__no_password__';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}
async function stop() {
	for (const child of [...children].reverse()) {
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {}
	}
	await delay(1000);
	for (const child of [...children].reverse()) {
		try {
			process.kill(-child.pid, 'SIGKILL');
		} catch {}
	}
}
process.once('SIGINT', () => {
	void stop().finally(() => process.exit(130));
});
process.once('SIGTERM', () => {
	void stop().finally(() => process.exit(143));
});
function start(command, args, options, log) {
	const fd = fs.openSync(log, 'w');
	try {
		const child = spawn(command, args, { ...options, detached: true, stdio: ['ignore', fd, fd] });
		children.push(child);
		child.on('error', (error) => {
			evidence.error = error.message;
		});
		return child;
	} finally {
		fs.closeSync(fd);
	}
}
try {
	const npmVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/cypress/package.json'), 'utf8')).version;
	evidence.cypressPackage = npmVersion;
	for (const folder of [
		'imports/modules/requests',
		'imports/modules/requestitems',
		'.cypress/request-journey',
		'.cypress/ai-ready'
	])
		for (const file of files(confined(root, folder)))
			evidence.sources[folder + '/' + file] = hash(fs.readFileSync(confined(root, folder + '/' + file)));
	for (const file of [
		'package-lock.json',
		'tools/verify-request-journey.mjs',
		'cypress.request-journey.config.ts',
		'imports/server/registerApi.ts',
		'imports/modules/index.ts'
	])
		evidence.sources[file] = hash(fs.readFileSync(confined(root, file)));
	prepareRuntimeFixture(root, temporary);
	const appPort = await freePort(),
		mongoPort = await freePort(),
		baseUrl = `http://127.0.0.1:${appPort}`;
	const ready = path.join(temporary, 'journey-ready.json'),
		password = randomBytes(24).toString('hex');
	syntheticPassword = password;
	const env = Object.fromEntries(
		['PATH', 'HOME', 'USER', 'LANG', 'CI', 'TMPDIR', 'METEOR_ALLOW_SUPERUSER']
			.filter((key) => process.env[key])
			.map((key) => [key, process.env[key]])
	);
	Object.assign(env, {
		ROOT_URL: baseUrl,
		MONGO_URL: `mongodb://127.0.0.1:${mongoPort}/request_journey_fixture`,
		JOURNEY_PASSWORD: password,
		JOURNEY_READY_FILE: ready
	});
	fs.mkdirSync(path.join(temporary, 'database'));
	const mongoLog = path.join(temporary, 'mongo.log');
	const mongo = start(
		findBundledMongo(),
		[
			'--dbpath',
			path.join(temporary, 'database'),
			'--bind_ip',
			'127.0.0.1',
			'--port',
			String(mongoPort),
			'--nounixsocket'
		],
		{ env },
		mongoLog
	);
	const mongoDeadline = Date.now() + 30000;
	while (!fs.readFileSync(mongoLog, 'utf8').includes('Waiting for connections')) {
		if (mongo.exitCode !== null || Date.now() > mongoDeadline) throw new Error('Disposable Mongo failed to start');
		await delay(250);
	}
	// Only this temporary copy loads provisioning code. The delivered app has no test endpoint/switch.
	fs.writeFileSync(
		path.join(temporary, 'server/journey-fixtures.ts'),
		`import fs from 'node:fs';
import {Meteor} from 'meteor/meteor';
import {Accounts} from 'meteor/accounts-base';
import {userprofileServerApi} from '../imports/modules/userprofile/api/userProfileServerApi';
import {RequestAssignments} from '../imports/modules/requests/server/assignments';
Meteor.startup(async()=>{
 if (process.env.NODE_ENV==='production'||new URL(process.env.ROOT_URL!).hostname!=='127.0.0.1')throw new Error('Disposable fixture only');
 const ids:Record<string,string>={};
 for (const actor of ['requester','reviewer','outsider','admin']) {
  const email=actor==='admin'?'journey-admin@example.test':actor+'@journey.example.test';const id=await Accounts.createUserAsync({email,password:process.env.JOURNEY_PASSWORD!});ids[actor]=id;
  await Meteor.users.updateAsync(id,{$set:{'emails.0.verified':true}});
  await userprofileServerApi.getCollectionInstance().insertAsync({_id:id,accountId:id,username:actor,email,roles:actor==='admin'?['Administrador']:[],status:'active'});
 }
 await RequestAssignments.insertAsync({_id:ids.requester,reviewerId:ids.reviewer,active:true});
 fs.writeFileSync(process.env.JOURNEY_READY_FILE!,JSON.stringify(ids));
});\n`
	);
	const appLog = path.join(temporary, 'app.log');
	const app = start('meteor', ['run', '--port', `127.0.0.1:${appPort}`], { cwd: temporary, env }, appLog);
	const deadline = Date.now() + 600000;
	while (true) {
		if (app.exitCode !== null || evidence.error) throw new Error('Disposable Meteor app failed to start');
		if (fs.existsSync(ready)) {
			try {
				const response = await fetch(baseUrl + '/health/ready');
				if (response.ok && (await response.json()).status === 'ready') break;
			} catch {}
		}
		if (Date.now() > deadline) throw new Error('Disposable journey app readiness timeout');
		await delay(1000);
	}
	delete process.env.ELECTRON_RUN_AS_NODE;
	const syntax = spawnSync(
		process.execPath,
		[
			path.join(root, 'tools/check-browser-bundle.mjs'),
			path.join(temporary, '.meteor/local/build/programs/web.browser')
		],
		{ cwd: root, encoding: 'utf8' }
	);
	if (syntax.status !== 0) throw new Error('Emitted browser bundle syntax gate failed: ' + syntax.stderr);
	console.log(syntax.stdout.trim());
	const cypress = createRequire(import.meta.url)('cypress');
	const result = await cypress.run({
		project: root,
		configFile: path.join(root, 'cypress.request-journey.config.ts'),
		config: { baseUrl },
		browser: 'electron',
		env: {
			disposableJourney: true,
			journeyPassword: password,
			requesterEmail: 'requester@journey.example.test',
			reviewerEmail: 'reviewer@journey.example.test',
			outsiderEmail: 'outsider@journey.example.test'
		}
	});
	if ('failures' in result) throw new Error(result.message || 'Cypress failed to start');
	Object.assign(evidence, {
		browser: result.browserName,
		browserVersion: result.browserVersion,
		totalTests: result.totalTests,
		passed: result.totalPassed,
		failed: result.totalFailed,
		pending: result.totalPending,
		skipped: result.totalSkipped
	});
	if (
		result.totalTests !== 2 ||
		result.totalPassed !== 2 ||
		result.totalFailed ||
		result.totalSkipped ||
		result.totalPending
	)
		throw new Error('Request journey failed, skipped or reported an unexpected test count');
	console.log('Request journey: 2/2 real browser/DDP/Mongo scenarios passed.');
	const baseline = await cypress.run({
		project: root,
		configFile: path.join(root, 'cypress.ai-ready.config.ts'),
		config: { baseUrl },
		browser: 'electron',
		env: { TEST_USER_EMAIL: 'journey-admin@example.test', TEST_USER_PASSWORD: password }
	});
	if ('failures' in baseline) throw new Error(baseline.message || 'Baseline browser failed to start');
	evidence.baselineBrowser = {
		totalTests: baseline.totalTests,
		passed: baseline.totalPassed,
		failed: baseline.totalFailed,
		pending: baseline.totalPending,
		skipped: baseline.totalSkipped
	};
	if (
		baseline.totalTests !== 10 ||
		baseline.totalPassed !== 10 ||
		baseline.totalFailed ||
		baseline.totalSkipped ||
		baseline.totalPending
	)
		throw new Error('Baseline browser qualification failed, skipped or reported an unexpected count');
	evidence.status = 'passed';
	console.log('Baseline browser: 10/10 authentication, profile and owner CRUD scenarios passed.');
} catch (error) {
	evidence.error = error.message;
	process.exitCode = 1;
	console.error(error.message);
	for (const file of ['app.log', 'mongo.log']) {
		const log = path.join(temporary, file);
		if (fs.existsSync(log))
			console.error(fs.readFileSync(log, 'utf8').slice(-6000).replaceAll(syntheticPassword, '[redacted]'));
	}
	// Do not persist logs that could contain authentication values. Keep only diagnostics in this receipt.
} finally {
	await stop();
	evidence.finishedAt = new Date().toISOString();
	fs.mkdirSync(path.join(root, '.ai-artifacts'), { recursive: true });
	fs.writeFileSync(path.join(root, '.ai-artifacts/request-journey.json'), JSON.stringify(evidence, null, 2) + '\n');
	fs.rmSync(temporary, { recursive: true, force: true });
}
