import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { exact, fail, hash } from '../lib.mjs';

const gates = ['acceptance', 'security', 'regression', 'scope'];
const defaultRuntime = { spawn, spawnSync };
const runtimeEnv = () => ({ PATH: process.env.PATH || '/usr/bin:/bin', HOME: '/nonexistent' });
const digest = /^[a-f0-9]{64}$/;
function cleanPath(value, label) {
	if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n,]/.test(value))
		fail('harness-path', `Invalid ${label}`);
	const real = fs.realpathSync(value);
	if (real !== value || !fs.lstatSync(value).isDirectory())
		fail('harness-path', `${label} must be a canonical directory, not a symlink`);
	return real;
}
export function validateEnvelope(config) {
	const required = ['version', 'image', 'candidate', 'verifier', 'output', 'command', 'limits'];
	exact(config, [...required, 'verification'], required);
	if (
		config.version !== 1 ||
		typeof config.image !== 'string' ||
		! /^(?:[-a-zA-Z0-9./_:]+@)?sha256:[a-f0-9]{64}$/.test(config.image)
	)
		fail('harness-image', 'Pin an approved prebuilt image by SHA256 digest');
	for (const key of ['candidate', 'verifier', 'output']) cleanPath(config[key], key);
	for (const [a, b] of [
		['candidate', 'verifier'],
		['candidate', 'output'],
		['verifier', 'output']
	]) {
		if (config[a] === config[b] || config[a].startsWith(config[b] + '/') || config[b].startsWith(config[a] + '/'))
			fail('harness-overlap', 'Candidate, verifier and evidence directories must be disjoint');
	}
	if (
		!Array.isArray(config.command) ||
		!config.command.length ||
		config.command.length > 30 ||
		config.command.some((x) => typeof x !== 'string' || x.includes('\0') || x.length > 4096) ||
		!config.command[0].startsWith('/verifier/')
	)
		fail('harness-command', 'Entrypoint must be a trusted executable under /verifier');
	const relative = config.command[0].slice('/verifier/'.length);
	if (!relative || relative.split('/').some((part) => !part || part === '.' || part === '..'))
		fail('harness-command', 'Noncanonical verifier entrypoint');
	const entry = path.resolve(config.verifier, relative);
	if (!entry.startsWith(config.verifier + '/') || fs.realpathSync(entry) !== entry || !fs.statSync(entry).isFile())
		fail('harness-command', 'Verifier entry must be a real confined file');
	exact(
		config.limits,
		['seconds', 'memoryMB', 'cpus', 'pids', 'outputBytes', 'diskMB'],
		['seconds', 'memoryMB', 'cpus', 'pids', 'outputBytes']
	);
	const max = { seconds: 3600, memoryMB: 8192, cpus: 8, pids: 512, outputBytes: 10485760, diskMB: 8192 };
	for (const [key, value] of Object.entries(config.limits))
		if (!Number.isFinite(value) || value <= 0 || value > max[key] || (key !== 'cpus' && !Number.isInteger(value)))
			fail('harness-budget', `Invalid ${key}`);
	if (config.verification !== undefined) {
		exact(config.verification, ['kind', 'minimumTests', 'baselineCommit'], ['kind', 'minimumTests']);
		if (
			config.verification.baselineCommit !== undefined &&
			(typeof config.verification.baselineCommit !== 'string' ||
				!/^[a-f0-9]{40}$/.test(config.verification.baselineCommit))
		)
			fail('verification-policy', 'Baseline must be an immutable commit');
		if (
			!gates.includes(config.verification.kind) ||
			!Number.isSafeInteger(config.verification.minimumTests) ||
			config.verification.minimumTests < 1 ||
			config.verification.minimumTests > 1000000
		)
			fail('verification-policy', 'A known gate and reviewed positive minimum test count are required');
	}
	return config;
}

/** Hash all entries, including empty directories and executable bits. No symlinks/devices/hard links. */
export function treeHash(root) {
	cleanPath(root, 'tree');
	const entries = [];
	let bytes = 0;
	const walk = (directory, prefix = '') => {
		for (const name of fs.readdirSync(directory).sort()) {
			const file = path.join(directory, name),
				relative = prefix + name,
				stat = fs.lstatSync(file);
			if (++entries.length > 20000) fail('candidate-tree', 'Tree entry budget exceeded');
			if (stat.isDirectory()) {
				entries[entries.length - 1] = [relative, 'directory', stat.mode & 0o777];
				walk(file, relative + '/');
			} else if (stat.isFile() && stat.nlink === 1) {
				bytes += stat.size;
				if (stat.size > 64000000 || bytes > 256000000) fail('candidate-tree', 'Tree byte budget exceeded');
				const data = fs.readFileSync(file);
				entries[entries.length - 1] = [relative, 'file', stat.mode & 0o777, hash(data)];
			} else fail('candidate-tree', 'Symlinks, hard links and nonregular tree entries are forbidden');
		}
	};
	walk(root);
	return hash(JSON.stringify(entries));
}

