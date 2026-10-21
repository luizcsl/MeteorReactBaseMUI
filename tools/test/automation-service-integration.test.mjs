import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { build } from 'esbuild';
import { createRecipe } from '../recipes.mjs';
import { validateFeature } from '../automation/contracts/validate.mjs';
import { renderExtensions } from '../automation/generators/feature.mjs';
import { renderIntegration, planIntegration, applyIntegration } from '../integrate.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const input = {
	schemaVersion: 3,
	intent: 'create-feature',
	name: 'serviceinvoices',
	archetype: 'owner',
	fields: [{ name: 'title', label: 'Title', type: 'string', required: true, maxLength: 160 }],
	permissions: { read: ['owner'], write: ['owner'] },
	services: {
		csv: { fields: ['title'], maxRows: 10 },
		reports: { metrics: [{ name: 'count', op: 'count' }] },
		audit: { events: ['updated'], retentionDays: 30 }
	}
};
const write = (root, file, source) => {
	const target = path.join(root, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, source);
};
test('feature generation plus reviewed ports/acceptance integrates one recipe repository with typed service server/client bridge', async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-integration-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.mkdirSync(path.join(dir, 'imports/modules'), { recursive: true });
	for (const [name, source] of Object.entries(renderIntegration(dir, [])))
		write(dir, 'imports/integration/' + name, source);
	const feature = validateFeature(input);
	createRecipe(dir, feature.definition);
	for (const [name, source] of Object.entries(renderExtensions(feature.definition, input, dir)))
		write(dir, name, source);
	const prefix = 'imports/modules/serviceinvoices';
	write(
		dir,
		prefix + '/custom/server/ports.ts',
		"import type {RecipePorts} from '../../../../core/recipes/server/engine'; export const ports: Omit<RecipePorts,'repository'>={resolveIdentity:async(userId)=>({userId,roles:[]})};"
	);
	write(
		dir,
		prefix + '/custom/server/acceptance.test.ts',
		"import assert from 'node:assert/strict'; import { serviceContracts } from '../../generated/services/contracts'; describe('independent identity criteria',()=>{it('rejects forged ownership',()=>assert.throws(()=>serviceContracts.report.input.parse({filters:{},ownerId:'attacker'})));});"
	);
	const spec = { schemaVersion: 1, module: 'serviceinvoices', label: 'Invoices' };
	assert.throws(() => planIntegration(dir, spec), /servicePorts|File does not exist/);
	write(
		dir,
		prefix + '/custom/server/servicePorts.ts',
		"import type {ServiceAdapters} from '../../generated/services/server/register'; export const serviceAdapters: ServiceAdapters={audit:{append:async()=>{},list:async()=>[]}};"
	);
	const plan = planIntegration(dir, spec);
	assert.equal(plan.changes.length, 4);
	applyIntegration(dir, plan);
	const metadata = JSON.parse(fs.readFileSync(path.join(dir, prefix + '/generated/services/registration.json')));
	assert.deepEqual(metadata.requiredAdapters, ['audit']);
	assert.deepEqual(metadata.optionalAdapters, ['query']);
	const bridge = fs.readFileSync(path.join(dir, 'imports/integration/server/register.ts'), 'utf8');
	assert.match(bridge, /const servicePorts0=registerServiceinvoices\(ports0\)/);
	assert.match(bridge, /registerServices0\(servicePorts0, serviceAdapters0\)/);
	const testBridge = fs.readFileSync(path.join(dir, 'imports/integration/server/tests.ts'), 'utf8');
	assert.match(testBridge, /custom\/server\/acceptance.test/);
	for (const name of ['core', 'automationServices', 'api'])
		fs.symlinkSync(path.join(root, 'imports', name), path.join(dir, 'imports', name), 'dir');
	fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
	const roots = [
		'imports/integration/server/register.ts',
		'imports/integration/server/tests.ts',
		prefix + '/generated/services/client.ts',
		prefix + '/generated/services/ConnectedReportDashboard.tsx'
	];
	const options = {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.Preserve,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		esModuleInterop: true,
		skipLibCheck: true,
		noEmit: true,
		jsx: ts.JsxEmit.ReactJSX,
		typeRoots: [path.join(root, 'node_modules/@types')],
		types: ['node', 'meteor', 'mocha']
	};
	const program = ts.createProgram(
		roots.map((name) => path.join(dir, name)),
		options
	);
	const diagnostics = ts.getPreEmitDiagnostics(program);
	assert.equal(
		diagnostics.length,
		0,
		ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCurrentDirectory: () => root,
			getCanonicalFileName: (x) => x,
			getNewLine: () => '\n'
		})
	);
	const methods = {},
		rows = new Map(),
		collectionNames = [];
	let actor = 'alice';
	class MeteorError extends Error {
		constructor(error, reason) {
			super(reason);
			this.error = error;
		}
	}
	const Meteor = {
		isServer: true,
		Error: MeteorError,
		methods: (input) => Object.assign(methods, input),
		status: () => ({ connected: true }),
		call(name, input, callback) {
			Promise.resolve()
				.then(() => methods[name].call({ userId: actor }, input))
				.then(
					(value) => callback(undefined, value),
					(error) => callback(error)
				);
		}
	};
	const matches = (row, selector) =>
		Object.entries(selector).every(([key, value]) =>
			key === 'tenantId' && value?.$exists === false ? row.tenantId === undefined : row[key] === value
		);
	class Collection {
		constructor(name) {
			collectionNames.push(name);
		}
		async insertAsync(row) {
			if (rows.has(row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
			rows.set(row._id, row);
		}
		async findOneAsync(selector) {
			return typeof selector === 'string'
				? rows.get(selector)
				: [...rows.values()].find((row) => matches(row, selector));
		}
		rawCollection() {
			return {
				aggregate: (pipeline) => ({
					toArray: async () => [
						{
							count: [...rows.values()].filter((row) => row.ownerId === pipeline[0].$match.ownerId && !row.deleted)
								.length
						}
					]
				})
			};
		}
		find(selector, options) {
			return {
				fetchAsync: async () => [...rows.values()].filter((row) => matches(row, selector)).slice(0, options.limit)
			};
		}
	}
	const require = createRequire(path.join(root, 'package.json'));
	async function evaluate(file) {
		const out = await build({
			entryPoints: [path.join(dir, file)],
			bundle: true,
			platform: 'node',
			format: 'cjs',
			external: ['meteor/*'],
			write: false
		});
		const module = { exports: {} };
		new Function('require', 'module', 'exports', out.outputFiles[0].text)(
			(name) =>
				name === 'meteor/meteor'
					? { Meteor }
					: name === 'meteor/mongo'
						? { Mongo: { Collection } }
						: name === 'meteor/ddp-rate-limiter'
							? { DDPRateLimiter: { addRule: () => {} } }
							: require(name),
			module,
			module.exports
		);
		return module.exports;
	}
	(await evaluate('imports/integration/server/register.ts')).registerIntegratedModules();
	assert.deepEqual(collectionNames, ['recipe_serviceinvoices']);
	const client = (await evaluate(prefix + '/generated/services/client.ts')).createServiceClient();
	assert.equal((await client.importCsv({ text: 'title\nShared repository', mutationPrefix: 'batch' })).completed, 1);
	const records = await methods['serviceinvoices.list'].call({ userId: 'alice' }, { filters: {}, limit: 10 });
	assert.equal(records.length, 1);
	assert.equal(records[0].data.title, 'Shared repository');
	assert.match(await client.exportCsv({ filters: {} }), /Shared repository/);
	assert.deepEqual(await client.report({ filters: {} }), { count: 1 });
	actor = 'bob';
	assert.doesNotMatch(await client.exportCsv({ filters: {} }), /Shared repository/);
	assert.deepEqual(await client.report({ filters: {} }), { count: 0 });
	actor = null;
	await assert.rejects(client.report({ filters: {} }), (error) => error.error === 'unauthenticated');
});
