import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { catalog } from '../automation/catalog/registry.mjs';
test('dependency workflow discoverable separately with strict embedded schema', () => {
	const result = catalog({ capability: '52', schemas: true });
	const c = result.capabilities[0];
	assert.equal(c.status, 'supported');
	assert.equal(c.executor, 'dependencies');
	assert.match(c.entrypoint, /dependencies-cli/);
	assert.deepEqual(c.allowedWrites, ['package.json', 'package-lock.json']);
	assert.equal(result.schemas[c.inputSchema].additionalProperties, false);
	assert.deepEqual(result.schemas[c.inputSchema].required, ['updates']);
});
test('dependency CLI rejects missing approval and arbitrary commands before any npm process', () => {
	for (const args of [[], ['install'], ['apply', 'missing.json'], ['plan', 'missing.json', 'extra']]) {
		const result = spawnSync(process.execPath, ['tools/automation/adapters/dependencies-cli.mjs', ...args], {
			encoding: 'utf8'
		});
		assert.equal(result.status, 1);
		assert.equal(JSON.parse(result.stdout).status, 'blocked');
		assert.match(JSON.parse(result.stdout).diagnostics[0].message, /Use plan/);
	}
});
