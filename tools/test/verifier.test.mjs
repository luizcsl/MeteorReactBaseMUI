import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseTapSummary, checkScope } from '../harness/verifier/run.mjs';
import { hash } from '../lib.mjs';
const tap = '# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
test('trusted verifier refuses missing, duplicated, failed, cancelled, skipped and undersized summaries', () => {
	assert.deepEqual(parseTapSummary(tap, 3), { total: 3, passed: 3, failed: 0, skipped: 0 });
	for (const bad of [
		'',
		tap + '# tests 3\n',
		tap.replace('# pass 3', '# pass 2'),
		tap.replace('# skipped 0', '# skipped 1'),
		tap.replace('# cancelled 0', '# cancelled 1')
	])
		assert.throws(() => parseTapSummary(bad, 3));
	assert.throws(() => parseTapSummary(tap, 4));
});
test('scope verifier binds deletions and additions to protected baseline', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-'));
	try {
		fs.mkdirSync(path.join(root, 'imports'));
		fs.writeFileSync(path.join(root, 'imports/a.ts'), 'changed');
		const baseline = { 'imports/a.ts': hash('original'), 'package.json': hash('{}') };
		assert.throws(() => checkScope(root, baseline, ['imports/']), /package.json/);
		fs.writeFileSync(path.join(root, 'package.json'), '{}');
		assert.equal(checkScope(root, baseline, ['imports/']).failed, 0);
		fs.writeFileSync(path.join(root, 'outside.ts'), 'bad');
		assert.throws(() => checkScope(root, baseline, ['imports/']), /outside/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
