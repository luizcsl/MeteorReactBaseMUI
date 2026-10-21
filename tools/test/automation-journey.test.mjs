import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRecipe } from '../recipes.mjs';
import { renderIntegration } from '../integrate.mjs';
import { planAutomation } from '../automation/planner/plan.mjs';
import { applyAutomation } from '../automation/runner/execute.mjs';

const feature = {
	schemaVersion: 3,
	intent: 'create-feature',
	name: 'journeynotes',
	archetype: 'owner',
	fields: [{ name: 'title', label: 'Title', type: 'string', required: true, maxLength: 80 }],
	permissions: { read: ['owner'], write: ['owner'] }
};
const acceptance = '// Independent supervisor-owned fixture. This text is not application qualification.\nexport {};\n';
const request = (kind, input) => ({ schemaVersion: 1, operations: [{ id: 'journey', kind, input }] });
function write(root, file, text) {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), text);
}
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'independent-automation-journey-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, 'imports/modules'), { recursive: true });
	for (const [file, text] of Object.entries(renderIntegration(root, [])))
		write(root, 'imports/integration/' + file, text);
	return root;
}
async function reviewedApply(root, plan) {
	return applyAutomation(root, plan, { planHash: plan.planHash, reviews: plan.requiresReview });
}

test('independent journey creates, requires acceptance, selects owner adapter, integrates and evolves without rewriting acceptance', async (t) => {
	const root = fixture(t),
		prefix = `imports/modules/${feature.name}`;
	await applyAutomation(root, await planAutomation(root, request('feature', feature)));
	const integration = request('integrate', {
		schemaVersion: 1,
		module: feature.name,
		label: 'Journey notes',
		identity: 'owner-active-account'
	});
	await assert.rejects(() => planAutomation(root, integration));
	assert.equal(fs.existsSync(path.join(root, prefix, 'custom/server/ports.ts')), false);
	write(root, `${prefix}/custom/server/acceptance.test.ts`, acceptance);
	const plan = await planAutomation(root, integration);
	assert.ok(plan.requiresReview.includes('security'));
	await assert.rejects(() => applyAutomation(root, plan), /review/);
	assert.equal((await reviewedApply(root, plan)).qualified, false);
	assert.match(read(root, `${prefix}/custom/server/ports.ts`), /ownerRecipePorts/);
	assert.match(read(root, 'imports/integration/routes.tsx'), /journeynotes\/automation\/Page/);
	assert.match(read(root, 'imports/integration/server/register.ts'), /registerJourneynotes\(ports0\)/);
	assert.match(read(root, 'imports/integration/server/tests.ts'), /custom\/server\/acceptance\.test/);
	const ports = read(root, `${prefix}/custom/server/ports.ts`);
	const evolution = await planAutomation(
		root,
		request('evolve', {
			schemaVersion: 1,
			module: feature.name,
			operations: [
				{
					kind: 'add-field',
					field: { name: 'count', label: 'Count', type: 'integer', required: false, min: 0, max: 100 }
				}
			]
		})
	);
	await reviewedApply(root, evolution);
	assert.equal(read(root, `${prefix}/custom/server/acceptance.test.ts`), acceptance);
	assert.equal(read(root, `${prefix}/custom/server/ports.ts`), ports);
	assert.match(read(root, `${prefix}/automation/REFERENCE.md`), /count: integer/);
	assert.equal((await planAutomation(root, integration)).changes.length, 0);
});

test('independent journey never overwrites a different reviewed identity adapter', async (t) => {
	const root = fixture(t),
		prefix = `imports/modules/${feature.name}`;
	await applyAutomation(root, await planAutomation(root, request('feature', feature)));
	write(root, `${prefix}/custom/server/acceptance.test.ts`, acceptance);
	const custom = 'export const ports = previouslyReviewedPorts();\n';
	write(root, `${prefix}/custom/server/ports.ts`, custom);
	await assert.rejects(() =>
		planAutomation(
			root,
			request('integrate', {
				schemaVersion: 1,
				module: feature.name,
				label: 'Notes',
				identity: 'owner-active-account'
			})
		)
	);
	assert.equal(read(root, `${prefix}/custom/server/ports.ts`), custom);
	assert.equal(read(root, `${prefix}/custom/server/acceptance.test.ts`), acceptance);
});

test('project composition cannot remove security review required by the identical feature integration', async (t) => {
	const root = fixture(t);
	createRecipe(root, {
		schemaVersion: 1,
		name: feature.name,
		profile: feature.archetype,
		fields: feature.fields,
		rules: [],
		filters: [],
		states: ['draft'],
		transitions: [],
		permissions: feature.permissions
	});
	write(root, `imports/modules/${feature.name}/custom/server/acceptance.test.ts`, acceptance);
	const integrated = { ...feature, integration: { label: 'Notes', identity: 'owner-active-account' } };
	const single = await planAutomation(root, request('feature', integrated));
	const composed = await planAutomation(root, request('project', { profile: 'owner-app', features: [integrated] }));
	assert.ok(single.requiresReview.includes('security'));
	assert.ok(composed.requiresReview.includes('security'));
	assert.deepEqual(composed.changes, single.changes);
	await assert.rejects(() => applyAutomation(root, composed), /review/);
});

