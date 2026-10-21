import fs from 'node:fs';
import path from 'node:path';
import { confined, files, hash } from './lib.mjs';
export function prepareExampleFixture(root, destination) {
	for (const name of ['imports', 'client', 'server', 'public', 'tests', '.meteor']) {
		const source = confined(root, name);
		fs.cpSync(source, path.join(destination, name), {
			recursive: true,
			filter: (file) => name !== '.meteor' || !file.startsWith(path.join(source, 'local'))
		});
	}
	for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', '.meteorignore'])
		fs.copyFileSync(confined(root, name), path.join(destination, name));
	for (const name of ['.babelrc', '.babelrc.json', 'babel.config.js', 'babel.config.cjs', '.babel-plugins']) {
		const source = confined(root, name, { missing: true });
		if (fs.existsSync(source)) fs.cpSync(source, path.join(destination, name), { recursive: true });
	}
	fs.symlinkSync(path.join(root, 'node_modules'), path.join(destination, 'node_modules'), 'dir');
	return destination;
}
export function exampleSources(root) {
	const names = [
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'.meteorignore',
		'.meteor/packages',
		'.meteor/versions',
		'.meteor/release',
		'tools/run-example-tests.mjs',
		'tools/example-fixture.mjs',
		'cypress.example.config.ts'
	];
	for (const folder of ['imports', 'client', 'server', 'tests', '.cypress/example'])
		for (const name of files(confined(root, folder))) names.push(folder + '/' + name);
	for (const name of ['.babelrc', '.babelrc.json', 'babel.config.js', 'babel.config.cjs'])
		if (fs.existsSync(confined(root, name, { missing: true }))) names.push(name);
	return Object.fromEntries(names.sort().map((file) => [file, hash(fs.readFileSync(confined(root, file)))]));
}
