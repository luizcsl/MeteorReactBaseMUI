import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planCodemod } from '../automation/codemods/index.mjs';

function fixture(t, sources) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-codemods-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	for (const [file, source] of Object.entries(sources)) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), source);
	}
	return root;
}
function clean(result) {
	assert.deepEqual(
		result.diagnostics.filter((d) => d.severity === 'error'),
		[]
	);
	assert.equal(result.requiresReview, true);
	return result;
}
function output(result, file) {
	return result.changes.find((change) => change.path === file)?.after;
}
const model = 'export interface Invoice { title: string; }\n';

test('field rename follows symbol references across files, not unrelated fields or strings; plan is read-only', (t) => {
	const root = fixture(t, {
		'model.ts': model,
		'use.ts':
			'import { Invoice } from "./model";\nconst invoice: Invoice = { title: "title" };\nconsole.log(invoice.title);\nconst other = { title: "untouched" }; console.log(other.title);\n'
	});
	const result = clean(
		planCodemod(root, { kind: 'rename-field', file: 'model.ts', symbol: 'title', newName: 'caption' })
	);
	assert.match(output(result, 'model.ts'), /caption: string/);
	assert.match(output(result, 'use.ts'), /invoice.caption/);
	assert.match(output(result, 'use.ts'), /caption: "title"/);
	assert.match(output(result, 'use.ts'), /other.title/);
	assert.equal(result.migrations[0].executesDataChanges, false);
	assert.equal(fs.readFileSync(path.join(root, 'model.ts'), 'utf8'), model);
	assert.deepEqual(
		planCodemod(root, { kind: 'rename-field', file: 'model.ts', symbol: 'title', newName: 'caption' }),
		result
	);
});
test('field rename fails closed on collisions, ambiguity, invalid identifiers and unknown keys', (t) => {
	const root = fixture(t, {
		'model.ts': 'interface A { title: string; caption: string; }\ninterface B { title: string; }'
	});
	for (const extra of [{ newName: 'caption' }, { newName: 'bad-name' }, { newName: 'newTitle', untrusted: true }]) {
		const result = planCodemod(root, { kind: 'rename-field', file: 'model.ts', symbol: 'title', ...extra });
		assert.equal(result.changes.length, 0);
		assert.ok(result.diagnostics.some((d) => d.severity === 'error'));
	}
	const result = planCodemod(root, {
		kind: 'rename-field',
		file: 'model.ts',
		symbol: 'title',
		newName: 'caption',
		position: 15
	});
	assert.equal(result.diagnostics.at(-1).code, 'name-collision');
});
test('field type/required change emits explicit pending backfill plan, never data execution', (t) => {
	const root = fixture(t, { 'model.ts': 'export interface Invoice { count?: string; }' });
	const result = clean(
		planCodemod(root, { kind: 'change-field', file: 'model.ts', symbol: 'count', type: 'number', required: true })
	);
	assert.match(output(result, 'model.ts'), /count: number/);
	assert.equal(result.migrations[0].conversion, 'must-be-explicitly-designed');
	assert.equal(result.migrations[0].status, 'planned-not-executed');
});
test('source module rename updates semantic imports and deletes old source in plan', (t) => {
	const root = fixture(t, {
		'model.ts': model,
		'use.ts': 'import { Invoice } from "./model"; export type Result = Invoice;'
	});
	const result = clean(planCodemod(root, { kind: 'rename-module', file: 'model.ts', to: 'contracts/invoice.ts' }));
	assert.equal(output(result, 'model.ts'), null);
	assert.equal(output(result, 'contracts/invoice.ts'), model);
	assert.match(output(result, 'use.ts'), /\.\/contracts\/invoice/);
});
test('route rename transforms recognized AST properties without arbitrary strings', (t) => {
	const root = fixture(t, {
		'routes.tsx': 'const route = { path: "/old", label: "/old" }; const link = <a href="/old">old</a>;'
	});
	const result = clean(planCodemod(root, { kind: 'rename-route', file: 'routes.tsx', from: '/old', to: '/new' }));
	assert.match(output(result, 'routes.tsx'), /path: "\/new"/);
	assert.match(output(result, 'routes.tsx'), /href="\/new"/);
	assert.match(output(result, 'routes.tsx'), /label: "\/old"/);
});
test('compiler moves declaration and updates import consumers', (t) => {
	const root = fixture(t, {
		'math.ts': 'export function double(value: number): number { return value * 2; }\nexport const untouched = 1;\n',
		'use.ts': 'import { double, untouched } from "./math"; export const value = double(untouched);'
	});
	const result = clean(planCodemod(root, { kind: 'move-symbol', file: 'math.ts', symbol: 'double', to: 'double.ts' }));
	assert.match(output(result, 'double.ts'), /function double/);
	assert.doesNotMatch(output(result, 'math.ts'), /function double/);
	assert.match(output(result, 'use.ts'), /from ["']\.\/double["']/);
});
test('progressive legacy modernization extracts a contract, explicitly retains runtime migration gaps', (t) => {
	const root = fixture(t, {
		'legacy.ts': 'export interface LegacyDto { title: string; }\nexport const marker = 1;',
		'use.ts': 'import { LegacyDto } from "./legacy"; export type View = LegacyDto;'
	});
	const result = clean(
		planCodemod(root, {
			kind: 'modernize-legacy',
			file: 'legacy.ts',
			symbol: 'LegacyDto',
			to: 'contracts/dto.ts',
			recipe: 'extract-public-contract'
		})
	);
	assert.match(output(result, 'contracts/dto.ts'), /interface LegacyDto/);
	assert.ok(result.diagnostics.some((d) => d.code === 'legacy-behavior-unmigrated'));
	const denied = planCodemod(root, {
		kind: 'modernize-legacy',
		file: 'legacy.ts',
		symbol: 'LegacyDto',
		to: 'contracts/dto.ts',
		recipe: 'rewrite-productbase'
	});
	assert.equal(denied.changes.length, 0);
});
test('approved Meteor async recipe follows imported binding and preserves awaited expression grouping', (t) => {
	const root = fixture(t, {
		'meteor.d.ts':
			'declare module "meteor/meteor" { export const Meteor: { user(): { name: string } | null; userAsync(): Promise<{ name: string } | null> }; }',
		'server.ts':
			'import { Meteor as M } from "meteor/meteor"; export async function lookup() { return M.user()?.name; }\nfunction unrelated() { const M = { user: () => 1 }; return M.user(); }'
	});
	const result = clean(
		planCodemod(root, { kind: 'migrate-framework', file: 'server.ts', recipe: 'meteor-user-async' })
	);
	assert.match(output(result, 'server.ts'), /\(await M.userAsync\(\)\)\?\.name/);
	assert.match(output(result, 'server.ts'), /return M.user\(\);/);
});
test('framework migration refuses to implicitly make synchronous callers async', (t) => {
	const root = fixture(t, {
		'server.ts': 'import { Meteor } from "meteor/meteor"; export function lookup() { return Meteor.user(); }'
	});
	const result = planCodemod(root, { kind: 'migrate-framework', file: 'server.ts', recipe: 'meteor-user-async' });
	assert.equal(result.changes.length, 0);
	assert.equal(result.diagnostics.at(-1).code, 'async-context');
});
test('deprecate reports references; removal rejects live or exported symbols', (t) => {
	const root = fixture(t, {
		'lib.ts': 'export function used() { return 1; }\nfunction unused() { return 2; }\n',
		'use.ts': 'import { used } from "./lib"; used();'
	});
	const deprecated = clean(planCodemod(root, { kind: 'deprecate-symbol', file: 'lib.ts', symbol: 'used' }));
	assert.match(output(deprecated, 'lib.ts'), /@deprecated/);
	assert.ok(deprecated.diagnostics[0].references.length);
	assert.equal(planCodemod(root, { kind: 'remove-symbol', file: 'lib.ts', symbol: 'used' }).changes.length, 0);
	const removed = clean(planCodemod(root, { kind: 'remove-symbol', file: 'lib.ts', symbol: 'unused' }));
	assert.doesNotMatch(output(removed, 'lib.ts'), /function unused/);
});
test('unknown operations, syntax errors, traversal and existing targets are rejected without partial edits', (t) => {
	const root = fixture(t, { 'broken.ts': 'export interface Broken {', 'ok.ts': model });
	for (const operation of [
		{ kind: 'shell', file: 'ok.ts' },
		{ kind: 'rename-field', file: 'broken.ts', symbol: 'title', newName: 'caption' },
		{ kind: 'rename-module', file: 'ok.ts', to: '../escape.ts' },
		{ kind: 'rename-module', file: 'ok.ts', to: 'broken.ts' }
	]) {
		const result = planCodemod(root, operation);
		assert.equal(result.changes.length, 0);
		assert.ok(result.diagnostics.some((d) => d.severity === 'error'));
	}
});

test('missing rename target and script-global runtime removal fail closed', (t) => {
	const root = fixture(t, { 'model.ts': model, 'global.ts': 'function globallyReachable() { return 42; }' });
	const rename = planCodemod(root, { kind: 'rename-field', file: 'model.ts', symbol: 'title' });
	assert.equal(rename.changes.length, 0);
	assert.equal(rename.diagnostics.at(-1).code, 'field-name');
	const remove = planCodemod(root, { kind: 'remove-symbol', file: 'global.ts', symbol: 'globallyReachable' });
	assert.equal(remove.changes.length, 0);
	assert.equal(remove.diagnostics.at(-1).code, 'global-symbol');
});
test('framework recipe refuses partial edits if one call has unsafe context', (t) => {
	const root = fixture(t, {
		'server.ts':
			'import { Meteor } from "meteor/meteor"; async function good() { return Meteor.user(); } function bad() { return Meteor.user(); }'
	});
	const result = planCodemod(root, { kind: 'migrate-framework', file: 'server.ts', recipe: 'meteor-user-async' });
	assert.deepEqual(result.changes, []);
	assert.deepEqual(result.migrations, []);
});

function legacyFixture(t, { write = false, optional = false, override = false } = {}) {
	const sources = {};
	for (const file of [
		'imports/core/server/operations.ts',
		'imports/core/contracts/schema.ts',
		'imports/core/contracts/errors.ts'
	])
		sources[file] = fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
	sources['imports/api/serverBase.ts'] = `export interface LegacyContext { userId: string | null; validate(): void; }
export class ServerApiBase {
  businessCalls = 0; validatorCalls = 0;
  handlers: Record<string, (this: { userId: string | null }, ...args: unknown[]) => Promise<unknown>> = {};
  registerMethod = (name: string, business: Function, count = 1, minimum = count) => {
    const self = this;
    this.handlers[name] = async function (...args: unknown[]) {
      if (args.length < minimum || args.length > count) throw new Error('invalid-arguments');
      while (args.length < count) args.push(undefined);
      const context: LegacyContext = { userId: this.userId, validate() { self.validatorCalls++; } };
      const result = await business(...args, context); context.validate(); return result;
    };
  };
}`;
	sources['imports/modules/demo/server/legacy.ts'] =
		`import { ServerApiBase, type LegacyContext } from '../../../api/serverBase';
import { strictObject, string } from '../../../core/contracts/schema';
import { OperationError, type TrustedContext, type Invocation } from '../../../core/server/operations';
const inputSchema = strictObject({ id: string() });
const outputSchema = strictObject({ id: string(), title: string() });
async function policy(context: TrustedContext, input: { id: string }) { if (context.userId !== 'owner') throw new OperationError('forbidden'); }
async function buildContext(invocation: Invocation) { return { userId: invocation.userId ?? '', requestId: 'trusted' }; }
function identity(context: LegacyContext) { return context.userId; }
function project(result: { id: string; title: string; secret: string }, context: TrustedContext) { return { id: result.id, title: result.title }; }
let concurrencyCalls = 0;
async function executeWrite<T>(context: TrustedContext, input: { id: string }, perform: () => Promise<T>): Promise<T> { concurrencyCalls++; return perform(); }
export class LegacyApi extends ServerApiBase {
  ${override ? 'registerMethod = (name: string, fn: Function) => {};' : ''}
  constructor() { super(); this.registerMethod('lookup', this.lookup.bind(this)${optional ? ', 1, 0' : ''}); }
  async lookup(input: { id: string }, context: LegacyContext) {
    if (!context.userId) throw new OperationError('unauthenticated');
    if (context.userId !== 'owner') throw new OperationError('forbidden');
    this.businessCalls++; return { id: input.id, title: 'kept-business', secret: 'not-public' };
  }
}
export function getConcurrencyCalls() { return concurrencyCalls; }
`;
	const root = fixture(t, sources);
	const operation = {
		kind: 'modernize-legacy',
		recipe: 'register-method-to-operation',
		file: 'imports/modules/demo/server/legacy.ts',
		symbol: 'lookup',
		mappings: {
			input: 'inputSchema',
			output: 'outputSchema',
			policy: 'policy',
			contextBuilder: 'buildContext',
			identityFromLegacy: 'identity',
			project: 'project',
			effect: write ? 'write' : 'read',
			...(write ? { concurrency: 'executeWrite' } : {})
		}
	};
	return { root, sources, operation };
}
async function loadFixture(root, sources) {
	const ts = (await import('typescript')).default;
	const vm = await import('node:vm');
	const cache = new Map();
	function load(file) {
		if (cache.has(file)) return cache.get(file).exports;
		const module = { exports: {} };
		cache.set(file, module);
		const source = sources[file] ?? fs.readFileSync(path.join(root, file), 'utf8');
		const compiled = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
		});
		const run = vm.runInThisContext('(function(require,module,exports){' + compiled.outputText + '\n})');
		run(
			(spec) => {
				assert.ok(spec.startsWith('.'));
				return load(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) + '.ts');
			},
			module,
			module.exports
		);
		return module.exports;
	}
	return load('imports/modules/demo/server/legacy.ts');
}
test('legacy registerMethod migration executes real core contracts and preserves captured business/legacy validator', async (t) => {
	const { root, sources, operation } = legacyFixture(t);
	const before = await loadFixture(root, sources),
		old = new before.LegacyApi();
	const oldResult = await old.handlers.lookup.call({ userId: 'owner' }, { id: 'one' });
	const plan = clean(planCodemod(root, operation));
	assert.equal(plan.changes.length, 1);
	assert.match(output(plan, operation.file), /operationHandler as/);
	const after = await loadFixture(root, { ...sources, [operation.file]: output(plan, operation.file) }),
		migrated = new after.LegacyApi();
	const result = await migrated.handlers.lookup.call({ userId: 'owner' }, { id: 'one' });
	assert.deepEqual(result, { id: oldResult.id, title: oldResult.title });
	assert.equal(migrated.businessCalls, 1);
	assert.equal(migrated.validatorCalls, 1);
	assert.equal('secret' in result, false);
	for (const [userId, input, code] of [
		[null, { id: 'one' }, 'unauthenticated'],
		['other', { id: 'one' }, 'forbidden'],
		['owner', { id: 'one', ownerId: 'owner' }, 'invalid-input'],
		['owner', { id: 1 }, 'invalid-input']
	]) {
		await assert.rejects(
			() => migrated.handlers.lookup.call({ userId }, input),
			(error) => error.code === code
		);
	}
	assert.equal(migrated.businessCalls, 1);
	assert.equal(migrated.validatorCalls, 1);
	await assert.rejects(
		() => migrated.handlers.lookup.call({ userId: 'owner' }, { id: 'one' }, { userId: 'attacker' }),
		/invalid-arguments/
	);
});
test('legacy write adapter invokes reviewed concurrency executor and original mutation exactly once', async (t) => {
	const { root, sources, operation } = legacyFixture(t, { write: true });
	const plan = clean(planCodemod(root, operation));
	const api = await loadFixture(root, { ...sources, [operation.file]: output(plan, operation.file) });
	const migrated = new api.LegacyApi();
	await migrated.handlers.lookup.call({ userId: 'owner' }, { id: 'one' });
	assert.equal(api.getConcurrencyCalls(), 1);
	assert.equal(migrated.businessCalls, 1);
	await assert.rejects(
		() => migrated.handlers.lookup.call({ userId: 'other' }, { id: 'one' }),
		(error) => error.code === 'forbidden'
	);
	assert.equal(api.getConcurrencyCalls(), 1);
	assert.equal(migrated.businessCalls, 1);
});
test('legacy migration rejects missing concurrency, fabricated mappings, optional arity and registration overrides', (t) => {
	for (const options of [{ write: true }, { optional: true }, { override: true }]) {
		const { root, operation } = legacyFixture(t, options);
		if (options.write) delete operation.mappings.concurrency;
		assert.equal(planCodemod(root, operation).changes.length, 0);
	}
	const { root, operation } = legacyFixture(t);
	for (const value of ['missingPolicy', 'policy(); evil()', 'inputSchema']) {
		const bad = structuredClone(operation);
		bad.mappings.policy = value;
		const plan = planCodemod(root, bad);
		assert.equal(plan.changes.length, 0);
		assert.ok(plan.diagnostics.some((d) => d.severity === 'error'));
	}
});