/** Candidate and trusted verifier are separate read-only mounts. Evidence is NEVER mounted. */
export function sandboxArguments(input, name) {
	const c = validateEnvelope(input);
	if (!/^ai-verify-[a-f0-9]{16}$/.test(name)) fail('harness-name', 'Invalid container name');
	return [
		'run',
		'--rm',
		'--pull=never',
		'--name',
		name,
		'--network=none',
		'--read-only',
		'--cap-drop=ALL',
		'--security-opt=no-new-privileges',
		'--user=65534:65534',
		`--pids-limit=${c.limits.pids}`,
		`--memory=${c.limits.memoryMB}m`,
		`--memory-swap=${c.limits.memoryMB}m`,
		`--cpus=${c.limits.cpus}`,
		'--ulimit=nofile=1024:1024',
		'--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m',
		`--tmpfs=/scratch:rw,nosuid,nodev,size=${c.limits.diskMB || 1024}m`,
		'--mount',
		`type=bind,src=${c.candidate},dst=/candidate,readonly`,
		'--mount',
		`type=bind,src=${c.verifier},dst=/verifier,readonly`,
		'--workdir=/candidate',
		'--env=HOME=/tmp',
		'--env=CI=true',
		...(c.verification
			? [
					`--env=AI_VERIFY_KIND=${c.verification.kind}`,
					...(c.verification.baselineCommit ? [`--env=AI_VERIFY_BASELINE=${c.verification.baselineCommit}`] : [])
				]
			: []),
		c.image,
		...c.command
	];
}
function docker(runtime, engine, args) {
	try {
		return runtime.spawnSync(engine, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1048576, env: runtimeEnv() });
	} catch (error) {
		return { status: null, error, stdout: '', stderr: '' };
	}
}
export function preflight(config, { engine = 'docker', runtime = defaultRuntime } = {}) {
	validateEnvelope(config);
	if (!['docker', 'podman'].includes(engine))
		fail('harness-engine', 'Only approved Docker or Podman executables supported');
	const version = docker(runtime, engine, ['version', '--format', '{{.Client.Version}}']);
	if (version.error || version.status !== 0)
		return {
			status: 'blocked',
			rule: 'sandbox-unavailable',
			message: 'An operational approved container runtime is required; no unsandboxed fallback exists'
		};
	const localId = /^sha256:/.test(config.image);
	const inspect = docker(runtime, engine, ['image', 'inspect', config.image, '--format', localId ? '{{.Id}}' : '{{json .RepoDigests}}']);
	let digests = [];
	try {
		digests = JSON.parse(inspect.stdout);
	} catch {
		/* Fail closed below. */
	}
	const matched = localId ? String(inspect.stdout || '').trim() === config.image : Array.isArray(digests) && digests.includes(config.image);
	if (inspect.error || inspect.status !== 0 || !matched)
		return {
			status: 'blocked',
			rule: 'image-unavailable',
			message: 'Pinned image must be provisioned and approved by the operator; executor never pulls automatically'
		};
	return { status: 'ready', engine, image: config.image };
}

/**
 * Only a reviewed verifier may emit this sole stdout JSON object. It must capture untrusted
 * test stdout separately and calculate counts/hashes itself, never forward model assertions.
 * This protocol detects missing/stale evidence; it does not make an unreviewed verifier trusted.
 */
export function validateVerificationReport(report, expected) {
	exact(
		report,
		['protocol', 'kind', 'candidateTreeHash', 'verifierTreeHash', 'tests', 'baselineCommit'],
		['protocol', 'kind', 'candidateTreeHash', 'verifierTreeHash', 'tests']
	);
	exact(
		expected,
		['kind', 'minimumTests', 'candidateTreeHash', 'verifierTreeHash', 'baselineCommit'],
		['kind', 'minimumTests', 'candidateTreeHash', 'verifierTreeHash']
	);
	if (
		!gates.includes(expected.kind) ||
		!Number.isSafeInteger(expected.minimumTests) ||
		expected.minimumTests < 1 ||
		expected.minimumTests > 1000000 ||
		![expected.candidateTreeHash, expected.verifierTreeHash].every(
			(value) => typeof value === 'string' && digest.test(value)
		) ||
		(expected.baselineCommit !== undefined &&
			(typeof expected.baselineCommit !== 'string' || !/^[a-f0-9]{40}$/.test(expected.baselineCommit)))
	)
		fail('verification-policy', 'Invalid supervisor verification expectations');
	if (report.baselineCommit !== expected.baselineCommit) fail('verification-binding', 'Verifier baseline mismatch');
	if (
		report.protocol !== 'ai-verifier/v1' ||
		!gates.includes(report.kind) ||
		report.kind !== expected.kind ||
		!digest.test(report.candidateTreeHash) ||
		!digest.test(report.verifierTreeHash) ||
		report.candidateTreeHash !== expected.candidateTreeHash ||
		report.verifierTreeHash !== expected.verifierTreeHash
	)
		fail('verification-binding', 'Verifier protocol, gate or tree hash mismatch');
	exact(report.tests, ['total', 'passed', 'failed', 'skipped']);
	for (const count of Object.values(report.tests))
		if (!Number.isSafeInteger(count) || count < 0 || count > 1000000)
			fail('verification-counts', 'Invalid test counts');
	if (
		report.tests.total < expected.minimumTests ||
		report.tests.total !== report.tests.passed ||
		report.tests.failed !== 0 ||
		report.tests.skipped !== 0
	)
		fail(
			'verification-counts',
			'All reviewed required tests must execute and pass; zero/skipped/failed tests do not qualify'
		);
	return report;
}

