// Maintainer qualification with receipts bound to the current source bytes.
// This diagnostic runner is not an independent sandbox or a release/deploy action.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { confined, files, hash } from './lib.mjs';
const root = process.cwd();
if (process.argv.length !== 2) {
	console.error('Usage: npm run qualify (no arguments)');
	process.exit(2);
}
function sourceSnapshot() {
	const names = [
		'AGENTS.md',
		'README.md',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'.nvmrc',
		'.meteor/release',
		'.meteor/packages',
		'.meteor/versions',
		'.meteorignore',
		'.babelrc',
		'.babelrc.json',
		'babel.config.js',
		'babel.config.cjs',
		'cypress.ai-ready.config.ts',
		'cypress.recipe-ui.config.ts',
		'cypress.request-journey.config.ts'
	];
	for (const folder of [
		'imports',
		'public',
		'client',
		'server',
		'tests',
		'tools',
		'templates',
		'evals',
		'docs',
		'.github/workflows',
		'.cypress/ai-ready',
		'.cypress/recipe-ui',
		'.cypress/request-journey',
		'.babel-plugins'
	]) {
		const target = confined(root, folder, { missing: folder === '.babel-plugins' });
		if (!fs.existsSync(target) && folder === '.babel-plugins') continue;
		for (const file of files(target)) names.push(folder + '/' + file);
	}
	return Object.fromEntries(
		names
			.filter((file) => file !== 'docs/BOILERPLATE_IMPROVEMENTS_REPORT.md')
			.sort()
			.map((file) => {
				const optional = ['.babelrc', '.babelrc.json', 'babel.config.js', 'babel.config.cjs'].includes(file);
				const target = confined(root, file, { missing: optional });
				return [file, fs.existsSync(target) ? hash(fs.readFileSync(target)) : null];
			})
	);
}
const receipt = {
	schemaVersion: 1,
	sourceExclusions: ['docs/BOILERPLATE_IMPROVEMENTS_REPORT.md', '.ai-artifacts/', 'build/dependency caches'],
	baselineCommit: null,
	node: process.versions.node,
	npm: spawnSync('npm', ['--version'], { cwd: root, encoding: 'utf8' }).stdout?.trim(),
	sourceHash: null,
	sources: {},
	startedAt: new Date().toISOString(),
	status: 'failed',
	qualified: false,
	gates: []
};
const artifacts = confined(root, '.ai-artifacts', { missing: true });
fs.mkdirSync(artifacts, { recursive: true });
try {
	const before = sourceSnapshot();
	const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
	if (git.status !== 0) throw new Error('Cannot identify baseline commit');
	receipt.baselineCommit = git.stdout.trim();
	receipt.sources = before;
	receipt.sourceHash = hash(JSON.stringify(before));
	for (const script of [
		'doctor',
		'typecheck',
		'test:toolkit',
		'verify',
		'test:migrations',
		'test:transactions',
		'templates:runtime',
		'test:recipe-ui',
		'test:request-journey'
	]) {
		const started = Date.now();
		console.log(`Qualification: ${script}`);
		const result = spawnSync('npm', ['run', script], {
			cwd: root,
			encoding: 'utf8',
			timeout: 1200000,
			maxBuffer: 32 * 1024 * 1024
		});
		const output = (result.stdout ?? '') + (result.stderr ?? '');
		fs.writeFileSync(path.join(artifacts, `qualification-${script.replaceAll(':', '-')}.log`), output);
		receipt.gates.push({
			command: `npm run ${script}`,
			exitCode: result.status,
			signal: result.signal,
			seconds: (Date.now() - started) / 1000,
			outputHash: hash(output)
		});
		if (result.status !== 0 || result.error || result.signal) throw new Error(`Gate failed or unavailable: ${script}`);
	}
	if (hash(JSON.stringify(sourceSnapshot())) !== receipt.sourceHash)
		throw new Error('Sources changed during qualification; results are stale');
	receipt.status = 'passed';
	receipt.qualified = false;
	receipt.qualificationScope =
		'local application evidence; verify:release, hosted supply-chain and external harness qualification remain mandatory before release';
} catch (error) {
	receipt.error = error.message;
	process.exitCode = 1;
	console.error(error.message);
} finally {
	receipt.finishedAt = new Date().toISOString();
	fs.writeFileSync(path.join(artifacts, 'qualification.json'), JSON.stringify(receipt, null, 2) + '\n');
}
