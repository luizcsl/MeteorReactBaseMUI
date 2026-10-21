import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = await mkdtemp(path.join(tmpdir(), 'boilerplate-core-'));
try {
 const outfile = path.join(dir, 'core.cjs');
 await build({ entryPoints: ['tests/core.node.test.ts'], bundle: true, platform: 'node', format: 'cjs', outfile });
 const result = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
 process.exitCode = result.status ?? 1;
} finally { await rm(dir, { recursive: true, force: true }); }
