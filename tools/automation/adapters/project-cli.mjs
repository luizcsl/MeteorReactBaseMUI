#!/usr/bin/env node
/** Separate new-project boundary: no installs, credential setup, or overwrites. */
import fs from 'node:fs';
import path from 'node:path';
import { planProject, applyProject } from '../project.mjs';
const [command, workspace, file, reviewFile, ...extra] = process.argv.slice(2);
function read(file, limit) {
	if (!file || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || fs.statSync(file).size > limit)
		throw new Error('Expected bounded regular JSON file');
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}
try {
	if (
		extra.length ||
		!['plan', 'apply'].includes(command) ||
		!workspace ||
		!file ||
		(command === 'plan' && reviewFile) ||
		(command === 'apply' && !reviewFile)
	)
		throw new Error(
			'Use plan workspace-directory request.json | apply workspace-directory project-plan.json review.json'
		);
	let result;
	if (command === 'plan') result = await planProject(path.resolve(workspace), read(file, 65536));
	else {
		const review = read(reviewFile, 4096);
		if (
			!review ||
			Array.isArray(review) ||
			Object.keys(review).length !== 1 ||
			typeof review.approvedPlanHash !== 'string' ||
			!/^[a-f0-9]{64}$/.test(review.approvedPlanHash)
		)
			throw new Error('Expected exact reviewed approvedPlanHash');
		result = await applyProject(path.resolve(workspace), read(file, 128 * 1024 * 1024), review.approvedPlanHash);
	}
	process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
	process.stdout.write(
		JSON.stringify({
			schemaVersion: 1,
			status: 'blocked',
			diagnostics: [
				{
					code: 'project-review',
					message: error.message,
					remedy:
						'Use an approved tracked local source and a new destination inside the explicit workspace; independently review the exact plan.'
				}
			]
		}) + '\n'
	);
	process.exitCode = 1;
}
