#!/usr/bin/env node
/** Reviewed adversarial fixture, NOT an evaluator of model/application quality. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { treeHash } from '../executor.mjs';

const mode = process.argv[2];
let passed = 0;
const check = (condition, message) => {
	assert.ok(condition, message);
	passed++;
};
const receipt = () => ({
	protocol: 'ai-verifier/v1',
	kind: process.env.AI_VERIFY_KIND,
	candidateTreeHash: treeHash('/candidate'),
	verifierTreeHash: treeHash('/verifier'),
	tests: { total: passed, passed, failed: 0, skipped: 0 }
});
const cgroup = (file) => fs.readFileSync(`/sys/fs/cgroup/${file}`, 'utf8').trim();

if (mode === 'hang') {
	process.stdout.write('ready\n');
	setInterval(() => {}, 1000);
} else if (mode === 'output') {
	while (true) process.stdout.write('x'.repeat(8192));
} else if (mode === 'oom') {
	// Every page is touched; allocation cannot be satisfied by lazy virtual memory.
	const held = [];
	while (true) held.push(Buffer.alloc(8 * 1024 * 1024, 1));
} else if (mode === 'missing') {
	// A successful exit with no evidence must never qualify.
} else {
	if (mode === 'positive') {
		check(process.getuid() === 65534 && process.getgid() === 65534, 'unprivileged identity');
		const status = fs.readFileSync('/proc/self/status', 'utf8');
		check(/^CapEff:\s+0+$/m.test(status), 'effective capabilities removed');
		check(/^NoNewPrivs:\s+1$/m.test(status), 'no-new-privileges enforced');
		check(
			fs.readdirSync('/sys/class/net').every((name) => name === 'lo'),
			'no external network interface'
		);
		check(!process.env.AI_HARNESS_SECRET_SENTINEL, 'host credentials not inherited');
		check(!fs.existsSync('/var/run/docker.sock'), 'host Docker socket not exposed');
		check(!fs.existsSync(process.argv[3]), 'host evidence directory not mounted');
		const probe = spawnSync(process.execPath, ['/candidate/attack.mjs'], { encoding: 'utf8', timeout: 5000 });
		assert.equal(probe.status, 0, probe.stderr);
		const attempts = JSON.parse(probe.stdout);
		for (const target of [
			'/candidate/created-by-candidate',
			'/verifier/created-by-candidate',
			'/candidate/attack.mjs',
			'/verifier/run.mjs',
			'/var/tmp/created-by-candidate'
		])
			check(attempts[target] === 'EROFS', `${target}: read-only mount enforced independently of file permissions`);
		check(attempts.root === 'EPERM', 'candidate privilege escalation denied');
		check(
			['ENETUNREACH', 'EHOSTUNREACH', 'EACCES', 'EPERM'].includes(attempts.network),
			'candidate external connection denied by isolation, not timeout'
		);
		fs.writeFileSync('/scratch/allowed', 'ephemeral');
		check(fs.readFileSync('/scratch/allowed', 'utf8') === 'ephemeral', 'bounded scratch is writable');
		fs.copyFileSync('/bin/true', '/scratch/exec-probe');
		const scratchExec = spawnSync('/scratch/exec-probe', [], { timeout: 5000 });
		check(!scratchExec.error && scratchExec.status === 0, 'bounded scratch supports staged native executables');
		fs.copyFileSync('/bin/true', '/tmp/noexec-probe');
		const tmpExec = spawnSync('/tmp/noexec-probe', [], { timeout: 5000 });
		check(tmpExec.error?.code === 'EACCES', '/tmp remains non-executable');
		check(cgroup('memory.max') === String(256 * 1024 * 1024), 'memory cgroup bound');
		check(cgroup('memory.swap.max') === '0', 'swap disabled');
		check(cgroup('pids.max') === '32', 'PID cgroup bound');
		const [quota, period] = cgroup('cpu.max').split(' ').map(Number);
		check(quota / period === 0.5, 'CPU cgroup bound');
	} else if (mode === 'disk') {
		let denied;
		const fd = fs.openSync('/scratch/fill', 'w');
		try {
			for (let i = 0; i < 32; i++) fs.writeSync(fd, Buffer.alloc(1024 * 1024, 1));
		} catch (error) {
			denied = error.code;
		} finally {
			fs.closeSync(fd);
		}
		check(denied === 'ENOSPC', 'scratch tmpfs capacity enforced');
	} else if (mode === 'pids') {
		const children = [];
		let denied;
		try {
			for (let i = 0; i < 64; i++) {
				const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
				const result = await new Promise((resolve) => {
					child.once('spawn', () => resolve('spawned'));
					child.once('error', (error) => resolve(error.code));
				});
				if (result !== 'spawned') {
					denied = result;
					break;
				}
				children.push(child);
			}
		} finally {
			await Promise.all(
				children.map(
					(child) =>
						new Promise((resolve) => {
							child.once('close', resolve);
							child.kill('SIGKILL');
						})
				)
			);
		}
		check(denied === 'EAGAIN', 'cgroup prevents excessive process creation');
		check(children.length > 0 && children.length < 32, 'PID cap reached below configured bound');
	} else passed = 2;

	const report = receipt();
	if (mode === 'zero') report.tests = { total: 0, passed: 0, failed: 0, skipped: 0 };
	if (mode === 'failed') report.tests = { total: 2, passed: 1, failed: 1, skipped: 0 };
	if (mode === 'skipped') report.tests = { total: 2, passed: 1, failed: 0, skipped: 1 };
	if (mode === 'candidate-hash') report.candidateTreeHash = '0'.repeat(64);
	if (mode === 'verifier-hash') report.verifierTreeHash = '0'.repeat(64);
	if (mode === 'wrong-gate') report.kind = 'scope';
	if (mode === 'extra-output') console.log('untrusted extra output');
	if (mode === 'malformed') console.log('{not-json');
	else console.log(JSON.stringify(report));
	if (mode === 'nonzero') process.exitCode = 7;
}
