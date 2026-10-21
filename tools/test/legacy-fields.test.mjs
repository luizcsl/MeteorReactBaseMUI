import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectLegacyFields } from '../legacy-fields.mjs';
import { architectureContext } from '../architecture.mjs';
const root = path.resolve(import.meta.dirname, '../..');
function fixture(t) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-fields-inspection-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const paths = [
		'imports/modules/example/architecture.manifest.json',
		'imports/modules/example/api/exampleValues.ts',
		'imports/legacy/exposure.ts',
		'imports/legacy/allowedValues.ts',
		...architectureContext(root, ['imports/modules/example/api/exampleSch.ts'])[0].legacyReferences.map((r) => r.file)
	];
	for (const file of new Set(paths)) {
		fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
		fs.copyFileSync(path.join(root, file), path.join(directory, file));
	}
	return directory;
}
function change(directory, file, before, after) {
	const target = path.join(directory, file),
		source = fs.readFileSync(target, 'utf8');
	assert.ok(source.includes(before), before);
	fs.writeFileSync(target, source.replace(before, after));
}
test('legacy inspection links actual source consumers and hashes tests without claiming runtime acceptance', () => {
	const result = inspectLegacyFields(root, 'example');
	assert.equal(result.status, 'passed');
	assert.equal(result.qualified, false);
	assert.deepEqual(result.domain.find((f) => f.field === 'type').allowedValues, [
		'Categoria A',
		'Categoria B',
		'Categoria C'
	]);
	assert.ok(result.sources['imports/modules/example/tests/server/fields.test.ts']);
	const context = architectureContext(root, ['imports/modules/example/api/exampleSch.ts'])[0];
	assert.ok(
		context.legacyReferences.some(
			(r) => r.symbol === 'ServerApiBase._checkDataBySchema' && /^[a-f0-9]{64}$/.test(r.hash)
		)
	);
});
for (const [name, file, before, after, rule] of [
	[
		'projection',
		'api/exampleServerApi.ts',
		'projection: exampleListProjection',
		'projection: { title: 1 }',
		'legacy-projection'
	],
	[
		'reduced schema',
		'pages/exampleList/exampleListController.tsx',
		'const exampleSchReduzido = exampleListSchema',
		'const exampleSchReduzido = { title: { type: String } }',
		'legacy-reduced-schema'
	],
	[
		'new field without exposure decision',
		'api/exampleSch.ts',
		'image: {',
		'newField: { type: String, optional: true }, image: {',
		'legacy-exposure'
	],
	['unconstrained UI options', 'api/exampleSch.ts', 'allowedValues: EXAMPLE_CATEGORIES,', '', 'legacy-values'],
	['form', 'pages/exampleDetail/exampleDetailView.tsx', 'name="type"', 'name="title"', 'legacy-form'],
	[
		'controller subscription',
		'pages/exampleDetail/exampleDetailContoller.tsx',
		"subscribe('exampleDetail'",
		"subscribe('wrongDetail'",
		'legacy-controller'
	]
])
	test(`legacy inspection detects drift in ${name}`, (t) => {
		const directory = fixture(t);
		change(directory, 'imports/modules/example/' + file, before, after);
		const result = inspectLegacyFields(directory, 'example');
		assert.equal(result.status, 'failed');
		assert.ok(
			result.diagnostics.some((d) => d.rule === rule),
			JSON.stringify(result.diagnostics)
		);
	});
test('removing validator enforcement is a diagnostic even if its name remains in a comment', (t) => {
	const directory = fixture(t);
	const file = 'imports/api/serverBase.ts';
	const text = fs.readFileSync(path.join(directory, file), 'utf8');
	change(
		directory,
		file,
		'assertAllowedValues(schema, _docObj as Record<string, unknown>, fieldsNamesIgnoreCheck);',
		'/* assertAllowedValues(schema, _docObj as Record<string, unknown>, fieldsNamesIgnoreCheck); */'
	);
	const result = inspectLegacyFields(directory, 'example');
	assert.ok(result.diagnostics.some((d) => d.rule === 'legacy-validator'));
});
test('unconfigured legacy modules explicitly require review instead of passing exposure checks', () => {
	for (const module of ['aniversario', 'userprofile']) {
		const result = inspectLegacyFields(root, module);
		assert.equal(result.status, 'needs-review');
		assert.equal(result.qualified, false);
	}
});
test('legacy metadata refuses traversal and symlinked references before reading them', (t) => {
	const directory = fixture(t),
		file = 'imports/modules/example/architecture.manifest.json',
		target = path.join(directory, file),
		manifest = JSON.parse(fs.readFileSync(target));
	manifest.legacy.validator.file = '../outside.ts';
	fs.writeFileSync(target, JSON.stringify(manifest));
	assert.throws(() => inspectLegacyFields(directory, 'example'), { rule: 'path' });
	manifest.legacy.validator.file = 'imports/api/serverBase.ts';
	fs.writeFileSync(target, JSON.stringify(manifest));
	fs.unlinkSync(path.join(directory, manifest.legacy.validator.file));
	fs.symlinkSync(path.join(root, manifest.legacy.validator.file), path.join(directory, manifest.legacy.validator.file));
	assert.throws(() => inspectLegacyFields(directory, 'example'), { rule: 'symlink' });
});

test('legacy metadata requires both list and detail publication paths', (t) => {
	const directory = fixture(t),
		target = path.join(directory, 'imports/modules/example/architecture.manifest.json'),
		manifest = JSON.parse(fs.readFileSync(target));
	manifest.legacy.publications.pop();
	fs.writeFileSync(target, JSON.stringify(manifest));
	assert.throws(() => inspectLegacyFields(directory, 'example'), { rule: 'legacy-manifest' });
});