export async function runVerifier(
	config,
	{ engine = 'docker', signal, runtime = defaultRuntime, expectedCandidateTreeHash, expectedVerifierTreeHash } = {}
) {
	const ready = preflight(config, { engine, runtime });
	if (ready.status !== 'ready') return ready;
	if (signal?.aborted) return { status: 'cancelled', reason: 'cancelled' };
	const candidateTreeHash = treeHash(config.candidate),
		verifierTreeHash = treeHash(config.verifier);
	if (
		(expectedCandidateTreeHash && candidateTreeHash !== expectedCandidateTreeHash) ||
		(expectedVerifierTreeHash && verifierTreeHash !== expectedVerifierTreeHash)
	)
		return {
			status: 'blocked',
			rule: 'tree-mutation',
			reason: 'Candidate or trusted verifier changed before execution'
		};
	const name = `ai-verify-${randomBytes(8).toString('hex')}`,
		args = sandboxArguments(config, name),
		started = Date.now();
	const result = await new Promise((resolve) => {
		let stdout = [],
			stderr = [],
			bytes = 0,
			reason = null,
			settled = false,
			child,
			timer;
		const cleanup = () => {
			const removed = docker(runtime, engine, ['rm', '-f', name]);
			return {
				attempted: true,
				confirmed:
					!removed.error &&
					(removed.status === 0 || /(?:No such container|no container with name or ID)/i.test(removed.stderr || ''))
			};
		};
		const finish = (code, error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', cancel);
			const cleaned = cleanup();
			resolve({
				exitCode: code,
				reason: reason || error || (!cleaned.confirmed ? 'cleanup-unconfirmed' : null),
				seconds: (Date.now() - started) / 1000,
				stdout: Buffer.concat(stdout).toString('utf8'),
				stderr: Buffer.concat(stderr).toString('utf8'),
				outputBytes: bytes,
				cleanup: cleaned
			});
		};
		const stop = (why) => {
			if (reason || settled) return;
			reason = why;
			docker(runtime, engine, ['kill', name]);
			child?.kill('SIGKILL');
			// Do not depend on an eventual close event to clean a stuck client process.
			finish(null);
		};
		const cancel = () => stop('cancelled');
		const consume = (destination, chunk) => {
			if (settled || reason) return;
			const buffer = Buffer.from(chunk);
			bytes += buffer.length;
			if (bytes > config.limits.outputBytes) stop('output-budget');
			else destination.push(buffer);
		};
		try {
			child = runtime.spawn(engine, args, { env: runtimeEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
			child.stdout.on('data', (chunk) => consume(stdout, chunk));
			child.stderr.on('data', (chunk) => consume(stderr, chunk));
			child.on('error', (error) => finish(null, error.code || 'spawn-error'));
			child.on('close', (code) => finish(code));
			timer = setTimeout(() => stop('timeout'), config.limits.seconds * 1000);
			signal?.addEventListener('abort', cancel, { once: true });
			if (signal?.aborted) cancel();
		} catch (error) {
			finish(null, error.code || 'spawn-error');
		}
	});
	let verification = null,
		reason = result.reason;
	try {
		if (treeHash(config.candidate) !== candidateTreeHash || treeHash(config.verifier) !== verifierTreeHash)
			reason = 'tree-mutation';
	} catch {
		reason = 'tree-mutation';
	}
	if (!reason && result.exitCode === 0) {
		if (!config.verification) reason = 'verification-required';
		else {
			try {
				verification = validateVerificationReport(JSON.parse(result.stdout), {
					...config.verification,
					candidateTreeHash,
					verifierTreeHash
				});
			} catch (error) {
				reason = error.rule || 'verification-protocol';
			}
		}
	}
	const status =
		reason === 'cancelled'
			? 'cancelled'
			: reason
				? 'blocked'
				: result.exitCode === 0 && verification
					? 'verified'
					: 'failed';
	const evidence = {
		version: 1,
		...result,
		status,
		reason,
		verification,
		image: config.image,
		candidateTreeHash,
		verifierTreeHash,
		command: config.command,
		fixture: runtime !== defaultRuntime,
		notice:
			'Not task acceptance. Requires all independent reviewed gates. Protocol output must originate in trusted verifier code, not forwarded candidate output; a privileged host or compromised runtime is outside this boundary.'
	};
	// Revalidate the destination immediately before writing; never follow an output directory swap.
	cleanPath(config.output, 'output');
	const destination = path.join(config.output, `${name}.json`);
	fs.writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
	return { ...evidence, evidenceFile: destination };
}
