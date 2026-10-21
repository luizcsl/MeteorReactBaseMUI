import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRecipe } from './recipes.mjs';
import { prepareRuntimeFixture } from './verify-template-runtime.mjs';
const root = process.cwd(),
	temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'template-build-'));
try {
	if (!fs.existsSync(path.join(root, 'node_modules/typescript/bin/tsc')))
		throw new Error('Install npm dependencies before template build verification');
	prepareRuntimeFixture(root, temporary);
	for (const file of fs.readdirSync(path.join(root, 'templates/recipes')).filter((x) => x.endsWith('.json')))
		createRecipe(temporary, JSON.parse(fs.readFileSync(path.join(root, 'templates/recipes', file), 'utf8')));
	const result = spawnSync(
		process.execPath,
		[
			path.join(root, 'node_modules/typescript/bin/tsc'),
			'--noEmit',
			'--pretty',
			'false',
			'--project',
			path.join(temporary, 'tsconfig.json')
		],
		{ encoding: 'utf8' }
	);
	process.stdout.write(result.stdout || '');
	process.stderr.write(result.stderr || '');
	if (result.status !== 0) throw new Error('Generated template typecheck failed');
	console.log(
		'Generated owner-crud and all structured recipe fixtures typechecked; Meteor runtime test suite remains required.'
	);
} finally {
	fs.rmSync(temporary, { recursive: true, force: true });
}
