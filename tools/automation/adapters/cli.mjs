#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planAutomation } from '../planner/plan.mjs';
import { applyAutomation, recoverAutomation } from '../runner/execute.mjs';
import { inspectAutomation } from '../planner/impact.mjs';
import { verifyAutomation, reportAutomation } from '../validation/evidence.mjs';
import { catalog } from '../catalog/registry.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const [command, file, approvalFile, ...extra] = process.argv.slice(2);
const read = (file) => {
	const target = path.resolve(file);
	if (fs.statSync(target).size > 4 * 1024 * 1024) throw new Error('JSON input exceeds 4 MiB');
	return JSON.parse(fs.readFileSync(target, 'utf8'));
};
try {
	if (extra.length || (approvalFile && !['apply', 'report'].includes(command)) || (file && command === 'recover'))
		throw new Error('Unexpected arguments');
	let result;
	if (command === 'catalog') result = catalog(file ? read(file) : {});
	else if (command === 'inspect') result = inspectAutomation(root, file ? read(file) : {});
	else if (command === 'plan') result = await planAutomation(root, read(file));
	else if (command === 'apply')
		result = await applyAutomation(root, read(file), approvalFile ? read(approvalFile) : {});
	else if (command === 'verify') result = verifyAutomation(root, file ? read(file) : {});
	else if (command === 'report') result = reportAutomation(read(file), approvalFile ? read(approvalFile) : undefined);
	else if (command === 'recover') result = await recoverAutomation(root);
	else
		throw new Error(
			'Use catalog | inspect [input.json] | plan request.json | apply plan.json [review.json] | verify [options.json] | report plan.json [evidence.json] | recover'
		);
	process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
	process.stdout.write(
		JSON.stringify(
			{
				schemaVersion: 1,
				status:
					error.rule === 'needs-review'
						? 'needs-review'
						: error.rule === 'needs-design'
							? 'needs-design'
							: error.rule === 'unsupported'
								? 'unsupported'
								: 'blocked',
				diagnostics: [
					{
						code: error.rule ?? error.code ?? 'automation-error',
						message: error.message,
						path: error.file ?? '',
						remedy: 'Correct the bounded contract or request review; never bypass failed gates.'
					}
				]
			},
			null,
			2
		) + '\n'
	);
	process.exitCode = 1;
}
