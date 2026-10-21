#!/usr/bin/env node
/** Supervisor-owned regression gate. Mutants exist only in bundler memory, never source files. */
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const core = 'imports/core/server/';
const recipe = 'imports/core/recipes/';
const engine = `${recipe}server/engine.ts`;
const property = (name) => `recipe property: ${name}`;
const membership = 'property: membership decisions require all independent authority predicates';
const mutations = [
	{
		id: 'skip-operation-policy',
		file: `${core}operations.ts`,
		from: 'await operation.policy(ctx, input);',
		to: '/* mutant: policy skipped */',
		test: 'property: denied policy never reaches handler'
	},
	{
		id: 'accept-forged-context',
		file: `${core}operations.ts`,
		from: '!ctx.userId || ctx.userId !== this.userId',
		to: '!ctx.userId',
		test: 'property: all mismatched invocation identities fail before policy or handler'
	},
	{
		id: 'skip-output-contract',
		file: `${core}operations.ts`,
		from: 'return operation.output.parse(await operation.handler(ctx, input));',
		to: 'return await operation.handler(ctx, input);',
		test: 'property: outputs cannot leak undeclared fields'
	},
	{
		id: 'accept-revoked-membership',
		file: `${core}policy.ts`,
		from: '!membership.active || ',
		to: '',
		test: membership
	},
	{
		id: 'accept-wrong-tenant-member',
		file: `${core}policy.ts`,
		from: 'membership.tenantId !== tenantId || ',
		to: '',
		test: membership
	},
	{
		id: 'accept-wrong-member-user',
		file: `${core}policy.ts`,
		from: 'membership.userId !== ctx.userId || ',
		to: '',
		test: membership
	},
	{
		id: 'allow-tenant-role-escalation',
		file: `${core}policy.ts`,
		from: ' || !allowedRoles.includes(membership.role)',
		to: '',
		test: membership
	},
	{
		id: 'omit-personal-tenant-boundary',
		file: engine,
		from: '{ ownerId: who.userId, tenantId: null }',
		to: '{ ownerId: who.userId }',
		test: property('personal selectors explicitly exclude tenant records for the same owner')
	},
	{
		id: 'trust-repository-owner-scope',
		file: engine,
		from: '(!scope.ownerId || row.ownerId === scope.ownerId)',
		to: 'true',
		test: property('service independently rejects repository cross-owner and cross-tenant reads')
	},
	{
		id: 'trust-repository-tenant-scope',
		file: engine,
		from: "(!Object.hasOwn(scope, 'tenantId') || (row.tenantId ?? null) === scope.tenantId)",
		to: 'true',
		test: property('service independently rejects repository cross-owner and cross-tenant reads')
	},
	{
		id: 'accept-forged-recipe-identity',
		file: engine,
		from: 'who.userId !== userId ||',
		to: 'false ||',
		test: property('forged identity and revoked membership fail before repository writes')
	},
	{
		id: 'allow-self-review',
		file: engine,
		from: " || (d.profile === 'approval' && t.roles.includes('reviewer') && row.ownerId === who.userId)",
		to: '',
		test: property('review requires another current reviewer in the same tenant')
	},
	{
		id: 'skip-transition-role',
		file: engine,
		from: 'if (!permitted ||',
		to: 'if (false ||',
		test: property('review requires another current reviewer in the same tenant')
	},
	{
		id: 'edit-submitted-approval',
		file: engine,
		from: "if (d.profile === 'approval' && row.state !== d.states[0]) throw new OperationError('forbidden');\n\t\t\tconst data",
		to: 'const data',
		test: property('submitted approval data cannot change or disappear')
	},
	{
		id: 'skip-persisted-envelope-before-write',
		file: engine,
		from: 'project(row); // Reject corrupted persisted DTOs before a mutation can execute.',
		to: '/* mutant: persisted envelope trusted */',
		test: property('corrupt persisted envelopes fail before any mutation and private keys never project')
	},
	{
		id: 'accept-zero-output-version',
		file: engine,
		from: 'row.version < 1 ||',
		to: 'false ||',
		test: property('corrupt persisted envelopes fail before any mutation and private keys never project')
	},
	{
		id: 'leak-undeclared-recipe-fields',
		file: engine,
		from: 'data: parseRecipeData(d, row.data)',
		to: 'data: row.data',
		test: property('corrupt persisted envelopes fail before any mutation and private keys never project')
	},
	{
		id: 'accept-changed-creation-replay',
		file: engine,
		from: 'stored.creationFingerprint !== creationFingerprint ||',
		to: 'false ||',
		test: property('mutation replay binds the original payload and cannot resurrect a tombstone')
	},
	// A deleted receipt has two independent checks. Remove both to model the lost invariant,
	// rather than claiming an equivalent single-site mutant survived the test suite.
	{
		id: 'accept-deleted-creation-replay',
		file: engine,
		edits: [
			{ from: 'stored.deleted\n', to: 'false\n' },
			{ from: 'row.deleted !== false ||', to: 'false ||' }
		],
		test: property('replay rejects deleted receipts even if historical data remains')
	},
	{
		id: 'allow-repository-id-redirection',
		file: engine,
		from: 'row._id !== id || ',
		to: '',
		test: property('repository reads cannot redirect mutations to another same-scope id')
	},
	{
		id: 'skip-linked-file-permission',
		file: `${recipe}server/attachments.ts`,
		from: '!(await ports.canReadFile(userId, fileId))',
		to: 'false',
		test: property('linked attachments require all three independent live permissions')
	},
	{
		id: 'skip-linked-document-permission',
		file: `${recipe}server/attachments.ts`,
		from: '!(await ports.canReadDocument(userId, documentId))',
		to: 'false',
		test: property('linked attachments require all three independent live permissions')
	},
	{
		id: 'skip-attachment-link-check',
		file: `${recipe}server/attachments.ts`,
		from: '!(await ports.linked(documentId, fileId))',
		to: 'false',
		test: property('linked attachments require all three independent live permissions')
	},
	{
		id: 'skip-import-row-contract',
		file: `${recipe}batch.ts`,
		from: 'rows.map((row) => parseRecipeData(definition, row))',
		to: 'rows as RecipeData[]',
		test: property('imports validate every row and terminal jobs never reopen')
	},
	{
		id: 'revive-successful-job',
		file: `${recipe}batch.ts`,
		from: 'succeeded: [],',
		to: "succeeded: ['running'],",
		test: property('imports validate every row and terminal jobs never reopen')
	}
];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-mutation-'));
const results = [];
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
try {
	for (const mutant of [null, ...mutations]) {
		const outfile = path.join(temp, `${mutant?.id || 'baseline'}.cjs`);
		try {
			await build({
				stdin: {
					contents:
						"import './tests/security-properties.node.test.ts'; import './tests/recipe-security-properties.node.test.ts';",
					resolveDir: process.cwd(),
					loader: 'ts'
				},
				bundle: true,
				platform: 'node',
				format: 'cjs',
				outfile,
				plugins: mutant
					? [
							{
								name: 'controlled-security-mutant',
								setup(b) {
									b.onLoad({ filter: /\.ts$/ }, (args) => {
										if (args.path !== path.resolve(mutant.file)) return;
										let contents = fs.readFileSync(args.path, 'utf8');
										for (const edit of mutant.edits ?? [mutant]) {
											if (contents.split(edit.from).length !== 2) throw Error(`Mutant anchor drift: ${mutant.id}`);
											contents = contents.replace(edit.from, edit.to);
										}
										return { contents, loader: 'ts' };
									});
								}
							}
						]
					: []
			});
		} catch (error) {
			results.push({ id: mutant?.id || 'baseline', passed: false, reason: 'build-or-anchor-failure' });
			process.stderr.write(`${error}\n`);
			continue;
		}
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', outfile], {
			encoding: 'utf8',
			timeout: 30000,
			env
		});
		const output = (run.stdout ?? '') + (run.stderr ?? '');
		const executed =
			/# tests [1-9]\d*/.test(output) && /\b(?:ok|not ok) \d+ - /.test(output) && !run.error && !run.signal;
		// A compile error, harness crash, unrelated failure or missing test cannot kill a mutant.
		// Require the named independent security property to fail with a real assertion.
		const failure = mutant
			? output.match(
					new RegExp(`^not ok \\d+ - ${escaped(mutant.test)}\\n([\\s\\S]*?)(?=^# Subtest:|^1\\.\\.)`, 'm')
				)?.[1]
			: undefined;
		const killed = executed && run.status !== 0 && !!failure && /code: ['"]ERR_ASSERTION['"]/.test(failure);
		const passed = mutant ? killed : executed && run.status === 0;
		results.push({
			id: mutant?.id || 'baseline',
			passed,
			exitCode: run.status,
			...(mutant ? { expectedProperty: mutant.test, assertionFailure: !!killed } : {})
		});
		if (!passed) process.stderr.write(output);
	}
	console.log(
		JSON.stringify(
			{
				version: 2,
				baseline: results[0],
				mutants: results.slice(1),
				killed: results.slice(1).filter((x) => x.passed).length,
				total: mutations.length
			},
			null,
			2
		)
	);
	if (results.some((x) => !x.passed)) process.exitCode = 1;
} finally {
	fs.rmSync(temp, { recursive: true, force: true });
}
