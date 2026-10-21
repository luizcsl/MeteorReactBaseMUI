import fs from 'node:fs';
import path from 'node:path';
import { confined, files, hash, fail, protectedPath } from '../../lib.mjs';
export function snapshot(root) {
	const output = {};
	let bytes = 0;
	for (const dir of ['imports', 'server', 'client', 'tests', 'templates', '.cypress', 'cypress', 'tools', 'evals']) {
		if (!fs.existsSync(path.join(root, dir))) continue;
		for (const file of files(confined(root, dir))) {
			const name = dir + '/' + file;
			const target = confined(root, name);
			const stat = fs.statSync(target);
			bytes += stat.size;
			if (stat.size > 4 * 1024 * 1024 || bytes > 64 * 1024 * 1024)
				fail('automation-budget', 'Source snapshot exceeds 64 MiB / 4 MiB per file', name);
			const buffer = fs.readFileSync(target);
			const text = buffer.toString('utf8');
			if (!Buffer.from(text).equals(buffer)) {
				if (/\.(?:png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|zip|gz)$/i.test(name)) continue;
				fail('automation-text-only', 'Expected UTF-8 code; binary assets are not transformed', name);
			}
			output[name] = text;
		}
	}
	for (const file of fs
		.readdirSync(root)
		.filter(
			(name) => /\.[cm]?[jt]sx?$/.test(name) || /^(?:package(?:-lock)?|tsconfig(?:\.[\w-]+)?)\.json$/.test(name)
		)) {
		if (/(?:secret|credential|token|private)/i.test(file))
			fail('automation-sensitive-source', 'Sensitive-looking root source needs an explicit isolated workflow', file);
		const target = confined(root, file);
		if (!fs.statSync(target).isFile()) continue;
		const buffer = fs.readFileSync(target);
		bytes += buffer.length;
		if (buffer.length > 4 * 1024 * 1024 || bytes > 64 * 1024 * 1024)
			fail('automation-budget', 'Source snapshot exceeds limits', file);
		const text = buffer.toString('utf8');
		if (!Buffer.from(text).equals(buffer)) fail('automation-text-only', 'Expected UTF-8 source', file);
		output[file] = text;
	}
	return output;
}
export function put(root, file, content) {
	const target = confined(root, file, { missing: true });
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}
export function safeGeneratedPath(file) {
	// Only fresh, module-local complementary tests may be emitted. Protected suites cannot be replaced.
	return (
		/^imports\/modules\/[a-z][a-z0-9]{2,31}\/(?:generated|automation|custom\/server)\//.test(file) ||
		/^imports\/integration\//.test(file)
	);
}
export function assertWritable(file, before, kind) {
	if (!file.startsWith('imports/') || file === 'imports/libs/router.ts')
		fail('automation-protected', 'Automation writes are confined to imports', file);
	if (protectedPath(file) && !(safeGeneratedPath(file) && (before === null || kind === 'evolve') && kind !== 'codemod'))
		fail('automation-protected', 'Protected tests or configuration cannot be changed', file);
	if (kind === 'codemod' && /\/(?:generated|custom\/server)\//.test(file))
		fail('automation-protected', 'Use metadata evolution for generated or trusted integration files', file);
}
export function changesBetween(before, after) {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])]
		.sort()
		.filter((p) => before[p] !== after[p])
		.map((file) => ({
			path: file,
			before: before[file] ?? null,
			after: after[file] ?? null,
			beforeHash: before[file] === undefined ? null : hash(before[file]),
			afterHash: after[file] === undefined ? null : hash(after[file]),
			diff: `--- a/${file}\n+++ b/${file}\n${(before[file] ?? '')
				.split('\n')
				.map((x) => '-' + x)
				.join('\n')}\n${(after[file] ?? '')
				.split('\n')
				.map((x) => '+' + x)
				.join('\n')}\n`
		}));
}
