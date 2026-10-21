import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confined, hash, fail, exact } from '../../lib.mjs';
import { createRecipe } from '../../recipes.mjs';
import { planEvolution, applyEvolution } from '../../evolve.mjs';
import { planIntegration, applyIntegration } from '../../integrate.mjs';
import { validateRequest, validateFeature, json } from '../contracts/validate.mjs';
import { snapshot, put, changesBetween, assertWritable } from '../runner/files.mjs';
import { renderExtensions } from '../generators/feature.mjs';
function installIdentity(stage, module, selection) {
	const prefix = `imports/modules/${module}`;
	const acceptance = `${prefix}/custom/server/acceptance.test.ts`;
	if (!fs.existsSync(confined(stage, acceptance, { missing: true })))
		fail(
			'needs-review',
			'Supply independently reviewed custom/server/acceptance.test.ts before integration',
			acceptance
		);
	if (selection.identity === undefined) {
		if (selection.ports !== undefined) fail('automation-identity', 'ports requires reviewed-ports identity');
		return;
	}
	if (!['owner-active-account', 'reviewed-ports'].includes(selection.identity))
		fail('automation-identity', 'Choose owner-active-account or reviewed-ports');
	const definition = JSON.parse(fs.readFileSync(confined(stage, `${prefix}/module.definition.json`), 'utf8'));
	if (
		selection.identity === 'owner-active-account' &&
		(definition.profile !== 'owner' || selection.ports !== undefined)
	)
		fail('automation-identity', 'Owner adapter only supports owner modules and no custom ports path');
	let content;
	if (selection.identity === 'reviewed-ports') {
		if (typeof selection.ports !== 'string' || !selection.ports.endsWith('/server/ports.ts'))
			fail('automation-identity', 'Reviewed ports must be an existing server/ports.ts');
		const source = confined(stage, selection.ports);
		const destination = `${prefix}/custom/server/ports.ts`;
		if (selection.ports === destination) content = fs.readFileSync(source, 'utf8');
		else {
			let reference = path.posix.relative(path.posix.dirname(destination), selection.ports).replace(/\.ts$/, '');
			if (!reference.startsWith('.')) reference = './' + reference;
			content = `export { ports } from ${JSON.stringify(reference)};\n`;
		}
	} else
		content =
			"import { ownerRecipePorts } from '../../../../server/recipeIdentity';\nexport const ports = ownerRecipePorts();\n";
	const file = `${prefix}/custom/server/ports.ts`,
		target = confined(stage, file, { missing: true });
	if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== content)
		fail('automation-customization', 'Existing trusted ports differ; explicit security refactoring required', file);
	put(stage, file, content);
}
async function feature(stage, raw, diagnostics, regenerate = false) {
	const { definition, ...spec } = validateFeature(raw);
	if (!regenerate) createRecipe(stage, definition);
	const prefix = `imports/modules/${definition.name}`;
	if (regenerate) {
		const old = JSON.parse(fs.readFileSync(confined(stage, `${prefix}/module.automation.json`), 'utf8'));
		for (const [file, expected] of Object.entries(old.files)) {
			if (hash(fs.readFileSync(confined(stage, `${prefix}/${file}`))) !== expected)
				fail('automation-customization', 'Extension drift; preserve custom edits', file);
		}
	}
	const output = renderExtensions(definition, spec, stage);
	for (const [file, content] of Object.entries(output)) {
		if (typeof content !== 'string') fail('automation-generator', 'Generator must emit text', file);
		const target = confined(stage, file, { missing: true });
		if (!regenerate && fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== content)
			fail('automation-customization', 'Existing extension differs; do not overwrite customizations', file);
		put(stage, file, content);
	}
	if (spec.integration && !regenerate) {
		installIdentity(stage, definition.name, spec.integration);
		const plan = planIntegration(stage, { schemaVersion: 1, module: definition.name, label: spec.integration.label });
		applyIntegration(stage, plan);
	}
	diagnostics.push({
		code: 'qualification-required',
		module: definition.name,
		message: 'Generated code is unqualified until independent acceptance and runtime gates pass.'
	});
}
export async function planAutomation(root, raw) {
	const request = validateRequest(raw),
		before = snapshot(root),
		stage = fs.mkdtempSync(path.join(os.tmpdir(), 'meteor-automation-plan-'));
	const diagnostics = [],
		migrations = [],
		reviews = new Set(),
		steps = [];
	try {
		for (const [file, content] of Object.entries(before)) put(stage, file, content);
		// Installed compiler declarations are read-only resolution inputs, not copied or writable outputs.
		if (fs.existsSync(path.join(root, 'node_modules')))
			fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(stage, 'node_modules'), 'dir');
		fs.mkdirSync(path.join(stage, 'imports/modules'), { recursive: true });
		for (const operation of request.operations) {
			const start = snapshot(stage);
			if (operation.kind === 'feature') {
				await feature(stage, operation.input, diagnostics);
				if (operation.input.integration || operation.input.workflow || operation.input.relationships)
					reviews.add('security');
			}
			if (operation.kind === 'project') {
				exact(operation.input, ['profile', 'features']);
				if (
					!['owner-app', 'tenant-app'].includes(operation.input.profile) ||
					!Array.isArray(operation.input.features) ||
					!operation.input.features.length ||
					operation.input.features.length > 10
				)
					fail('automation-project', 'Choose owner-app/tenant-app and 1–10 feature contracts');
				for (const input of operation.input.features) {
					if (operation.input.profile === 'owner-app' && input.archetype !== 'owner')
						fail('automation-project', 'owner-app accepts owner features only');
					await feature(stage, input, diagnostics);
					if (input.integration || input.workflow || input.relationships) reviews.add('security');
				}
			}
			if (operation.kind === 'evolve') {
				const plan = planEvolution(stage, operation.input);
				if (plan.migrationRequired) {
					migrations.push({ module: plan.module, kind: 'backfill-required', execution: 'separate-reviewed-workflow' });
					reviews.add('migration');
				}
				if (operation.input.operations.some((x) => x.kind === 'replace-permissions')) reviews.add('security');
				applyEvolution(stage, plan);
				const prefix = `imports/modules/${plan.module}`;
				const extensionPath = confined(stage, `${prefix}/module.automation.json`, { missing: true });
				if (fs.existsSync(extensionPath)) {
					const extension = JSON.parse(fs.readFileSync(extensionPath, 'utf8'));
					const next = JSON.parse(fs.readFileSync(confined(stage, `${prefix}/module.definition.json`), 'utf8'));
					await feature(
						stage,
						{
							...extension.feature,
							fields: next.fields,
							filters: next.filters,
							states: next.states,
							transitions: next.transitions,
							permissions: next.permissions,
							rules: next.rules ?? []
						},
						diagnostics,
						true
					);
				}
			}
			if (operation.kind === 'integrate') {
				exact(
					operation.input,
					['schemaVersion', 'module', 'label', 'identity', 'ports'],
					['schemaVersion', 'module', 'label']
				);
				installIdentity(stage, operation.input.module, operation.input);
				const plan = planIntegration(stage, {
					schemaVersion: operation.input.schemaVersion,
					module: operation.input.module,
					label: operation.input.label
				});
				applyIntegration(stage, plan);
				reviews.add('security');
			}
			if (operation.kind === 'codemod') {
				const { planCodemod } = await import('../codemods/index.mjs');
				const plan = await planCodemod(stage, operation.input);
				if (
					(plan.diagnostics ?? []).some((d) => d.severity === 'error') ||
					plan.status === 'unsupported' ||
					plan.status === 'needs-design'
				)
					fail('unsupported', 'Codemod requires design: ' + JSON.stringify(plan.diagnostics));
				diagnostics.push(...(plan.diagnostics ?? []));
				migrations.push(...(plan.migrations ?? []));
				if (plan.requiresReview) reviews.add('semantic-change');
				for (const change of plan.changes) {
					assertWritable(change.path, change.before, 'codemod');
					const target = confined(stage, change.path, { missing: true });
					const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
					if (current !== change.before) fail('automation-codemod', 'Codemod stale precondition', change.path);
					if (change.after === null) fs.unlinkSync(target);
					else put(stage, change.path, change.after);
				}
			}
			const changes = changesBetween(start, snapshot(stage));
			for (const c of changes) assertWritable(c.path, c.before, operation.kind);
			steps.push({
				id: operation.id,
				kind: operation.kind,
				dependsOn: operation.dependsOn ?? [],
				files: changes.map((c) => c.path)
			});
		}
		const changes = changesBetween(before, snapshot(stage));
		if (changes.length > 250) fail('automation-budget', 'Plan exceeds 250 changed files; split the task');
		const plan = {
			schemaVersion: 1,
			engineVersion: '1.0.0',
			request,
			steps,
			preconditions: Object.fromEntries(Object.entries(before).map(([p, c]) => [p, hash(c)])),
			changes,
			diagnostics,
			migrations,
			requiresReview: [...reviews].sort(),
			qualified: false,
			requiredGates: ['typecheck', 'test:core', 'test:mutations', 'test:toolkit', 'verify', 'test:browser']
		};
		return { ...plan, planHash: hash(json(plan)) };
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
	}
}
