import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseArguments } from '../arguments.mjs';

test('CLI rejects typos, positional arguments, duplicates and missing values', () => {
	for (const [command, args] of [
		['doctor', ['--unknown']],
		['doctor', ['unexpected']],
		['task:validate', ['--task', 'a.json', '--task', 'b.json']],
		['task:validate', ['--task', '--json']],
		['task:state', ['--task', 'a.json']],
		['module:new', ['--spec', '']],
		['migration:export', ['--store', 'a.json', '--plan', 'b.json', '--aply']],
		['constructor', []],
		['unknown', ['--help']],
		[undefined, []]
	]) assert.throws(() => parseArguments(command, args), { rule: 'usage' });
});

test('evolution requires exactly one mode, without precedence between mutations', () => {
	for (const args of [[], ['--plan', 'a', '--apply', 'b'], ['--apply', 'a', '--recover', 'notes']])
		assert.throws(() => parseArguments('module:evolve', args), { rule: 'usage' });
	for (const mode of ['--plan', '--apply', '--recover'])
		assert.equal(parseArguments('module:evolve', [mode, 'value']).get(mode), 'value');
});

test('valid invocations preserve values, explicit migration apply and help', () => {
	assert.equal(parseArguments('module:new', ['--spec', 'path with spaces.json']).get('--spec'), 'path with spaces.json');
	assert.equal(parseArguments('module:new', ['--help']).get('--help'), true);
	assert.equal(parseArguments('--help', []).size, 0);
	const args = ['--store', 'store.json', '--plan', 'plan.json', '--json'];
	assert.equal(parseArguments('migration:export', args).has('--apply'), false);
	assert.equal(parseArguments('migration:export', [...args, '--apply']).get('--apply'), true);
});

test('CLI reports usage before attempting file reads or dispatching conflicting modes', () => {
	for (const args of [
		['module:evolve', '--recover', 'invalid/name', '--apply', '/nonexistent-plan.json'],
		['migration:export', '--store', '/nonexistent-store.json', '--plan', '/nonexistent-plan.json', '--aply']
	]) {
		const result = spawnSync(process.execPath, [new URL('../cli.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8' });
		assert.equal(result.status, 2, result.stderr);
		assert.equal(result.stdout, '');
		assert.equal(JSON.parse(result.stderr).diagnostics[0].rule, 'usage');
	}
});
