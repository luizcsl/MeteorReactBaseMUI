import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRecipe } from '../recipes.mjs';
import { planIntegration, applyIntegration, renderIntegration } from '../integrate.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const spec = { schemaVersion: 1, module: 'ownednotes', label: 'Notes' };
function fixture(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrate-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.mkdirSync(path.join(dir, 'imports/modules'), { recursive: true });
	for (const [file, content] of Object.entries(renderIntegration(dir, [])))
		write(dir, 'imports/integration/' + file, content);
	createRecipe(dir, JSON.parse(fs.readFileSync(path.join(root, 'templates/recipes/owner.json'))));
	write(
		dir,
		'imports/modules/ownednotes/custom/server/ports.ts',
		'export const ports={resolveIdentity:async(userId:string)=>({userId,roles:[]})};'
	);
	write(
		dir,
		'imports/modules/ownednotes/custom/server/acceptance.test.ts',
		"describe('independent acceptance',()=>{it('has product criteria',()=>{});});"
	);
	return dir;
}
function write(root, file, content) {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), content);
}
test('integration plans server, authenticated route, navigation and tests without writing; apply is idempotent and never qualifies', (t) => {
	const dir = fixture(t),
		before = fs.readFileSync(path.join(dir, 'imports/integration/registry.json'), 'utf8');
	const plan = planIntegration(dir, spec);
	assert.equal(fs.readFileSync(path.join(dir, 'imports/integration/registry.json'), 'utf8'), before);
	assert.equal(plan.changes.length, 4);
	assert.ok(plan.changes.every((c) => c.diff.includes('+++')));
	assert.equal(applyIntegration(dir, plan).qualified, false);
	assert.match(fs.readFileSync(path.join(dir, 'imports/integration/routes.tsx'), 'utf8'), /authenticatedOnly:true/);
	assert.match(
		fs.readFileSync(path.join(dir, 'imports/integration/server/register.ts'), 'utf8'),
		/registerOwnednotes\(ports0\)/
	);
	assert.match(fs.readFileSync(path.join(dir, 'imports/integration/server/tests.ts'), 'utf8'), /acceptance.test/);
	assert.equal(applyIntegration(dir, planIntegration(dir, spec)).status, 'unchanged');
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(dir, 'imports/modules/ownednotes/module.manifest.json'))).qualified,
		false
	);
});
test('stale, tampered, drifted and symlink plans fail closed', (t) => {
	const dir = fixture(t),
		plan = planIntegration(dir, spec);
	assert.throws(() => applyIntegration(dir, { ...plan, qualified: true }), /stale or modified/);
	fs.appendFileSync(path.join(dir, 'imports/modules/ownednotes/custom/server/ports.ts'), '// changed');
	assert.throws(() => applyIntegration(dir, plan), /stale or modified/);
	fs.appendFileSync(path.join(dir, 'imports/modules/ownednotes/generated/Page.tsx'), '// manual');
	assert.throws(() => planIntegration(dir, spec), /Generated drift/);
	const other = fixture(t);
	fs.rmSync(path.join(other, 'imports/modules/ownednotes/custom/server/ports.ts'));
	fs.symlinkSync('/tmp', path.join(other, 'imports/modules/ownednotes/custom/server/ports.ts'));
	assert.throws(() => planIntegration(other, spec), /Symbolic links/);
});
test('integration rejects missing business ports/tests, route collisions and invalid specifications', (t) => {
	const dir = fixture(t);
	for (const change of [{ module: '../bad' }, { label: '' }, { unknown: true }])
		assert.throws(() => planIntegration(dir, { ...spec, ...change }));
	write(dir, 'imports/modules/index.ts', "export const routes=[{path:'/modules/:name',component:null}];");
	assert.throws(() => planIntegration(dir, spec), /Route collision/);
	fs.rmSync(path.join(dir, 'imports/modules/index.ts'));
	fs.rmSync(path.join(dir, 'imports/modules/ownednotes/custom/server/acceptance.test.ts'));
	assert.throws(() => planIntegration(dir, spec), /File does not exist/);
});
test('integration lock and directory replacement rollback preserve original bytes', (t) => {
	const dir = fixture(t),
		plan = planIntegration(dir, spec),
		before = fs.readFileSync(path.join(dir, 'imports/integration/registry.json'), 'utf8');
	write(dir, 'imports/.integration.lock', 'busy');
	assert.throws(() => applyIntegration(dir, plan), /locked/);
	fs.rmSync(path.join(dir, 'imports/.integration.lock'));
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => {
		if (from.includes('.integration-stage-') && !from.endsWith('.backup')) throw new Error('injected rename failure');
		return rename(from, to);
	};
	try {
		assert.throws(() => applyIntegration(dir, plan), /injected/);
	} finally {
		fs.renameSync = rename;
	}
	assert.equal(fs.readFileSync(path.join(dir, 'imports/integration/registry.json'), 'utf8'), before);
});
test('owner integration verifies canonical bytes and supports a reviewed custom context', (t) => {
	const dir = fixture(t);
	fs.cpSync(path.join(root, 'templates'), path.join(dir, 'templates'), { recursive: true });
	// Create the owner scaffold with its current pinned template rather than a forged manifest.
	return import('../scaffold.mjs').then(({ scaffold }) => {
		scaffold(dir, { schemaVersion: 1, templateVersion: '1.0.0', profile: 'owner-crud', name: 'notes' });
		write(
			dir,
			'imports/modules/notes/custom/server/ports.ts',
			'export const context=async()=>({userId:"fixture",requestId:"test"});'
		);
		write(dir, 'imports/modules/notes/custom/server/acceptance.test.ts', 'export {};');
		const input = { schemaVersion: 1, module: 'notes', label: 'Notes' };
		const plan = planIntegration(dir, input);
		assert.ok(plan.changes.some((change) => change.content.includes('registerNotes(ports')));
		const file = path.join(dir, 'imports/modules/notes/server/register.ts');
		fs.appendFileSync(file, '// drift');
		const manifestFile = path.join(dir, 'imports/modules/notes/module.manifest.json'),
			manifest = JSON.parse(fs.readFileSync(manifestFile));
		return import('../lib.mjs').then(({ hash }) => {
			manifest.files['server/register.ts'] = hash(fs.readFileSync(file));
			fs.writeFileSync(manifestFile, JSON.stringify(manifest));
			assert.throws(() => planIntegration(dir, input), /Generated drift/);
		});
	});
});
test('master/detail integration requires a reviewed parent selection page', (t) => {
	const dir = fixture(t);
	createRecipe(dir, JSON.parse(fs.readFileSync(path.join(root, 'templates/recipes/master-detail.json'))));
	const definition = JSON.parse(fs.readFileSync(path.join(root, 'templates/recipes/master-detail.json')));
	const name = definition.name;
	write(dir, `imports/modules/${name}/custom/server/ports.ts`, 'export const ports={};');
	write(dir, `imports/modules/${name}/custom/server/acceptance.test.ts`, 'export {};');
	const input = { schemaVersion: 1, module: name, label: 'Items' };
	assert.throws(() => planIntegration(dir, input), /File does not exist/);
	write(dir, `imports/modules/${name}/custom/ui/Page.tsx`, 'export default function Page(){return null;}');
	const plan = planIntegration(dir, input);
	assert.ok(plan.changes.some((change) => change.content.includes(`/modules/${name}/custom/ui/Page`)));
});

test('route inspection allows disjoint wildcard namespaces and rejects computed or oversized metadata', (t) => {
	const dir = fixture(t);
	write(dir, 'imports/modules/index.ts', "export const routes=[{path:'/example/*',component:null}];");
	assert.ok(planIntegration(dir, spec).changes.length);
	write(dir, 'imports/modules/index.ts', "const path='/modules/ownednotes';export const routes=[{path}];");
	assert.throws(() => planIntegration(dir, spec), /Computed route metadata/);
	write(dir, 'imports/modules/index.ts', "export const routes=[{['path']:'/modules/ownednotes'}];");
	assert.throws(() => planIntegration(dir, spec), /Computed route metadata/);
	write(dir, 'imports/modules/index.ts', 'export const routes=[];');
	write(dir, 'imports/integration/registry.json', ' '.repeat(1024 * 1024 + 1));
	assert.throws(() => planIntegration(dir, spec), /Metadata exceeds/);
});
