import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeSource, astGraph, astContext, astBoundaries } from '../ast.mjs';
function fixture(t, content) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-tools-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	for (const [name, text] of Object.entries(content)) {
		fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
		fs.writeFileSync(path.join(root, name), text);
	}
	return root;
}
const task = {
	schemaVersion: 1,
	id: 'ast-test',
	objective: 'Inspect module',
	acceptance: ['complete closure'],
	allowedPaths: ['imports/modules/demo/'],
	contextFiles: ['imports/modules/demo/ui/Page.tsx'],
	commands: ['typecheck'],
	budget: { seconds: 30, tokens: 1000, costUSD: 1, files: 10, attempts: 2, contextBytes: 50000, contextFiles: 20 },
	state: 'planned'
};
test('AST resolves aliases, multiline imports, reexports and type imports, ignores comments', (t) => {
	const root = fixture(t, {
		'tsconfig.json': JSON.stringify({
			compilerOptions: { moduleResolution: 'Bundler', module: 'Preserve', paths: { '@/*': ['./imports/*'] } }
		}),
		'imports/modules/demo/ui/Page.tsx': `import {\n value\n} from '@/modules/demo/contracts';\nexport { value } from '../contracts';\ntype T = import('../types').T;\n// require('../server/secret')\nexport function hello(\nname:string\n): string {return name;}`,
		'imports/modules/demo/contracts/index.ts': 'export const value=1;',
		'imports/modules/demo/types.ts': 'export type T=string;'
	});
	const r = analyzeSource(root, task.contextFiles[0]);
	assert.deepEqual(r.dependencies, ['imports/modules/demo/contracts/index.ts', 'imports/modules/demo/types.ts']);
	assert.deepEqual(r.diagnostics, []);
	assert.match(r.symbols.find((x) => x.name === 'hello').signature, /name:string/);
	assert.equal(astContext(root, task).files.length, 3);
});
test('computed imports and require fail closed, templates with no substitution are static', (t) => {
	const root = fixture(t, {
		'imports/a.ts': "const name='a'; import(name); require(name); import(`./b`);",
		'imports/b.ts': 'export {};'
	});
	const r = analyzeSource(root, 'imports/a.ts');
	assert.equal(r.diagnostics.filter((x) => x.rule === 'computed-import').length, 2);
	assert.deepEqual(r.dependencies, ['imports/b.ts']);
	assert.throws(() => astContext(root, { ...task, contextFiles: ['imports/a.ts'] }), /Computed module/);
});
test('AST catches transitive UI/server reachability via barrel and cross-module private access', (t) => {
	const root = fixture(t, {
		'imports/modules/demo/ui/Page.tsx': "export {secret} from '../contracts';",
		'imports/modules/demo/contracts/index.ts': "export {secret} from '../server/secret';",
		'imports/modules/demo/server/secret.ts': "import x from '../../other/domain/private'; export const secret=x;",
		'imports/modules/other/domain/private.ts': 'export default 1;'
	});
	const r = astBoundaries(root);
	assert.equal(r.status, 'failed');
	assert(r.diagnostics.some((x) => x.rule === 'pure-layer'));
	assert(r.diagnostics.some((x) => x.rule === 'transitive-ui-server'));
	assert(r.diagnostics.some((x) => x.rule === 'module-private'));
});
test('compiler graph rejects parse errors and unresolved local aliases without incomplete context', (t) => {
	const root = fixture(t, {
		'tsconfig.json': JSON.stringify({
			compilerOptions: { moduleResolution: 'Bundler', module: 'Preserve', paths: { '@/*': ['./imports/*'] } }
		}),
		'imports/a.ts': "import x from '@/missing'; export const = ;"
	});
	const r = analyzeSource(root, 'imports/a.ts');
	assert(r.diagnostics.some((x) => x.rule === 'syntax'));
	assert(r.diagnostics.some((x) => x.rule === 'unresolved-dependency'));
});
test('context rejects escape, symlink, secrets and file/output budgets', (t) => {
	const root = fixture(t, {
		'imports/a.ts': "import './b';",
		'imports/b.ts': 'export const value=1;',
		'.env': 'SECRET=not-real'
	});
	assert.throws(() => astContext(root, { ...task, contextFiles: ['.env'] }), /Credential/);
	assert.throws(
		() => astContext(root, { ...task, contextFiles: ['imports/a.ts'], budget: { ...task.budget, contextFiles: 1 } }),
		/file budget/
	);
	assert.throws(
		() => astContext(root, { ...task, contextFiles: ['imports/a.ts'], budget: { ...task.budget, contextBytes: 50 } }),
		/budget/
	);
	fs.symlinkSync(path.join(root, 'imports/b.ts'), path.join(root, 'imports/link.ts'));
	assert.throws(() => analyzeSource(root, 'imports/link.ts'), /Symbolic/);
});
test('canonical cycles are blocking and source graph deterministically bounded', (t) => {
	const root = fixture(t, {
		'imports/core/domain/a.ts': "export {b} from './b'; export const a=1;",
		'imports/core/domain/b.ts': "export {a} from './a'; export const b=1;"
	});
	const r = astBoundaries(root);
	assert(r.diagnostics.some((x) => x.rule === 'dependency-cycle'));
	assert.throws(() => astGraph(root, { maxFiles: 1 }), /file limit/);
	assert.deepEqual(astGraph(root), astGraph(root));
});
test('server guards are recognized structurally, but a guard alone never exempts UI server leakage', (t) => {
	const root = fixture(t, {
		'imports/ui/Page.ts':
			"export function f(){if(!Meteor.isServer)return; return require('../server/secret');} export function g(){if(Meteor.isServer){return require('../server/secret');}} export function h(){if(Meteor.isServer){return ()=>require('../server/secret');}}",
		'imports/server/secret.ts': 'export const secret=1;'
	});
	const r = analyzeSource(root, 'imports/ui/Page.ts');
	assert.deepEqual(
		r.edges.map((e) => e.serverGuarded),
		[true, true, false]
	);
	assert.equal(astBoundaries(root).status, 'failed');
});
test('the reviewed legacy bridge is SHA pinned and exposes review debt', (t) => {
	const result = astBoundaries(process.cwd());
	assert.equal(result.status, 'passed', JSON.stringify(result.diagnostics));
	assert(result.debt.some((d) => d.rule === 'reviewed-isomorphic-bridge'));
	const original = analyzeSource(process.cwd(), 'imports/api/attachmentsCollection.ts');
	const content = {
		'imports/api/attachmentsCollection.ts': original.source + '\n// changed bridge\n',
		'imports/ui/Page.ts': "import '../api/attachmentsCollection';"
	};
	for (const dependency of original.dependencies) content[dependency] = 'export {};';
	const root = fixture(t, content);
	const changed = astBoundaries(root);
	assert(changed.diagnostics.some((d) => d.rule === 'transitive-ui-server'));
	assert(!changed.debt.some((d) => d.rule === 'reviewed-isomorphic-bridge'));
});
test('escaped specifiers and import-equals resolve the real server target', (t) => {
	const root = fixture(t, {
		'imports/modules/demo/ui/Page.ts': "import secret = require('../ser\\u0076er/secret'); export * from '../barrel';",
		'imports/modules/demo/barrel.ts': "export * from './server/secret';",
		'imports/modules/demo/server/secret.ts': 'export const secret=1;'
	});
	const r = analyzeSource(root, 'imports/modules/demo/ui/Page.ts');
	assert.equal(r.edges[0].kind, 'import-equals');
	assert.equal(r.edges[0].target, 'imports/modules/demo/server/secret.ts');
	assert(astBoundaries(root).diagnostics.some((d) => d.rule === 'ui-server'));
});
test('aliased and property-based loaders fail closed instead of disappearing from closure', (t) => {
	const root = fixture(t, {
		'imports/a.ts':
			"const load=require; load('./server'); module.require('./server'); globalThis['require']('./server');",
		'imports/server.ts': 'export {};'
	});
	const r = analyzeSource(root, 'imports/a.ts');
	assert.equal(r.diagnostics.filter((d) => d.rule === 'indirect-loader').length, 3);
	assert.throws(() => astContext(root, { ...task, contextFiles: ['imports/a.ts'] }), /module loading/);
});
test('dependency closure cannot hide server leakage in a normally excluded nested directory', (t) => {
	const root = fixture(t, {
		'imports/modules/demo/ui/Page.ts': "import '../custom/node_modules/bridge';",
		'imports/modules/demo/custom/node_modules/bridge.ts': "import '../../server/secret';",
		'imports/modules/demo/server/secret.ts': 'export const secret=1;'
	});
	const result = astBoundaries(root);
	assert(result.diagnostics.some((d) => d.rule === 'transitive-ui-server'));
	assert(astGraph(root).files.some((f) => f.file.endsWith('custom/node_modules/bridge.ts')));
});