test('master-detail integration preserves the trusted parent-aware custom page', async (t) => {
	const root = fixture(t),
		detail = { ...feature, name: 'journeyitems', archetype: 'master-detail' };
	await applyAutomation(root, await planAutomation(root, request('feature', detail)));
	const prefix = `imports/modules/${detail.name}`;
	write(root, `${prefix}/custom/server/acceptance.test.ts`, acceptance);
	write(root, `${prefix}/custom/server/ports.ts`, 'export const ports = reviewedParentAwarePorts();\n');
	const page =
		'// Trusted parent selection composition fixture.\nexport default function ParentPage() { return null; }\n';
	write(root, `${prefix}/custom/ui/Page.tsx`, page);
	const plan = await planAutomation(
		root,
		request('integrate', { schemaVersion: 1, module: detail.name, label: 'Items' })
	);
	await reviewedApply(root, plan);
	assert.match(read(root, 'imports/integration/routes.tsx'), /journeyitems\/custom\/ui\/Page/);
	assert.doesNotMatch(read(root, 'imports/integration/routes.tsx'), /journeyitems\/automation\/Page/);
	assert.equal(read(root, `${prefix}/custom/ui/Page.tsx`), page);
});

test('composed semantic rename sees protected Cypress consumers and fails closed', async (t) => {
	const root = fixture(t);
	write(root, 'imports/widget.ts', 'export const value = 1;\n');
	const consumer = "import { value } from '../imports/widget'; console.log(value);\n";
	write(root, '.cypress/consumer.ts', consumer);
	await assert.rejects(() =>
		planAutomation(
			root,
			request('codemod', { kind: 'rename-module', file: 'imports/widget.ts', to: 'imports/renamed.ts' })
		)
	);
	assert.equal(read(root, '.cypress/consumer.ts'), consumer);
	assert.equal(fs.existsSync(path.join(root, 'imports/renamed.ts')), false);
});

test('service journey requires reviewed private storage and connects generated services to the same recipe repository', async (t) => {
	const root = fixture(t);
	const spec = {
		...feature,
		filters: ['title'],
		services: {
			search: { fields: ['title'], pageSize: 25 },
			reports: { metrics: [{ name: 'count', op: 'count' }] },
			attachments: { maxBytes: 1024, mimeTypes: ['application/pdf'] }
		}
	};
	await applyAutomation(root, await planAutomation(root, request('feature', spec)));
	const prefix = `imports/modules/${feature.name}`;
	write(root, `${prefix}/custom/server/acceptance.test.ts`, acceptance);
	const integration = request('integrate', {
		schemaVersion: 1,
		module: feature.name,
		label: 'Notes',
		identity: 'owner-active-account'
	});
	await assert.rejects(
		() => planAutomation(root, integration),
		(error) => error.file?.endsWith('custom/server/servicePorts.ts')
	);
	assert.equal(fs.existsSync(path.join(root, prefix, 'custom/server/ports.ts')), false);
	const adapters = 'export const serviceAdapters = independentlyReviewedPrivateStorageAndQueryAdapters;\n';
	write(root, `${prefix}/custom/server/servicePorts.ts`, adapters);
	await reviewedApply(root, await planAutomation(root, integration));
	const registration = read(root, 'imports/integration/server/register.ts');
	assert.match(registration, /const servicePorts0=registerJourneynotes\(ports0\)/);
	assert.match(registration, /registerServices0\(servicePorts0, serviceAdapters0\)/);
	assert.match(read(root, `${prefix}/automation/Page.tsx`), /search=\{searchClient\}/);
	assert.match(read(root, `${prefix}/generated/services/client.ts`), /callMethod<unknown>/);
	assert.match(read(root, `${prefix}/generated/services/server/register.ts`), /registerMethods\(/);
	assert.equal(read(root, `${prefix}/custom/server/servicePorts.ts`), adapters);
	assert.equal(read(root, `${prefix}/custom/server/acceptance.test.ts`), acceptance);
});

test('recomputed manifest hashes cannot authorize a modified generated extension at integration', async (t) => {
	const root = fixture(t),
		prefix = `imports/modules/${feature.name}`;
	await applyAutomation(root, await planAutomation(root, request('feature', feature)));
	write(root, `${prefix}/custom/server/acceptance.test.ts`, acceptance);
	const changed = read(root, `${prefix}/automation/Page.tsx`) + '\n// Unreviewed generated mutation\n';
	write(root, `${prefix}/automation/Page.tsx`, changed);
	const manifest = JSON.parse(read(root, `${prefix}/module.automation.json`));
	manifest.files['automation/Page.tsx'] = createHash('sha256').update(changed).digest('hex');
	write(root, `${prefix}/module.automation.json`, JSON.stringify(manifest, null, 2) + '\n');
	await assert.rejects(
		() =>
			planAutomation(
				root,
				request('integrate', {
					schemaVersion: 1,
					module: feature.name,
					label: 'Notes',
					identity: 'owner-active-account'
				})
			),
		/deterministic generator/
	);
	assert.equal(read(root, `${prefix}/automation/Page.tsx`), changed);
	assert.equal(read(root, `${prefix}/custom/server/acceptance.test.ts`), acceptance);
});
