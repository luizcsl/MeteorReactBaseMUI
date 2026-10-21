// Real-browser UI qualification with a controllable RecipeClient, not Meteor/DDP E2E.
// Temporary, loopback-only fixture; no application route or production data access.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const sources = [
	'imports/core/ui/RecipePage.tsx',
	'imports/core/ui/RecipeForm.tsx',
	'imports/core/recipes/definition.ts',
	'tools/fixtures/recipe-ui.tsx',
	'.cypress/recipe-ui/recipe-ui.cy.js',
	'cypress.recipe-ui.config.ts'
];

export async function prepareRecipeUI(root, temporary) {
	const bundle = path.join(temporary, 'recipe-ui.js');
	await build({
		absWorkingDir: root,
		entryPoints: ['tools/fixtures/recipe-ui.tsx'],
		outfile: bundle,
		bundle: true,
		platform: 'browser',
		target: ['chrome110'],
		format: 'iife',
		sourcemap: 'inline',
		define: { 'process.env.NODE_ENV': '"development"' },
		logLevel: 'warning'
	});
	return {
		bundle: await fs.readFile(bundle),
		hashes: Object.fromEntries(
			await Promise.all(
				sources.map(async (source) => [
					source,
					createHash('sha256')
						.update(await fs.readFile(path.join(root, source)))
						.digest('hex')
				])
			)
		)
	};
}

export async function serveRecipeUI(bundle) {
	const html =
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recipe UI qualification fixture</title></head><body><div id="root"></div><script src="/recipe-ui.js"></script></body></html>';
	const server = http.createServer((request, response) => {
		response.setHeader('Cache-Control', 'no-store');
		response.setHeader('X-Content-Type-Options', 'nosniff');
		if (!['GET', 'HEAD'].includes(request.method)) {
			response.writeHead(405).end();
			return;
		}
		const content = request.url === '/' ? html : request.url === '/recipe-ui.js' ? bundle : undefined;
		if (content === undefined) {
			response.writeHead(404).end('Not found');
			return;
		}
		response.setHeader(
			'Content-Type',
			request.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8'
		);
		response.end(request.method === 'HEAD' ? undefined : content);
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			})
	};
}

async function main() {
	const args = process.argv.slice(2);
	if (
		args.some(
			(arg) =>
				![
					'--build-only',
					'--browser=electron',
					'--browser=chrome',
					'--browser=chromium',
					'--browser=firefox',
					'--browser=edge'
				].includes(arg)
		)
	) {
		throw new Error(
			'Usage: node tools/verify-recipe-ui.mjs [--build-only] [--browser=electron|chrome|chromium|firefox|edge]'
		);
	}
	const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'recipe-ui-'));
	const artifacts = path.join(root, '.ai-artifacts');
	const evidence = {
		qualification:
			'real-browser UI with controlled RecipeClient; not DDP, Mongo, authorization or full application E2E',
		startedAt: new Date().toISOString(),
		status: 'failed',
		browserExecuted: false,
		sourceHashes: {}
	};
	let listener;
	try {
		const prepared = await prepareRecipeUI(root, temporary);
		evidence.sourceHashes = prepared.hashes;
		if (args.includes('--build-only')) {
			evidence.status = 'build-only';
			console.log('Recipe UI browser bundle compiled. Browser NOT RUN; this is not a qualification pass.');
			return;
		}
		listener = await serveRecipeUI(prepared.bundle);
		delete process.env.ELECTRON_RUN_AS_NODE;
		const cypress = require('cypress');
		const result = await cypress.run({
			project: root,
			configFile: path.join(root, 'cypress.recipe-ui.config.ts'),
			config: { baseUrl: listener.url },
			browser: args.find((arg) => arg.startsWith('--browser='))?.split('=')[1] ?? 'electron',
			headed: false
		});
		if ('failures' in result) throw new Error(result.message || `Cypress could not run (${result.failures} failures)`);
		evidence.browserExecuted = true;
		Object.assign(evidence, {
			browserName: result.browserName,
			browserVersion: result.browserVersion,
			cypressVersion: result.cypressVersion,
			totalTests: result.totalTests,
			totalPassed: result.totalPassed,
			totalFailed: result.totalFailed,
			totalPending: result.totalPending,
			totalSkipped: result.totalSkipped,
			failures: result.runs.flatMap((run) =>
				run.tests
					.filter((test) => test.state !== 'passed')
					.map((test) => ({
						title: test.title.join(' > '),
						state: test.state,
						error: test.displayError ?? test.attempts?.find((attempt) => attempt.error)?.error?.message ?? null
					}))
			)
		});
		if (
			!result.totalTests ||
			result.totalPassed !== result.totalTests ||
			result.totalFailed ||
			result.totalPending ||
			result.totalSkipped
		) {
			throw new Error('Recipe UI qualification failed, skipped tests, or reported zero passing tests');
		}
		evidence.status = 'passed';
		console.log(
			`Recipe UI qualification: ${result.totalPassed}/${result.totalTests} passed in ${result.browserName}. Controlled remote client only; server qualification is separate.`
		);
	} catch (error) {
		evidence.error = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		evidence.finishedAt = new Date().toISOString();
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(
			path.join(artifacts, args.includes('--build-only') ? 'recipe-ui-build.json' : 'recipe-ui.json'),
			`${JSON.stringify(evidence, null, 2)}\n`
		);
		if (listener) await listener.close();
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
