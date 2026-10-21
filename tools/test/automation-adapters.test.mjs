import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dispatch } from '../automation/adapters/mcp.mjs';
test('MCP discovers six tools with required arguments and retrieves selected embedded schemas', async () => {
	const listed = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
	assert.equal(listed.tools.length, 6);
	assert.deepEqual(listed.tools.find((t) => t.name === 'toolkit.plan').inputSchema.required, ['input']);
	const result = await dispatch({
		jsonrpc: '2.0',
		id: 2,
		method: 'tools/call',
		params: { name: 'toolkit.catalog', arguments: { capability: '23', schemas: true } }
	});
	const catalog = JSON.parse(result.content[0].text);
	assert.equal(catalog.capabilities[0].id, '23');
	assert.ok(catalog.schemas['tools/automation/contracts/ui.v1.schema.json']);
});
test('MCP rejects arbitrary tool commands/missing required arguments and structures domain errors', async () => {
	for (const params of [
		{ name: 'shell', arguments: { command: 'echo injected' } },
		{ name: 'toolkit.plan', arguments: {} },
		{ name: 'toolkit.catalog', arguments: { shell: 'injected' } }
	])
		await assert.rejects(() => dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }));
	const result = await dispatch({
		jsonrpc: '2.0',
		id: 2,
		method: 'tools/call',
		params: {
			name: 'toolkit.plan',
			arguments: { input: { schemaVersion: 1, operations: [{ id: 'bad', kind: 'shell', input: {} }] } }
		}
	});
	assert.equal(result.isError, true);
	assert.equal(JSON.parse(result.content[0].text).diagnostics[0].code, 'unsupported');
});
test('CLI outputs structured JSON and nonzero exit for malformed invocation', () => {
	const result = spawnSync(
		process.execPath,
		['tools/automation/adapters/cli.mjs', 'catalog', 'unexpected.json', 'unexpected2.json'],
		{ encoding: 'utf8' }
	);
	assert.equal(result.status, 1);
	const error = JSON.parse(result.stdout);
	assert.equal(error.status, 'blocked');
	assert.match(error.diagnostics[0].message, /Unexpected/);
});
