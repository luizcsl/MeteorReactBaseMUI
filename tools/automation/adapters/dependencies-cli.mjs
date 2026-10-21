#!/usr/bin/env node
/** Deliberately separate from the six ordinary automation tools and protected-path runner. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planDependencies, applyDependencies } from '../dependencies.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const [command, file, reviewFile, ...extra] = process.argv.slice(2);
function read(file, limit) {
	if (!file || fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || fs.statSync(file).size > limit)
		throw new Error('Expected bounded regular JSON file');
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}
try {
	if (
		extra.length ||
		!['plan', 'apply'].includes(command) ||
		!file ||
		(command === 'plan' && reviewFile) ||
		(command === 'apply' && !reviewFile)
	)
		throw new Error('Use plan updates.json | apply dependency-plan.json review.json');
	let result;
	if (command === 'plan') result = await planDependencies(root, read(file, 65536));
	else {
		const review = read(reviewFile, 4096);
		if (
			!review ||
			Array.isArray(review) ||
			Object.keys(review).length !== 1 ||
			typeof review.approvedPlanHash !== 'string' ||
			!/^[a-f0-9]{64}$/.test(review.approvedPlanHash)
		)
			throw new Error('Review requires only approvedPlanHash, the exact independently reviewed dependency plan hash');
		result = applyDependencies(root, read(file, 128 * 1024 * 1024), review.approvedPlanHash);
	}
	process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
	process.stdout.write(
		JSON.stringify({
			schemaVersion: 1,
			status: 'blocked',
			diagnostics: [
				{
					code: 'dependency-review',
					message: error.message,
					remedy:
						'Review the exact package and lock diffs; preserve concurrent edits and resolve any retained recovery lock before retrying.'
				}
			]
		}) + '\n'
	);
	process.exitCode = 1;
}
