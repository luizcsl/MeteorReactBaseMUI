import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { architectureContext } from '../architecture.mjs';
test('context distinguishes legacy, canonical core and domain-only modules with pinned manifests', () => {
	const result = architectureContext(path.resolve(import.meta.dirname, '../..'), [
		'imports/modules/example/api/exampleApi.ts',
		'imports/modules/tasks/contracts/index.ts',
		'imports/modules/requestitems/contracts/index.ts'
	]);
	assert.deepEqual(
		result.map((r) => [r.module, r.architecture, r.reference]),
		[
			['example', 'legacy', false],
			['requestitems', 'domain-only', false],
			['tasks', 'core-v1', true]
		]
	);
	assert.ok(result.every((r) => /^[a-f0-9]{64}$/.test(r.hash)));
});
