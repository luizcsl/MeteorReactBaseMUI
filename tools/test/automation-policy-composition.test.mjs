import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderIntegration } from '../integrate.mjs';
import { planAutomation } from '../automation/planner/plan.mjs';
import { applyAutomation } from '../automation/runner/execute.mjs';
function write(root, file, text) {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), text);
}
const feature = {
	schemaVersion: 3,
	intent: 'create-feature',
	name: 'guardednotes',
	archetype: 'owner',
	fields: [{ name: 'count', label: 'Count', type: 'integer', required: true, min: 0, max: 100 }],
	states: ['draft', 'ready'],
	transitions: [{ from: 'draft', to: 'ready', roles: ['owner'] }],
	permissions: { read: ['owner'], write: ['owner'] },
	workflow: {
		transitions: [
			{
				from: 'draft',
				to: 'ready',
				conditions: [{ field: 'count', op: 'gte', value: 1 }],
				deadline: { anchor: 'updatedAt', afterMs: 1000, mode: 'after' }
			}
		]
	}
};
const req = (kind, input) => ({ schemaVersion: 1, operations: [{ id: 'policy', kind, input }] });
test('workflow composition is reviewed, generated, registered and deterministic after integration', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-composition-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, 'imports/modules'), { recursive: true });
	for (const [file, text] of Object.entries(renderIntegration(root, [])))
		write(root, 'imports/integration/' + file, text);
	const plan = await planAutomation(root, req('feature', feature));
	assert.ok(plan.requiresReview.includes('security'));
	await assert.rejects(() => applyAutomation(root, plan), /review/);
	await applyAutomation(root, plan, { planHash: plan.planHash, reviews: plan.requiresReview });
	assert.ok(fs.existsSync(path.join(root, 'imports/modules/guardednotes/generated/workflow/server/index.ts')));
	write(
		root,
		'imports/modules/guardednotes/custom/server/acceptance.test.ts',
		'// Independently supplied test fixture, not qualification\nexport {};\n'
	);
	const input = { schemaVersion: 1, module: 'guardednotes', label: 'Guarded notes', identity: 'owner-active-account' };
	const integration = await planAutomation(root, req('integrate', input));
	await applyAutomation(root, integration, { planHash: integration.planHash, reviews: integration.requiresReview });
	assert.match(
		fs.readFileSync(path.join(root, 'imports/integration/server/register.ts'), 'utf8'),
		/registerGuardednotes\(workflowPorts0\(ports0\)\)/
	);
	assert.equal((await planAutomation(root, req('integrate', input))).changes.length, 0);
});

test('relationship generator cannot integrate without explicit adapter and composes with workflow', async (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relation-composition-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, 'imports/modules'), { recursive: true });
	for (const [file, text] of Object.entries(renderIntegration(root, [])))
		write(root, 'imports/integration/' + file, text);
	const input = {
		...feature,
		relationships: {
			incoming: [{ name: 'children', source: 'childnotes', field: 'parentId', policy: 'restrict', maxAffected: 20 }],
			outgoing: [],
			maxTotal: 30
		}
	};
	const plan = await planAutomation(root, req('feature', input));
	await applyAutomation(root, plan, { planHash: plan.planHash, reviews: plan.requiresReview });
	const prefix = 'imports/modules/guardednotes/custom/server/';
	write(root, prefix + 'acceptance.test.ts', '// Fixture only.\nexport {};\n');
	const integrationInput = {
		schemaVersion: 1,
		module: 'guardednotes',
		label: 'Relations',
		identity: 'owner-active-account'
	};
	await assert.rejects(() => planAutomation(root, req('integrate', integrationInput)), /relationshipPorts/);
	write(
		root,
		prefix + 'relationshipPorts.ts',
		'// Explicit reviewed composition fixture.\nexport const relationshipAdapter = approvedAdapter;\n'
	);
	const integration = await planAutomation(root, req('integrate', integrationInput));
	await applyAutomation(root, integration, { planHash: integration.planHash, reviews: integration.requiresReview });
	assert.match(
		fs.readFileSync(path.join(root, 'imports/integration/server/register.ts'), 'utf8'),
		/registerGuardednotes\(relationshipPorts0\(workflowPorts0\(ports0\), relationshipAdapter0\)\)/
	);
});
