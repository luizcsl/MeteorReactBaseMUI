import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planAutomation } from '../automation/planner/plan.mjs';
import { applyAutomation, recoverAutomation } from '../automation/runner/execute.mjs';
import { catalog } from '../automation/catalog/registry.mjs';
import { validateRequest } from '../automation/contracts/validate.mjs';
import { selectImpact } from '../automation/planner/impact.mjs';
const request = {
	schemaVersion: 1,
	operations: [
		{
			id: 'create',
			kind: 'feature',
			input: {
				schemaVersion: 3,
				intent: 'create-feature',
				name: 'notes',
				archetype: 'owner',
				fields: [{ name: 'title', label: 'Title', type: 'string', required: true, maxLength: 80 }],
				permissions: { read: ['owner'], write: ['owner'] }
			}
		}
	]
};
function root(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-test-'));
	fs.mkdirSync(path.join(dir, 'imports/modules'), { recursive: true });
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}
test('catalog traces all 55 capabilities uniquely with limits', () => {
	const c = catalog();
	assert.equal(c.capabilities.length, 55);
	assert.equal(new Set(c.capabilities.map((x) => x.id)).size, 55);
	assert.ok(c.capabilities.every((x) => x.limits && x.executor));
});
test('plan is deterministic and does not mutate project; apply and replay are bounded', async (t) => {
	const dir = root(t),
		a = await planAutomation(dir, request),
		b = await planAutomation(dir, request);
	assert.deepEqual(a, b);
	assert.deepEqual(fs.readdirSync(path.join(dir, 'imports/modules')), []);
	assert.ok(a.changes.every((c) => c.afterHash && c.diff));
	const result = await applyAutomation(dir, a);
	assert.equal(result.status, 'applied');
	assert.equal(result.qualified, false);
	await assert.rejects(() => applyAutomation(dir, a), /modified|drifted/);
	const noOp = await planAutomation(dir, request);
	assert.equal(noOp.changes.length, 0);
	assert.equal((await applyAutomation(dir, noOp)).status, 'unchanged');
});
test('plan tampering and source drift fail before writes', async (t) => {
	const dir = root(t),
		plan = await planAutomation(dir, request);
	const forged = structuredClone(plan);
	forged.changes[0].after = 'evil';
	await assert.rejects(() => applyAutomation(dir, forged), /modified|drifted/);
	assert.equal(fs.existsSync(path.join(dir, 'imports/modules/notes')), false);
	fs.writeFileSync(path.join(dir, 'imports/other.ts'), 'export const changed=true;');
	await assert.rejects(() => applyAutomation(dir, plan), /modified|drifted/);
});
test('unknown fields/profile/injected policies rejected', async (t) => {
	const dir = root(t);
	for (const mutate of [
		(x) => (x.operations[0].input.shell = 'echo unsafe'),
		(x) => (x.operations[0].input.archetype = 'public'),
		(x) => (x.operations[0].input.permissions.read = ['anyone'])
	]) {
		const x = structuredClone(request);
		mutate(x);
		await assert.rejects(() => planAutomation(dir, x));
	}
});
test('DAG stable topological order; cycle and missing dependencies fail closed', () => {
	const input = {
		schemaVersion: 1,
		operations: [
			{ id: 'second', kind: 'evolve', input: {}, dependsOn: ['first'] },
			{ id: 'first', kind: 'feature', input: {} }
		]
	};
	assert.deepEqual(
		validateRequest(input).operations.map((x) => x.id),
		['first', 'second']
	);
	input.operations[1].dependsOn = ['second'];
	assert.throws(() => validateRequest(input), /cycle/);
});
test('symlink sources cannot escape project', async (t) => {
	const dir = root(t);
	fs.symlinkSync(os.tmpdir(), path.join(dir, 'imports/escape'));
	await assert.rejects(() => planAutomation(dir, request), /Symbolic/);
});
test('composed failure never leaves the earlier feature half-created', async (t) => {
	const dir = root(t),
		bad = structuredClone(request);
	bad.operations.push({
		id: 'broken',
		kind: 'evolve',
		dependsOn: ['create'],
		input: { schemaVersion: 1, module: 'notes', operations: [{ kind: 'unknown' }] }
	});
	await assert.rejects(() => planAutomation(dir, bad));
	assert.deepEqual(fs.readdirSync(path.join(dir, 'imports/modules')), []);
});
test('permission evolution requires review bound to exact plan', async (t) => {
	const dir = root(t);
	await applyAutomation(dir, await planAutomation(dir, request));
	const evolution = {
		schemaVersion: 1,
		operations: [
			{
				id: 'policy',
				kind: 'evolve',
				input: {
					schemaVersion: 1,
					module: 'notes',
					operations: [{ kind: 'replace-permissions', permissions: { read: ['owner'], write: ['owner'] } }]
				}
			}
		]
	};
	const plan = await planAutomation(dir, evolution);
	assert.deepEqual(plan.requiresReview, ['security']);
	await assert.rejects(() => applyAutomation(dir, plan), /review/);
	assert.equal(
		(await applyAutomation(dir, plan, { planHash: plan.planHash, reviews: ['security'] })).status,
		'unchanged'
	);
});
test('impact is transitive and never removes mandatory gates', () => {
	const result = selectImpact(
		{
			edges: [
				{ from: 'a.test.ts', to: 'a.ts' },
				{ from: 'a.ts', to: 'b.ts' }
			]
		},
		['b.ts']
	);
	assert.deepEqual(result.affected, ['a.test.ts', 'a.ts', 'b.ts']);
	assert.ok(result.mandatoryGates.includes('verify'));
});
test('evolution regenerates UI, fixtures, documentation and extension manifest without drift', async (t) => {
	const dir = root(t);
	await applyAutomation(dir, await planAutomation(dir, request));
	const evolution = {
		schemaVersion: 1,
		operations: [
			{
				id: 'field',
				kind: 'evolve',
				input: {
					schemaVersion: 1,
					module: 'notes',
					operations: [
						{
							kind: 'add-field',
							field: { name: 'count', label: 'Count', type: 'integer', required: false, min: 0, max: 100 }
						}
					]
				}
			}
		]
	};
	const plan = await planAutomation(dir, evolution);
	assert.ok(plan.changes.some((x) => x.path.endsWith('REFERENCE.md')));
	assert.ok(plan.changes.some((x) => x.path.endsWith('FeatureUI.tsx')));
	assert.ok(plan.changes.some((x) => x.path.endsWith('module.automation.json')));
	await applyAutomation(dir, plan);
	const repeat = await planAutomation(dir, evolution);
	assert.equal(repeat.changes.length, 0);
});
test('evolution refuses customized generated extension', async (t) => {
	const dir = root(t);
	await applyAutomation(dir, await planAutomation(dir, request));
	fs.appendFileSync(path.join(dir, 'imports/modules/notes/generated/FeatureUI.tsx'), '\n// custom edit\n');
	await assert.rejects(
		() =>
			planAutomation(dir, {
				schemaVersion: 1,
				operations: [
					{
						id: 'filter',
						kind: 'evolve',
						input: { schemaVersion: 1, module: 'notes', operations: [{ kind: 'add-filter', field: 'title' }] }
					}
				]
			}),
		/drift/
	);
});
test('impact consumes actual astGraph file/dependency representation', () => {
	assert.deepEqual(
		selectImpact(
			{
				files: [
					{ file: 'ui.ts', dependencies: ['contract.ts'] },
					{ file: 'contract.ts', dependencies: [] }
				]
			},
			['contract.ts']
		).affected,
		['contract.ts', 'ui.ts']
	);
});
test('semantic planning includes protected consumers and fails rather than breaking their references', async (t) => {
	const dir = root(t);
	fs.writeFileSync(path.join(dir, 'imports/widget.ts'), 'export const value = 1;\n');
	fs.mkdirSync(path.join(dir, '.cypress'));
	fs.writeFileSync(
		path.join(dir, '.cypress/consumer.ts'),
		"import { value } from '../imports/widget'; console.log(value);\n"
	);
	await assert.rejects(
		() =>
			planAutomation(dir, {
				schemaVersion: 1,
				operations: [
					{
						id: 'move',
						kind: 'codemod',
						input: { kind: 'rename-module', file: 'imports/widget.ts', to: 'imports/renamed.ts' }
					}
				]
			}),
		/confined|Protected/
	);
	assert.equal(fs.existsSync(path.join(dir, 'imports/widget.ts')), true);
});
test('catalog provides selected schemas and runnable request without filesystem access', () => {
	const result = catalog({ capability: '23', schemas: true });
	assert.equal(result.capabilities.length, 1);
	assert.ok(result.schemas['tools/automation/contracts/ui.v1.schema.json']);
	assert.equal(result.example.operations[0].kind, 'feature');
	assert.throws(() => catalog({ capability: '99' }));
});
