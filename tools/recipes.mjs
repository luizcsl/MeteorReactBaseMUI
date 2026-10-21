import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { confined, hash, fail } from './lib.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiled = buildSync({
	entryPoints: [path.join(root, 'imports/core/recipes/definition.ts')],
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false
});
const contracts = await import(
	'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
export const validateDefinition = contracts.validateDefinition;
export function renderDefinition(input) {
	const d = validateDefinition(input),
		name = d.name,
		upper = name[0].toUpperCase() + name.slice(1),
		json = JSON.stringify(d, null, 2);
	return {
		'generated/definition.ts': `// Generated from module.definition.json. Use module:evolve, not manual edits.\nimport { validateDefinition } from '../../../core/recipes/definition';\nexport const definition = validateDefinition(${json});\n`,
		'generated/server/register.ts': `// Server registration adapter. Import only from server code.\nimport { definition } from '../definition';\nimport { type RecipePorts } from '../../../../core/recipes/server/engine';\nimport { registerRecipe } from '../../../../core/recipes/server/register';\nexport function register${upper}(ports: Omit<RecipePorts,'repository'>) {\n return registerRecipe(definition,ports);\n}\n`,
		'generated/Page.tsx': `// Generated metadata-driven page. All permissions are enforced again on the server.\nimport React, { useContext } from 'react';\nimport AuthContext from '../../../app/authProvider/authContext';\nimport { createRecipeClient } from '../../../core/ui/recipeClient';\nimport { RecipePage } from '../../../core/ui/RecipePage';\nimport { definition } from './definition';\nconst client = createRecipeClient(definition);\nexport default function ${upper}Page({parentId=null}:{parentId?:string|null}){const { user, isLoggedIn } = useContext(AuthContext); if (!isLoggedIn) return null; return <RecipePage key={user?._id ?? 'anonymous'} definition={definition} client={client} parentId={parentId}/>;}\n`,
		'generated/contract.test.ts': `// Generated tests complement, never replace, the supervisor-owned security suite.\nimport assert from 'node:assert/strict';\nimport { parseRecipeData } from '../../../core/recipes/definition';\nimport { definition } from './definition';\nexport function verify${upper}Contract(){assert.throws(()=>parseRecipeData(definition,{ownerId:'attacker'}));assert.throws(()=>parseRecipeData(definition,{$where:'true'}));}\n`
	};
}
export function createRecipe(project, input) {
	const d = validateDefinition(input);
	if (['tasks', 'core', 'server', 'client', 'index', 'tests'].includes(d.name))
		fail('recipe-name', 'Reserved module name');
	const generated = renderDefinition(d),
		definition = JSON.stringify(d, null, 2) + '\n';
	const manifest = {
		schemaVersion: 1,
		coreVersion: '2.0.0',
		templateVersion: '2.0.0',
		definitionHash: hash(definition),
		files: Object.fromEntries(Object.entries(generated).map(([p, c]) => [p, hash(c)])),
		qualified: false,
		registration: {
			server: `Import generated/server/register and register${d.name[0].toUpperCase() + d.name.slice(1)} with a server-owned resolveIdentity that checks active account and current membership.`,
			ui: 'Import generated/Page from an authenticated route. Master/detail requires a trusted scoped parentExists implementation.',
			tests: 'Run the independent recipe suite plus a real DDP/browser flow before production.'
		}
	};
	const output = {
		...generated,
		'module.definition.json': definition,
		'module.manifest.json': JSON.stringify(manifest, null, 2) + '\n',
		'custom/README.md': 'Customizations belong here or in a wrapper. Never edit generated files.\n'
	};
	const destination = confined(project, `imports/modules/${d.name}`, { missing: true });
	if (fs.existsSync(destination)) {
		if (
			Object.entries(output).every(
				([p, c]) =>
					fs.existsSync(confined(destination, p, { missing: true })) &&
					fs.readFileSync(confined(destination, p), 'utf8') === c
			)
		)
			return { status: 'unchanged', module: d.name, manifest };
		fail('recipe-collision', 'Existing module differs; use an evolution plan');
	}
	const parent = confined(project, 'imports/modules'),
		stage = fs.mkdtempSync(path.join(parent, '.recipe-'));
	try {
		for (const [p, c] of Object.entries(output)) {
			const target = confined(stage, p, { missing: true });
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, c, { flag: 'wx' });
		}
		if (fs.existsSync(destination)) fail('recipe-collision', 'Destination appeared');
		fs.renameSync(stage, destination);
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
	}
	return { status: 'created', module: d.name, manifest };
}
