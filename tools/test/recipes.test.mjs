import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { createRecipe, renderDefinition, validateDefinition } from '../recipes.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const fixture = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-'));
	fs.mkdirSync(path.join(dir, 'imports/modules'), { recursive: true });
	return dir;
};
const spec = () => JSON.parse(fs.readFileSync(path.join(root, 'templates/recipes/owner.json'), 'utf8'));
test('recipe generated files are deterministic and rerun is idempotent', () => {
	const dir = fixture();
	try {
		const a = createRecipe(dir, spec());
		assert.equal(a.status, 'created');
		assert.equal(createRecipe(dir, spec()).status, 'unchanged');
		assert.deepEqual(renderDefinition(spec()), renderDefinition(spec()));
		assert.ok(fs.existsSync(path.join(dir, 'imports/modules/ownednotes/generated/server/register.ts')));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
test('recipe invalid spec makes zero changes and symlink escape rejected', () => {
	const dir = fixture();
	try {
		assert.throws(() => createRecipe(dir, { ...spec(), name: '../../escape' }));
		assert.deepEqual(fs.readdirSync(path.join(dir, 'imports/modules')), []);
		fs.symlinkSync(os.tmpdir(), path.join(dir, 'imports/modules/ownednotes'));
		assert.throws(() => createRecipe(dir, spec()));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
test('recipe custom code preserved and generated drift never overwritten', () => {
	const dir = fixture();
	try {
		createRecipe(dir, spec());
		const module = path.join(dir, 'imports/modules/ownednotes');
		fs.writeFileSync(path.join(module, 'custom/custom.ts'), 'export const custom = true;');
		assert.equal(createRecipe(dir, spec()).status, 'unchanged');
		fs.appendFileSync(path.join(module, 'generated/Page.tsx'), '// custom change');
		assert.throws(() => createRecipe(dir, spec()));
		assert.equal(fs.readFileSync(path.join(module, 'custom/custom.ts'), 'utf8'), 'export const custom = true;');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
test('all recipe profiles validate and generated source compiles', async () => {
	const dir = fixture();
	try {
		for (const filename of fs.readdirSync(path.join(root, 'templates/recipes')).filter((f) => f.endsWith('.json'))) {
			const d = validateDefinition(JSON.parse(fs.readFileSync(path.join(root, 'templates/recipes', filename), 'utf8')));
			for (const [file, contents] of Object.entries(renderDefinition(d))) {
				await build({
					stdin: { contents, loader: file.endsWith('.tsx') ? 'tsx' : 'ts', resolveDir: root },
					bundle: true,
					write: false,
					platform: 'node',
					packages: 'external',
					external: ['../../../*', '../../../../*']
				});
			}
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
test('recipe service negative/property tests pass outside Meteor', async () => {
	const dir = fixture();
	try {
		const outfile = path.join(dir, 'recipes.cjs');
		await build({
			entryPoints: [path.join(root, 'tests/recipes.node.test.ts')],
			outfile,
			bundle: true,
			platform: 'node',
			format: 'cjs'
		});
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', outfile], { encoding: 'utf8', env });
		assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
		assert.match(result.stdout, /tests 15/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
