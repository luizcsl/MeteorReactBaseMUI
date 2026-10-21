// Required real-Mongo qualification: an unavailable binary/startup/test is a
// failure, never a skipped green gate. Only starts a disposable loopback server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function findBundledMongo() {
	if (process.env.MONGOD_BINARY) {
		const candidate = path.resolve(process.env.MONGOD_BINARY);
		fs.accessSync(candidate, fs.constants.X_OK);
		return candidate;
	}
	const release = fs
		.readFileSync(path.join(root, '.meteor/release'), 'utf8')
		.trim()
		.replace(/^METEOR@/, '');
	const base = path.join(os.homedir(), '.meteor/packages/meteor-tool');
	if (fs.existsSync(base)) {
		for (const version of fs.readdirSync(base).sort()) {
			if (version !== release && !version.startsWith(`.${release}.`)) continue;
			const folder = path.join(base, version);
			if (!fs.statSync(folder).isDirectory()) continue;
			for (const platform of fs.readdirSync(folder).sort()) {
				if (!platform.startsWith('mt-')) continue;
				const candidate = path.join(folder, platform, 'dev_bundle/mongodb/bin/mongod');
				try {
					fs.accessSync(candidate, fs.constants.X_OK);
					return candidate;
				} catch {}
			}
		}
	}
	throw new Error(
		`No bundled mongod for Meteor ${release}; install the pinned Meteor release or set MONGOD_BINARY to an approved official binary`
	);
}

async function stop(child, closed) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	child.kill('SIGTERM');
	let timer;
	try {
		await Promise.race([
			closed,
			new Promise(
				(resolve) =>
					(timer = setTimeout(() => {
						child.kill('SIGKILL');
						resolve();
					}, 15000))
			)
		]);
		await closed;
	} finally {
		clearTimeout(timer);
	}
}

async function main() {
	const binary = findBundledMongo();
	const port = Number(process.env.MONGO_MIGRATION_TEST_PORT ?? 32118);
	if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
		throw new Error('MONGO_MIGRATION_TEST_PORT must be 1024..65535');
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-migration-gate-'));
	const database = path.join(directory, 'db');
	const log = path.join(directory, 'mongod.log');
	fs.mkdirSync(database);
	const env = Object.fromEntries(
		['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'CI']
			.filter((key) => process.env[key])
			.map((key) => [key, process.env[key]])
	);
	let server,
		serverClosed,
		tests,
		testsClosed,
		failure,
		forceTimer,
		interrupted = false;
	const interrupt = () => {
		interrupted = true;
		tests?.kill('SIGTERM');
		server?.kill('SIGTERM');
		forceTimer ??= setTimeout(() => {
			tests?.kill('SIGKILL');
			server?.kill('SIGKILL');
		}, 5000);
	};
	process.on('SIGINT', interrupt);
	process.on('SIGTERM', interrupt);
	try {
		console.log(`Mongo migration gate: isolated loopback port ${port}, binary ${binary}`);
		server = spawn(
			binary,
			[
				'--dbpath',
				database,
				'--bind_ip',
				'127.0.0.1',
				'--port',
				String(port),
				'--nounixsocket',
				'--setParameter',
				'diagnosticDataCollectionEnabled=false',
				'--logpath',
				log
			],
			{ env, stdio: ['ignore', 'ignore', 'pipe'] }
		);
		server.on('error', (error) => (failure = error));
		server.stderr.on('data', (bytes) => process.stderr.write(bytes));
		serverClosed = new Promise((resolve) => server.once('close', (code, signal) => resolve({ code, signal })));
		const deadline = Date.now() + 20000;
		while (true) {
			if (interrupted || failure || server.exitCode !== null || server.signalCode !== null)
				throw (
					failure ?? new Error(`Disposable mongod exited before readiness (${server.exitCode ?? server.signalCode})`)
				);
			if (fs.existsSync(log) && /Waiting for connections/.test(fs.readFileSync(log, 'utf8'))) break;
			if (Date.now() >= deadline) throw new Error('Disposable mongod did not become ready in 20 seconds');
			await delay(100);
		}
		// The readiness evidence is from OUR spawned process/log. Never connect to
		// an unrelated server that happens to already own the requested port.
		let output = '';
		tests = spawn(process.execPath, ['--test', '--test-reporter=tap', 'tools/test/mongo-migrations.test.mjs'], {
			cwd: root,
			env: { ...env, MONGO_MIGRATION_TEST_URI: `mongodb://127.0.0.1:${port}/` },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		tests.on('error', (error) => (failure = error));
		const collect = (bytes) => {
			if (output.length + bytes.length > 8 * 1024 * 1024) {
				failure = new Error('Migration test output exceeded 8 MiB');
				interrupt();
				return;
			}
			output += bytes.toString();
			process.stdout.write(bytes);
		};
		tests.stdout.on('data', collect);
		tests.stderr.on('data', collect);
		testsClosed = new Promise((resolve) => tests.once('close', (code, signal) => resolve({ code, signal })));
		const timer = setTimeout(() => {
			failure = new Error('Real Mongo migration tests exceeded 120 seconds');
			interrupt();
		}, 120000);
		let result;
		try {
			result = await testsClosed;
		} finally {
			clearTimeout(timer);
		}
		if (
			interrupted ||
			failure ||
			result.code !== 0 ||
			!/real local Mongo: native driver CAS/.test(output) ||
			!/^# pass [1-9][0-9]*\s*$/m.test(output) ||
			!/^# fail 0\s*$/m.test(output) ||
			!/^# skipped 0\s*$/m.test(output)
		) {
			throw failure ?? new Error('Real Mongo migration qualification failed, skipped a test, or did not run');
		}
		console.log(
			'Real Mongo migration adapter QUALIFIED: native driver tests passed with zero skips. Not replica failover or backup/restore qualification.'
		);
	} catch (error) {
		if (fs.existsSync(log)) console.error(`Disposable Mongo log tail:\n${fs.readFileSync(log, 'utf8').slice(-12000)}`);
		throw error;
	} finally {
		await stop(tests, testsClosed);
		await stop(server, serverClosed);
		clearTimeout(forceTimer);
		process.off('SIGINT', interrupt);
		process.off('SIGTERM', interrupt);
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		await main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
