// Explicit source selection for module-level evidence; never infer acceptance from general suites.
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash } from './lib.mjs';
const source = 'imports/modules/example/tests/fields.node.test.ts';
if (process.argv.length !== 3 || process.argv[2] !== source) {
	console.error('Pass the exact Example contract test source');
	process.exit(2);
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'example-contracts-'));
try {
	const outfile = path.join(temporary, 'example.cjs');
	await build({
		stdin: {
			contents: `import './${source}'; import './tests/legacy-fields.node.test.ts';`,
			resolveDir: process.cwd(),
			loader: 'ts'
		},
		bundle: true,
		platform: 'node',
		format: 'cjs',
		outfile
	});
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', outfile], { encoding: 'utf8', env });
	const output = (run.stdout ?? '') + (run.stderr ?? '');
	process.stdout.write(output);
	if (
		run.status !== 0 ||
		run.error ||
		!/^# tests [1-9]\d*$/m.test(output) ||
		!/^# fail 0$/m.test(output) ||
		!/^# skipped 0$/m.test(output)
	)
		throw new Error('Example contracts failed, skipped or reported no tests');
	console.log(
		JSON.stringify({
			schemaVersion: 1,
			status: 'passed',
			testSources: Object.fromEntries(
				[source, 'tests/legacy-fields.node.test.ts'].map((file) => [file, hash(fs.readFileSync(file))])
			),
			command: 'npm run test:example:contracts',
			acceptance: 'contract-only; real Mongo/DDP/browser acceptance is separate'
		})
	);
} finally {
	fs.rmSync(temporary, { recursive: true, force: true });
}
