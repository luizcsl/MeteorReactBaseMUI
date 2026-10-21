#!/usr/bin/env node
/** Protected test compiler/launcher; runs from the reviewed verifier mount. */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire('/opt/toolchain/package.json');
const { buildSync } = require('esbuild');
const entry = process.argv[2];
if (!/^tests\/[a-zA-Z0-9_./-]+\.node\.test\.ts$/.test(entry) || entry.includes('..'))
	throw Error('A reviewed Node test entry under tests/ is required');
const outfile = '/scratch/trusted-gate.cjs';
buildSync({
	entryPoints: [path.join('/scratch/candidate', entry)],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	outfile
});
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', outfile], {
	stdio: 'inherit',
	env: {
		PATH: '/opt/toolchain/bin:/usr/local/bin:/usr/bin:/bin',
		HOME: '/scratch/home',
		TMPDIR: '/scratch',
		CI: 'true'
	}
});
process.exitCode = run.status ?? 1;
