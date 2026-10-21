import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { catalog } from '../automation/catalog/registry.mjs';
test('project scaffold is discoverable with separate explicit workspace boundary', () => {
	const result = catalog({ capability: '01', schemas: true }),
		entry = result.capabilities[0];
	assert.equal(entry.status, 'supported');
	assert.match(entry.entrypoint, /project-cli/);
	assert.deepEqual(result.schemas[entry.inputSchema].required, ['source', 'destination', 'name']);
	assert.deepEqual(entry.allowedWrites, ['<new-destination>/**']);
});
test('project CLI rejects missing workspace/review and extra args before filesystem actions', () => {
	for (const args of [
		[],
		['install'],
		['plan'],
		['apply', 'workspace', 'plan.json'],
		['plan', 'workspace', 'request.json', 'extra']
	]) {
		const result = spawnSync(process.execPath, ['tools/automation/adapters/project-cli.mjs', ...args], {
			encoding: 'utf8'
		});
		assert.equal(result.status, 1);
		assert.equal(JSON.parse(result.stdout).status, 'blocked');
		assert.match(JSON.parse(result.stdout).diagnostics[0].message, /Use plan/);
	}
});
