import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderUI, validateUI } from '../automation/generators/ui.mjs';
import { renderTests, fixtureData } from '../automation/generators/tests.mjs';
import { renderDefinition } from '../recipes.mjs';
import { renderServices } from '../automation/generators/services.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const definition = () => JSON.parse(fs.readFileSync(path.join(root, 'templates/recipes/owner.json'), 'utf8'));
const ui = {
	layout: 'wizard',
	steps: [
		{ label: 'Identity', fields: ['title'] },
		{ label: 'Completion', fields: ['done'] }
	],
	bulk: 'delete',
	locales: ['en', 'pt-BR'],
	pageSize: 5
};
test('UI generator deterministically implements bounded controls and refuses unknown promises', () => {
	const d = definition(),
		a = renderUI({ definition: d, ui });
	assert.deepEqual(a, renderUI({ definition: d, ui }));
	const source = a[`imports/modules/${d.name}/generated/FeatureUI.tsx`];
	for (const text of [
		'DataGrid',
		'Dialog',
		'Stepper',
		'client.remove',
		'parseRecipeData(definition,next)',
		'scopeKey',
		'sequence.current',
		'aria-labelledby',
		'disableRowSelectionExcludeModel'
	])
		assert.ok(source.includes(text), text);
	assert.ok(!source.includes('Meteor.call'));
	assert.ok(!source.includes('localStorage'));
	for (const invalid of [
		{ layout: 'kanban' },
		{ pagination: 'cursor' },
		{ bulk: 'approve' },
		{ pageSize: 1000 },
		{ pageSize: null },
		{ layout: null },
		{ locales: ['fr'] },
		{
			layout: 'wizard',
			steps: [
				{ label: 'one', fields: ['title'] },
				{ label: 'two', fields: ['title'] }
			]
		},
		{ steps: [] }
	])
		assert.throws(() => renderUI({ definition: d, ui: invalid }));
	assert.throws(
		() =>
			validateUI(
				d,
				Object.defineProperty({}, 'layout', {
					enumerable: true,
					get() {
						throw new Error('getter invoked');
					}
				})
			),
		/unsupported key/
	);
});
test('generated tests reject unsupported paths and unsatisfiable fixtures', () => {
	const d = definition();
	for (const tests of [
		{ propertyCases: 0 },
		{ propertyCases: null },
		{ propertyCases: 101 },
		{ browserPath: 'https://example.com' },
		{ browserPath: '/../etc' },
		{ skipSecurity: true }
	])
		assert.throws(() => renderTests({ definition: d, tests }));
	assert.equal(fixtureData(d).title, 'fixture');
	assert.throws(() => renderUI({ definition: { ...d, name: '../../escape' } }));
	const outputs = renderTests({ definition: d });
	assert.ok(Object.keys(outputs).every((p) => !p.startsWith('tests/') && !p.includes('..')));
	assert.match(outputs[`imports/modules/${d.name}/automation/tests/mutation.mjs`], /tools\/run-mutation-tests.mjs/);
});
test('generated TSX and tests pass strict TypeScript and generated negative tests execute', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-ui-'));
	try {
		fs.mkdirSync(path.join(dir, 'imports'), { recursive: true });
		fs.symlinkSync(path.join(root, 'imports/core'), path.join(dir, 'imports/core'));
		fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
		if (fs.existsSync(path.join(dir, 'imports')))
			for (const name of ['app', 'api', 'automationServices'])
				fs.symlinkSync(path.join(root, 'imports', name), path.join(dir, 'imports', name));
		const d = definition(),
			base = `imports/modules/${d.name}/generated`;
		const files = {
			...renderUI({
				definition: d,
				ui: { ...ui, persistProgress: 'session' },
				services: { search: { fields: ['done'], pageSize: 25 } }
			}),
			...Object.fromEntries(
				Object.entries(
					renderServices({ definition: d, services: { search: { fields: ['done'], pageSize: 25 } } })
				).filter(([file]) => ['client.ts', 'contracts.ts', 'config.ts'].some((name) => file.endsWith('/' + name)))
			),
			...renderTests({ definition: d }),
			[`${base}/definition.ts`]: renderDefinition(d)['generated/definition.ts']
		};
		for (const [file, content] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
			fs.writeFileSync(path.join(dir, file), content);
		}
		const config = {
			compilerOptions: {
				target: 'ESNext',
				module: 'Preserve',
				moduleResolution: 'Bundler',
				strict: true,
				types: ['node', 'react', 'meteor'],
				paths: { '/imports/*': [path.join(root, 'imports/*')] },
				esModuleInterop: true,
				skipLibCheck: true,
				noEmit: true,
				jsx: 'react-jsx'
			},
			files: Object.keys(files).filter((file) => /\.tsx?$/.test(file))
		};
		fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(config));
		const check = spawnSync(
			process.execPath,
			[
				path.join(root, 'node_modules/typescript/bin/tsc'),
				'--project',
				path.join(dir, 'tsconfig.json'),
				'--pretty',
				'false'
			],
			{ encoding: 'utf8' }
		);
		assert.equal(check.status, 0, check.stdout + '\n' + check.stderr);
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		const run = spawnSync(process.execPath, [path.join(dir, `imports/modules/${d.name}/automation/tests/verify.mjs`)], {
			encoding: 'utf8',
			env
		});
		assert.equal(run.status, 0, run.stdout + '\n' + run.stderr);
		assert.match(run.stdout, /tests 3/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
test('complementary authorization suite executes for every canonical recipe profile', async () => {
	const { build } = await import('esbuild');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-profiles-'));
	try {
		fs.mkdirSync(path.join(dir, 'imports'), { recursive: true });
		fs.symlinkSync(path.join(root, 'imports/core'), path.join(dir, 'imports/core'));
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		for (const file of fs.readdirSync(path.join(root, 'templates/recipes')).filter((file) => file.endsWith('.json'))) {
			const d = JSON.parse(fs.readFileSync(path.join(root, 'templates/recipes', file), 'utf8'));
			const files = {
				...renderTests({ definition: d }),
				[`imports/modules/${d.name}/generated/definition.ts`]: renderDefinition(d)['generated/definition.ts']
			};
			for (const [relative, content] of Object.entries(files)) {
				const target = path.join(dir, relative);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, content);
			}
			const outfile = path.join(dir, d.name + '.cjs');
			await build({
				entryPoints: [path.join(dir, `imports/modules/${d.name}/generated/automation.node.test.ts`)],
				outfile,
				bundle: true,
				platform: 'node',
				format: 'cjs'
			});
			const result = spawnSync(process.execPath, ['--test', outfile], { env, encoding: 'utf8' });
			assert.equal(result.status, 0, file + '\n' + result.stdout + '\n' + result.stderr);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
test('visual comparator detects a changed pixel and never approves missing baselines', async () => {
	const { default: sharp } = await import('sharp');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-visual-'));
	try {
		fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
		const outputs = renderTests({ definition: definition() });
		const script = path.join(dir, 'visual.mjs');
		fs.writeFileSync(script, outputs['imports/modules/ownednotes/automation/tests/visual.mjs']);
		const a = path.join(dir, 'a.png'),
			b = path.join(dir, 'b.png');
		await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ffffff' } })
			.png()
			.toFile(a);
		await sharp({ create: { width: 2, height: 2, channels: 4, background: '#000000' } })
			.png()
			.toFile(b);
		assert.equal(spawnSync(process.execPath, [script, a, a]).status, 0);
		assert.notEqual(spawnSync(process.execPath, [script, a, b]).status, 0);
		assert.notEqual(spawnSync(process.execPath, [script, path.join(dir, 'missing.png'), a]).status, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
test('generated Cypress and command runners are syntactically executable JavaScript', async () => {
	const { transformSync } = await import('esbuild');
	for (const [file, source] of Object.entries(renderTests({ definition: definition() })))
		if (/\.(mjs|js)$/.test(file))
			assert.doesNotThrow(() => transformSync(source, { loader: 'js', format: 'esm' }), file);
});
test('generated cursor controller rejects stale replies and follows opaque cursor navigation', async () => {
	const { build } = await import('esbuild');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-state-'));
	try {
		fs.mkdirSync(path.join(dir, 'imports'), { recursive: true });
		fs.symlinkSync(path.join(root, 'imports/core'), path.join(dir, 'imports/core'));
		const d = definition(),
			base = `imports/modules/${d.name}/generated`,
			files = renderUI({ definition: d });
		for (const [file, source] of [
			[`${base}/ui.state.ts`, files[`${base}/ui.state.ts`]],
			[`${base}/definition.ts`, renderDefinition(d)['generated/definition.ts']]
		]) {
			fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
			fs.writeFileSync(path.join(dir, file), source);
		}
		const out = path.join(dir, 'state.cjs');
		await build({
			entryPoints: [path.join(dir, base, 'ui.state.ts')],
			outfile: out,
			bundle: true,
			platform: 'node',
			format: 'cjs'
		});
		const { createCursorPager, createDraftStore, clearDrafts } = await import(out);
		const requests = [],
			states = [];
		const pager = createCursorPager(
			(input) => new Promise((resolve, reject) => requests.push({ input, resolve, reject })),
			(state) => states.push(state)
		);
		const a = pager.request({ filters: { done: false }, limit: 5, order: 'asc' }),
			b = pager.request({ filters: { done: true }, limit: 10, order: 'desc' });
		requests[1].resolve({ items: [{ id: 'new' }], nextCursor: 'opaque-page-2' });
		await b;
		requests[0].resolve({ items: [{ id: 'stale' }], nextCursor: null });
		await a;
		assert.equal(states.at(-1).rows[0].id, 'new');
		const next = pager.next();
		assert.equal(requests[2].input.cursor, 'opaque-page-2');
		assert.equal(requests[2].input.order, 'desc');
		assert.equal(requests[2].input.limit, 10);
		requests[2].resolve({ items: [], nextCursor: null });
		await next;
		const previous = pager.previous();
		assert.equal(requests[3].input.cursor, null);
		requests[3].resolve({ items: [], nextCursor: 'again' });
		await previous;
		const denied = pager.request({ filters: {}, limit: 5, order: 'asc' });
		assert.equal(requests[4].input.cursor, null);
		requests[4].reject(new Error('revoked'));
		await denied;
		assert.deepEqual(states.at(-1).rows, []);
		assert.equal(states.at(-1).error, true);
		const late = pager.refresh();
		const count = states.length;
		pager.dispose();
		requests[5].resolve({ items: [{ id: 'private' }], nextCursor: null });
		await late;
		assert.equal(states.length, count);
		const values = new Map(),
			storage = {
				getItem: (key) => values.get(key) ?? null,
				setItem: (key, value) => values.set(key, value),
				removeItem: (key) => values.delete(key)
			};
		let now = 1000;
		const alice = createDraftStore(storage, 'alice', 'new', 2, 'schema-v1', () => now);
		assert.equal(alice.save(1, { title: 'private', done: true }), true);
		assert.deepEqual(createDraftStore(storage, 'alice', 'new', 2, 'schema-v1', () => now).read(), {
			step: 1,
			data: { title: 'private', done: true }
		});
		assert.equal(createDraftStore(storage, 'bob', 'new', 2, 'schema-v1', () => now).read(), null);
		assert.equal(alice.read(), null, 'switching identity purged prior private draft');
		alice.save(1, { title: 'again' });
		now += 1800001;
		assert.equal(alice.read(), null, 'TTL expires');
		now = 1000;
		alice.save(0, { title: 'again' });
		assert.equal(
			createDraftStore(storage, 'alice', 'new', 2, 'schema-v2', () => now).read(),
			null,
			'schema change expires draft'
		);
		assert.equal(alice.save(5, { title: 'invalid step' }), false);
		assert.equal(alice.save(0, { ownerId: 'forged' }), false);
		assert.equal(alice.save(0, { title: 'x'.repeat(2001) }), false);
		alice.save(0, { title: 'revoke' });
		clearDrafts(storage);
		assert.equal(alice.read(), null, 'revocation/logout cleanup');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
test('session drafts reject non-owner profiles without a trusted tenant scope', () => {
	for (const profile of ['team', 'approval', 'master-detail'])
		assert.throws(
			() => renderUI({ definition: { ...definition(), profile }, ui: { ...ui, persistProgress: 'session' } }),
			/owner profile/
		);
	assert.doesNotThrow(() =>
		renderUI({ definition: definition(), ui: { ...ui, persistProgress: 'session', reactive: true } })
	);
	const source = renderUI({ definition: definition(), ui: { ...ui, persistProgress: 'session', reactive: true } })[
		'imports/modules/ownednotes/generated/FeatureUI.tsx'
	];
	// Extract the actual generated subscription invalidation handler and execute its privacy cleanup.
	const match = source.match(/client\.subscribe\(\{\},100,parentId,state=>\{([\s\S]*?)\}\);\s*return\(\)=>/);
	assert.ok(match);
	const handler = match[1],
		effects = [];
	const callback = new Function(
		'state',
		'live',
		'token',
		'sequence',
		't',
		'setRows',
		'setLoading',
		'setError',
		'setEditing',
		'setDetail',
		'setRevision',
		'creation',
		'setSelected',
		'clearDrafts',
		'browserDraftStorage',
		handler
	);
	for (const state of [
		{ rows: [], loading: true, error: null },
		{ rows: [], loading: false, error: new Error('revoked') }
	]) {
		const creation = { current: { id: 'pending' } };
		let cleared = false;
		callback(
			state,
			{ current: true },
			1,
			{ current: 1 },
			{ conflict: 'denied' },
			(v) => effects.push(['rows', v]),
			() => {},
			() => {},
			(v) => effects.push(['editing', v]),
			(v) => effects.push(['detail', v]),
			() => {},
			creation,
			() => {},
			() => {
				cleared = true;
			},
			() => ({})
		);
		assert.equal(cleared, true);
		assert.equal(creation.current, null);
		assert.deepEqual(effects.at(-2), ['editing', null]);
		assert.deepEqual(effects.at(-1), ['detail', null]);
	}
});