test('same-file property references do not count as duplicate declarations', (t) => {
	const root = fixture(t, {
		'model.ts': 'export interface Model { title: string; } export function label(value: Model) { return value.title; }'
	});
	const result = clean(
		planCodemod(root, { kind: 'rename-field', file: 'model.ts', symbol: 'title', newName: 'caption' })
	);
	assert.match(output(result, 'model.ts'), /value.caption/);
});
test('generated legacy adapter passes strict TypeScript compilation against real core contracts', async (t) => {
	const { root, operation } = legacyFixture(t, { write: true });
	const plan = clean(planCodemod(root, operation));
	fs.writeFileSync(path.join(root, operation.file), output(plan, operation.file));
	const ts = (await import('typescript')).default;
	const program = ts.createProgram([path.join(root, operation.file)], {
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler
	});
	assert.deepEqual(
		ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
		[]
	);
});
test('write executor cannot invoke legacy mutation twice or bypass it silently', async (t) => {
	for (const body of [
		'await perform(); return perform();',
		"return { id: 'fake', title: 'fake', secret: 'fake' } as T;"
	]) {
		const { root, sources, operation } = legacyFixture(t, { write: true });
		const plan = clean(planCodemod(root, operation));
		const changed = output(plan, operation.file).replace(
			'concurrencyCalls++; return perform();',
			'concurrencyCalls++; ' + body
		);
		const api = await loadFixture(root, { ...sources, [operation.file]: changed });
		const migrated = new api.LegacyApi();
		await assert.rejects(
			() => migrated.handlers.lookup.call({ userId: 'owner' }, { id: 'one' }),
			/exactly once|did not invoke/
		);
		assert.ok(migrated.businessCalls <= 1);
	}
});
