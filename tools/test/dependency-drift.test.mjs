import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dependencyCheck } from '../checks.mjs';
test('doctor detects installed drift and lock mismatch without treating key order as drift', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const write = (file, value) => {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), JSON.stringify(value));
	};
	write('package.json', { dependencies: { beta: '^2', alpha: '^1' } });
	write('package-lock.json', {
		packages: {
			'': { dependencies: { alpha: '^1', beta: '^2' } },
			'node_modules/alpha': { version: '1.0.0' },
			'node_modules/beta': { version: '2.0.0' }
		}
	});
	write('node_modules/alpha/package.json', { version: '1.0.0' });
	write('node_modules/beta/package.json', { version: '2.0.0' });
	assert.equal(dependencyCheck(root).status, 'passed');
	write('node_modules/beta/package.json', { version: '1.0.0' });
	assert.match(dependencyCheck(root).message, /beta: installed 1.0.0, lock 2.0.0/);
	write('package.json', { dependencies: { alpha: '^1', beta: '^3' } });
	assert.match(dependencyCheck(root).message, /manifest\/lock mismatch/);
});
