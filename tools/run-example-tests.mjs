// Isolated, explicitly selected module acceptance. Never targets the user's running application.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { findBundledMongo } from './verify-mongo-migrations.mjs';
import { prepareExampleFixture, exampleSources } from './example-fixture.mjs';
import { hash } from './lib.mjs';
const modes = {
	'--server': 'imports/modules/example/tests/server/fields.test.ts',
	'--browser': '.cypress/example/fields.cy.js',
	'--security': 'tests/server.ts'
};
const [mode, flag, source, ...extra] = process.argv.slice(2);
if (!Object.hasOwn(modes, mode) || flag !== '--test-source' || source !== modes[mode] || extra.length) {
	console.error('Use --server|--browser|--security --test-source <the exact Example test source>');
	process.exit(2);
}
const root = process.cwd(),
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'example-acceptance-')),
	children = [];
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(4).toString('hex');
const receipt = {
	runId,
	command: 'npm run ' + (mode === '--security' ? 'test:security' : 'test:example:' + mode.slice(2)),
	schemaVersion: 1,
	status: 'failed',
	mode: mode.slice(2),
	testSources: { [source]: hash(fs.readFileSync(path.join(root, source))) },
	sources: exampleSources(root),
	startedAt: new Date().toISOString(),
	realMongo: true,
	realDDP: true,
	realBrowser: mode === '--browser'
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = Object.fromEntries(
	['PATH', 'HOME', 'USER', 'LANG', 'CI', 'TMPDIR', 'METEOR_ALLOW_SUPERUSER']
		.filter((key) => process.env[key])
		.map((key) => [key, process.env[key]])
);
let password = '__none__';
async function freePort() {
	const s = net.createServer();
	await new Promise((resolve, reject) => {
		s.once('error', reject);
		s.listen(0, '127.0.0.1', resolve);
	});
	const port = s.address().port;
	await new Promise((resolve) => s.close(resolve));
	return port;
}
function start(command, args, log, cwd = root) {
	const fd = fs.openSync(log, 'w');
	try {
		const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
		child.on('error', (e) => (receipt.error = e.message));
		children.push(child);
		return child;
	} finally {
		fs.closeSync(fd);
	}
}
async function stop() {
	for (const c of [...children].reverse()) {
		try {
			process.kill(-c.pid, 'SIGTERM');
		} catch {}
	}
	await wait(1000);
	for (const c of [...children].reverse()) {
		try {
			process.kill(-c.pid, 'SIGKILL');
		} catch {}
	}
}
for (const signal of ['SIGINT', 'SIGTERM'])
	process.once(signal, () => {
		void stop().finally(() => {
			fs.rmSync(directory, { recursive: true, force: true });
			process.exit(signal === 'SIGINT' ? 130 : 143);
		});
	});
try {
	prepareExampleFixture(root, directory);
	const port = await freePort(),
		mongoPort = await freePort(),
		url = `http://127.0.0.1:${port}`;
	Object.assign(env, { ROOT_URL: url, MONGO_URL: `mongodb://127.0.0.1:${mongoPort}/example_acceptance_fixture` });
	fs.mkdirSync(path.join(directory, 'database'));
	const mongoLog = path.join(directory, 'mongo.log'),
		mongo = start(
			findBundledMongo(),
			[
				'--dbpath',
				path.join(directory, 'database'),
				'--bind_ip',
				'127.0.0.1',
				'--port',
				String(mongoPort),
				'--nounixsocket'
			],
			mongoLog
		);
	const mongoDeadline = Date.now() + 30000;
	while (!fs.readFileSync(mongoLog, 'utf8').includes('Waiting for connections')) {
		if (mongo.exitCode !== null || receipt.error || Date.now() > mongoDeadline)
			throw new Error('Isolated Mongo failed to start');
		await wait(200);
	}
	if (mode !== '--browser') {
		if (mode === '--server') {
			const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
			pkg.meteor = {
				...pkg.meteor,
				testModule: { server: 'tests/example-fields.server.ts', client: 'tests/example-fields.client.ts' }
			};
			fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(pkg, null, 2));
			fs.writeFileSync(
				path.join(directory, 'tests/example-fields.server.ts'),
				`import '../${source.replace(/\.ts$/, '')}';\n`
			);
			fs.writeFileSync(path.join(directory, 'tests/example-fields.client.ts'), 'export {};\n');
		}
		Object.assign(env, { NODE_ENV: 'test', TEST_SERVER_ONLY: '1' });
		const result = spawnSync(
			'meteor',
			['test', '--once', '--driver-package', 'meteortesting:mocha', '--port', `127.0.0.1:${port}`],
			{ cwd: directory, env, encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024 }
		);
		const output = (result.stdout ?? '') + (result.stderr ?? '');
		process.stdout.write(output);
		receipt.output = output;
		receipt.outputHash = hash(output);
		receipt.exitCode = result.status;
		if (
			result.status !== 0 ||
			result.error ||
			!(mode === '--server' ? /\b3 passing\b/ : /\b[1-9]\d* passing\b/).test(output) ||
			/\b[1-9]\d* (?:pending|failing)\b/.test(output)
		)
			throw new Error('Example real-server acceptance failed, skipped or did not run all three cases');
		receipt.tests = receipt.passed = Number(output.match(/\b([1-9]\d*) passing\b/)[1]);
	} else {
		password = randomBytes(24).toString('hex');
		Object.assign(env, {
			DEFAULT_ADMIN_USERNAME: 'ExampleAcceptance',
			DEFAULT_ADMIN_EMAIL: 'example-acceptance@example.test',
			DEFAULT_ADMIN_PASSWORD: password
		});
		const appLog = path.join(directory, 'app.log'),
			app = start('meteor', ['run', '--port', `127.0.0.1:${port}`], appLog, directory),
			deadline = Date.now() + 600000;
		while (true) {
			if (app.exitCode !== null || receipt.error) throw new Error('Isolated Example app failed');
			try {
				const response = await fetch(url + '/health/ready');
				if (response.ok && (await response.json()).status === 'ready') break;
			} catch {}
			if (Date.now() > deadline) throw new Error('Isolated Example app readiness timeout');
			await wait(1000);
		}
		delete process.env.ELECTRON_RUN_AS_NODE;
		const cypress = createRequire(import.meta.url)('cypress');
		const result = await cypress.run({
			project: root,
			configFile: path.join(root, 'cypress.example.config.ts'),
			spec: source,
			config: { baseUrl: url },
			browser: 'electron',
			env: { EXAMPLE_FIXTURE: true, TEST_USER_EMAIL: env.DEFAULT_ADMIN_EMAIL, TEST_USER_PASSWORD: password }
		});
		if ('failures' in result) throw new Error(result.message || 'Example browser could not start');
		Object.assign(receipt, {
			tests: result.totalTests,
			passed: result.totalPassed,
			failed: result.totalFailed,
			skipped: result.totalSkipped,
			pending: result.totalPending,
			browser: result.browserName
		});
		if (
			result.totalTests !== 2 ||
			result.totalPassed !== 2 ||
			result.totalFailed ||
			result.totalSkipped ||
			result.totalPending
		)
			throw new Error('Example browser acceptance failed, skipped or did not run both cases');
	}
	if (hash(JSON.stringify(exampleSources(root))) !== hash(JSON.stringify(receipt.sources)))
		throw new Error('Example sources changed during acceptance; evidence is stale');
	receipt.status = 'passed';
} catch (error) {
	receipt.error = error.message;
	process.exitCode = 1;
	console.error(error.message);
	for (const file of ['app.log', 'mongo.log'])
		if (fs.existsSync(path.join(directory, file)))
			console.error(
				fs.readFileSync(path.join(directory, file), 'utf8').slice(-4000).replaceAll(password, '[redacted]')
			);
} finally {
	await stop();
	receipt.finishedAt = new Date().toISOString();
	const evidence = path.join(root, '.ai-artifacts/legacy-runs', runId);
	fs.mkdirSync(evidence, { recursive: true });
	if (receipt.output) {
		fs.writeFileSync(path.join(evidence, 'server.log'), receipt.output);
		delete receipt.output;
	}
	for (const file of ['app.log', 'mongo.log'])
		if (fs.existsSync(path.join(directory, file)))
			fs.writeFileSync(
				path.join(evidence, file),
				fs.readFileSync(path.join(directory, file), 'utf8').replaceAll(password, '[redacted]')
			);
	receipt.artifacts = path.relative(root, evidence);
	fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(receipt, null, 2) + '\n');
	fs.mkdirSync(path.join(root, '.ai-artifacts'), { recursive: true });
	fs.writeFileSync(
		path.join(root, `.ai-artifacts/example-${mode.slice(2)}.json`),
		JSON.stringify(receipt, null, 2) + '\n'
	);
	fs.rmSync(directory, { recursive: true, force: true });
}
