#!/usr/bin/env node
import { inspectLegacyFields } from './legacy-fields.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readJson, fail, validateTask } from './lib.mjs';
import { parseArguments } from './arguments.mjs';
import { scaffold } from './scaffold.mjs';
import { context } from './context.mjs';
import { astGraph } from './ast.mjs';
import { planIntegration, applyIntegration } from './integrate.mjs';
import { createRecipe } from './recipes.mjs';
import { planEvolution, applyEvolution, recoverEvolution } from './evolve.mjs';
import { migrateFile, rehearseRestore } from './migrations/runner.mjs';
import { patchCheck, boundaries, docsCheck, doctor, saveTaskState, changedFiles } from './checks.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);
const verifications = [];
function run(cmd, argv) {
	const result = spawnSync(cmd, argv, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
	const output = (result.stdout || '') + (result.stderr || '');
	verifications.push({ command: [cmd, ...argv], exitCode: result.status, output });
	if (result.status !== 0)
		fail(
			'verification-failed',
			`${cmd} ${argv.join(' ')} failed: ${output.slice(-6000)}`,
			'',
			`${cmd} ${argv.join(' ')}`
		);
}
try {
	const options = parseArguments(command, args);
	const option = (name) => options.get(name);
	if (args.includes('--help') || command === '--help') {
		const help = {
			'legacy:check': {
				command: 'npm run legacy:check -- --module example',
				note: 'Static AST inspection only. Checks actual publications, reduced schema, form and explicit omission policy. Linked tests remain mandatory.'
			},
			'module:new': {
				command: 'npm run module:new -- --spec templates/owner-crud/example.spec.json',
				schema: 'tools/schemas/module-spec.v1.schema.json',
				example: readJson(path.join(root, 'templates/owner-crud/example.spec.json')),
				note: 'Owner-only title/status CRUD. Atomic directory install, collision rejection, idempotent rerun. Register server/UI/tests explicitly from generated manifest; qualified=false until independent tests pass.'
			},
			'module:integrate': {
				command: 'npm run module:integrate -- --plan integration.json (or --apply reviewed-plan.json)',
				schema: 'tools/schemas/module-integration.v1.schema.json',
				example: { schemaVersion: 1, module: 'ownednotes', label: 'Minhas notas' },
				note: 'Supply reviewed custom/server/ports.ts and acceptance.test.ts first. Plans include complete diffs and hashes; apply wires server/routes/menu/tests but preserves qualified=false.'
			},
			'agent:context': {
				command: 'npm run agent:context -- --task tools/task.example.json',
				schema: 'tools/schemas/task.v1.schema.json',
				example: readJson(path.join(root, 'tools/task.example.json')),
				note: 'Compiler-resolved TypeScript AST closure and exported signatures. Computed imports, unresolved dependencies and exceeded budgets fail closed.'
			},
			'task:state': {
				command: 'npm run task:state -- --task tools/task.example.json --evidence usage.json',
				exampleEvidence: { seconds: 30, tokens: 1500, costUSD: 0.02, attempts: 1 },
				note: 'Cumulative usage persisted under .agent-state; exhausted budget is needs-review. This is not an executor or independent qualification.'
			}
		};
		process.stdout.write(
			JSON.stringify(
				help[command] || {
					commands: [
						'doctor',
						'legacy:check',
						'module:new',
						'agent:context',
						'task:validate',
						'task:state',
						'patch:check',
						'boundaries:check',
						'docs:verify',
						'templates:verify',
						'check:changed',
						'recipe:new',
						'module:evolve',
						'module:integrate',
						'agent:graph',
						'migration:export',
						'migration:restore-rehearsal'
					],
					diagnostics: 'JSON by default; --json accepted. Exit 0 passed, 1 failed, 2 invalid usage.'
				},
				null,
				2
			) + '\n'
		);
		process.exit(0);
	}
	let result;
	switch (command) {
		case 'legacy:check':
			result = inspectLegacyFields(root, option('--module'));
			break;
		case 'doctor':
			result = doctor(root);
			break;
		case 'module:new':
			result = scaffold(root, readJson(option('--spec')));
			break;
		case 'recipe:new':
			result = createRecipe(root, readJson(option('--definition')));
			break;
		case 'module:integrate':
			result = options.has('--apply')
				? applyIntegration(root, readJson(option('--apply')))
				: planIntegration(root, readJson(option('--plan')));
			break;
		case 'module:evolve':
			result = args.includes('--recover')
				? recoverEvolution(root, option('--recover'))
				: args.includes('--apply')
					? applyEvolution(root, readJson(option('--apply')))
					: planEvolution(root, readJson(option('--plan')));
			break;
		case 'agent:graph':
			result = astGraph(root);
			break;
		case 'migration:export':
			result = await migrateFile(root, option('--store'), readJson(option('--plan')), {
				apply: args.includes('--apply')
			});
			break;
		case 'migration:restore-rehearsal':
			result = await rehearseRestore(root, option('--store'), option('--id'));
			break;
		case 'agent:context':
			result = context(root, readJson(option('--task')));
			break;
		case 'task:validate':
			result = { status: 'passed', task: validateTask(readJson(option('--task'))) };
			break;
		case 'task:state':
			result = saveTaskState(root, readJson(option('--task')), readJson(option('--evidence')));
			break;
		case 'patch:check':
			result = patchCheck(root, readJson(option('--task')));
			break;
		case 'boundaries:check':
			result = boundaries(root);
			break;
		case 'docs:verify':
			result = docsCheck(root);
			break;
		case 'templates:verify':
			run(process.execPath, ['--test', 'tools/test/scaffold.test.mjs']);
			run(process.execPath, ['tools/verify-template-build.mjs']);
			result = {
				status: 'passed',
				notice:
					'Deterministic generation, safety invariants and generated TypeScript checked. Full Meteor runtime gates are independently required.'
			};
			break;
		case 'check:changed':
			result = { changed: changedFiles(root), ...boundaries(root) };
			if (result.status === 'passed') run('npm', ['run', 'typecheck']);
			break;
		default:
			fail(
				'usage',
				'Commands: doctor, module:new --spec, agent:context --task, task:validate --task, task:state --task --evidence, patch:check --task, boundaries:check, docs:verify, templates:verify, check:changed'
			);
	}
	if (verifications.length) result.verifications = verifications;
	process.stdout.write(JSON.stringify(result, null, 2) + '\n');
	if (result.status === 'failed' || (command === 'legacy:check' && result.status !== 'passed')) process.exitCode = 1;
} catch (error) {
	process.stderr.write(
		JSON.stringify(
			{
				status: 'failed',
				diagnostics: [
					{
						file: error.file || '',
						line: error.line || 1,
						rule: error.rule || 'internal',
						message: error.message,
						command: error.command || `node tools/cli.mjs ${command || ''}`
					}
				]
			},
			null,
			2
		) + '\n'
	);
	process.exitCode = error.rule === 'usage' ? 2 : 1;
}
